/**
 * tab-title-summary —— 会话状态上标签 + 轻量 Recap
 *
 * 场景：Windows Terminal 开了很多标签，每个标签跑一个 pi 在干不同的事，
 * 标签页只显示 pi 默认标题，看不出各自在干嘛；隔一会回来也忘了该接着干什么。
 *
 * 两个功能，共享同一次极小的模型调用（每轮大的用户级对话结束时触发）：
 * 1. 标签状态短语：≤18 字中文短语 → ctx.ui.setTitle() → WT 标签页可见。
 * 2. 轻量 Recap：同一调用顺带产出「做了 / 接下来」两行短句，缓存到磁盘，
 *    /recap 或会话恢复时直接展示（展示本身零 token）。
 *
 * 关键口径：
 * - 「新会话」= ctx.modelRegistry.complete() 的裸模型调用：messages 只含本次
 *   摘要材料，不写入当前 session 文件、不进 LLM 上下文，对进行中的任务零污染。
 * - 只 recap「最近」：喂给总结模型的材料固定为「上一次状态 + 本轮用户输入 +
 *   工具动作 + 助手产出」各截断 400 字（≈几百 token），永远不读历史全量；
 *   输出限 150 token。对标 Claude Code recap 的全会话总结，这里刻意做轻。
 * - 滚动更新：每轮把上一次状态带上，三行随最新进展漂移（整体任务不丢）。
 * - 兜底：无可用模型 / 调用失败时，用本轮用户输入的第一句做本地启发式短语，
 *   标签照样更新，不阻塞、不报错打扰。
 *
 * 用法：
 *   /recap             展示「状态/做了/接下来」（面板），有新进展则顺手刷新
 *   /recap redo        强制重新总结一次
 *   /tabtitle          查看当前状态短语并刷新
 *   /tabtitle 修复渲染页  手动设置状态短语（跳过模型调用）
 *   /tabtitle off|on   关闭/恢复自动刷新
 *
 * 安装/重载：
 *   pi install git:github.com/SomeTestZero/pi-lite-recap   （或 git:git@github.com:SomeTestZero/pi-lite-recap.git）
 *   然后重启 pi 或 /reload。不要与 ~/.pi/agent/extensions/ 里的同名文件并存（会重复注册）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ============================== 配置 ==============================

/** 总结用廉价模型候选（按顺序取第一个「已配置认证」的）。改这里换模型。 */
const SUMMARY_CANDIDATES: Array<[provider: string, modelId: string]> = [
	["xiaomi-token-plan-cn", "mimo-v2.6-flash"],
	["xiaomi", "mimo-v2.6-flash"],
	["neu-llm-gateway", "qwen3.8-flash-next"],
	["deepseek", "deepseek-flash"],
];

/** 标签页宽度有限，状态短语硬上限（字符数，中文按 1 算） */
const MAX_SUMMARY_CHARS = 18;
/** Recap「做了 / 接下来」两行的硬上限 */
const MAX_RECAP_LINE_CHARS = 25;
/** 摘要材料各字段截断长度（省 token） */
const MAX_EXCERPT = 400;
/** 总结调用的输出上限（token） */
const MAX_OUTPUT_TOKENS = 150;
/** 总结调用超时（毫秒），失败直接走本地兜底 */
const SUMMARY_TIMEOUT_MS = 30_000;
/** 状态持久化文件（外部存储，不进任何会话上下文） */
const STORE_FILE = path.join(
	process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
	"tab-title-summaries.json",
);
/** store 里最多保留多少个会话的记录 */
const STORE_MAX_SESSIONS = 200;

// ============================== 小工具 ==============================

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };

/** 取 message content 里的纯文本 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const block = part as ContentBlock;
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** 取 message content 里的工具调用线索：「read(core/store.py)」「bash(npm test)」 */
function extractToolHints(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const hints: string[] = [];
	for (const part of content) {
		const block = part as ContentBlock;
		if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
		const args = block.arguments ?? {};
		const key = String(args.path ?? args.file ?? args.command ?? args.pattern ?? args.query ?? "");
		const keyClip = key.replace(/\s+/g, " ").slice(0, 40);
		hints.push(keyClip ? `${block.name}(${keyClip})` : block.name);
	}
	return hints;
}

/** 截断（按码点，避免把 emoji/汉字代理对切坏） */
function clip(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/** 挤压空白、剥掉引号/标题符号/尾部标点，做成干净的短语 */
function cleanPhrase(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[#>*\-–—\d.\)\]、\s]+/, "") // markdown 标题/列表/序号
		.replace(/^[「『"'“‘`（(\[]+/, "")
		.replace(/[」』"'”’`）)\]。！？!?；;：:，,、\s]+$/, "");
}

/** 本地兜底短语：取本轮用户输入的第一句 */
function heuristicSummary(userText: string): string {
	const first = cleanPhrase(userText.split(/[。！？!?\n]/)[0] ?? "");
	return clip(first || "对话中", MAX_SUMMARY_CHARS);
}

// ============================== 持久化 ==============================

/** 一次滚动总结的产物：标签短语 + Recap 两行 */
type Recap = { label: string; did: string; next: string };
type RecapRecord = Recap & { updatedAt: number };
type RecapStore = Record<string, RecapRecord>;

function loadStore(): RecapStore {
	try {
		const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as RecapStore;
		// 兼容旧版只有 { summary } 的记录
		for (const [key, rec] of Object.entries(raw)) {
			if (!rec.label && (rec as unknown as { summary?: string }).summary) {
				rec.label = (rec as unknown as { summary?: string }).summary ?? "";
			}
			rec.label ??= "";
			rec.did ??= "";
			rec.next ??= "";
		}
		return raw;
	} catch {
		return {};
	}
}

function saveStore(store: RecapStore): void {
	try {
		// 超量裁剪：按更新时间保留最近 N 个会话
		const keys = Object.keys(store);
		if (keys.length > STORE_MAX_SESSIONS) {
			keys.sort((a, b) => (store[b].updatedAt ?? 0) - (store[a].updatedAt ?? 0));
			for (const key of keys.slice(STORE_MAX_SESSIONS)) delete store[key];
		}
		fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
		fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, "\t"));
	} catch {
		// 持久化失败不影响主流程
	}
}

// ============================== 标题 ==============================

function dirBase(ctx: ExtensionContext): string {
	return path.basename(ctx.cwd || process.cwd());
}

function buildTitle(ctx: ExtensionContext, label: string | undefined, busy: boolean): string {
	const marker = busy ? "▶ " : "";
	const body = label ? clip(cleanPhrase(label), MAX_SUMMARY_CHARS) : "π";
	return `${marker}${body} · ${dirBase(ctx)}`;
}

function applyTitle(ctx: ExtensionContext, label: string | undefined, busy: boolean): void {
	try {
		ctx.ui.setTitle(buildTitle(ctx, label, busy));
	} catch {
		// 无 UI（json/print 模式）时静默
	}
}

// ============================== 总结 ==============================

/** 一轮用户级对话里攒下的材料（只存截断后的文本，内存占用有界） */
type RoundDigest = {
	userTexts: string[];
	assistantText: string;
	tools: string[];
};

const EMPTY_ROUND = (): RoundDigest => ({ userTexts: [], assistantText: "", tools: [] });

/** 拼出喂给总结模型的材料（全部截断，控制在 ~1k 字以内） */
function buildSummaryPrompt(prev: Recap | undefined, round: RoundDigest): string {
	return [
		"你在为一个编码会话做滚动小结，供终端标签和 Recap 面板使用。根据下面的材料（只含最近一轮），输出固定三行：",
		`标签：<${MAX_SUMMARY_CHARS} 字以内的中文短语，动宾结构，写最近在做什么，例：修复渲染页崩溃>`,
		`做了：<${MAX_RECAP_LINE_CHARS} 字以内，最近一轮完成了什么>`,
		`接下来：<${MAX_RECAP_LINE_CHARS} 字以内，下一步该做什么；没有明确待办就写：继续当前任务>`,
		"要求：每行以「标签：」「做了：」「接下来：」开头；不要引号、解释、理由、额外行。",
		"",
		`上一次小结：${prev ? `标签 ${prev.label || "—"}；做了 ${prev.did || "—"}；接下来 ${prev.next || "—"}` : "（无）"}`,
		`本轮用户输入：${round.userTexts.map((t) => clip(t, MAX_EXCERPT)).join(" | ") || "（无）"}`,
		`本轮工具动作：${round.tools.slice(-8).join(", ") || "（无）"}`,
		`本轮助手产出：${clip(round.assistantText, MAX_EXCERPT) || "（无）"}`,
	].join("\n");
}

/** 解析三行输出；模型偶尔不守格式时尽力回收，保底 label 非空 */
function parseRecap(text: string): Recap | undefined {
	const recap: Recap = { label: "", did: "", next: "" };
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(标签|做了|接下来)\s*[:：]\s*(.+)$/.exec(line);
		if (!m) continue;
		const value = clip(cleanPhrase(m[2] ?? ""), m[1] === "标签" ? MAX_SUMMARY_CHARS : MAX_RECAP_LINE_CHARS);
		if (m[1] === "标签") recap.label = value;
		else if (m[1] === "做了") recap.did = value;
		else recap.next = value;
	}
	if (!recap.label) {
		// 格式没守住：取第一句当标签
		recap.label = heuristicSummary(text);
	}
	return recap.label ? recap : undefined;
}

/** 挑总结模型：候选表里第一个已配置认证的，其次当前会话模型 */
function pickSummaryModel(ctx: ExtensionContext) {
	for (const [provider, modelId] of SUMMARY_CANDIDATES) {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
	}
	if (ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) return ctx.model;
	return undefined;
}

/** 独立上下文的裸模型调用：一问一答，不进任何会话 */
async function callSummaryModel(ctx: ExtensionContext, prompt: string): Promise<Recap | undefined> {
	const model = pickSummaryModel(ctx);
	if (!model) return undefined;
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: MAX_OUTPUT_TOKENS,
				temperature: 0.2,
				cacheRetention: "none",
				maxRetries: 0,
				timeoutMs: SUMMARY_TIMEOUT_MS,
				sessionId: `${ctx.sessionManager.getSessionId()}-tabtitle`,
			},
		);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return parseRecap(text);
	} catch {
		return undefined;
	}
}

// ============================== 扩展主体 ==============================

export default function (pi: ExtensionAPI) {
	// —— 会话级状态 ——
	let round: RoundDigest = EMPTY_ROUND();
	let recap: Recap | undefined; // 当前小结（滚动）：标签 → 标题，三行 → Recap 面板
	let busy = false; // agent 是否在跑（标签加 ▶ 前缀）
	let enabled = true; // /tabtitle off 可关
	let alive = true; // session_shutdown 后停止一切异步收尾
	let summarizing = false; // 总结调用串行化
	let refreshQueued = false; // 总结进行中又来一轮 → 收尾后再刷一次
	let dirty = false; // 本轮是否有新材料（无新材料不调模型）
	const doneCallbacks: Array<() => void> = []; // 刷新收尾回调（/recap 等展示用）
	const reassertTimers: Array<ReturnType<typeof setTimeout>> = [];

	const persist = (sessionId: string) => {
		if (!recap) return;
		const store = loadStore();
		store[sessionId] = { ...recap, updatedAt: Date.now() };
		saveStore(store);
	};

	const paint = (ctx: ExtensionContext) => applyTitle(ctx, recap?.label, busy);

	/** Recap 面板（aboveEditor 小组件），展示零 token */
	const showRecapPanel = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !recap) return;
		const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		ctx.ui.setWidget("recap", [
			`● ${recap.label || "—"}`,
			recap.did ? `✓ 做了：${recap.did}` : "✓ 做了：—",
			recap.next ? `→ 接下来：${recap.next}` : "→ 接下来：—",
			`（${time} 小结，/recap 刷新）`,
		]);
	};

	const hideRecapPanel = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget("recap", undefined);
		} catch {
			// 无 UI 时静默
		}
	};

	/** 串行的刷新入口：一轮结束后调用；onDone 在本次（或被合并的后续）刷新收尾后回调 */
	const refresh = (ctx: ExtensionContext, force = false, onDone?: () => void) => {
		if (!enabled) {
			onDone?.();
			return;
		}
		if (summarizing) {
			refreshQueued = true;
			if (onDone) doneCallbacks.push(onDone);
			return;
		}
		if (!force && !dirty) {
			onDone?.();
			return;
		}
		if (onDone) doneCallbacks.push(onDone);
		summarizing = true;
		void (async () => {
			try {
				const prompt = buildSummaryPrompt(recap, round);
				const next =
					(await callSummaryModel(ctx, prompt)) ??
					({ label: heuristicSummary(round.userTexts[0] ?? ""), did: "", next: "" } as Recap);
				if (alive && next) {
					recap = next;
					dirty = false;
					round = EMPTY_ROUND(); // 本轮材料消费掉，下轮从头攒
					persist(ctx.sessionManager.getSessionId());
					paint(ctx);
				}
			} finally {
				summarizing = false;
				if (refreshQueued && alive) {
					refreshQueued = false;
					refresh(ctx); // doneCallbacks 留给合并后的这轮收尾
				} else {
					for (const cb of doneCallbacks.splice(0)) {
						try {
							cb();
						} catch {
							// 回调异常不影响主流程
						}
					}
				}
			}
		})();
	};

	// —— 事件接线 ——

	// 启动/换会话/重载：恢复该会话的小结并刷标题。恢复会话时顺手亮 Recap 面板
	// （纯读缓存，零 token）。pi 自己会在启动包检查完成后、/reload 时重写终端
	// 标题，所以延时重申几次抢回来。
	pi.on("session_start", (event, ctx) => {
		alive = true;
		round = EMPTY_ROUND();
		dirty = false;
		busy = false;
		recap = loadStore()[ctx.sessionManager.getSessionId()];
		paint(ctx);
		if (event.reason === "resume") showRecapPanel(ctx);
		for (const delay of [300, 1500, 5000]) {
			reassertTimers.push(setTimeout(() => alive && paint(ctx), delay));
		}
	});

	// 每轮开始：打「忙」标记（▶），收起 Recap 面板让位给干活
	pi.on("agent_start", (_event, ctx) => {
		busy = true;
		paint(ctx);
		hideRecapPanel(ctx);
	});

	// 攒材料：用户输入 / 助手产出 / 工具动作（只存截断文本，不调模型、零成本）
	pi.on("message_end", (event, _ctx) => {
		const msg = event.message as { role?: string; content?: unknown };
		if (msg.role === "user") {
			const text = cleanPhrase(extractText(msg.content));
			if (text && round.userTexts.length < 3) {
				round.userTexts.push(text);
				dirty = true;
			}
		} else if (msg.role === "assistant") {
			const text = extractText(msg.content).trim();
			if (text) {
				round.assistantText = text; // 只留最新一份产出 = 「最近」在做什么
				dirty = true;
			}
			for (const hint of extractToolHints(msg.content)) {
				round.tools.push(hint);
				dirty = true;
			}
			if (round.tools.length > 16) round.tools = round.tools.slice(-16);
		}
	});

	// 一轮大的用户级对话结束 → 滚动刷新（标签 + Recap 同源产物）
	pi.on("agent_settled", (_event, ctx) => {
		busy = false;
		paint(ctx);
		refresh(ctx);
	});

	// 收尾：停掉延时重申，异步收尾一律不再动 UI/存储
	pi.on("session_shutdown", (_event, ctx) => {
		alive = false;
		for (const t of reassertTimers) clearTimeout(t);
		reassertTimers.length = 0;
		persist(ctx.sessionManager.getSessionId());
	});

	// —— 命令 ——

	pi.registerCommand("recap", {
		description: "轻量 Recap：状态/做了/接下来（/recap redo 强制刷新）",
		handler: async (args, ctx) => {
			const force = args.trim().toLowerCase() === "redo";
			if (recap && !force && !dirty) {
				showRecapPanel(ctx); // 零 token：直接读缓存
				return;
			}
			if (ctx.hasUI && !recap) ctx.ui.notify("首次小结生成中…", "info");
			refresh(ctx, force, () => {
				if (alive) showRecapPanel(ctx);
			});
		},
	});

	pi.registerCommand("tabtitle", {
		description: "终端标签状态短语：/tabtitle [文本|off|on]（空参数=立即刷新）",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const sessionId = ctx.sessionManager.getSessionId();

			if (arg.toLowerCase() === "off") {
				enabled = false;
				if (ctx.hasUI) ctx.ui.notify("标签状态自动刷新已关闭", "info");
				return;
			}
			if (arg.toLowerCase() === "on") {
				enabled = true;
				if (ctx.hasUI) ctx.ui.notify("标签状态自动刷新已开启", "info");
				refresh(ctx, true);
				return;
			}
			if (arg) {
				recap = { label: clip(cleanPhrase(arg), MAX_SUMMARY_CHARS), did: recap?.did ?? "", next: recap?.next ?? "" };
				dirty = false;
				round = EMPTY_ROUND();
				persist(sessionId);
				paint(ctx);
				if (ctx.hasUI) ctx.ui.notify(`标签状态：${recap.label}`, "info");
				return;
			}

			if (ctx.hasUI) ctx.ui.notify(recap?.label ? `当前状态：${recap.label}，刷新中…` : "刷新中…", "info");
			refresh(ctx, true);
		},
	});
}
