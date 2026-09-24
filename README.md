# pi-lite-recap

pi coding agent 的**轻量会话小结**扩展（对标 Claude Code 的 Recap，刻意做轻）：

1. **标签状态短语**：每轮大的用户级对话结束时，生成一句 ≤18 字中文短语写进终端标题（Windows Terminal 标签页一眼看出每个标签在干嘛）。
2. **`/recap` 面板**：同一份小结顺带产出「做了 / 接下来」两行短句，恢复会话或敲 `/recap` 时亮出（编辑器上方小组件）。

## 为什么轻

| 口径 | 做法 |
|---|---|
| 不读历史全量 | 总结输入固定为「上一次小结 + 本轮用户输入 / 工具动作 / 助手产出」，各截断 400 字（≈几百 token） |
| 少费 token | 每轮仅 1 次廉价模型调用（标签和 recap 共享），输出 ≤150 token；`/recap` 展示与 resume 恢复**零 token**（读磁盘缓存） |
| 不污染任务上下文 | 总结走独立裸模型调用（`ctx.modelRegistry.complete`），不写 session 文件、不进 LLM 上下文 |
| 不打扰 | 失败/无模型时本地兜底（取本轮用户输入第一句），不报错、不阻塞 |

## 安装

```bash
pi install git:github.com/SomeTestZero/pi-lite-recap
# 或 SSH 形式：
# pi install git:git@github.com:SomeTestZero/pi-lite-recap.git
```

重启 pi 或 `/reload` 生效。注意：不要和个人扩展目录 `~/.pi/agent/extensions/` 里的同名文件并存（会重复注册、双倍调用）。

## 用法

```
/recap             展示「状态/做了/接下来」面板；有新进展才顺手刷新，否则纯读缓存
/recap redo        强制重新总结一次
/tabtitle          查看当前状态短语并刷新
/tabtitle 修复渲染页  手动设置状态短语（跳过模型调用，最省）
/tabtitle off|on   关闭/恢复自动刷新（标签 + recap 共用开关）
```

行为细节：

- agent 干活时标签前缀 `▶`，跑完去掉；恢复会话（resume）自动亮 recap 面板，开始干活自动收起。
- 小结按 sessionId 持久化到 `<agentDir>/tab-title-summaries.json`（默认 `~/.pi/agent/`，可用 `PI_CODING_AGENT_DIR` 覆盖），重启/换会话标题自动恢复。
- pi 自身会在启动包检查后和 `/reload` 时重写终端标题，扩展会延时重申几次抢回；不要和其他抢标题的扩展（如 titlebar-spinner）同开。

## 配置

文件顶部常量：

- `SUMMARY_CANDIDATES`：总结用廉价模型候选（按顺序取第一个已配认证的），默认 `xiaomi-token-plan-cn/mimo-v2.6-flash` → `neu-llm-gateway/qwen3.8-flash-next` → `deepseek/deepseek-flash`，兜底用当前会话模型。
- `MAX_SUMMARY_CHARS` / `MAX_RECAP_LINE_CHARS`：标签短语 / recap 行的字符上限（默认 18 / 25，按标签宽度调）。
- `MAX_EXCERPT` / `MAX_OUTPUT_TOKENS` / `SUMMARY_TIMEOUT_MS`：材料截断、输出上限、超时。

## 产物示例

```
标签：修复渲染页崩溃          → 标题：▶ 修复渲染页崩溃 · h3_studio
做了：定位双击越界，改了 ui/render.py
接下来：补冒烟测试并复跑
```
