/**
 * 校验并发的日志写入不丢条、账号保存不覆盖签到结果。
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const noop = () => {};
const asyncNoop = async () => {};

// ---- 内存存储（带一次可控延迟，放大竞态窗口） ----
let store = {};
const pendingGets = [];
const storage = {
  async get(keys) {
    // 读的时候把当前值复制一份，并让出事件循环 —— 真实 storage 也是这样异步的
    const snapshot = JSON.parse(JSON.stringify(store));
    await new Promise((r) => setTimeout(r, 5));
    if (keys == null) return snapshot;
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach((k) => { if (k in snapshot) out[k] = snapshot[k]; });
    return out;
  },
  async set(patch) {
    await new Promise((r) => setTimeout(r, 1));
    Object.assign(store, JSON.parse(JSON.stringify(patch)));
  },
  async remove(k) { delete store[k]; }
};

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
      getManifest: () => ({ version: '1.1.7' }),
      getPlatformInfo: (cb) => cb && cb({}), lastError: null
    },
    alarms: { onAlarm: { addListener: noop }, get: asyncNoop, create: noop, clear: asyncNoop },
    storage: { local: storage, onChanged: { addListener: noop } },
    declarativeNetRequest: {
      updateSessionRules: asyncNoop,
      getSessionRules: async () => []
    },
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

const rows = [];
let pass = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  rows.push(`${cond ? '[OK  ]' : '[FAIL]'} ${name}${cond ? '' : '  → ' + (extra || '')}`);
}

(async () => {
  // ---- 1. 并发写日志：12 条一条都不能丢 ----
  store = { logs: [] };
  const writes = [];
  for (let i = 0; i < 12; i++) {
    writes.push(sandbox.pushLog({ status: 'info', message: `m${i}` }));
  }
  await Promise.all(writes);
  const logs = store.logs || [];
  const msgs = logs.map((l) => l.message);
  check('并发写 12 条日志全部保留', logs.length === 12, `实际 ${logs.length} 条`);
  check('12 条内容互不重复',
    new Set(msgs).size === 12, msgs.join(','));
  check('最新的排在最前', msgs[0] === 'm11', msgs[0]);

  // ---- 2. 单条写失败不影响后续 ----
  const savedSet = storage.set;
  let failOnce = true;
  storage.set = async (patch) => {
    if (failOnce && patch.logs) { failOnce = false; throw new Error('boom'); }
    return savedSet(patch);
  };
  store = { logs: [] };
  const p1 = sandbox.pushLog({ status: 'info', message: 'x1' }).catch(() => 'err');
  const p2 = sandbox.pushLog({ status: 'info', message: 'x2' });
  await Promise.all([p1, p2]);
  storage.set = savedSet;
  check('一次写失败后后续仍能写入', (store.logs || []).length >= 1,
    `实际 ${(store.logs || []).length} 条`);

  // ---- 3. saveState 合并不覆盖较新的 last / snapshot ----
  // 直接调用消息处理器
  let listener = null;
  // 重新加载，捕获 onMessage 监听器
  const sandbox2 = { ...sandbox };
  sandbox2.chrome = JSON.parse(JSON.stringify({})) && {
    ...sandbox.chrome,
    runtime: {
      ...sandbox.chrome.runtime,
      onMessage: { addListener: (fn) => { listener = fn; } }
    }
  };
  vm.createContext(sandbox2);
  vm.runInContext(code, sandbox2, { filename: 'background.js' });

  const storedAccount = {
    id: 'acc_1', name: '旧名字', siteId: 'glados-cloud', cookie: 'c=1',
    last: { date: '2026-11-23', at: 2000, status: 'success', points: 100 },
    snapshot: { email: 'a@b.c', at: 2000, points: 500, leftDays: 30 },
    createdAt: 1000
  };
  store = { accounts: [storedAccount] };

  // 设置页提交的是它打开时读到的旧快照（at 更早），但改了名字
  const staleFromUi = [{
    id: 'acc_1', name: '新名字', siteId: 'glados-cloud', cookie: 'c=1',
    last: { date: '2026-11-22', at: 1000, status: 'fail', points: 0 },
    snapshot: { email: 'a@b.c', at: 1000, points: 400, leftDays: 31 },
    createdAt: 1000
  }];

  const resp = await new Promise((resolve) => {
    listener({ type: 'saveState', patch: { accounts: staleFromUi } }, {}, resolve);
  });
  check('saveState 返回成功', resp && resp.ok === true, JSON.stringify(resp));

  const saved = (store.accounts || [])[0] || {};
  check('保存时保留较新的 last（签到结果不丢）',
    saved.last && saved.last.at === 2000 && saved.last.status === 'success',
    JSON.stringify(saved.last));
  check('保存时保留较新的 snapshot',
    saved.snapshot && saved.snapshot.at === 2000 && saved.snapshot.points === 500,
    JSON.stringify(saved.snapshot));
  check('用户改动的字段生效（name）', saved.name === '新名字', saved.name);

  // ---- 4. UI 携带更新的数据时以 UI 为准 ----
  store = { accounts: [storedAccount] };
  const freshFromUi = [{
    id: 'acc_1', name: '旧名字', siteId: 'glados-cloud', cookie: 'c=1',
    last: { date: '2026-11-23', at: 5000, status: 'repeat', points: 0 },
    snapshot: { email: 'a@b.c', at: 5000, points: 600, leftDays: 29 },
    createdAt: 1000
  }];
  await new Promise((resolve) => {
    listener({ type: 'saveState', patch: { accounts: freshFromUi } }, {}, resolve);
  });
  const saved2 = (store.accounts || [])[0] || {};
  check('UI 数据更新时以 UI 为准', saved2.last && saved2.last.at === 5000,
    JSON.stringify(saved2.last));

  // ---- 5. 新增/删除账号仍正常工作 ----
  store = { accounts: [storedAccount] };
  await new Promise((resolve) => {
    listener({ type: 'saveState', patch: { accounts: [] } }, {}, resolve);
  });
  check('删除账号（提交空数组）生效', (store.accounts || []).length === 0,
    `剩余 ${(store.accounts || []).length}`);

  // ---- 6. 并发 updateAccount：读-改-写整体入队，字段不丢 ----
  store = { accounts: [{ id: 'acc_c', name: '并发' }] };
  const ups = [];
  for (let i = 1; i <= 8; i++) {
    ups.push(sandbox2.updateAccount('acc_c', { [`f${i}`]: i }));
  }
  await Promise.all(ups);
  const ca = (store.accounts || [])[0] || {};
  let allKept = true;
  for (let i = 1; i <= 8; i++) if (ca[`f${i}`] !== i) allKept = false;
  check('并发 8 次 updateAccount 更新全部保留', allKept, JSON.stringify(ca));

  // ---- 7. 签到写 last 与设置页保存交错，签到结果不被覆盖 ----
  store = {
    accounts: [{
      id: 'acc_r', name: '原名',
      last: { date: '2026-11-22', at: 1000, status: 'fail', points: 0 }
    }]
  };
  const staleUi = [{
    id: 'acc_r', name: '改名',
    last: { date: '2026-11-22', at: 1000, status: 'fail', points: 0 }
  }];
  const signIn = sandbox2.updateAccount('acc_r', {
    last: { date: '2026-11-23', at: 5000, status: 'success', points: 42 }
  });
  const uiSave = new Promise((resolve) => {
    listener({ type: 'saveState', patch: { accounts: staleUi } }, {}, resolve);
  });
  await Promise.all([signIn, uiSave]);
  const ra = (store.accounts || [])[0] || {};
  check('签到写 last 与设置页保存交错后签到结果不丢',
    ra.last && ra.last.at === 5000 && ra.last.status === 'success' && ra.name === '改名',
    JSON.stringify(ra));

  console.log('=== 存储竞态测试 ===\n');
  rows.forEach((l) => console.log('  ' + l));
  console.log(`\n${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
