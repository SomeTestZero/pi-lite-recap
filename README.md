# pi-lite-recap

pi coding agent 的**轻量会话小结**扩展（对标 Claude Code 的 Recap，刻意做轻）：

1. **标签 = 「主题 · 最近」**：每轮大的用户级对话结束时，生成一个**稳定的会话主题**（你是谁：讨论/构建什么）+ 一句 ≤18 字的**最近状态**（干到哪了），写进终端标题（Windows Terminal 标签页一眼认出会话身份）。
2. **`/recap` 面板**：同一份小结顺带产出「做了 / 接下来」两行短句，恢复会话或敲 `/recap` 时亮出（编辑器上方小组件）。

## 为什么轻

| 口径 | 做法 |
|---|---|
| 不读历史全量 | 总结输入固定为「上一次小结 + 会话开题（首条用户输入 80 字，定主题用）+ 本轮用户输入 / 工具动作 / 助手产出」，各截断 400 字（≈几百 token） |
| 少费 token | 每轮仅 1 次廉价模型调用（主题/标签/recap 共享），输出 ≤200 token；`/recap` 展示、resume 恢复、手动改主题**零 token**（读磁盘缓存/直接生效） |
| 不污染任务上下文 | 总结走独立裸模型调用（`ctx.modelRegistry.complete`），不写 session 文件、不进 LLM 上下文 |
| 不打扰 | 失败/无模型/**调用挂死**（硬看门狗强制收尾 + abort 请求）时本地兜底（取本轮材料第一句），不报错、不阻塞、后台不留孤儿请求 |
| 不反复请求 | 调用串行 + 意图合并（进行中再刷最多补一次）+ 自动刷新防抖（1.2s，环境变量 `PI_RECAP_DEBOUNCE_MS` 可调）；无新材料的 `/recap` 零调用 |

## 安装

```bash
pi install git:github.com/SomeTestZero/pi-lite-recap
# 或 SSH 形式：
# pi install git:git@github.com:SomeTestZero/pi-lite-recap.git
```

重启 pi 或 `/reload` 生效。注意：不要和个人扩展目录 `~/.pi/agent/extensions/` 里的同名文件并存（会重复注册、双倍调用）。

## 用法

```
/recap                展示「主题/最近/做了/接下来」面板；有新进展才顺手刷新，否则纯读缓存
/recap redo           强制重新总结一次
/recap topic 插件开发  手动设置/更换会话主题（零 token，立即生效）
/tabtitle             查看当前状态短语并刷新
/tabtitle 修复渲染页    手动设置状态短语（跳过模型调用，最省）
/tabtitle off|on      关闭/恢复自动刷新（标签 + recap 共用开关）
```

主题口径：主题是**会话身份**（讨论/构建的主线对象，如「recap 插件」），由首条用户输入 + 滚动材料概括而来，粘性保持不随最近动作漂移；主线变了用 `/recap topic` 手动换。

行为细节：

- agent 干活时标签前缀 `▶`，跑完去掉；恢复会话（resume）自动亮 recap 面板，开始干活自动收起。
- 小结按 sessionId 持久化到 `<agentDir>/tab-title-summaries.json`（默认 `~/.pi/agent/`，可用 `PI_CODING_AGENT_DIR` 覆盖），重启/换会话标题自动恢复。
- pi 自身会在启动包检查后和 `/reload` 时重写终端标题，扩展会延时重申几次抢回；不要和其他抢标题的扩展（如 titlebar-spinner）同开。

## 配置

文件顶部常量：

- `SUMMARY_CANDIDATES`：总结用廉价模型候选（按顺序取第一个已配认证的），默认 `xiaomi-token-plan-cn/mimo-v2.6-flash` → `neu-llm-gateway/qwen3.8-flash-next` → `deepseek/deepseek-flash`，兜底用当前会话模型。
- `MAX_TOPIC_CHARS` / `MAX_SUMMARY_CHARS` / `MAX_RECAP_LINE_CHARS`：主题 / 标签短语 / recap 行的字符上限（默认 14 / 18 / 25）。
- `MAX_EXCERPT` / `MAX_OUTPUT_TOKENS` / `SUMMARY_TIMEOUT_MS`：材料截断、输出上限、HTTP 超时。
- 环境变量：`PI_RECAP_HARD_TIMEOUT_MS`（硬看门狗，默认 35s）、`PI_RECAP_DEBOUNCE_MS`（自动刷新防抖，默认 1.2s）。

## 测试

```bash
# 回归测试：强刷意图/回调不丢、挂死看门狗、无新材料零调用（打桩，不联网）
node --experimental-strip-types test/repro-bugs.mjs

# 真机联调（可选）：pi --mode rpc 跑一轮极小对话，验证真实模型调用只发一次
node --experimental-strip-types test/live-rpc.mjs
```

## 产物示例

```
主题：recap 插件               → 标题：▶ recap 插件 · 修挂死 bug
标签：修挂死 bug
做了：给 complete() 加硬看门狗
接下来：跑真机联调
```
