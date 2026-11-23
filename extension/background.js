/**
 * background.js —— GLaDOS 自动签到（MV3 Service Worker）
 * session 模式复用浏览器会话；cookie 模式通过 DNR 仅注入临时标签页。
 */

'use strict';

// ---- 常量与默认配置 ----

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webtransport', 'webbundle', 'other'
];

const RULE_ID_BASE = 700000;
const LOG_LIMIT = 300;

const EXT_VERSION = '1.1.7';


const DEFAULT_SITES = [
  {
    id: 'glados-cloud', name: 'GLaDOS Cloud', domain: 'glados.cloud',
    checkinPath: '/console/checkin', mode: 'browser', enabled: true,
    note: '新站，含 Cloudflare 人机验证'
  },
  {
    id: 'glados-network', name: 'GLaDOS Network', domain: 'glados.network',
    checkinPath: '/console/checkin', mode: 'browser', enabled: false,
    note: '新站备用域名'
  },
  {
    id: 'glados-rocks', name: 'GLaDOS Rocks', domain: 'glados.rocks',
    checkinPath: '/console/checkin', mode: 'browser', enabled: false,
    note: '新站备用域名'
  },
  {
    id: 'glados-one', name: 'GLaDOS One', domain: 'glados.one',
    checkinPath: '/console/checkin', mode: 'browser', enabled: false,
    note: '新站备用域名'
  },
  {
    id: 'glados-space', name: 'GLaDOS Space', domain: 'glados.space',
    checkinPath: '/console/checkin', mode: 'browser', enabled: false,
    note: '新站备用域名'
  },
  {
    id: 'glados-vip', name: 'GLaDOS VIP', domain: 'glados.vip',
    checkinPath: '/console/checkin', mode: 'browser', enabled: false,
    note: '新站备用域名'
  },
  {
    id: 'glados-facility', name: 'GLaDOS Facility', domain: 'glados-facility.com',
    checkinPath: '/console/checkin', mode: 'browser', enabled: false,
    note: '新站备用域名'
  },
  {
    id: 'railgun', name: 'Railgun', domain: 'railgun.info',
    checkinPath: '/console/checkin', mode: 'api', enabled: false,
    note: '旧站，无挑战接口，可直接调用 API'
  }
];

const MAX_AUTO_RETRIES = 3;
const RETRY_BACKOFF_MS = [
  30 * 60 * 1000,   // 第 1 次自动重试：30 分钟
  2 * 60 * 60 * 1000, // 第 2 次：2 小时
  2 * 60 * 60 * 1000  // 第 3 次：2 小时；再失败则暂停到明天
];

const DEFAULT_SETTINGS = {
  targetHour: 9,          // 每天目标小时（0-23）
  maxDelayMinutes: 45,    // 目标小时内随机延迟上限（分钟）
  notifyEnabled: true,    // 桌面通知
  autoClickTurnstile: false, // 自动点击 Cloudflare 验证框（实验性）
  humanVerify: true,      // 被 Cloudflare 拒绝后切前台等人工验证，通过后自动重试
  keepTabOnVerify: true,  // 人工验证未完成时保留签到标签页
  foregroundOnManual: true, // 单账号「测试签到」时把签到页切到前台
  updateCheckEnabled: true, // 打开设置页时检查 GitHub Release
  skipIfDone: true,       // 今日已签则跳过
  pushdeerKey: '',        // PushDeer SendKey
  serverchanKey: '',      // ServerChan SendKey
  minStayMs: 4500,        // 页面停留下限
  maxStayMs: 6500         // 页面停留上限
};

const ALARM_TICK = 'gcd_tick';
const ALARM_DELAY = 'gcd_random_delay';
const DELAY_PLAN = 'gcd_delay_plan';

// ---- Service Worker 保活 ----

let keepAliveTimer = null;
let keepAliveRefs = 0;
let keepAlivePort = null;

function acquireKeepAlive() {
  keepAliveRefs++;
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    } catch (e) { /* ignore */ }
  }, 10000);
  try {
    if (chrome.runtime.connect) {
      keepAlivePort = chrome.runtime.connect({ name: 'gcd-keepalive' });
      keepAlivePort.onDisconnect.addListener(() => { keepAlivePort = null; });
    }
  } catch (e) { /* ignore */ }
}

function releaseKeepAlive() {
  keepAliveRefs = Math.max(0, keepAliveRefs - 1);
  if (keepAliveRefs > 0) return;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (keepAlivePort) {
    try { keepAlivePort.disconnect(); } catch (e) { /* ignore */ }
    keepAlivePort = null;
  }
}

// 自连接对端：连接保持期间 SW 不会被回收
if (chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener(() => {});
}


// ---- 存储层 ----

/**
 * 补上缺少的内置站点，保留已有站点的启用状态。
 */
function mergeDefaultSites(sites) {
  const list = Array.isArray(sites)
    ? sites.map((s) => Object.assign({}, s))
    : [];

  for (const def of DEFAULT_SITES) {
    const i = list.findIndex((s) => s.domain === def.domain);
    if (i < 0) {
      list.push(Object.assign({}, def));
      continue;
    }
    const current = list[i];
    if (!current.id) current.id = def.id;
    if (!current.checkinPath) current.checkinPath = def.checkinPath;
    if (!current.mode) current.mode = def.mode;
  }
  return list;
}

async function getState() {
  const raw = await chrome.storage.local.get(['accounts', 'sites', 'settings', 'logs']);
  const sites = mergeDefaultSites(raw.sites);
  return {
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    sites,
    settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
    logs: Array.isArray(raw.logs) ? raw.logs : []
  };
}

async function saveState(patch) {
  await chrome.storage.local.set(patch);
}

function todayStr(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function fmtTime(ts) {
  const t = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
         `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let logChain = Promise.resolve();

function pushLog(entry) {
  const run = async () => {
    const { logs } = await chrome.storage.local.get('logs');
    const list = Array.isArray(logs) ? logs : [];
    list.unshift(Object.assign({ at: Date.now(), time: fmtTime(Date.now()) }, entry));
    if (list.length > LOG_LIMIT) list.length = LOG_LIMIT;
    await chrome.storage.local.set({ logs: list });
  };
  const next = logChain.then(run);
  logChain = next.catch(() => {});
  return next;
}

let accountChain = Promise.resolve();

function withAccountLock(fn) {
  const next = accountChain.then(fn);
  accountChain = next.catch(() => {});
  return next;
}

// ---- 账号状态更新 ----

function retryStatePatch(account, result) {
  const today = todayStr();
  if (result.status === 'success' || result.status === 'repeat') {
    return { retryCount: 0, nextRetryAt: null, retryExhausted: false };
  }

  // 手动“立即签到”不计入自动重试次数，也不改变已有退避计划。
  if (result.trigger !== 'auto') return {};

  const sameDay = account.last && account.last.date === today;
  const prev = sameDay ? Math.max(0, Number(account.last.retryCount) || 0) : 0;
  if ((sameDay && account.last.retryExhausted) || prev >= MAX_AUTO_RETRIES) {
    return { retryCount: MAX_AUTO_RETRIES, nextRetryAt: null, retryExhausted: true };
  }

  const retryCount = prev + 1;
  return {
    retryCount,
    nextRetryAt: Date.now() + RETRY_BACKOFF_MS[retryCount - 1],
    retryExhausted: false
  };
}

async function updateAccount(accountId, patch) {
  return withAccountLock(async () => {
    const raw = await chrome.storage.local.get('accounts');
    const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) return null;
    accounts[idx] = Object.assign({}, accounts[idx], patch);
    await chrome.storage.local.set({ accounts });
    return accounts[idx];
  });
}

// ---- 账号认证方式 ----

/** 有 Cookie 走请求头注入，否则复用浏览器登录态。 */
function authModeOf(acc) {
  if (!acc) return 'session';
  if (!acc.cookie) return 'session';
  return 'cookie';
}

// ---- declarativeNetRequest：把指定账号的 Cookie / UA 注入到单个标签页 ----

// 规则 id 必须唯一：撞号时 updateSessionRules 会顺带删掉对方规则。
const usedRuleIds = new Set();
let ruleIdSyncPromise = null;

/** SW 重启后内存集合为空，首次分配前与现存 session 规则同步。 */
function ensureRuleIdSync() {
  if (!ruleIdSyncPromise) {
    ruleIdSyncPromise = (async () => {
      try {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        (rules || []).forEach((r) => usedRuleIds.add(r.id));
      } catch (e) { /* 读取失败就按空集合处理 */ }
    })();
  }
  return ruleIdSyncPromise;
}

function nextRuleId() {
  for (let id = RULE_ID_BASE + 1; id <= RULE_ID_BASE + 20000; id++) {
    if (!usedRuleIds.has(id)) {
      usedRuleIds.add(id);
      return id;
    }
  }
  // 极端情况：ID 用尽，退回一个肯定会冲突的范围外值
  return RULE_ID_BASE + 20001;
}

function releaseRuleId(ruleId) {
  if (ruleId) usedRuleIds.delete(ruleId);
}

/**
 * 仅 cookie 模式建规则。未填 UA 时不覆盖，保持真实指纹（避免「设备不一致」）。
 */
async function addTabScopedRule(tabId, account, site) {
  if (!account.cookie) return null;

  const headers = [];

  if (account.cookie) {
    headers.push({ header: 'Cookie', operation: 'set', value: account.cookie });
  }
  const ua = (account.userAgent || '').trim();
  if (ua) {
    headers.push({ header: 'User-Agent', operation: 'set', value: ua });
  }

  if (!headers.length) return null;

  await ensureRuleIdSync();
  const ruleId = nextRuleId();
  const rule = {
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: headers.concat([{
        header: 'Referer',
        operation: 'set',
        value: `https://${site.domain}${site.checkinPath}`
      }])
    },
    condition: {
      tabIds: [tabId],
      urlFilter: `||${site.domain}`,
      resourceTypes: ALL_RESOURCE_TYPES
    }
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [rule]
  });

  return ruleId;
}

async function removeRule(ruleId) {
  if (!ruleId) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch (e) {
    // 规则可能已被清理，忽略
  } finally {
    releaseRuleId(ruleId);
  }
}

async function clearAllSessionRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    if (rules.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules.map((r) => r.id)
      });
      rules.forEach((r) => releaseRuleId(r.id));
    }
  } catch (e) { /* ignore */ }
}

// ---- 页面内执行体（在目标页面的 MAIN world 中运行，不能引用外部变量） ----

/**
 * 在页面主世界查找并点击签到按钮，然后等待官网自己发出的签到响应。
 * 返回值必须可序列化，并带足够诊断信息，便于定位失败原因。
 */
async function clickCheckinInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 被重定向到登录页
  if (/\/login|\/authenticate|\/signin/i.test(location.pathname)) {
    return { ok: false, reason: 'not-logged-in', path: location.pathname };
  }

  const btnText = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
  // disabled 只代表暂时不可用，不等于已签到；完成态只认 is-done。
  const isDone = (el) =>
    !!el && !!(el.classList && el.classList.contains('is-done'));
  const DONE_TEXT = /已签到|已簽到|\balready\b|\bchecked\b|\bsigned\b|明日|tomorrow/i;

  const findButton = () => {
    let b = document.querySelector('button.ckb');
    if (b) return b;
    const btns = Array.prototype.slice.call(document.querySelectorAll('button'));
    return (
      btns.find((x) => /check\s*-?\s*in/i.test(x.textContent || '')) ||
      btns.find((x) => /签到|簽到/i.test(x.textContent || '')) ||
      null
    );
  };

  let btn = findButton();
  for (let i = 0; i < 24 && !btn; i++) {
    await sleep(500);
    btn = findButton();
  }

  if (!btn) return { ok: false, reason: 'button-not-found' };

  // 按钮可能只是还没启用（页面仍在渲染）：文案不像完成态时，再等最多 3 秒
  if (isDone(btn) && !DONE_TEXT.test(btnText(btn))) {
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      const again = findButton();
      if (!again) continue;
      btn = again;
      if (!isDone(again)) break;
    }
  }

  // 禁用态点击无效，随后会白等 100 秒，先等它可用。
  if (btn.disabled === true && !isDone(btn) && !DONE_TEXT.test(btnText(btn))) {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const again = findButton();
      if (again) btn = again;
      if (btn && btn.disabled !== true) break;
    }
    // 等了 10 秒还是禁用（且不像已签到）→ 直接报出来，不再空等
    if (btn && btn.disabled === true && !isDone(btn) && !DONE_TEXT.test(btnText(btn))) {
      return {
        ok: false,
        reason: 'button-disabled',
        text: btnText(btn),
        className: String(btn.className || '')
      };
    }
  }

  const before = {
    text: btnText(btn),
    disabled: btn.disabled === true,
    className: String(btn.className || ''),
    captures: (window.__gcdResults || []).length
  };

  // 点击前已经是完成态 / 文案就写着已签到 → 直接判定为重复
  if (isDone(btn) || DONE_TEXT.test(before.text)) {
    return { ok: true, already: true, text: before.text || '今日已签到', before };
  }

  // 清空上一次捕获，确保读到的是本次点击的响应
  const baseCount = before.captures;
  window.__gcdLast = null;

  // 派发完整鼠标事件链，接近真实点击
  const types = ['pointerover', 'mouseover', 'pointerenter', 'mouseenter',
                 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  for (const t of types) {
    try {
      const Ctor = t.startsWith('pointer') && typeof PointerEvent === 'function'
        ? PointerEvent : MouseEvent;
      btn.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, view: window }));
    } catch (e) { /* 部分事件可能不支持 */ }
  }

  // 等待官网自身请求返回（inject.js 旁听结果）
  let doneState = null;
  // 交互式 Turnstile 最长等 90 秒 + 响应处理，留足时间避免中断请求。
  const MAX_WAIT = 100000;
  const GRACE_AFTER_DONE = 10000; // 按钮变完成态后再给 10 秒等响应

  for (let waited = 0; waited < MAX_WAIT; waited += 500) {
    await sleep(500);
    const elapsed = waited + 500;

    if (window.__gcdLast) {
      return {
        ok: true, data: window.__gcdLast, before,
        waitedMs: elapsed,
        captures: (window.__gcdResults || []).length
      };
    }

    if (!doneState && isDone(btn)) {
      doneState = { at: elapsed, text: btnText(btn) || '' };
    }
    if (doneState && elapsed - doneState.at >= GRACE_AFTER_DONE) break;
  }

  // 没拿到服务端响应，但仍然可能有信息：按钮文案变了
  return {
    ok: false,
    reason: 'no-response',
    text: btnText(btn),
    doneState,
    before,
    captures: (window.__gcdResults || []).length,
    baseCount
  };
}

function readTurnstileInPage() {
  const frames = [];
  const collect = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('iframe').forEach((f) => frames.push(f));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collect(el.shadowRoot);
    });
  };
  collect(document);

  const tokenEl = document.querySelector('[name="cf-turnstile-response"]');
  const token = tokenEl ? String(tokenEl.value || '') : '';

  let frame = null;
  for (const f of frames) {
    const blob = `${f.src || ''} ${f.title || ''}`.toLowerCase();
    if (!blob.includes('challenges.cloudflare.com') &&
        !blob.includes('turnstile') &&
        !blob.includes('cloudflare')) continue;
    try { f.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* ignore */ }
    const rect = f.getBoundingClientRect();
    frame = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      visible: rect.width >= 40 && rect.height >= 20,
      src: String(f.src || '')
    };
    break;
  }
  return { token, frame };
}

async function waitTurnstileToken(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readTurnstileInPage
      });
      const state = (res && res[0] && res[0].result) || {};
      if (state.token) return true;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/no tab with id|no such tab|target closed|tab.*clos|receiving end does not exist/i.test(msg)) {
        return false;
      }
    }
    await sleep(300);
  }
  return false;
}

async function turnstileCheckboxPoint(tabId, frame, target) {
  await chrome.debugger.sendCommand(target, 'Page.enable');
  const tree = await chrome.debugger.sendCommand(target, 'Page.getFrameTree');
  const findFrame = (node) => {
    if (!node) return null;
    if (/challenges\.cloudflare\.com|turnstile/i.test(node.frame?.url || '')) {
      return node.frame;
    }
    for (const child of node.childFrames || []) {
      const found = findFrame(child);
      if (found) return found;
    }
    return null;
  };

  const child = findFrame(tree && tree.frameTree);
  if (child) {
    try {
      const world = await chrome.debugger.sendCommand(target, 'Page.createIsolatedWorld', {
        frameId: child.id,
        worldName: 'glados-turnstile-checkbox'
      });
      const evaluated = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        contextId: world.executionContextId,
        returnByValue: true,
        expression: `(() => {
          const selectors = [
            'input[type="checkbox"]',
            '[role="checkbox"]',
            '#challenge-stage input',
            '.ctp-checkbox-label input',
            '.cb-c'
          ];
          const seen = new Set();
          const find = (root) => {
            if (!root || seen.has(root)) return null;
            seen.add(root);
            for (const selector of selectors) {
              const el = root.querySelector(selector);
              if (!el) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return {
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  selector
                };
              }
            }
            for (const el of root.querySelectorAll('*')) {
              if (!el.shadowRoot) continue;
              const found = find(el.shadowRoot);
              if (found) return found;
            }
            return null;
          };
          return find(document);
        })()`
      });
      const point = evaluated && evaluated.result && evaluated.result.value;
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        return {
          x: Math.round(frame.x + point.x),
          y: Math.round(frame.y + point.y),
          source: point.selector
        };
      }
    } catch (e) { /* fallback to frame-relative point */ }
  }

  return {
    x: Math.round(frame.x + Math.min(28, frame.width / 5)),
    y: Math.round(frame.y + frame.height / 2),
    source: 'frame-fallback'
  };
}

async function clickTurnstileCheckbox(tabId, frame) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const point = await turnstileCheckboxPoint(tabId, frame, target);
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    await sleep(100);
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    return point;
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) { /* ignore */ }
  }
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) { /* ignore */ }
}

function notifyTurnstile() {
  try {
    chrome.notifications.create(`glados-turnstile-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'GLaDOS 需要人机验证',
      message: '签到页已打开，请完成 Cloudflare 验证；完成后会自动继续。'
    }, () => {
      if (chrome.runtime.lastError) console.warn('[turnstile notification]', chrome.runtime.lastError.message);
    });
  } catch (e) { /* ignore */ }
}

async function readTurnstileState(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readTurnstileInPage
    });
    return (res && res[0] && res[0].result) || null;
  } catch (e) {
    return null;
  }
}

/** 收集 Turnstile 相关动作，写入日志 detail（自动点击必须留痕）。 */
function tsNote(events, text) {
  if (!Array.isArray(events) || !text) return;
  events.push(text);
}

function turnstileSummary(events) {
  if (!Array.isArray(events) || !events.length) return '';
  // ⚙ 前缀让「扩展动过鼠标」这类动作在日志里一眼可见
  return `⚙ ${events.join('、')}`;
}

function watchTurnstileDuringClick(tabId, settings, events) {
  let stopped = false;
  let focused = false;
  let notified = false;
  let autoTried = false;

  const promise = (async () => {
    const deadline = Date.now() + 100000;
    while (!stopped && Date.now() < deadline) {
      const state = await readTurnstileState(tabId);
      if (!state) return;
      if (state.token) {
        if (autoTried) tsNote(events, '点击期间取得令牌');
        return;
      }
      if (state.frame) {
        if (!focused) {
          focused = true;
          await focusTab(tabId);
          tsNote(events, '检测到验证框，页面已切前台');
        }
        if (!notified) {
          notified = true;
          notifyTurnstile();
        }
        if (!autoTried && settings.autoClickTurnstile &&
            state.frame.visible && chrome.debugger) {
          autoTried = true;
          try {
            const point = await clickTurnstileCheckbox(tabId, state.frame);
            tsNote(events, `已自动点击验证框（${point && point.source ? point.source : '未知位置'}）`);
          } catch (e) {
            tsNote(events, `自动点击失败：${String(e && e.message || e).slice(0, 60)}`);
            console.warn('[turnstile] 自动点击失败', e);
          }
        }
      }
      await sleep(700);
    }
    if (autoTried) tsNote(events, '100 秒内未见令牌');
  })().catch((e) => console.warn('[turnstile watcher]', e));

  return {
    promise,
    stop() { stopped = true; return promise; }
  };
}

async function prepareTurnstile(tabId, settings, events) {
  let state = {};
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readTurnstileInPage
    });
    state = (res && res[0] && res[0].result) || {};
  } catch (e) {
    return { needed: false, ok: true };
  }
  if (!state.frame && !state.token) return { needed: false, ok: true };
  // 已有令牌 = 静默通过，属于正常情况，不写日志（避免日常噪音）
  if (state.token) return { needed: true, ok: true };

  // 某些 Turnstile 会静默完成，先给页面一点时间。
  if (await waitTurnstileToken(tabId, 5000)) {
    return { needed: true, ok: true };
  }

  // 从这里开始才算「需要交互」——之后每个动作都记日志
  await focusTab(tabId);

  let autoClicked = false;
  if (settings.autoClickTurnstile && state.frame.visible && chrome.debugger) {
    try {
      const point = await clickTurnstileCheckbox(tabId, state.frame);
      autoClicked = true;
      tsNote(events, `已自动点击验证框（${point && point.source ? point.source : '未知位置'}）`);
    } catch (e) {
      tsNote(events, `自动点击失败：${String(e && e.message || e).slice(0, 60)}`);
      console.warn('[turnstile] 自动点击失败', e);
    }
    if (await waitTurnstileToken(tabId, 15000)) {
      tsNote(events, '自动点击后取得令牌');
      return { needed: true, ok: true, auto: true };
    }
    if (autoClicked) tsNote(events, '自动点击后 15 秒内仍无令牌');
  } else if (!settings.autoClickTurnstile) {
    tsNote(events, '自动点击已关闭，已切前台等人工');
  } else {
    tsNote(events, '验证框不可见或缺少调试权限，已切前台等人工');
  }

  notifyTurnstile();
  const ok = await waitTurnstileToken(tabId, 90000);
  if (!autoClicked) tsNote(events, ok ? '人工验证完成' : '等待人工验证超时 90 秒');
  return { needed: true, ok, auto: autoClicked };
}

/**
 * API 模式：在页面上下文发起签到（同源，Cookie 由 DNR 注入）。
 * 适用于无 Turnstile 的旧站。
 */
async function apiCheckinInPage() {
  const host = location.hostname;
  const body = new URLSearchParams({ token: host }).toString();
  try {
    const resp = await fetch('/api/user/checkin', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'accept': 'application/json, text/plain, */*'
      },
      body
    });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!data) return { ok: false, reason: 'invalid-json', raw: text.slice(0, 200) };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e && e.message || e) };
  }
}

/**
 * 读取账号状态与积分（同源）。从 /api/user/points 的 history 流水解析
 * 每日签到记录，这是判断「今天签没签」最可靠的依据。
 */
async function fetchAccountSnapshotInPage() {
  const out = {};
  const grab = async (path) => {
    try {
      const r = await fetch(path, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          accept: 'application/json, text/plain, */*',
          'cache-control': 'no-cache'
        }
      });
      return await r.json();
    } catch (e) {
      return { __error: String(e && e.message || e) };
    }
  };
  const status = await grab('/api/user/status');
  const points = await grab('/api/user/points');
  const d = (status && status.data) || {};
  const pd = (points && points.data) || points || {};

  out.email = d.email || null;
  // 只接受明确的用户 ID 字段；通用 d.id 可能是配置/套餐 ID。
  out.userId = d.userId != null ? d.userId
    : (d.user_id != null ? d.user_id
      : (d.configureId != null ? d.configureId : null));
  out.leftDays = d.leftDays != null ? Number(d.leftDays) : null;
  out.vip = d.vip != null ? d.vip : null;
  out.points = pd.points != null ? Number(pd.points) : null;
  out.streak = pd.streak != null ? Number(pd.streak) : null;
  out.today = d.system_date || null;
  out.loggedIn = !!(status && status.code === 0);
  out.statusCode = status && status.code;

  // ---- 日期键 ----
  const keyOf = (dt) => `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`;
  const localToday = keyOf(new Date());

  const normDay = (v) => {
    if (!v) return null;
    const m = String(v).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? `${Number(m[1])}-${Number(m[2])}-${Number(m[3])}` : null;
  };
  const serverDay = normDay(d.system_date);

  // ---- history 流水 → 每日签到点数 ----
  out.checkinDays = {};
  const history = Array.isArray(pd.history) ? pd.history : [];
  history.forEach((item) => {
    if (!item) return;
    const biz = String(item.business || '');
    if (biz.indexOf('checkin') === -1) return;
    const rawTs = Number(item.time);
    if (!rawTs) return;
    // 兼容秒级时间戳；当前接口通常是毫秒。
    const ts = rawTs < 1e12 ? rawTs * 1000 : rawTs;
    const dt = new Date(ts);
    out.checkinDays[keyOf(dt)] = parseInt(item.change, 10) || 0;
  });

  // ---- earned 字典兜底（新站可能只给 earned） ----
  const earned = pd.earned;
  if (earned && typeof earned === 'object' && !Array.isArray(earned)) {
    Object.keys(earned).forEach((k) => {
      const norm = String(k).replace(/^(\d{4})-0?(\d{1,2})-0?(\d{1,2})$/, (m, y, mo, da) =>
        `${Number(y)}-${Number(mo)}-${Number(da)}`);
      if (out.checkinDays[norm] == null) out.checkinDays[norm] = Number(earned[k]) || 0;
    });
  }

  const todayKey = serverDay || localToday;
  out.todayKey = todayKey;
  out.localTodayKey = localToday;
  out.serverDay = serverDay;
  out.dayMismatch = !!(serverDay && serverDay !== localToday);
  out.todayPoints = out.checkinDays[todayKey] != null ? out.checkinDays[todayKey] : null;
  out.alreadyToday = out.todayPoints != null;
  out.earnedToday = out.todayPoints;
  out.serverDate = d.system_date || null;
  return out;
}

// ---- 结果归类 ----

/**
 * 归类服务端响应：success | repeat | turnstile | device | fail。
 * 拿不到响应时绝不默认成功，判断不了就报失败。
 */
function classifyResult(data, fallbackText) {
  const message = String((data && data.message) || fallbackText || '').trim();
  const lower = message.toLowerCase();

  if (!data) {
    if (/已签到|已簽到|\balready\b|\bchecked\b|\bsigned\b|observation logged|明日|tomorrow/i.test(message)) {
      return { status: 'repeat', points: 0, message: message || '今日已签到', raw: null };
    }
    return {
      status: 'fail',
      points: 0,
      message: message ? `未捕获到签到响应（页面显示：${message}）` : '未捕获到签到响应',
      raw: null
    };
  }

  // 兼容字符串形式的 code（"0"/"1"）。
  const rawCode = data.code;
  const code = rawCode == null || rawCode === '' ? null : Number(rawCode);
  const reason = String(data.reason || '').toLowerCase();

  // Turnstile / Cloudflare 拦截
  if (code === 5 || reason === 'turnstile' ||
      lower.includes('cloudflare') || lower.includes('turnstile') ||
      lower.includes('verification failed')) {
    return { status: 'turnstile', points: 0, message: message || 'Cloudflare 验证未通过', raw: data };
  }

  // 设备不匹配
  if (code === 4 || reason === 'device-mismatch') {
    return { status: 'device', points: 0, message: message || '设备与登录不一致', raw: data };
  }

  const points = Number(
    data.points != null ? data.points : (data.earned != null && typeof data.earned !== 'object' ? data.earned : 0)
  ) || 0;

  // `observation logged` 也可能是正常签到回执，不能仅凭它判 repeat。
  if (data.repeated === true || code === 1) {
    return { status: 'repeat', points: 0, message: message || '今日已签到', raw: data };
  }

  // code=0 是成功；即使文案包含 observation logged，也以 code/points 为准。
  if (code === 0) {
    if (points <= 0 && (lower.includes('already checked in') || lower.includes('已签到'))) {
      return { status: 'repeat', points: 0, message: message || '今日已签到', raw: data };
    }
    return { status: 'success', points, message: message || '签到成功', raw: data };
  }

  // 非 0 code 时，文案兜底判断重复签到
  if (lower.includes('already checked in') || lower.includes('observation logged') ||
      lower.includes('已签到')) {
    return { status: 'repeat', points: 0, message: message || '今日已签到', raw: data };
  }

  // 无 code 但日程显示已签
  if (code == null && (data.checkedIn === true || data.checked === true)) {
    return { status: 'repeat', points: 0, message: message || '今日已签到', raw: data };
  }

  return { status: 'fail', points: 0, message: message || `未预期响应 code=${code}`, raw: data };
}

// ---- 单账号签到 ----

/**
 * 本次运行中已确认的登录身份，用于防止多账号串号。
 * key = email, value = { accountId, name }
 */
let identityGuard = new Map();

/**
 * 等待标签页加载完成。需区分「标签页已关闭」与「加载慢」：
 * 后者超时后用 document.readyState 兜底，页面可跑就算可用。
 */
async function waitTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  let goneCount = 0;

  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) {
        goneCount++;
        if (goneCount >= 3) return false;
      } else if (tab.status === 'complete') {
        return true;
      } else {
        goneCount = 0;
      }
    } catch (e) {
      // 偶发的瞬时错误（例如标签页正在切换进程）不能直接判死
      goneCount++;
      if (goneCount >= 5) return false;
    }
    await sleep(400);
  }

  // 超时兜底：能注入脚本且文档已可用 → 视为可用
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        ready: document.readyState,
        hasBtn: !!document.querySelector('button.ckb'),
        title: document.title
      })
    });
    const r = (res && res[0] && res[0].result) || {};
    if (r.hasBtn || r.ready === 'complete' || r.ready === 'interactive') {
      return true;
    }
  } catch (e) { /* 无法注入，判定失败 */ }

  return false;
}

/**
 * 身份校验：确认当前标签页里的登录身份确实是本账号，避免签到到错误的账号。
 * 这一步在真正点击签到之前执行，失败即中止。
 */
/**
 * 新站各域名共用同一账号体系，railgun.info 是独立旧站。
 * 仅对明确列出的域名生效，未知域名按独立账号域处理。
 */
const GLADOS_SHARED_DOMAINS = new Set([
  'glados.cloud',
  'glados.network',
  'glados.rocks',
  'glados.one',
  'glados.space',
  'glados.vip',
  'glados-facility.com'
]);

function accountRealm(domain) {
  const d = String(domain || '').toLowerCase();
  if (d === 'railgun.info') return 'railgun';
  if (GLADOS_SHARED_DOMAINS.has(d)) return 'glados';
  return `domain:${d}`;
}

async function verifyIdentity(tabId, account, result, mode) {
  let snap = null;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fetchAccountSnapshotInPage
    });
    snap = (res && res[0] && res[0].result) || null;
  } catch (e) {
    result.message = `身份校验请求失败：${e.message || e}`;
    result.identityFailed = true;
    return false;
  }

  if (!snap || !snap.email) {
    const code = snap && snap.statusCode;
    if (mode === 'session') {
      result.message = code != null
        ? `浏览器登录态无效：/api/user/status 返回 code=${code}。请在 Chrome 里重新登录 ${result.domain || '该站点'} 后再试`
        : `浏览器未登录 ${result.domain || '该站点'}：未取到账号信息，请先在 Chrome 登录`;
    } else {
      result.message = code != null
        ? `Cookie 无效：/api/user/status 返回 code=${code}，请重新登录后更新 Cookie`
        : 'Cookie 无效：未取到账号信息，请重新登录后更新 Cookie';
    }
    result.identityFailed = true;
    return false;
  }

  // 与该账号历史快照比对
  const expected = account.snapshot && account.snapshot.email;
  if (expected && expected !== snap.email) {
    if (mode === 'session') {
      // 浏览器登录态就是唯一真相：用户换了账号，覆盖快照即可，不算失败
      result.identityChanged = `${expected} → ${snap.email}`;
    } else {
      result.message =
        `身份校验失败：期望 ${expected}，实际 ${snap.email}。` +
        'Cookie 注入可能未生效，已中止以避免签错账号';
      result.identityFailed = true;
      return false;
    }
  }

  // 与本次运行中其他账号比对（按账号库分组，railgun 独立）。
  const realm = accountRealm(result.domain || account.siteId);
  const realmLabel = realm === 'railgun' ? 'railgun 旧站' : 'GLaDOS 新站';
  const identityKey = snap.userId != null
    ? `${realm}|uid:${snap.userId}`
    : `${realm}|email:${snap.email}`;
  const dup = identityGuard.get(identityKey);
  if (dup && dup.accountId !== account.id) {
    result.message =
      `身份校验失败：与账号「${dup.name}」在 ${realmLabel}账号库解析为同一登录态（${snap.email}），已中止以避免串号`;
    result.identityFailed = true;
    return false;
  }
  identityGuard.set(identityKey, { accountId: account.id, name: account.name });

  result.email = snap.email;
  result.userId = snap.userId != null ? snap.userId : null;
  result.leftDays = snap.leftDays;
  result.pointsTotal = snap.points;
  result.vip = snap.vip != null ? snap.vip : null;
  result.streak = snap.streak != null ? snap.streak : null;
  // 服务端日历：今天是否已有签到记录（官网日历同一份数据）
  result.servedAlready = snap.alreadyToday === true;
  result.servedTodayPoints = snap.todayPoints != null ? snap.todayPoints : null;
  result.checkinDays = snap.checkinDays || null;
  return true;
}

/**
 * 打开临时标签页并挂上账号身份。
 * @param {object} opts { foreground 切到前台, timeoutMs 加载超时 }
 */
async function openSessionTab(account, site, path, opts) {
  const options = opts || {};
  const url = `https://${site.domain}${path}`;
  const tab = await chrome.tabs.create({
    url: 'about:blank',
    active: options.foreground === true
  });
  const tabId = tab.id;
  let ruleId = null;

  // 必须先在导航前挂规则，否则首个请求就不会带上目标账号身份
  if (authModeOf(account) === 'cookie') {
    ruleId = await addTabScopedRule(tabId, account, site);
  }

  if (options.foreground === true) await focusTab(tabId);

  await chrome.tabs.update(tabId, { url });
  let ok = await waitTabComplete(tabId, options.timeoutMs || 35000);

  // 首轮失败再导航一次：常见于代理刚建立连接 / 上一轮 DNR 规则刚生效
  if (!ok) {
    try {
      await chrome.tabs.update(tabId, { url });
      ok = await waitTabComplete(tabId, options.timeoutMs || 25000);
    } catch (e) { /* tab 已关闭 */ }
  }

  return { tabId, ruleId, ok };
}

/**
 * 保留的签到标签页：tabId → { accountId, ruleId }。
 * 保留期间不移除 DNR 规则（否则会退化成浏览器登录态、可能签错账号），
 * 标签页关闭时才清理。
 */
const KEPT_TABS_KEY = 'gcd_kept_tabs';
const keptTabs = new Map();

async function loadKeptTabs() {
  try {
    const raw = await chrome.storage.session.get(KEPT_TABS_KEY);
    const list = raw && raw[KEPT_TABS_KEY];
    if (Array.isArray(list)) {
      keptTabs.clear();
      list.forEach((x) => {
        if (x && x.tabId != null) {
          keptTabs.set(Number(x.tabId), { accountId: x.accountId, ruleId: x.ruleId || null });
        }
      });
    }
  } catch (e) { /* session 不可用按空处理 */ }
}

async function persistKeptTabs() {
  const list = Array.from(keptTabs.entries()).map(([tabId, info]) => ({
    tabId, accountId: info.accountId, ruleId: info.ruleId || null
  }));
  try {
    await chrome.storage.session.set({ [KEPT_TABS_KEY]: list });
  } catch (e) { /* ignore */ }
}

async function cleanupKeptTabsOnStartup() {
  await loadKeptTabs();
  for (const [tabId, info] of Array.from(keptTabs.entries())) {
    if (info.ruleId) await removeRule(info.ruleId);
    try { await chrome.tabs.remove(tabId); } catch (e) { /* 已关闭 */ }
  }
  keptTabs.clear();
  await persistKeptTabs();
}

cleanupKeptTabsOnStartup().catch(() => {});

async function registerKeptTab(tabId, accountId, ruleId) {
  if (tabId == null) return;
  keptTabs.set(tabId, { accountId, ruleId: ruleId || null });
  await persistKeptTabs();
}

/** 关掉某账号遗留的保留标签页（开始新一轮签到前调用）。 */
async function closeKeptTabForAccount(accountId) {
  let changed = false;
  for (const [tabId, info] of Array.from(keptTabs.entries())) {
    if (info.accountId !== accountId) continue;
    keptTabs.delete(tabId);
    changed = true;
    try { if (info.ruleId) await removeRule(info.ruleId); } catch (e) { /* ignore */ }
    try { await chrome.tabs.remove(tabId); } catch (e) { /* 已关闭 */ }
  }
  if (changed) await persistKeptTabs();
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    const info = keptTabs.get(tabId);
    if (!info) return;
    keptTabs.delete(tabId);
    persistKeptTabs().catch(() => {});
    if (info.ruleId) {
      removeRule(info.ruleId).catch(() => { /* ignore */ });
    }
  });
}

/**
 * 关闭临时标签页。keepTab 为 true 时保留页面与 DNR 规则（人工验证未完成），
 * 并登记到 keptTabs 以便下一轮清理。
 */
async function closeSessionTab(tabId, ruleId, keepTab, accountId) {
  if (keepTab) {
    await registerKeptTab(tabId, accountId, ruleId);
    return;
  }
  try { if (ruleId) await removeRule(ruleId); } catch (e) { /* ignore */ }
  if (tabId == null) return;
  await sleep(300);
  try { await chrome.tabs.remove(tabId); } catch (e) { /* 已关闭 */ }
}

/**
 * 读取某账号的服务器日历数据（积分、连续天数、每天签到点数）。
 * 用于设置页的 30 天签到日历，也用于验证"今天到底签没签"。
 */
async function getCalendar(account, site, days) {
  const span = Math.max(7, Math.min(60, days || 30));
  let tabId = null;
  let ruleId = null;
  try {
    const opened = await openSessionTab(account, site, '/console/checkin');
    tabId = opened.tabId;
    ruleId = opened.ruleId;
    if (!opened.ok) return { ok: false, error: '页面加载超时' };

    await sleep(500);
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fetchAccountSnapshotInPage
    });
    const snap = (res && res[0] && res[0].result) || null;
    if (!snap) return { ok: false, error: '未取到数据' };
    if (!snap.email) {
      return {
        ok: false,
        loggedIn: false,
        error: snap.statusCode != null
          ? `/api/user/status 返回 code=${snap.statusCode}`
          : '未取到账号信息'
      };
    }

    // 生成连续 N 天的日期列表，交给界面渲染。
    // 同时算出前置空白格，让日期与「一~日」表头真正对齐。
    const list = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = span - 1; i >= 0; i--) {
      const dt = new Date(base);
      dt.setDate(dt.getDate() - i);
      const key = `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`;
      const pts = snap.checkinDays ? snap.checkinDays[key] : null;
      list.push({
        key,
        label: `${dt.getMonth() + 1}/${dt.getDate()}`,
        checked: pts != null,
        points: pts != null ? pts : 0,
        isToday: i === 0
      });
    }

    const firstDay = new Date(base);
    firstDay.setDate(firstDay.getDate() - (span - 1));
    const leadingBlanks = (firstDay.getDay() + 6) % 7; // 周一为第一列

    return {
      ok: true,
      loggedIn: true,
      email: snap.email,
      points: snap.points,
      vip: snap.vip,
      streak: snap.streak,
      leftDays: snap.leftDays,
      todayKey: snap.todayKey,
      todayPoints: snap.todayPoints,
      alreadyToday: snap.alreadyToday === true,
      leadingBlanks,
      days: list
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    await closeSessionTab(tabId, ruleId);
  }
}
/** 单账号签到。opts: { force 忽略本地已签记录 } */
/**
 * 执行积分兑换。请求格式对齐 Python 版：POST /api/user/exchange，
 * body 为 form-urlencoded，字段 planType。
 */
async function exchangeInPage(plan) {
  try {
    const resp = await fetch('/api/user/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'accept': 'application/json, text/plain, */*'
      },
      body: new URLSearchParams({ planType: plan }).toString()
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { code: -1, message: `HTTP ${resp.status}` };
    }
    return {
      code: data.code != null ? data.code : -1,
      message: data.message || '',
      points: data.points != null ? data.points : null
    };
  } catch (e) {
    return { code: -1, message: e.message || String(e) };
  }
}

async function checkinOne(account, site, settings, trigger, opts) {
  const options = opts || {};
  const started = Date.now();
  const mode = authModeOf(account);
  let tabId = null;
  let ruleId = null;
  // 人机验证事件收集器；放在函数作用域，提前 return 也能被记录。
  const tsEvents = [];

  const result = {
    accountId: account.id,
    accountName: account.name || account.id,
    domain: site.domain,
    trigger: trigger || 'auto',
    authMode: mode,
    status: 'fail',
    points: 0,
    message: '',
    detail: '',
    already: false,
    identityFailed: false,
    identityChanged: null,
    email: null,
    leftDays: null,
    pointsTotal: null,
    streak: null,
    servedAlready: false,
    servedTodayPoints: null,
    checkinDays: null,
    exchangeOk: false,
    turnstileAuto: false,
    elapsed: 0
  };

  try {
    acquireKeepAlive();

    // 0. 清掉上次失败遗留的保留标签页，避免越积越多
    await closeKeptTabForAccount(account.id);

    // 1~3. 打开临时标签页并挂上本账号身份
    const foreground = options.foreground === true ||
      (trigger === 'manual' && options.foreground !== false && settings.foregroundOnManual !== false);
    const opened = await openSessionTab(account, site, site.checkinPath || '/console/checkin',
      { foreground });
    tabId = opened.tabId;
    ruleId = opened.ruleId;
    if (!opened.ok) {
      result.message = '页面加载超时（已重试一次导航）';
      result.detail = `请确认能正常打开 https://${site.domain}${site.checkinPath || '/console/checkin'}`;
      return result;
    }

    await sleep(600);

    // 4. 身份校验（防签错账号），同时取服务端日历快照
    const identified = await verifyIdentity(tabId, account, result, mode);
    if (!identified) return result;

    // 5. 前哨检查：服务端已有今日记录就不再点按钮
    if (result.servedAlready) {
      const pts = result.servedTodayPoints;
      result.status = 'repeat';
      result.already = true;
      result.message = pts != null && pts > 0
        ? `今日已签到（服务端记录：今天已入账 ${pts} 分）`
        : '今日已签到（服务端已存在今天的签到记录）';
      result.detail = '服务端日历前哨检查命中，未点击按钮';
      return result;
    }

    if (site.mode === 'api') {
      // ---- API 模式：无需渲染，直接提交 ----
      const apiRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: apiCheckinInPage
      });
      const r = (apiRes && apiRes[0] && apiRes[0].result) || {};
      if (!r.ok) {
        result.message = `接口调用失败：${r.reason || 'unknown'}`;
        return result;
      }
      const cls = classifyResult(r.data, '');
      Object.assign(result, {
        status: cls.status,
        points: cls.points,
        message: cls.message
      });
    } else {
      // ---- 浏览器模式：注入钩子 → 拟人停留 → 点击按钮 ----
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['inject.js']
        });
      } catch (e) {
        result.message = `注入失败：${e.message || e}`;
        return result;
      }

      // 官网要求 challenge 至少 2.5 秒后才能提交。
      const minStay = Math.max(2500, Number(settings.minStayMs) || 4500);
      const maxStay = Math.min(30000, Math.max(minStay, Number(settings.maxStayMs) || 6500));
      const stay = minStay + Math.random() * Math.max(0, maxStay - minStay);
      await sleep(stay);

      // 人机验证事件收集器已在外层声明（tsEvents）
      const turnstile = await prepareTurnstile(tabId, settings, tsEvents);
      if (turnstile.needed && !turnstile.ok) {
        result.status = 'turnstile';
        result.message = '需要完成 Cloudflare 人机验证；签到页已打开，请手动完成后再试';
        result.detail = turnstileSummary(tsEvents) || '检测到 Cloudflare 验证框，等待人工完成超时';
        return result;
      }

      const clickPromise = chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: clickCheckinInPage
      });
      // 有些 Turnstile 是点击签到按钮后才出现，点击期间也要盯着并激活页面。
      const watcher = turnstile.needed ? null : watchTurnstileDuringClick(tabId, settings, tsEvents);
      let clickRes;
      try {
        clickRes = await clickPromise;
      } finally {
        if (watcher) await watcher.stop();
      }
      const r = (clickRes && clickRes[0] && clickRes[0].result) || {};

      if (r.reason === 'not-logged-in') {
        result.message = mode === 'session'
          ? `浏览器未登录 ${site.domain}（被重定向到登录页），请先在 Chrome 登录`
          : 'Cookie 已失效（被重定向到登录页）';
        return result;
      }
      if (r.reason === 'button-not-found') {
        result.message = '未找到签到按钮（页面结构可能已变化）';
        return result;
      }
      if (r.reason === 'button-disabled') {
        result.message = '签到按钮一直处于禁用状态，页面可能未就绪或需要先完成验证';
        result.detail = `按钮文案：${r.text || '(空)'}；class：${r.className || '(空)'}`;
        return result;
      }
      if (r.reason === 'no-response') {
        // 点了但没抓到请求（已签账号常见）。判定优先级：服务端记录 > 按钮文案 > 报失败
        let snapTodayPoints = null;
        try {
          const s = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: fetchAccountSnapshotInPage
          });
          const snap = (s && s[0] && s[0].result) || null;
          if (snap && snap.todayPoints != null) snapTodayPoints = snap.todayPoints;
        } catch (e) { /* 快照失败继续用文案判断 */ }

        if (snapTodayPoints != null) {
          result.status = 'repeat';
          result.points = 0;
          result.message = `今日已签到（服务端记录：今天已入账 ${snapTodayPoints} 分）`;
        } else if (result.servedAlready) {
          // 点击前服务端就有记录，点击后反而没记录（极不可能），按已签到处理
          result.status = 'repeat';
          result.points = 0;
          result.message = '今日已签到（点击前服务端已有今日记录）';
        } else {
          const cls = classifyResult(null, r.text || (r.doneState && r.doneState.text) || '');
          Object.assign(result, {
            status: cls.status,
            points: cls.points,
            message: cls.message
          });
        }
        result.detail = [
          `点击前按钮：${r.before ? r.before.text || '(空)' : '?'}`,
          r.before && r.before.disabled ? '初始为禁用态' : '',
          `点击后按钮：${r.text || (r.doneState && r.doneState.text) || '(无变化)'}`,
          `本次新增 checkin 响应：${r.captures != null ? Math.max(0, r.captures - (r.baseCount || 0)) : '?'} 条`,
          snapTodayPoints != null ? `服务端今日记录：${snapTodayPoints} 分` : '服务端今日无记录'
        ].filter(Boolean).join('；');
      } else if (r.reason === 'timeout') {
        result.message = '点击后等待响应超时';
        return result;
      } else if (r.already) {
        result.status = 'repeat';
        result.already = true;
        result.message = r.text || '今日已签到';
        result.detail = '点击前按钮已是完成态或文案含「已签到」';
      } else {
        const cls = classifyResult(r.data, r.text);
        Object.assign(result, {
          status: cls.status,
          points: cls.points,
          message: cls.message
        });
        result.detail = `诊断：点击后约 ${r.waitedMs || '?'} ms 收到服务端响应`;
      }

      // ---- Cloudflare 被拒后的补救：切前台 + 等人工验证 + 重试一次 ----
      // 后台页拿不到 Turnstile 令牌会回 code=5：切前台等人工验证后自动重试。
      if (result.status === 'turnstile' && settings.humanVerify !== false) {
        await focusTab(tabId);
        notifyTurnstile();
        result.detail = (result.detail ? result.detail + '；' : '') +
          '已在验证弹窗等待人工完成（最多 90 秒）';

        const gotToken = await waitTurnstileToken(tabId, 90000);
        if (gotToken) {
          const retryRes = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: clickCheckinInPage
          });
          const rr = (retryRes && retryRes[0] && retryRes[0].result) || {};
          if (rr.data) {
            const cls2 = classifyResult(rr.data, rr.text);
            Object.assign(result, {
              status: cls2.status,
              points: cls2.points,
              message: cls2.message
            });
            result.detail = `人工完成验证后重试成功（${rr.waitedMs || '?'} ms）`;
          } else {
            result.message = '人机验证已通过，但重试未拿到签到结果，请手动确认';
            result.detail = `${result.detail}；重试返回 reason=${rr.reason || 'unknown'}`;
          }
        } else {
          result.message = '需要人机验证：签到页已切到前台，请完成 Cloudflare 验证后重试';
          result.detail = (result.detail || '') + '；等待 90 秒未取得令牌';
        }
      }
    }

    // 5.5 按账号配置自动兑换（签到成功或今日已签后）
    const exchangePlan = account.exchangePlan || 'none';
    if (exchangePlan !== 'none' &&
        (result.status === 'success' || result.status === 'repeat')) {
      const today = todayStr();
      const alreadyExchanged = account.last &&
        account.last.date === today &&
        account.last.exchangeDate === today &&
        account.last.exchangePlan === exchangePlan;
      if (alreadyExchanged) {
        // 防止手动重复点「立即签到」时反复消耗积分。
        result.exchange = `今日已兑换（${exchangePlan}），跳过`;
      } else {
        try {
          const exRes = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: exchangeInPage,
            args: [exchangePlan]
          });
          const ex = (exRes && exRes[0] && exRes[0].result) || {};
          if (ex.code === 0) {
            result.exchange = `兑换成功：${exchangePlan}`;
            result.exchangeOk = true;
          } else {
            result.exchange = `兑换失败：${ex.message || `code=${ex.code}`}`;
          }
        } catch (e) {
          result.exchange = `兑换异常：${e.message || e}`;
        }
        if (result.exchange) {
          result.detail = (result.detail ? result.detail + '；' : '') + result.exchange;
        }
      }
    }

    // 6. 复读快照（积分入库有延迟）
    await sleep(900);
    try {
      const snapRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: fetchAccountSnapshotInPage
      });
      const snap = (snapRes && snapRes[0] && snapRes[0].result) || null;
      if (snap && snap.email) {
        result.email = snap.email;
        result.userId = snap.userId != null ? snap.userId : result.userId;
        result.leftDays = snap.leftDays;
        result.pointsTotal = snap.points;
        result.vip = snap.vip != null ? snap.vip : result.vip;
        result.streak = snap.streak != null ? snap.streak : result.streak;
        result.checkinDays = snap.checkinDays || result.checkinDays;
        result.servedAlready = snap.alreadyToday === true;
        result.servedTodayPoints = snap.todayPoints != null ? snap.todayPoints : result.servedTodayPoints;

        // 最终裁决：本次被判"成功"但服务端没有今天的入账记录 → 说明其实没签上
        if (result.status === 'success' && result.points === 0 &&
            snap.alreadyToday !== true && result.trigger !== 'auto') {
          result.detail = (result.detail ? result.detail + '；' : '') +
            '注意：服务端未见今日积分记录，请到官网确认';
        }
      }
    } catch (e) { /* 快照失败不影响签到结论 */ }

    return result;
  } catch (e) {
    result.message = `执行异常：${e.message || e}`;
    return result;
  } finally {
    result.elapsed = Date.now() - started;

    // 把 Turnstile 相关动作并入 detail（任何分支都不漏记，且不覆盖已有结论）
    const tsText = turnstileSummary(tsEvents);
    if (tsText && String(result.detail || '').indexOf(tsText) === -1) {
      result.detail = result.detail ? `${result.detail}；${tsText}` : tsText;
    }
    result.turnstileAuto = tsEvents.some((s) => s.indexOf('已自动点击') === 0);

    // 人工验证未完成时保留标签页，让用户能直接接着操作
    const keepTab = result.status === 'turnstile' && settings.keepTabOnVerify !== false;

    // 清理动作本身不能抛异常，否则会覆盖上面的 return
    await closeSessionTab(tabId, ruleId, keepTab, account.id);
    if (keepTab) {
      result.detail = (result.detail ? result.detail + '；' : '') +
        '签到页已保留在前台，完成验证后可回来点「测试签到」';
    }

    // 先写日志再更新账号：日志是首要排查依据，不能被后续失败吞掉
    const okStatus = result.status === 'success' || result.status === 'repeat';

    try {
      await pushLog({
        accountId: result.accountId,
        accountName: result.accountName,
        domain: result.domain,
        trigger: result.trigger,
        authMode: result.authMode,
        status: result.status,
        ok: okStatus,
        points: result.points,
        message: result.message,
        detail: result.detail || '',
        identityChanged: result.identityChanged || '',
        exchange: result.exchange || '',
        elapsed: result.elapsed
      });
    } catch (e) {
      console.error('[checkinOne pushLog]', e);
    }

    try {
      // 无有效身份信息时保留旧快照，避免清空或用错账号覆盖。
      const snapshotPatch = (result.identityFailed || !result.email)
        ? (account.snapshot || null)
        : {
            email: result.email,
            userId: result.userId,
            leftDays: result.leftDays,
            points: result.pointsTotal,
            vip: result.vip,
            at: Date.now()
          };

      const todayPoints = result.servedTodayPoints != null
        ? result.servedTodayPoints
        : (result.status === 'success' ? result.points : null);

      await updateAccount(account.id, {
        last: {
          date: todayStr(),
          at: Date.now(),
          status: result.status,
          ok: okStatus,
          points: result.points,
          todayPoints,
          message: result.message,
          detail: result.detail || '',
          identityChanged: result.identityChanged || null,
          exchange: result.exchange || '',
          exchangeDate: result.exchangeOk
            ? todayStr()
            : (account.last ? account.last.exchangeDate : null),
          exchangePlan: result.exchangeOk
            ? (account.exchangePlan || 'none')
            : (account.last ? account.last.exchangePlan : null),
          trigger: result.trigger,
          authMode: result.authMode,
          ...retryStatePatch(account, result)
        },
        snapshot: result.email ? Object.assign({}, snapshotPatch, { todayPoints }) : snapshotPatch
      });
    } catch (e) {
      console.error('[checkinOne updateAccount]', e);
    }

    try {
      // 批量签到由 runAll 在所有账号结束后统一推送；单账号手动签到仍即时推送。
      if (!options.suppressNotify) await notifyResult(result, settings);
    } catch (e) { /* 通知失败不影响记录 */ }

    releaseKeepAlive();
  }
}

// ---- 登录态探测（不依赖 cookie 读取） ----

/**
 * 打开一个后台标签页，用浏览器自身的登录态请求 /api/user/status。
 * 这一步完全绕过 chrome.cookies，直接看服务端认不认当前会话。
 */
async function probeBrowserLogin(domain) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = tab.id;
    await chrome.tabs.update(tabId, { url: `https://${domain}/console/checkin` });
    const ok = await waitTabComplete(tabId, 20000);
    if (!ok) return { reachable: false, reason: '页面加载超时' };

    await sleep(800);

    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const out = { path: location.pathname, href: location.href };
        const getStatus = async (creds) => {
          try {
            const r = await fetch('/api/user/status', {
              credentials: creds,
              headers: { accept: 'application/json, text/plain, */*' }
            });
            const d = await r.json();
            return { httpStatus: r.status, data: d };
          } catch (e) {
            return { error: String(e && e.message || e) };
          }
        };

        // 带 cookie
        const withCookie = await getStatus('include');
        if (withCookie.error) {
          out.error = withCookie.error;
        } else {
          const d = withCookie.data || {};
          out.httpStatus = withCookie.httpStatus;
          out.code = d.code;
          out.email = (d.data && d.data.email) || null;
          out.leftDays = (d.data && d.data.leftDays != null) ? Number(d.data.leftDays) : null;
          out.vip = (d.data && d.data.vip != null) ? d.data.vip : null;
          out.message = d.message || null;
        }

        // 不带 cookie：用来证明登录态到底是不是靠 cookie
        const noCookie = await getStatus('omit');
        out.omitCode = noCookie.error ? null : (noCookie.data && noCookie.data.code);

        // 页面可见的 cookie（httpOnly 的看不到，仅作参考）
        try {
          out.docCookieNames = document.cookie
            ? document.cookie.split(';').map((s) => s.split('=')[0].trim()).filter(Boolean)
            : [];
        } catch (e) { out.docCookieNames = []; }

        // CookieStore：能拿到非 httpOnly 的条目
        try {
          if (window.cookieStore && window.cookieStore.getAll) {
            const list = await window.cookieStore.getAll();
            out.storeCookieNames = list.map((c) => c.name);
          }
        } catch (e) { /* ignore */ }

        return out;
      }
    });

    return Object.assign({ reachable: true, domain }, (res && res[0] && res[0].result) || {});
  } catch (e) {
    return { reachable: false, reason: String(e && e.message || e) };
  } finally {
    if (tabId != null) {
      await sleep(300);
      try { await chrome.tabs.remove(tabId); } catch (e) { /* ignore */ }
    }
  }
}

// ---- 通知 ----

const STATUS_TEXT = {
  success: '签到成功',
  repeat: '重复签到',
  turnstile: '验证未通过',
  device: '设备不一致',
  fail: '签到失败'
};

/**
 * 推送消息（换行方式按后端区分）：PushDeer 用 type=text，单 \n 即换行；
 * Server酱 按 Markdown 渲染，需行尾两空格 + \n 硬换行。
 * @param {string[]|string} content 推荐传行数组
 */
async function sendPushNotification(settings, title, content) {
  const lines = Array.isArray(content)
    ? content.map((s) => String(s))
    : String(content == null ? '' : content).split('\n');
  const pushdeerBody = lines.join('\n');        // 纯文本
  const serverchanBody = lines.join('  \n');    // Markdown 硬换行

  const results = [];
  const timeout = () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  };

  if (settings.pushdeerKey) {
    const t = timeout();
    try {
      const resp = await fetch('https://api2.pushdeer.com/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          pushkey: settings.pushdeerKey,
          text: title,
          desp: pushdeerBody,
          type: 'text'
        }),
        signal: t.signal
      });
      const data = await resp.json().catch(() => ({}));
      results.push({
        provider: 'PushDeer',
        ok: resp.ok && Number(data.code) === 0,
        message: data.message || ''
      });
    } catch (e) {
      results.push({ provider: 'PushDeer', ok: false, message: e.message || String(e) });
    } finally {
      t.done();
    }
  }

  if (settings.serverchanKey) {
    const t = timeout();
    const key = settings.serverchanKey;
    let url;
    if (/^https?:\/\//i.test(key)) {
      try {
        const u = new URL(key);
        if (!u.pathname.endsWith('.send')) {
          u.pathname = u.pathname.replace(/\/+$/, '') + '.send';
        }
        url = u.toString();
      } catch (e) {
        url = key;
      }
    } else {
      url = `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`;
    }
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title, desp: serverchanBody }),
        signal: t.signal
      });
      const data = await resp.json().catch(() => ({}));
      results.push({
        provider: 'ServerChan',
        ok: resp.ok && (Number(data.code) === 0 || data.data != null),
        message: data.message || data.errmsg || ''
      });
    } catch (e) {
      results.push({ provider: 'ServerChan', ok: false, message: e.message || String(e) });
    } finally {
      t.done();
    }
  }

  return results;
}

function logPushFailures(results) {
  const failed = (results || []).filter((r) => !r.ok);
  failed.forEach((r) => {
    console.warn(`[push] ${r.provider} 失败：${r.message || '未知错误'}`);
  });
  if (failed.length) {
    pushLog({
      status: 'info', ok: false, trigger: '-',
      accountName: '推送', domain: '-',
      message: `推送失败：${failed.map((r) => `${r.provider} ${r.message || ''}`.trim()).join('；')}`
    }).catch(() => {});
  }
}

async function notifyResult(result, settings) {
  // 单账号手动签到也使用与批量/Python 一致的报告格式。
  await notifySummary([result], settings, 0);
}

function sendTestNotification() {
  chrome.notifications.create(`glados-test-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'GLaDOS 自动签到',
    message: '桌面通知已生效'
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[notification test]', chrome.runtime.lastError.message);
    }
  });
}

async function notifySummary(results, settings, skipped) {
  if (!Array.isArray(results) || !results.length) return;

  const success = results.filter((r) => r.status === 'success').length;
  const repeat = results.filter((r) => r.status === 'repeat').length;
  const failed = results.length - success - repeat;
  const title = `GLaDOS 签到 · 成功 ${success} · 失败 ${failed} · 重复 ${repeat}`;

  // 与 Python 脚本的 Report.render 保持一致：
  // #1  大号  ✅ 签到成功  glados.cloud  获得 20 积分 · 剩余 48 天 · 总 409 积分
  // 账号名只在「多账号且至少一个有名字」时显示（单账号时省略，减少噪音）。
  const showName = results.length > 1 && results.some((r) => r.accountName);
  const lines = results.map((r, i) => {
    const emoji = r.status === 'success' ? '✅'
      : r.status === 'repeat' ? '🔄' : '🔴';
    const label = STATUS_TEXT[r.status] || r.status;
    const days = r.leftDays != null ? `${r.leftDays} 天` : 'None 天';
    const total = r.pointsTotal != null ? `${r.pointsTotal} 积分` : 'None 积分';
    const nameCell = showName ? `${r.accountName || '未命名'}  ` : '';
    let line = `#${i + 1}  ${nameCell}${emoji} ${label}  ${r.domain}  ` +
      `获得 ${r.points || 0} 积分 · 剩余 ${days} · 总 ${total}`;
    if (r.exchange) line += ` · ${r.exchange}`;
    return line;
  });
  if (skipped > 0) lines.push(`另有 ${skipped} 个账号跳过`);

  // 传行数组，由 sendPushNotification 按后端各自决定换行方式
  const pushResults = await sendPushNotification(settings || {}, title, lines);
  logPushFailures(pushResults);

  if (!settings || settings.notifyEnabled === false) return;
  try {
    chrome.notifications.create(`glados-summary-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: failed === 0 ? `✅ ${title}` : `⚠️ ${title}`,
      message: lines.join('\n')
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[notification summary]', chrome.runtime.lastError.message);
      }
    });
  } catch (e) { /* 通知失败不影响主流程 */ }
}

// ---- 批量签到 ----

let running = false;

/**
 * 依次给所有启用账号签到（同一站点串行，避免并发触发风控）。
 * @returns {Promise<{results:Array, skipped:number}>}
 */
async function runAll(options) {
  const opts = options || {};
  if (running) return { results: [], skipped: 0, busy: true };
  running = true;
  identityGuard = new Map();
  acquireKeepAlive();

  try {
    const { accounts, sites, settings } = await getState();
    const today = todayStr();
    const targets = [];
    const isAuto = (opts.trigger || 'auto') === 'auto';
    const autoSessionSites = new Set();
    let skippedDone = 0;

    for (const acc of accounts) {
      if (acc.enabled === false) continue;
      const site = sites.find((s) => s.id === acc.siteId);
      if (!site || site.enabled === false) continue;
      // 明确选了 cookie 模式却没填 Cookie 的，直接跳过（不要静默串到浏览器登录态）
      if (acc.authMode === 'cookie' && !acc.cookie) continue;

      // 自动任务只保留每个站点的第一个浏览器登录态账号，避免同一登录态被反复调度。
      if (isAuto && authModeOf(acc) === 'session') {
        if (autoSessionSites.has(site.id)) continue;
        autoSessionSites.add(site.id);
      }

      const sameDay = acc.last && acc.last.date === today;
      const done = sameDay && (acc.last.status === 'success' || acc.last.status === 'repeat');
      // 自动任务每天只跑一次（与 skipIfDone 无关），手动 force 可强制重跑。
      if (done && (settings.skipIfDone || isAuto) && !opts.force) {
        skippedDone++;
        continue;
      }

      // 自动任务遵守每日重试上限和退避；手动“立即签到”不受限制。
      if ((opts.trigger || 'auto') === 'auto' && sameDay) {
        if (acc.last.retryExhausted) continue;
        if (acc.last.nextRetryAt && acc.last.nextRetryAt > Date.now()) continue;
      }

      targets.push({ acc, site });
    }

    const results = [];
    const sessionSites = new Set();

    for (const t of targets) {
      // 同一站点只能有一个 session 账号：浏览器只有一个登录态
      if (authModeOf(t.acc) === 'session') {
        if (sessionSites.has(t.site.id)) {
          const dup = {
            accountId: t.acc.id,
            accountName: t.acc.name || t.acc.id,
            domain: t.site.domain,
            trigger: opts.trigger || 'auto',
            authMode: 'session',
            status: 'fail',
            points: 0,
            message: '同一站点只能有一个「浏览器登录态」账号，多账号请改为填写 Cookie'
          };
          results.push(dup);
          try {
            await pushLog({
              accountId: dup.accountId, accountName: dup.accountName, domain: dup.domain,
              trigger: dup.trigger, status: dup.status, ok: false, points: 0, message: dup.message
            });
          } catch (err) { /* ignore */ }
          try {
            await updateAccount(t.acc.id, {
              last: {
                date: today, status: 'fail', message: dup.message, at: Date.now()
              }
            });
          } catch (err) { /* ignore */ }
          continue;
        }
        sessionSites.add(t.site.id);
      }

      // 每个账号之间加一点间隔，降低集中请求特征
      if (results.length > 0) await sleep(1500 + Math.random() * 2500);
      try {
        // 批量一律后台执行，避免每个账号都抢窗口
        const r = await checkinOne(t.acc, t.site, settings, opts.trigger || 'auto',
          { force: !!opts.force, suppressNotify: true, foreground: false });
        results.push(r);
      } catch (e) {
        // 单账号异常不中断整轮
        const r = {
          accountId: t.acc.id,
          accountName: t.acc.name || t.acc.id,
          domain: t.site.domain,
          trigger: opts.trigger || 'auto',
          status: 'fail',
          points: 0,
          message: `未捕获异常：${e.message || e}`
        };
        results.push(r);
        try {
          await pushLog({
            accountId: r.accountId, accountName: r.accountName, domain: r.domain,
            trigger: r.trigger, status: r.status, ok: false, points: 0, message: r.message
          });
        } catch (err) { /* ignore */ }
      }
    }

    const skipped = skippedDone;
    try {
      await notifySummary(results, settings, skipped);
    } catch (e) { /* 汇总推送失败不影响结果 */ }

    return { results, skipped };
  } finally {
    running = false;
    releaseKeepAlive();
  }
}

// ---- 调度 ----

async function ensureAlarms() {
  const existing = await chrome.alarms.get(ALARM_TICK);
  if (!existing) {
    chrome.alarms.create(ALARM_TICK, { delayInMinutes: 1, periodInMinutes: 15 });
  }
}

async function clearDelayPlan() {
  await chrome.alarms.clear(ALARM_DELAY);
  await chrome.storage.local.remove(DELAY_PLAN);
}

function randomDelayMinutes(settings, now) {
  const limit = Math.max(0.5, Math.min(settings.maxDelayMinutes || 45, 59 - now.getMinutes()));
  return Math.random() * limit + 0.5; // 至少 30 秒
}

async function tick() {
  const { accounts, sites, settings } = await getState();
  if (!accounts.length) {
    await clearDelayPlan();
    return;
  }

  const now = new Date();
  const today = todayStr(now);
  const hour = now.getHours();
  const target = Number(settings.targetHour);

  // 是否有待签账号
  const autoSessionSites = new Set();
  const pending = accounts.filter((a) => {
    if (a.enabled === false) return false;
    const site = sites.find((s) => s.id === a.siteId);
    if (!site || site.enabled === false) return false;
    if (a.authMode === 'cookie' && !a.cookie) return false;
    // 同一站点只让第一个浏览器登录态账号参与自动调度
    if (authModeOf(a) === 'session') {
      if (autoSessionSites.has(site.id)) return false;
      autoSessionSites.add(site.id);
    }
    const sameDay = a.last && a.last.date === today;
    const done = sameDay && (a.last.status === 'success' || a.last.status === 'repeat');
    if (sameDay) {
      if (a.last.retryExhausted) return false;
      if (a.last.nextRetryAt && a.last.nextRetryAt > Date.now()) return false;
    }
    // 已签成功即结束；不看 skipIfDone，否则会每 15 分钟重跑
    return !done;
  });

  if (!pending.length) {
    await clearDelayPlan();
    return;
  }

  if (hour < target) {
    // 清理可能从昨天残留的计划，避免它在新计划前触发
    await clearDelayPlan();
    return;
  }

  if (hour === target) {
    const existing = await chrome.alarms.get(ALARM_DELAY);
    const { [DELAY_PLAN]: plan } = await chrome.storage.local.get(DELAY_PLAN);
    if (existing && plan && plan.date === today) return; // 今日随机计划已在排队
    if (existing || plan) await clearDelayPlan();

    // 23:58 之后再随机延迟必然跨日，直接立即补签，避免把计划带到明天。
    if (target === 23 && now.getMinutes() >= 58) {
      await runAll({ trigger: 'auto' });
      return;
    }

    const delay = randomDelayMinutes(settings, now);
    await chrome.storage.local.set({
      [DELAY_PLAN]: { date: today, at: Date.now() + delay * 60000 }
    });
    chrome.alarms.create(ALARM_DELAY, { delayInMinutes: delay });
    await pushLog({
      status: 'info', ok: true, trigger: 'auto',
      accountName: '调度', domain: '-',
      message: `已安排今日随机签到：约 ${delay.toFixed(1)} 分钟后执行`
    });
    return;
  }

  // hour > target：错过时间窗，清理旧计划后直接补签
  await clearDelayPlan();
  await runAll({ trigger: 'auto' });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TICK) {
    try { await tick(); } catch (e) { console.error('[tick]', e); }
  } else if (alarm.name === ALARM_DELAY) {
    acquireKeepAlive();
    try {
      const { [DELAY_PLAN]: plan } = await chrome.storage.local.get(DELAY_PLAN);
      if (!plan || plan.date !== todayStr()) {
        await clearDelayPlan();
        await tick();
        return;
      }

      const jitter = 1000 + Math.random() * 20000; // 秒级抖动
      await sleep(jitter);

      // 抖动期间跨过午夜：不要把昨天的计划算到今天
      if (plan.date !== todayStr()) {
        await clearDelayPlan();
        await tick();
        return;
      }

      try {
        await runAll({ trigger: 'auto' });
      } finally {
        await chrome.storage.local.remove(DELAY_PLAN);
      }
    } catch (e) { console.error('[delay]', e); }
    finally { releaseKeepAlive(); }
  }
});

// ---- 生命周期 ----

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    const { accounts } = await chrome.storage.local.get('accounts');
    if (!Array.isArray(accounts)) await chrome.storage.local.set({ accounts: [] });

    const { sites } = await chrome.storage.local.get('sites');
    const mergedSites = mergeDefaultSites(sites);
    await chrome.storage.local.set({ sites: mergedSites });

    const { settings } = await chrome.storage.local.get('settings');
    if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });

    await ensureAlarms();
    await clearDelayPlan();

    if (details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    }
  })().catch((e) => console.error('[onInstalled]', e));
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await ensureAlarms();
    await clearAllSessionRules();
    // 重新启动后旧随机闹钟可能已失去日期上下文，按当前时间重新判断。
    await clearDelayPlan();
    await tick();
  })().catch((e) => console.error('[onStartup]', e));
});

// ---- 消息路由（popup / options 调用） ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'getState': {
          // 顺带确保定时器存在（Service Worker 被回收后 alarms 可能缺失）
          await ensureAlarms();
          const s = await getState();
          sendResponse({ ok: true, state: s, today: todayStr(), version: EXT_VERSION });
          break;
        }
        case 'saveState': {
          const patch = msg.patch || {};
          const allowed = {};
          if (patch.sites) allowed.sites = patch.sites;
          if (patch.settings) {
            const current = await chrome.storage.local.get('settings');
            allowed.settings = Object.assign(
              {}, DEFAULT_SETTINGS, current.settings || {}, patch.settings
            );
          }
          await withAccountLock(async () => {
            if (patch.accounts) {
              const stored = await chrome.storage.local.get('accounts');
              const prev = Array.isArray(stored.accounts) ? stored.accounts : [];
              const prevById = new Map(prev.map((a) => [a.id, a]));
              allowed.accounts = patch.accounts.map((a) => {
                const old = a && a.id ? prevById.get(a.id) : null;
                if (!old) return a;
                const merged = Object.assign({}, old, a);
                const oldAt = (old.last && old.last.at) || 0;
                const newAt = (a.last && a.last.at) || 0;
                if (oldAt > newAt) merged.last = old.last;
                const oldSnap = (old.snapshot && old.snapshot.at) || 0;
                const newSnap = (a.snapshot && a.snapshot.at) || 0;
                if (oldSnap > newSnap) merged.snapshot = old.snapshot;
                return merged;
              });
            }
            await saveState(allowed);
          });
          // 设置变更后清掉过期计划，由下一次 tick 重新安排
          if (patch.accounts || patch.sites || patch.settings) {
            await chrome.alarms.clear(ALARM_DELAY);
            await chrome.storage.local.remove(DELAY_PLAN);
          }
          sendResponse({ ok: true });
          break;
        }
        case 'runAll': {
          const r = await runAll({ trigger: 'manual', force: !!msg.force });
          sendResponse({ ok: true, ...r });
          break;
        }
        case 'runOne': {
          if (running) {
            sendResponse({ ok: false, error: '已有签到任务正在运行，请稍后再试' });
            break;
          }
          running = true;
          identityGuard = new Map();
          try {
            const { accounts, sites, settings } = await getState();
            const acc = accounts.find((a) => a.id === msg.accountId);
            const site = acc && sites.find((s) => s.id === acc.siteId);
            if (!acc || !site) {
              sendResponse({ ok: false, error: '账号或站点不存在' });
              break;
            }
            // 单账号测试默认切到前台，便于观察点击与完成验证
            const r = await checkinOne(acc, site, settings, 'manual',
              { force: true, foreground: msg.foreground !== false });
            sendResponse({ ok: true, result: r });
          } finally {
            running = false;
          }
          break;
        }
        case 'getCalendar': {
          // 只读日历不要清空 identityGuard，否则会削弱正在进行的多账号防串号检查。
          const { accounts, sites } = await getState();
          const acc = accounts.find((a) => a.id === msg.accountId);
          const site = acc && sites.find((s) => s.id === acc.siteId);
          if (!acc || !site) {
            sendResponse({ ok: false, error: '账号或站点不存在' });
            break;
          }
          const cal = await getCalendar(acc, site, msg.days || 30);
          sendResponse({ ok: true, result: cal });
          break;
        }
        case 'clearLogs': {
          await chrome.storage.local.set({ logs: [] });
          sendResponse({ ok: true });
          break;
        }
        case 'probeLogin': {
          // 决定性诊断：不读 cookie，直接用浏览器当前登录态请求接口
          const domain = msg.domain || 'glados.cloud';
          const res = await probeBrowserLogin(domain);
          sendResponse({ ok: true, result: res });
          break;
        }
        case 'resetSession': {
          if (running) {
            sendResponse({ ok: false, error: '签到进行中，请稍后再重置' });
            break;
          }
          await clearAllSessionRules();
          for (const [tabId] of Array.from(keptTabs.entries())) {
            try { await chrome.tabs.remove(tabId); } catch (e) { /* 已关闭 */ }
          }
          keptTabs.clear();
          await persistKeptTabs();
          sendResponse({ ok: true });
          break;
        }
        case 'testNotification': {
          const permissionLevel = await new Promise((resolve) => {
            if (typeof chrome.notifications.getPermissionLevel !== 'function') {
              resolve('unknown');
              return;
            }
            chrome.notifications.getPermissionLevel((level) => resolve(level));
          });
          sendTestNotification();
          sendResponse({ ok: true, permissionLevel });
          break;
        }
        case 'testPush': {
          const { settings } = await getState();
          const results = await sendPushNotification(
            settings,
            'GLaDOS 自动签到测试推送',
            [
              '如果你看到这条消息，说明推送配置已生效。',
              '第 1 行：换行自检',
              '第 2 行：如果三行分开显示，说明换行正确'
            ]
          );
          sendResponse({
            ok: results.length > 0 && results.every((r) => r.ok),
            results,
            error: results.length ? '' : '未配置 PushDeer 或 ServerChan SendKey'
          });
          break;
        }
        case 'testProxy': {
          sendResponse({ ok: false, error: 'not-supported' });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // 异步响应
});
