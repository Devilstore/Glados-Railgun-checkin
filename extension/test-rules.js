/**
 * 校验 DNR 规则 ID 分配与保留标签页的生命周期。
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const noop = () => {};
const asyncNoop = async () => {};

// ---- 记录 chrome API 调用 ----
const calls = {
  addedRules: [],
  ruleObjects: [],
  removedRules: [],
  removedTabs: []
};

let onRemovedHandler = null;

const sessionStore = {};
const sessionStorage = {
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach((k) => { if (k in sessionStore) out[k] = JSON.parse(JSON.stringify(sessionStore[k])); });
    return out;
  },
  async set(patch) { Object.assign(sessionStore, JSON.parse(JSON.stringify(patch))); }
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
      getManifest: () => ({ version: '0.0.0' }),
      getPlatformInfo: (cb) => cb && cb({}), lastError: null
    },
    alarms: { onAlarm: { addListener: noop }, get: asyncNoop, create: noop, clear: asyncNoop },
    storage: {
      local: { get: async () => ({}), set: asyncNoop },
      session: sessionStorage,
      onChanged: { addListener: noop }
    },
    declarativeNetRequest: {
      updateSessionRules: async ({ removeRuleIds, addRules }) => {
        (removeRuleIds || []).forEach((id) => calls.removedRules.push(id));
        (addRules || []).forEach((r) => {
          calls.addedRules.push(r.id);
          calls.ruleObjects.push(r);
        });
      },
      getSessionRules: async () => []
    },
    notifications: { create: noop },
    tabs: {
      create: asyncNoop, get: asyncNoop, update: asyncNoop,
      remove: async (id) => calls.removedTabs.push(id),
      onRemoved: { addListener: (fn) => { onRemovedHandler = fn; } }
    },
    scripting: { executeScript: asyncNoop },
    cookies: { getAll: async () => [] },
    windows: { update: asyncNoop },
    debugger: { attach: asyncNoop, detach: asyncNoop, sendCommand: asyncNoop }
  }
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'background.js' });

const { nextRuleId, releaseRuleId, addTabScopedRule, removeRule, closeSessionTab } = sandbox;
if (!nextRuleId || !releaseRuleId) {
  console.error('❌ 未能取到 nextRuleId / releaseRuleId');
  process.exit(1);
}

const rows = [];
let pass = 0;
const total = 23;
function check(name, cond, extra) {
  if (cond) pass++;
  rows.push(`${cond ? '[OK  ]' : '[FAIL]'} ${name}${cond || !extra ? '' : '  → ' + extra}`);
}

(async () => {
  // 1) 连续分配 500 个 ID 必须唯一
  const ids = [];
  for (let i = 0; i < 500; i++) ids.push(nextRuleId());
  check('分配 500 个规则 ID 全部唯一', new Set(ids).size === 500,
    `unique=${new Set(ids).size}`);
  check('规则 ID 均大于基准值', ids.every((id) => id > 700000));

  // 2) 释放后可复用
  const freed = ids[0];
  releaseRuleId(freed);
  const reuse = nextRuleId();
  check('释放的 ID 会被复用（不会无限增长）', reuse === freed, `got=${reuse}, freed=${freed}`);

  // 3) 模拟旧算法的撞号场景：不同 tabId 但相同 id 不应再出现
  const account = { id: 'acc_a', cookie: 'koa:sess=x; koa:sess.sig=y' };
  const site = { domain: 'glados.cloud', checkinPath: '/console/checkin' };
  calls.addedRules.length = 0;
  const a1 = await addTabScopedRule(101, account, site);
  const a2 = await addTabScopedRule(102, account, site);
  check('两个标签页同时挂规则时 ID 不同', a1 !== a2, `${a1} vs ${a2}`);
  check('两条规则都成功写入', calls.addedRules.length === 2);

  // 4) session 模式不建规则
  const sessionRule = await addTabScopedRule(103, { id: 'acc_s', cookie: '' }, site);
  check('session 模式不创建 DNR 规则', sessionRule === null);

  // 5) 保留标签页：不移除规则、不关闭标签页
  calls.removedRules.length = 0;
  calls.removedTabs.length = 0;
  await closeSessionTab(201, a1, true, account.id);
  check('保留标签页时不移除 DNR 规则', !calls.removedRules.includes(a1),
    `removed=${JSON.stringify(calls.removedRules)}`);
  check('保留标签页时不关闭标签页', !calls.removedTabs.includes(201));

  // 6) 标签页被关闭后规则自动清理
  calls.removedRules.length = 0;
  check('已注册 tabs.onRemoved 监听', typeof onRemovedHandler === 'function');
  if (typeof onRemovedHandler === 'function') {
    onRemovedHandler(201);
    // removeRule 是异步的，给它一个 tick
    await new Promise((r) => setTimeout(r, 30));
    check('标签页关闭后自动移除其 DNR 规则', calls.removedRules.includes(a1),
      `removed=${JSON.stringify(calls.removedRules)}`);
  }

  // 7) 规则必须限定域名，否则 Cookie 会被塞进第三方请求
  const r0 = calls.ruleObjects[0];
  check('规则带 urlFilter', !!(r0 && r0.condition && r0.condition.urlFilter),
    JSON.stringify(r0 && r0.condition));

  /**
   * 模拟 DNR urlFilter 的 || 前缀语义：匹配域名本身及其子域，
   * 但要求命中点位于主机名开头或 . 之后。
   */
  const matchAnchor = (filter, url) => {
    if (!filter.startsWith('||')) return false;
    const host = String(url).replace(/^https?:\/\//, '').split(/[/?#]/)[0].toLowerCase();
    const d = filter.slice(2).toLowerCase();
    return host === d || host.endsWith('.' + d);
  };

  const dom = 'glados.cloud';
  check('匹配本站签到页', matchAnchor('||' + dom, `https://${dom}/console/checkin`));
  check('匹配本站 API', matchAnchor('||' + dom, `https://${dom}/api/user/checkin`));
  check('匹配子域', matchAnchor('||' + dom, `https://api.${dom}/api/user/status`));
  check('不匹配第三方 CDN',
    !matchAnchor('||' + dom, 'https://cdn.jsdelivr.net/npm/vue.js'));
  check('不匹配字体站',
    !matchAnchor('||' + dom, 'https://fonts.gstatic.com/s/x.woff2'));
  check('不匹配仿冒域名',
    !matchAnchor('||' + dom, 'https://notglados.cloud.evil.com/'));

  if (r0 && r0.condition) {
    check('实际规则的 urlFilter 指向该站点',
      r0.condition.urlFilter === '||' + site.domain,
      String(r0.condition.urlFilter));
  }

  // 8) 保留标签页写入 session storage
  await closeSessionTab(301, a2, true, account.id);
  const snap = () => (sessionStore.gcd_kept_tabs || []).map((x) => x.tabId);
  check('保留标签页写入 session storage', snap().includes(301), JSON.stringify(snap()));

  // 9) onRemoved 同步更新 session
  onRemovedHandler(301);
  await new Promise((r) => setTimeout(r, 30));
  check('标签页关闭后 session 记录同步移除', !snap().includes(301), JSON.stringify(snap()));

  // 10) 启动清理：恢复 session 记录并关闭残留标签页与规则
  sessionStore.gcd_kept_tabs = [{ tabId: 401, accountId: account.id, ruleId: a1 }];
  calls.removedTabs.length = 0;
  calls.removedRules.length = 0;
  await sandbox.cleanupKeptTabsOnStartup();
  check('启动清理关闭 session 中的残留标签页', calls.removedTabs.includes(401),
    JSON.stringify(calls.removedTabs));
  check('启动清理移除残留 DNR 规则', calls.removedRules.includes(a1),
    JSON.stringify(calls.removedRules));
  check('启动清理后 session 记录清空', snap().length === 0, JSON.stringify(snap()));

  console.log('=== 规则 ID 与保留标签页测试 ===\n');
  rows.forEach((l) => console.log('  ' + l));
  console.log(`\n${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
