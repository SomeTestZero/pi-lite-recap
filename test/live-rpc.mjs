// 真机联调：通过 pi --mode rpc 跑一轮极小对话，观察真实总结调用是否工作、是否只发一次
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const STORE = os.homedir() + '/.pi/agent/tab-title-summaries.json';
const readStore = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } };
const before = readStore();

process.env.PI_RECAP_DEBOUNCE_MS = '500';
const workdir = os.tmpdir() + '/pi-recap-live';
fs.mkdirSync(workdir, { recursive: true });
const cliPath = 'C:/Users/yyp/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
const child = spawn(process.execPath, [cliPath, '--mode', 'rpc', '--model', 'xiaomi-token-plan-cn/mimo-v2.6-flash'], {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const uiRequests = [];
let settledAt = 0;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'extension_ui_request') {
      uiRequests.push(ev.method === 'setTitle' ? `setTitle: ${ev.title}` : `${ev.method}: ${JSON.stringify(ev.widgetLines ?? ev.statusText ?? ev.message ?? null)}`);
      console.log('[ui]', ev.method, ev.title ?? JSON.stringify(ev.widgetLines ?? ev.message ?? ''));
    } else if (ev.type === 'agent_settled') {
      settledAt = Date.now();
      console.log('[event] agent_settled');
    } else if (ev.type === 'extension_error') {
      console.log('[EXT-ERROR]', JSON.stringify(ev));
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));

child.stdin.write(JSON.stringify({ id: 'r1', type: 'prompt', message: '只回复ok，不要做任何别的事' }) + '\n');

// 等 settle 后再留 8s（防抖 0.5s + 真实模型调用），观察是否恰好一次小结
setTimeout(() => {
  const after = readStore();
  const fresh = Object.entries(after).filter(([k]) => !before[k]);
  console.log('\n===== 结果 =====');
  console.log('settle 距启动:', settledAt ? '已触发' : '未触发');
  console.log('新增 store 记录数:', fresh.length);
  for (const [k, v] of fresh) console.log(' ', k, JSON.stringify(v));
  console.log('setTitle 次数:', uiRequests.filter((x) => x.startsWith('setTitle')).length);
  for (const u of uiRequests) console.log('  ', u);
  child.kill();
  process.exit(fresh.length === 1 ? 0 : 1);
}, 45000);
