/**
 * test-classify.js —— 用 Node 加载 background.js 并测试 classifyResult
 * 运行：node test-classify.js
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
  URLSearchParams,
  chrome: {
    runtime: {
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      onMessage: { addListener: noop },
      getURL: (p) => p,
      lastError: null
    },
    alarms: {
      onAlarm: { addListener: noop },
      get: asyncNoop,
      create: noop,
      clear: asyncNoop
    },
    storage: {
      local: { get: async () => ({}), set: asyncNoop },
      onChanged: { addListener: noop }
    },
    declarativeNetRequest: {
      updateSessionRules: asyncNoop,
      getSessionRules: async () => [],
      sessionRules: {}
    },
    notifications: { create: noop },
    tabs: {
      create: asyncNoop, get: asyncNoop, update: asyncNoop, remove: asyncNoop,
      onRemoved: { addListener: noop }
    },
    scripting: { executeScript: asyncNoop },
    cookies: { getAll: async () => [] }
  }
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'background.js' });

const classify = sandbox.classifyResult;
if (typeof classify !== 'function') {
  console.error('❌ 未能从 background.js 取到 classifyResult');
  process.exit(1);
}

const cases = [
  // [名称, 输入, 期望 status, 期望 points]
  ['新站成功 code=0 repeated=false',
    { code: 0, points: 10, repeated: false, message: 'Checkin! Got 10 Points' }, 'success', 10],
  ['新站重复 code=1 repeated=true',
    { code: 1, points: 0, repeated: true, message: "Today's observation logged. Return tomorrow for more points." }, 'repeat', 0],
  ['设备不匹配 code=4',
    { code: 4, reason: 'device-mismatch', points: 0, loginDevice: 'Windows', currentDevice: 'macos', message: 'Automated check-in detected.' }, 'device', 0],
  ['Turnstile 拦截 code=5',
    { code: 5, reason: 'turnstile', message: 'Cloudflare verification failed. Nothing was recorded — please retry.' }, 'turnstile', 0],
  ['仅 message 含 Cloudflare',
    { code: 0, message: 'Cloudflare verification failed' }, 'turnstile', 0],
  ['旧站成功 code=0 points=2',
    { code: 0, points: 2, message: 'Checkin! Got 2 Points (Free account)' }, 'success', 2],
  ['旧站重复 code=1',
    { code: 1, message: 'Already checked in today. Come back tomorrow.' }, 'repeat', 0],
  ['无 code 但 checkedIn=true',
    { today: '2026-11-15', checkedIn: true, checkedDates: ['2026-11-15'] }, 'repeat', 0],
  ['points 为字符串',
    { code: 0, points: '5.00000000', message: 'ok' }, 'success', 5],
  ['code 为字符串 "0"',
    { code: '0', points: 5, message: 'ok' }, 'success', 5],
  ['observation logged 但 code=0 有积分',
    { code: 0, points: 10, message: "Today's observation logged. Return tomorrow for more points." }, 'success', 10],
  ['earned 为数字',
    { code: 0, earned: 3, message: 'ok' }, 'success', 3],
  ['earned 为字典（不应崩）',
    { code: 0, earned: { '2026-11-15': 1 }, message: 'ok' }, 'success', 0],
  ['矛盾 code=0 + repeated=true',
    { code: 0, repeated: true, points: 0, message: 'x' }, 'repeat', 0],
  ['未知响应',
    { code: 99, message: 'something odd' }, 'fail', 0],
  ['空对象',
    {}, 'fail', 0],
  // ---- 无服务端响应（本次修复的重点：绝不能默认成功）----
  ['无响应 + 空文案',
    null, '', 'fail', 0],
  ['无响应 + 按钮显示已签到',
    null, '已签到', 'repeat', 0],
  ['无响应 + 英文已签',
    null, 'Already checked in today', 'repeat', 0],
  ['无响应 + 按钮显示 Checked',
    null, 'Checked', 'repeat', 0],
  ['无响应 + 按钮显示签到',
    null, '签到', 'fail', 0]
];

let pass = 0;
const rows = [];
for (const row of cases) {
  // 兼容 4 元组 [name, input, expStatus, expPoints]
  // 与 5 元组 [name, input, fallbackText, expStatus, expPoints]
  const [name, input] = row;
  const rest = row.slice(2);
  const expPoints = rest.pop();
  const expStatus = rest.pop();
  const fallback = rest.length ? rest[0] : '';

  let r;
  try {
    r = classify(input, fallback);
  } catch (e) {
    rows.push(`[FAIL] ${name} -> 抛异常 ${e.message}`);
    continue;
  }
  const ok = r.status === expStatus && r.points === expPoints;
  if (ok) pass++;
  rows.push(
    `${ok ? '[OK  ]' : '[FAIL]'} ${String(name).padEnd(32)} -> ${String(r.status).padEnd(10)} points=${r.points}` +
    (ok ? '' : `   期望 ${expStatus}/${expPoints}，实际 message=${JSON.stringify(r.message)}`)
  );
}

console.log('=== classifyResult 测试 ===\n');
rows.forEach((l) => console.log('  ' + l));
console.log(`\n${pass}/${cases.length} 通过`);

process.exit(pass === cases.length ? 0 : 1);
