/**
 * 校验人机验证事件的日志文案格式（防止改动后丢失留痕）。
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const noop = () => {};
const asyncNoop = async () => {};

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, Number, String, Array, Object, Map, Set,
  URLSearchParams, AbortController,
  fetch: async () => ({ ok: true, json: async () => ({ code: 0 }) }),
  chrome: {
    runtime: {
      onInstalled: { addListener: noop }, onStartup: { addListener: noop },
      onMessage: { addListener: noop }, getURL: (p) => p,
      getManifest: () => ({ version: '0.0.0' }),
      getPlatformInfo: (cb) => cb && cb({}), lastError: null
    },
    alarms: { onAlarm: { addListener: noop }, get: asyncNoop, create: noop, clear: asyncNoop },
    storage: { local: { get: async () => ({}), set: asyncNoop }, onChanged: { addListener: noop } },
    declarativeNetRequest: { updateSessionRules: asyncNoop, getSessionRules: async () => [] },
    notifications: { create: noop },
    tabs: {
      create: asyncNoop, get: asyncNoop, update: asyncNoop, remove: asyncNoop,
      onRemoved: { addListener: noop }
    },
    scripting: { executeScript: asyncNoop },
    cookies: { getAll: async () => [] },
    windows: { update: asyncNoop },
    debugger: { attach: asyncNoop, detach: asyncNoop, sendCommand: asyncNoop }
  }
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'background.js' });

const { turnstileSummary, tsNote } = sandbox;
if (typeof turnstileSummary !== 'function' || typeof tsNote !== 'function') {
  console.error('❌ 未能取到 turnstileSummary / tsNote');
  process.exit(1);
}

const cases = [
  ['无事件 → 空串（静默通过不留噪音）', [], ''],
  ['自动点击并成功', ['已自动点击验证框（input[type=checkbox]）', '自动点击后取得令牌'],
    '⚙ 已自动点击验证框（input[type=checkbox]）、自动点击后取得令牌'],
  ['自动点击但无令牌', ['已自动点击验证框（frame-fallback）', '自动点击后 15 秒内仍无令牌'],
    '⚙ 已自动点击验证框（frame-fallback）、自动点击后 15 秒内仍无令牌'],
  ['自动点击关闭转人工', ['自动点击已关闭，已切前台等人工', '人工验证完成'],
    '⚙ 自动点击已关闭，已切前台等人工、人工验证完成'],
  ['点击期间才出现验证框', ['检测到验证框，页面已切前台', '已自动点击验证框（input）', '点击期间取得令牌'],
    '⚙ 检测到验证框，页面已切前台、已自动点击验证框（input）、点击期间取得令牌']
];

let pass = 0;
const rows = [];
for (const [name, events, expected] of cases) {
  const actual = turnstileSummary(events);
  const ok = actual === expected;
  if (ok) pass++;
  rows.push(`${ok ? '[OK  ]' : '[FAIL]'} ${name}`);
  if (!ok) {
    rows.push(`        期望: ${JSON.stringify(expected)}`);
    rows.push(`        实际: ${JSON.stringify(actual)}`);
  }
}

// 行为校验：tsNote 不能写入非法输入，且必须保持顺序
const ev = [];
tsNote(ev, 'b');
tsNote(ev, 'a');
tsNote(ev, '');
tsNote(null, 'x');
const orderOk = ev.length === 2 && ev[0] === 'b' && ev[1] === 'a';
rows.push(`${orderOk ? '[OK  ]' : '[FAIL]'} tsNote 保序且忽略空值`);
if (orderOk) pass++;

(async () => {
  const execOrig = sandbox.chrome.scripting.executeScript;

  let execCalls = 0;
  sandbox.chrome.scripting.executeScript = async () => {
    execCalls++;
    if (execCalls === 1) {
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    }
    return [{ result: { token: 'TK' } }];
  };
  const gotToken = await sandbox.waitTurnstileToken(1, 1000);
  sandbox.chrome.scripting.executeScript = execOrig;
  const navOk = gotToken === true;
  rows.push(`${navOk ? '[OK  ]' : '[FAIL]'} waitTurnstileToken 忽略导航瞬时错误并继续轮询` +
    (navOk ? '' : `  → calls=${execCalls}`));
  if (navOk) pass++;

  sandbox.chrome.scripting.executeScript = async () => { throw new Error('No tab with id: 999'); };
  const t0 = Date.now();
  const closed = await sandbox.waitTurnstileToken(999, 5000);
  const elapsed = Date.now() - t0;
  sandbox.chrome.scripting.executeScript = execOrig;
  const fatalOk = closed === false && elapsed < 1000;
  rows.push(`${fatalOk ? '[OK  ]' : '[FAIL]'} waitTurnstileToken 标签页关闭时立即退出` +
    (fatalOk ? '' : `  → elapsed=${elapsed}`));
  if (fatalOk) pass++;

  const total = cases.length + 3;
  console.log('=== 人机验证日志文案测试 ===\n');
  rows.forEach((l) => console.log('  ' + l));
  console.log(`\n${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
