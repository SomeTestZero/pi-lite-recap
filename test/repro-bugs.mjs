// 回归测试：「一直刷新中」/ 反复请求 / 挂死 卡死 类 bug
process.env.PI_CODING_AGENT_DIR = '/tmp/tabtitle-bug/agent';
process.env.PI_RECAP_HARD_TIMEOUT_MS = '800'; // 硬看门狗
process.env.PI_RECAP_DEBOUNCE_MS = '50'; // 自动刷新防抖
const fs = (await import('node:fs')).default;
const mod = await import('file:///E:/pi-lite-recap/extensions/tab-title-summary.ts');

function makeEnv({ completeImpl, sessId }) {
  const titles = [], widgets = [], notifies = [];
  let calls = 0;
  const ctx = {
    cwd: 'E:/proj',
    ui: {
      setTitle: (t) => titles.push(t),
      notify: (m) => notifies.push(m),
      setWidget: (k, v) => widgets.push([k, v]),
    },
    hasUI: true,
    sessionManager: { getSessionId: () => sessId },
    modelRegistry: {
      find: () => ({ id: 'fake' }),
      hasConfiguredAuth: () => true,
      complete: (...a) => { calls++; return completeImpl(...a); },
    },
  };
  const h = {};
  mod.default({ on: (e, f) => { h[e] = f; }, registerCommand: (n, o) => { h['cmd:' + n] = o.handler; } });
  return { ctx, h, titles, widgets, notifies, calls: () => calls };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const storeOf = (sid) => {
  try { return JSON.parse(fs.readFileSync('/tmp/tabtitle-bug/agent/tab-title-summaries.json', 'utf8'))[sid] ?? {}; }
  catch { return {}; }
};
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
  if (!ok) failures++;
};

// ========== T1: 慢调用进行中来了新材料 + 强刷 → 意图和材料都不能丢 ==========
{
  let phase = 0;
  const env = await makeEnv({
    sessId: 'sess-t1',
    completeImpl: async (_m, c2) => {
      const text = c2.messages[0].content[0].text;
      if (phase === 0) { await sleep(200); return { content: [{ type: 'text', text: '标签：第一次结果\n做了：A\n接下来：B' }] }; }
      return { content: [{ type: 'text', text: text.includes('任务二') ? '标签：第二次结果\n做了：C\n接下来：D' : '标签：材料丢失了\n做了：X\n接下来：Y' }] };
    },
  });
  await env.h.message_end({ message: { role: 'user', content: [{ type: 'text', text: '任务一' }] } }, env.ctx);
  await env.h.agent_settled({}, env.ctx);
  await sleep(80); // 防抖 50ms → call#1 飞着（200ms）
  phase = 1;
  await env.h.message_end({ message: { role: 'user', content: [{ type: 'text', text: '任务二改需求了' }] } }, env.ctx);
  await env.h['cmd:tabtitle']('', env.ctx); // 强刷意图
  await sleep(600);
  const rec = storeOf('sess-t1');
  check('T1 强刷意图+新材料都不丢（label=第二次结果, calls=2）',
    rec.label === '第二次结果' && env.calls() === 2,
    `label=${rec.label} calls=${env.calls()}`);
}

// ========== T2: 调用进行中敲 /recap → 回调必达，面板必须亮 ==========
{
  const env = await makeEnv({
    sessId: 'sess-t2',
    completeImpl: async () => { await sleep(150); return { content: [{ type: 'text', text: '标签：X\n做了：Y\n接下来：Z' }] }; },
  });
  await env.h.message_end({ message: { role: 'user', content: [{ type: 'text', text: '任务' }] } }, env.ctx);
  await env.h.agent_settled({}, env.ctx);
  await sleep(80); // call 飞着
  await env.h['cmd:recap']('', ctxOf(env)); // 回调入队
  await sleep(400);
  const panelShown = env.widgets.some(([k, v]) => k === 'recap' && Array.isArray(v));
  check('T2 /recap 回调不丢（面板必须亮出）', panelShown, `widgets=${env.widgets.length}`);
}

// ========== T3: complete() 永不返回 → 看门狗兜住，且不永久卡死 ==========
{
  const env = await makeEnv({
    sessId: 'sess-t3',
    completeImpl: () => new Promise(() => {}), // 永不 settle
  });
  await env.h.message_end({ message: { role: 'user', content: [{ type: 'text', text: '任务三' }] } }, env.ctx);
  await env.h.agent_settled({}, env.ctx);
  await sleep(1200); // > 看门狗 800ms：fallback 应已落盘
  const first = storeOf('sess-t3');
  // 再来一轮：必须还能继续（summarizing 没被永久卡死）
  await env.h.message_end({ message: { role: 'user', content: [{ type: 'text', text: '任务三B继续干' }] } }, env.ctx);
  await env.h['cmd:tabtitle']('', env.ctx);
  await sleep(1200);
  const second = storeOf('sess-t3');
  check('T3 挂死被看门狗兜住且不卡死（fallback 两轮都落盘）',
    !!first.label && second.label.includes('任务三B') && env.calls() === 2,
    `first=${first.label} second=${second.label} calls=${env.calls()}`);
}

// ========== T4: 无新材料时反复敲 /recap → 零调用（不烧 token） ==========
{
  const env = await makeEnv({
    sessId: 'sess-t4',
    completeImpl: async () => ({ content: [{ type: 'text', text: '标签：Q\n做了：W\n接下来：E' }] }),
  });
  await env.h.message_end({ message: { role: 'user', content: [{ type: 'text', text: '任务四' }] } }, env.ctx);
  await env.h.agent_settled({}, env.ctx);
  await sleep(300); // 自动刷新完成（1 次调用）
  await env.h['cmd:recap']('', env.ctx);
  await env.h['cmd:recap']('', env.ctx);
  await sleep(100);
  const panelShown = env.widgets.filter(([k, v]) => k === 'recap' && Array.isArray(v)).length >= 1;
  check('T4 无新材料反复 /recap = 1 次调用 + 面板照常',
    env.calls() === 1 && panelShown, `calls=${env.calls()} panel=${panelShown}`);
}

function ctxOf(env) { return env.ctx; }
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
