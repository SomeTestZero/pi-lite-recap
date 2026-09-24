/**
 * tab-title-summary —— 会话主题/状态上标签 + 轻量 Recap
 *
 * 场景：Windows Terminal 开了很多标签，每个标签跑一个 pi 在干不同的事，
 * 标签页只显示 pi 默认标题，看不出各自在干嘛；隔一会回来也忘了该接着干什么。
 *
 * 两个功能，共享同一次极小的模型调用（每轮大的用户级对话结束时触发）：
 * 1. 标签 = 「主题 · 最近」：主题（会话主线，粘性稳定）+ 状态短语（最近在做什么，
 *    滚动漂移）→ ctx.ui.setTitle() → WT 标签页一眼看出这个会话是干什么的、干到哪了。
 * 2. 轻量 Recap：同一调用顺带产出「做了 / 接下来」两行短句，缓存到磁盘，
 *    /recap 或会话恢复时直接展示（展示本身零 token）。
 *
 * 关键口径：
 * - 「新会话」= ctx.modelRegistry.complete() 的裸模型调用：messages 只含本次
 *   摘要材料，不写入当前 session 文件、不进 LLM 上下文，对进行中的任务零污染。
 * - 只 recap「最近」：喂给总结模型的材料固定为「上一次小结 + 会话开题（首条用户
 *   输入 80 字，只用来定主题）+ 本轮用户输入/工具动作/助手产出（各截断 400 字）」，
 *   永远不读历史全量；输出限 200 token。
 * - 主题粘性：prompt 要求沿用上一次小结的主题，解析时空主题自动继承旧值；
 *   要换主题用 `/recap topic <文本>` 手动改（零 token，立即生效）。
 * - 滚动更新：每轮把上一次小结带上，三行随最新进展漂移（整体任务不丢）。
 * - 兜底：无可用模型 / 调用失败 / 调用挂死（硬看门狗强制收尾并 abort 请求）时，
 *   用本轮材料做本地启发式小结，标签照样更新，不阻塞、不报错打扰。
 *
 * 并发与节流口径（防「一直刷新中」/ 反复请求烧 token）：
 * - 调用串行；进行中收到刷新请求只置合并标记（强刷意图不丢），收尾后补至多一次。
 * - 回调在刷新链最终收尾时必定触发，任何早退路径都不吞回调。
 * - 材料桶带版本号：调用期间新到的材料不被误消费，留给下一次刷新。
 * - 自动刷新防抖（AUTO_DEBOUNCE_MS）：一轮内连续多次 settle 合并成一次调用。
 * - 双层超时：timeoutMs（HTTP）+ HARD_TIMEOUT_MS 硬看门狗（Promise.race + abort），
 *   complete() 永不返回也不会卡死或在后台留孤儿请求。
 *
 * 用法：
 *   /recap                展示「主题/状态/做了/接下来」（面板），有新进展则顺手刷新
 *   /recap redo           强制重新总结一次
 *   /recap topic 插件开发  手动设置会话主题（零 token，立即生效）
 *   /tabtitle             查看当前状态短语并刷新
 *   /tabtitle 修复渲染页    手动设置状态短语（跳过模型调用）
 *   /tabtitle off|on      关闭/恢复自动刷新
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

/** 会话主题硬上限（字符数，中文按 1 算） */
const MAX_TOPIC_CHARS = 14;
/** 标签页宽度有限，状态短语硬上限 */
const MAX_SUMMARY_CHARS = 18;
/** Recap「做了 / 接下来」两行的硬上限 */
const MAX_RECAP_LINE_CHARS = 25;
/** 摘要材料各字段截断长度（省 token） */
const MAX_EXCERPT = 400;
/** 会话开题（首条用户输入）截断长度：只用来定主题 */
const MAX_OPENING_CHARS = 80;
/** 总结调用的输出上限（token） */
const MAX_OUTPUT_TOKENS = 200;
/** 总结调用的 HTTP 超时（毫秒） */
const SUMMARY_TIMEOUT_MS = 30_000;
/** 硬看门狗（毫秒）：complete() 挂死也强制收尾 + abort 请求，绝不吊后台。环境变量 PI_RECAP_HARD_TIMEOUT_MS 可覆盖。 */
const HARD_TIMEOUT_MS = Number(process.env.PI_RECAP_HARD_TIMEOUT_MS ?? SUMMARY_TIMEOUT_MS + 5_000);
/** 自动刷新防抖（毫秒）：一轮内连续多次 settle 合并成一次调用。环境变量 PI_RECAP_DEBOUNCE_MS 可覆盖。 */
const AUTO_DEBOUNCE_MS = Number(process.env.PI_RECAP_DEBOUNCE_MS ?? 1_200);
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

/** 取第一句并清洗 */
function firstSentence(text: string): string {
	return cleanPhrase(text.split(/[。！？!?\n]/)[0] ?? "");
}

/** 本地兜底短语：取本轮用户输入的第一句 */
function heuristicSummary(userText: string): string {
	return clip(firstSentence(userText) || "对话中", MAX_SUMMARY_CHARS);
}

/** 本地兜底小结：模型不可用/挂死时也能更新标签和面板（did 从助手产出取一句） */
function fallbackRecap(round: RoundDigest): Recap {
	return {
		topic: "",
		label: heuristicSummary(round.userTexts[0] ?? ""),
		did: round.assistantText ? clip(firstSentence(round.assistantText), MAX_RECAP_LINE_CHARS) : "",
		next: "",
	};
}

// ============================== 持久化 ==============================

/** 一次滚动总结的产物：会话主题 + 标签短语 + Recap 两行 */
type Recap = { topic: string; label: string; did: string; next: string };
type RecapRecord = Recap & { updatedAt: number };
type RecapStore = Record<string, RecapRecord>;

function loadStore(): RecapStore {
	try {
		const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as RecapStore;
		// 兼容旧版记录（无 topic / 旧字段 summary）
		for (const rec of Object.values(raw)) {
			if (!rec.label && (rec as unknown as { summary?: string }).summary) {
				rec.label = (rec as unknown as { summary?: string }).summary ?? "";
			}
			rec.topic ??= "";
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

/**
 * 标题格式：
 *   有主题：`▶ 主题 · 最近`（主题即身份，省掉目录后缀，标签页最宽也认得出是谁）
 *   无主题：`▶ 最近 · 目录`（兜底）
 */
function buildTitle(ctx: ExtensionContext, recap: Recap | undefined, busy: boolean): string {
	const marker = busy ? "▶ " : "";
	if (recap?.topic) {
		return `${marker}${clip(cleanPhrase(recap.topic), MAX_TOPIC_CHARS)} · ${recap.label ? clip(cleanPhrase(recap.label), MAX_SUMMARY_CHARS) : "…"}`;
	}
	const body = recap?.label ? clip(cleanPhrase(recap.label), MAX_SUMMARY_CHARS) : "π";
	return `${marker}${body} · ${dirBase(ctx)}`;
}

function applyTitle(ctx: ExtensionContext, recap: Recap | undefined, busy: boolean): void {
	try {
		ctx.ui.setTitle(buildTitle(ctx, recap, busy));
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

/** 拼出喂给总结模型的材料（全部截断，控制在 ~1.2k 字以内） */
function buildSummaryPrompt(prev: Recap | undefined, round: RoundDigest, opening: string): string {
	return [
		"你在为一个编码会话做滚动小结，供终端标签和 Recap 面板使用。根据下面的材料（只含最近一轮），输出固定四行：",
		`主题：<${MAX_TOPIC_CHARS} 字以内的名词短语，整个会话讨论/构建的主线对象，例：recap 插件、渲染页崩溃、数据导出>`,
		`标签：<${MAX_SUMMARY_CHARS} 字以内的中文短语，动宾结构，写最近在做什么，例：修复卡死 bug>`,
		`做了：<${MAX_RECAP_LINE_CHARS} 字以内，最近一轮完成了什么>`,
		`接下来：<${MAX_RECAP_LINE_CHARS} 字以内，下一步该做什么；没有明确待办就写：继续当前任务>`,
		"要求：每行以「主题：」「标签：」「做了：」「接下来：」开头；不要引号、解释、理由、额外行。",
		"主题口径：主题是会话身份，保持稳定，优先沿用上一次小结的主题；只有会话主线明显改变时才换新主题。",
		"",
		`上一次小结：${prev ? `主题 ${prev.topic || "—"}；标签 ${prev.label || "—"}；做了 ${prev.did || "—"}；接下来 ${prev.next || "—"}` : "（无）"}`,
		`会话开题（首条用户输入，仅供定主题）：${opening ? clip(opening, MAX_OPENING_CHARS) : "（无）"}`,
		`本轮用户输入：${round.userTexts.map((t) => clip(t, MAX_EXCERPT)).join(" | ") || "（无）"}`,
		`本轮工具动作：${round.tools.slice(-8).join(", ") || "（无）"}`,
		`本轮助手产出：${clip(round.assistantText, MAX_EXCERPT) || "（无）"}`,
	].join("\n");
}

/** 解析四行输出；模型偶尔不守格式时尽力回收，保底 label 非空 */
function parseRecap(text: string): Recap | undefined {
	const recap: Recap = { topic: "", label: "", did: "", next: "" };
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(主题|标签|做了|接下来)\s*[:：]\s*(.+)$/.exec(line);
		if (!m) continue;
		const max = m[1] === "主题" ? MAX_TOPIC_CHARS : m[1] === "标签" ? MAX_SUMMARY_CHARS : MAX_RECAP_LINE_CHARS;
		const value = clip(cleanPhrase(m[2] ?? ""), max);
		if (m[1] === "主题") recap.topic = value;
		else if (m[1] === "标签") recap.label = value;
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

/** 独立上下文的裸模型调用：一问一答，不进任何会话。双层超时 + abort，绝不吊后台。 */
async function callSummaryModel(ctx: ExtensionContext, prompt: string): Promise<Recap | undefined> {
	const model = pickSummaryModel(ctx);
	if (!model) return undefined;
	const ac = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const hardStop = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			ac.abort(); // 中断挂起的 HTTP 请求，不留后台孤儿
			resolve(undefined);
		}, HARD_TIMEOUT_MS);
	});
	try {
		const call = (async () => {
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
					signal: ac.signal,
					sessionId: `${ctx.sessionManager.getSessionId()}-tabtitle`,
				},
			);
			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return parseRecap(text);
		})();
		return await Promise.race([call, hardStop]);
	} catch {
		return undefined;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// ============================== 扩展主体 ==============================

export default function (pi: ExtensionAPI) {
	// —— 会话级状态 ——
	let round: RoundDigest = EMPTY_ROUND();
	let recap: Recap | undefined; // 当前小结（滚动）：主题/标签 → 标题，四行 → Recap 面板
	let sessionOpening = ""; // 首条用户输入（定主题用，截断 80 字）
	let busy = false; // agent 是否在跑（标签加 ▶ 前缀）
	let enabled = true; // /tabtitle off 可关
	let alive = true; // session_shutdown 后停止一切异步收尾
	let summarizing = false; // 总结调用串行化
	let queuedForce = false; // 调用进行中收到的强刷意图（收尾后必须补刷，不许被吞）
	let digestVersion = 0; // 材料桶版本号：调用期间新到的材料不能被误消费
	let dirty = false; // 本轮是否有新材料（无新材料不调模型）
	let autoTimer: ReturnType<typeof setTimeout> | undefined; // 自动刷新防抖
	const doneCallbacks: Array<() => void> = []; // 刷新收尾回调（/recap 等展示用）
	const reassertTimers: Array<ReturnType<typeof setTimeout>> = [];

	const persist = (sessionId: string) => {
		if (!recap) return;
		const store = loadStore();
		store[sessionId] = { ...recap, updatedAt: Date.now() };
		saveStore(store);
	};

	const paint = (ctx: ExtensionContext) => applyTitle(ctx, recap, busy);

	/** Recap 面板（aboveEditor 小组件），展示零 token */
	const showRecapPanel = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !recap) return;
		const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		ctx.ui.setWidget("recap", [
			recap.topic ? `◎ 主题：${recap.topic}` : "◎ 主题：—",
			`● 最近：${recap.label || "—"}`,
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

	// —— 刷新链：串行 + 意图合并 + 回调必达 ——

	const flushDone = () => {
		for (const cb of doneCallbacks.splice(0)) {
			try {
				cb();
			} catch {
				// 回调异常不影响主流程
			}
		}
	};

	const runRefresh = (ctx: ExtensionContext) => {
		summarizing = true;
		queuedForce = false; // 本次调用已兑现；调用期间再来强刷会重新置位
		const consumedVersion = digestVersion;
		void (async () => {
			try {
				const prompt = buildSummaryPrompt(recap, round, sessionOpening);
				const next = (await callSummaryModel(ctx, prompt)) ?? fallbackRecap(round);
				if (alive) {
					// 主题粘性：模型没给主题就沿用旧主题（prompt 也要求稳定）
					if (!next.topic && recap?.topic) next.topic = recap.topic;
					recap = next;
					// 只消费本次调用覆盖的材料；调用期间新到的留给下一次刷新
					if (digestVersion === consumedVersion) {
						round = EMPTY_ROUND();
						dirty = false;
					}
					persist(ctx.sessionManager.getSessionId());
					paint(ctx);
				}
			} catch {
				// 内部已有兜底，这里只是保险，绝不出未处理拒绝
			} finally {
				summarizing = false;
				if (alive && (queuedForce || dirty)) {
					runRefresh(ctx); // 合并后的补刷，回调留给它收尾
				} else {
					flushDone();
				}
			}
		})();
	};

	/** 刷新入口：onDone 在刷新链最终收尾后必定回调（任何早退路径都不吞回调） */
	const refresh = (ctx: ExtensionContext, force = false, onDone?: () => void) => {
		if (onDone) doneCallbacks.push(onDone);
		if (!enabled) {
			flushDone();
			return;
		}
		if (force) queuedForce = true;
		if (summarizing) return; // 在飞的调用收尾时统一补刷/flush，意图与回调都不丢
		if (!queuedForce && !dirty) {
			flushDone(); // 无可做：回调也必须触发
			return;
		}
		runRefresh(ctx);
	};

	/** 自动刷新（agent_settled）：防抖合并一轮内多次 settle，省调用 */
	const scheduleAutoRefresh = (ctx: ExtensionContext) => {
		if (autoTimer) clearTimeout(autoTimer);
		autoTimer = setTimeout(() => {
			autoTimer = undefined;
			if (alive) refresh(ctx);
		}, AUTO_DEBOUNCE_MS);
	};

	// —— 事件接线 ——

	// 启动/换会话/重载：恢复该会话的小结并刷标题。恢复会话时顺手亮 Recap 面板
	// （纯读缓存，零 token）。pi 自己会在启动包检查完成后、/reload 时重写终端
	// 标题，所以延时重申几次抢回来。
	pi.on("session_start", (event, ctx) => {
		alive = true;
		round = EMPTY_ROUND();
		sessionOpening = "";
		digestVersion = 0;
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
			if (text) {
				if (!sessionOpening) sessionOpening = text; // 首条用户输入 → 定主题
				if (round.userTexts.length < 3) round.userTexts.push(text);
				dirty = true;
				digestVersion++;
			}
		} else if (msg.role === "assistant") {
			const text = extractText(msg.content).trim();
			if (text) {
				round.assistantText = text; // 只留最新一份产出 = 「最近」在做什么
				dirty = true;
				digestVersion++;
			}
			for (const hint of extractToolHints(msg.content)) {
				round.tools.push(hint);
				dirty = true;
				digestVersion++;
			}
			if (round.tools.length > 16) round.tools = round.tools.slice(-16);
		}
	});

	// 一轮大的用户级对话结束 → 防抖后滚动刷新（标题 + Recap 同源产物）
	pi.on("agent_settled", (_event, ctx) => {
		busy = false;
		paint(ctx);
		scheduleAutoRefresh(ctx);
	});

	// 收尾：停掉延时重申与防抖 timer，异步收尾一律不再动 UI/存储
	pi.on("session_shutdown", (_event, ctx) => {
		alive = false;
		if (autoTimer) {
			clearTimeout(autoTimer);
			autoTimer = undefined;
		}
		for (const t of reassertTimers) clearTimeout(t);
		reassertTimers.length = 0;
		persist(ctx.sessionManager.getSessionId());
	});

	// —— 命令 ——

	pi.registerCommand("recap", {
		description: "轻量 Recap：主题/最近/做了/接下来（/recap redo 强刷，/recap topic <文本> 定主题）",
		handler: async (args, ctx) => {
			const arg = args.trim();

			// /recap topic <文本>：手动定/换主题（零 token，立即生效）
			if (/^topic\b/i.test(arg)) {
				const topic = clip(cleanPhrase(arg.replace(/^topic\b\s*/i, "")), MAX_TOPIC_CHARS);
				if (!topic) {
					if (ctx.hasUI) ctx.ui.notify(recap?.topic ? `当前主题：${recap.topic}` : "尚未设置主题（/recap topic <文本> 设置）", "info");
					return;
				}
				recap = { topic, label: recap?.label ?? "", did: recap?.did ?? "", next: recap?.next ?? "" };
				persist(ctx.sessionManager.getSessionId());
				paint(ctx);
				showRecapPanel(ctx);
				if (ctx.hasUI) ctx.ui.notify(`主题已设为：${topic}`, "info");
				return;
			}

			const force = arg.toLowerCase() === "redo";
			if (recap && !force && !dirty && !summarizing && !queuedForce) {
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
				recap = {
					topic: recap?.topic ?? "",
					label: clip(cleanPhrase(arg), MAX_SUMMARY_CHARS),
					did: recap?.did ?? "",
					next: recap?.next ?? "",
				};
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
