/**
 * options.js —— 设置界面逻辑
 */

'use strict';

const COOKIE_NAMES = [
  'koa:sess', 'koa:sess.sig',
  'gld:accts', 'gld:accts.sig',
  'gld:sess', 'gld:sess.sig'
];

const STATUS_LABEL = {
  success: '成功',
  repeat: '已签到',
  turnstile: '验证未通过',
  device: '设备不一致',
  fail: '失败',
  info: '提示'
};

const BUILTIN_SITE_IDS = new Set([
  'glados-cloud',
  'glados-network',
  'glados-rocks',
  'glados-one',
  'glados-space',
  'glados-vip',
  'glados-facility',
  'railgun'
]);

const $ = (id) => document.getElementById(id);

let STATE = null;
let TODAY = '';
let editingId = null;
let busy = false;
let accMode = 'session';
let settingsDirty = false;

const MODE_HINT = {
  session: '使用当前浏览器已登录的 GLaDOS 会话，无需填写 Cookie。同一站点只能有一个。',
  cookie: '粘贴该账号的完整 Cookie；可添加多个账号。'
};

// ---- 通信 ----
function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp) {
        reject(new Error('无响应，请重新加载扩展'));
        return;
      }
      if (resp.ok === false) {
        reject(new Error(resp.error || '操作失败'));
        return;
      }
      resolve(resp);
    });
  });
}

// ---- 工具 ----
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function siteOf(acc) {
  return (STATE.sites || []).find((s) => s.id === acc.siteId) || null;
}

function nextAccountName(accounts) {
  let max = 0;
  for (const acc of accounts || []) {
    const m = String(acc.name || '').match(/^账号\s*(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return `账号 ${max + 1}`;
}

function planLabel(vip) {
  const n = Number(vip);
  if (!Number.isFinite(n)) return '—';
  if (n === 0 || n === 10) return 'Free';
  if (n === 11) return 'Edu';
  if (n === 21) return 'Basic';
  if (n === 31) return 'Pro';
  if (n === 41) return 'Team';
  if (n === 51) return 'Enterprise';
  return `VIP ${n}`;
}

/** 与 background.js 保持一致：有 Cookie 即 cookie 模式，否则走浏览器登录态 */
function authModeOf(acc) {
  if (!acc) return 'session';
  if (!acc.cookie) return 'session';
  return 'cookie';
}

function parseCookiePairs(header) {
  const pairs = new Map();
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && value) pairs.set(name, value);
  });
  return pairs;
}

/** Cookie 至少要有 gld 或 koa 的 sess + sig 成对字段。 */
function hasSessionPair(header) {
  const pairs = parseCookiePairs(header);
  const gld = Boolean(pairs.get('gld:sess') && pairs.get('gld:sess.sig'));
  const koa = Boolean(pairs.get('koa:sess') && pairs.get('koa:sess.sig'));
  return gld || koa;
}

function todayStatus(acc) {
  const last = acc.last;
  if (!last) return { cls: 'idle', label: '未执行', text: '今日未签到' };
  if (last.date === TODAY) {
    const cls = last.status === 'success' ? 'success'
      : last.status === 'repeat' ? 'repeat'
      : (last.status === 'turnstile' || last.status === 'device' || last.status === 'fail') ? 'fail'
      : 'idle';
    const time = new Date(last.at);
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    return { cls, label: STATUS_LABEL[last.status] || last.status, text: `${hh}:${mm}` };
  }
  return { cls: 'idle', label: '未执行', text: '今日未签到' };
}

function todayEarned(acc) {
  const last = acc && acc.last;
  if (!last || last.date !== TODAY) return null;
  if (last.todayPoints != null) return Math.max(0, Number(last.todayPoints) || 0);
  const snapshot = acc.snapshot || {};
  if (snapshot.todayPoints != null) return Math.max(0, Number(snapshot.todayPoints) || 0);
  if (last.status === 'success') {
    return Math.max(0, Number(last.points) || 0);
  }
  return null;
}

function lastMessageOf(last, today) {
  if (!last) return null;
  const isToday = last.date === today;
  return {
    isToday,
    message: last.message || '',
    boost: isToday && last.status === 'success' && last.points > 0 ? last.points : null
  };
}

function dotCls(acc) {
  const t = todayStatus(acc);
  if (t.cls === 'success' || t.cls === 'repeat') return 'ok';
  if (t.cls === 'fail') return 'err';
  return '';
}

// ---- 渲染：账号 ----
function renderAccounts() {
  const list = $('accountList');
  const accounts = STATE.accounts || [];
  $('badgeAccounts').textContent = String(accounts.length);
  $('accountsEmpty').hidden = accounts.length > 0;

  list.innerHTML = accounts.map((acc) => {
    const site = siteOf(acc);
    const st = todayStatus(acc);
    const snap = acc.snapshot || {};
    const last = acc.last || null;
    const mode = authModeOf(acc);
    const earnedToday = todayEarned(acc);

    const lm = lastMessageOf(last, TODAY);
    const lastMsg = !lm ? ''
      : (lm.isToday
          ? `${escapeHtml(lm.message)}${lm.boost != null ? ` <strong>+${lm.boost}</strong>` : ''}`
          : `上次 ${escapeHtml(lm.message)}`);
    const lastMain = last
      ? `<div class="acc-last-main">
           <span class="pill ${st.cls === 'idle' ? 'idle' : st.cls}">${escapeHtml(st.label)}</span>
           <span class="acc-last-msg">${lastMsg}</span>
           <span class="acc-last-time">${escapeHtml(lm.isToday ? st.text : last.date)}</span>
         </div>`
      : `<div class="acc-last-main">
           <span class="pill idle">未执行</span>
           <span class="acc-last-msg">尚未签到</span>
         </div>`;

    let retryNote = '';
    if (last && last.date === TODAY &&
        last.status !== 'success' && last.status !== 'repeat') {
      if (last.retryExhausted) {
        retryNote = '今日自动重试已用尽，明天再试';
      } else if (last.nextRetryAt) {
        const t = new Date(last.nextRetryAt);
        retryNote = `下次自动重试：${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      }
    }
    const detailText = [last && last.detail, retryNote].filter(Boolean).join(' · ');
    const detail = detailText
      ? `<div class="acc-detail">${escapeHtml(detailText)}</div>`
      : '';

    return `
      <article class="acc-card ${acc.enabled === false ? 'is-off' : ''}" data-id="${escapeHtml(acc.id)}">
        <div class="acc-top">
          <span class="acc-dot ${dotCls(acc)}"></span>
          <span class="acc-name" title="${escapeHtml(acc.name || '未命名')}">${escapeHtml(acc.name || '未命名')}</span>
          <span class="acc-site" title="${escapeHtml(site ? site.domain : '')}">${escapeHtml(site ? site.domain : '站点缺失')}</span>
          <span class="acc-mode">${mode === 'session' ? '浏览器登录态' : 'Cookie'}</span>
          ${acc.exchangePlan && acc.exchangePlan !== 'none'
            ? `<span class="acc-mode" title="签到后自动兑换">兑换 ${escapeHtml(acc.exchangePlan.replace('plan', ''))}</span>`
            : ''}
          ${acc.enabled === false ? '<span class="acc-off-tag">已停用</span>' : ''}
        </div>

        <div class="acc-body">
          <div class="acc-metric">
            <div class="acc-metric-label">账号</div>
            <div class="acc-metric-value" title="${escapeHtml(snap.email || '')}">${escapeHtml(snap.email || '—')}</div>
          </div>
          <div class="acc-metric">
            <div class="acc-metric-label">剩余天数</div>
            <div class="acc-metric-value">${snap.leftDays != null ? snap.leftDays + ' 天' : '—'}</div>
          </div>
          <div class="acc-metric">
            <div class="acc-metric-label">总积分</div>
            <div class="acc-metric-value">${snap.points != null ? snap.points : '—'}</div>
          </div>
          <div class="acc-metric">
            <div class="acc-metric-label">会员版本</div>
            <div class="acc-metric-value">${planLabel(snap.vip)}</div>
          </div>
          <div class="acc-metric">
            <div class="acc-metric-label">今日已获取</div>
            <div class="acc-metric-value">${earnedToday != null ? `+${earnedToday} 分` : '—'}</div>
          </div>
        </div>

        <div class="acc-last">${lastMain}${detail}</div>

        <div class="acc-actions">
          <button class="btn btn-sm btn-ghost" data-act="checkin" data-id="${escapeHtml(acc.id)}" title="真实签到；今日已签通常不会加积分">立即签到</button>
          <button class="btn btn-sm btn-ghost" data-act="edit" data-id="${escapeHtml(acc.id)}">编辑</button>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-danger" data-act="del" data-id="${escapeHtml(acc.id)}">删除</button>
        </div>
      </article>
    `;
  }).join('');

  const signedCount = accounts.filter((a) => {
    const t = todayStatus(a);
    return t.cls === 'success' || t.cls === 'repeat';
  }).length;
  $('todaySummary').textContent = accounts.length
    ? `${signedCount} / ${accounts.length}`
    : '无账号';
}

// ---- 渲染：站点 ----
function renderSites() {
  const tbody = $('siteList');
  tbody.innerHTML = (STATE.sites || []).map((s) => `
    <tr class="${s.enabled === false ? 'is-off' : ''}" data-id="${escapeHtml(s.id)}">
      <td>
        <input type="checkbox" class="switch" data-act="site-toggle"
               data-id="${escapeHtml(s.id)}" ${s.enabled !== false ? 'checked' : ''}>
      </td>
      <td class="mono">${escapeHtml(s.domain)}</td>
      <td>
        <button class="btn btn-sm btn-ghost" data-act="site-del" data-id="${escapeHtml(s.id)}"
                ${BUILTIN_SITE_IDS.has(s.id) ? 'disabled title="内置站点不可删除，请使用启用/停用"' : ''}>删除</button>
      </td>
    </tr>
  `).join('');
}

// ---- 渲染：服务器日历 ----
let calBusy = false;
let calendarLoaded = false;

function fillCalAccounts() {
  const sel = $('calAccount');
  const accounts = (STATE.accounts || []).filter((a) => a.enabled !== false);
  const prev = sel.value;
  sel.innerHTML = accounts
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}</option>`)
    .join('');
  if (prev && accounts.some((a) => a.id === prev)) sel.value = prev;
}

async function loadCalendar(accountId) {
  if (calBusy) return;
  const id = accountId || $('calAccount').value;
  if (!id) {
    $('calStatus').hidden = false;
    $('calStatus').className = 'cal-status is-error';
    $('calStatus').textContent = '还没有账号，请先在「账号」页添加。';
    $('calGrid').innerHTML = '';
    $('calBoard').hidden = true;
    return;
  }

  calBusy = true;
  const btn = $('btnCalRefresh');
  const oldLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '读取中…';
  $('calBoard').hidden = true;
  $('calStatus').hidden = false;
  $('calStatus').className = 'cal-status';
  $('calStatus').textContent = '正在打开后台签到页读取服务器数据…';

  try {
    const resp = await send('getCalendar', { accountId: id, days: 30 });
    const r = resp.result || {};

    if (!r.ok) {
      $('calStatus').className = 'cal-status is-error';
      $('calStatus').textContent = r.loggedIn === false
        ? `未登录：${r.error || '该账号在这个浏览器里没有有效会话'}`
        : `读取失败：${r.error || '未知错误'}`;
      $('calGrid').innerHTML = '';
      $('calBoard').hidden = true;
      $('calPoints').textContent = '—';
      $('calStreak').textContent = '—';
      $('calLeftDays').textContent = '—';
      $('calToday').textContent = '—';
      return;
    }

    $('calPoints').textContent = r.points != null ? `${r.points} 点` : '—';
    $('calStreak').textContent = r.streak != null ? `${r.streak} 天` : '—';
    $('calLeftDays').textContent = r.leftDays != null ? `${r.leftDays} 天` : '—';
    $('calToday').textContent = r.alreadyToday
      ? `已签 +${r.todayPoints}`
      : '未签';

    $('calStatus').hidden = true;

    const leadingBlanks = Math.max(0, Math.min(6, Number(r.leadingBlanks) || 0));
    const blanks = Array.from({ length: leadingBlanks }, () =>
      '<div class="cal-cell cal-blank" aria-hidden="true"></div>'
    ).join('');

    $('calBoard').hidden = false;
    $('calGrid').innerHTML = blanks + (r.days || []).map((d) => {
      const cls = [
        'cal-cell',
        d.checked ? 'is-checked' : '',
        d.isToday ? 'is-today' : ''
      ].filter(Boolean).join(' ');
      return `
        <div class="${cls}" title="${escapeHtml(d.key)}：${d.checked ? '已签到 +' + d.points + ' 点' : '未签到'}">
          <span class="cal-date">${escapeHtml(d.isToday ? '今日' : d.label)}</span>
          <span class="cal-pts">${d.checked ? '+' + d.points : '—'}</span>
        </div>
      `;
    }).join('');
    calendarLoaded = true;
  } catch (e) {
    $('calStatus').hidden = false;
    $('calStatus').className = 'cal-status is-error';
    $('calStatus').textContent = `读取失败：${e.message}`;
    $('calBoard').hidden = true;
  } finally {
    calBusy = false;
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

// ---- 渲染：调度 ----
function renderSchedule() {
  const s = STATE.settings || {};
  $('targetHour').value = s.targetHour != null ? s.targetHour : 9;
  $('maxDelay').value = s.maxDelayMinutes != null ? s.maxDelayMinutes : 45;
  $('minStay').value = s.minStayMs != null ? s.minStayMs : 4500;
  $('maxStay').value = s.maxStayMs != null ? s.maxStayMs : 6500;
  $('skipIfDone').checked = s.skipIfDone !== false;
  $('notifyEnabled').checked = s.notifyEnabled !== false;
  $('autoClickTurnstile').checked = s.autoClickTurnstile === true;
  $('foregroundOnManual').checked = s.foregroundOnManual !== false;
  $('humanVerify').checked = s.humanVerify !== false;
  $('keepTabOnVerify').checked = s.keepTabOnVerify !== false;
  $('updateCheckEnabled').checked = s.updateCheckEnabled !== false;
}

// ---- 渲染：推送 ----
function renderPush() {
  const s = STATE.settings || {};
  $('pushdeerKey').value = s.pushdeerKey || '';
  $('serverchanKey').value = s.serverchanKey || '';
}

// ---- 渲染：日志 ----
function renderLogs() {
  const logs = STATE.logs || [];
  $('logsEmpty').hidden = logs.length > 0;
  $('logList').innerHTML = logs.slice(0, 120).map((l) => {
    const cls = l.status === 'success' ? 'success'
      : l.status === 'repeat' ? 'repeat'
      : l.status === 'info' ? 'idle'
      : 'fail';
    const label = STATUS_LABEL[l.status] || l.status;
    const time = (l.time || '').slice(5);
    return `
      <div class="log-row">
        <span class="log-time">${escapeHtml(time)}</span>
        <span class="log-msg">
          <strong>${escapeHtml(l.accountName || '-')}</strong>
          <span style="color:var(--text-faint)"> · ${escapeHtml(l.domain || '-')} · </span>
          ${escapeHtml(l.message || '')}
          ${l.detail ? `<span class="log-detail">${escapeHtml(l.detail)}</span>` : ''}
        </span>
        <span class="log-right">
          ${l.points > 0 ? `<strong style="color:var(--success)">+${l.points}</strong>` : ''}
          <span class="pill ${cls}">${escapeHtml(label)}</span>
        </span>
      </div>
    `;
  }).join('');
}

// ---- 更新 ----
const UPDATE_STAMP_KEY = 'gcd_update_checked_at';
const UPDATE_CACHE_KEY = 'gcd_update_last_result';
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;   // 1 小时内不重复联网

let pendingRelease = null;
let updateBusy = false;
let notesOpen = false;

const curVer = () => chrome.runtime.getManifest().version;

/** 更新区只有一行：状态文字 + 至多一个可点的按钮。 */
function setUpdateLine(cls, text) {
  $('updateBar').className = 'update-line' + (cls ? ' ' + cls : '');
  $('updateState').textContent = text;
}

function setNotes(text) {
  const btn = $('btnToggleNotes');
  const el = $('updateNotes');
  if (!text) {
    btn.hidden = true;
    el.hidden = true;
    el.textContent = '';
    notesOpen = false;
    return;
  }
  el.textContent = text;
  btn.hidden = false;
  btn.textContent = notesOpen ? '收起说明' : '更新说明';
  el.hidden = !notesOpen;
}

/** 只保留一个按钮可见。name 为 null 时全部隐藏。 */
function showOnly(name) {
  for (const id of ['btnCheckUpdate', 'btnApplyUpdate', 'btnReloadExt']) {
    $(id).hidden = id !== name;
  }
}

/** 把版本号格式化成「v1.1.1」；非法值返回「v?」。 */
function vTag(v) {
  const p = window.Updater && Updater.parseVer(v);
  return p ? `v${p.join('.')}` : `v${v || '?'}`;
}

function fmtAgo(ts) {
  const d = Date.now() - Number(ts || 0);
  if (!Number.isFinite(d) || d < 0) return '';
  const m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 决定更新区显示内容（纯函数，便于单测）。
 * @returns {{cls:string, text:string, button:string|null, stale:boolean}} stale=需要联网
 */
function decideUpdateView(input) {
  const cur = String(input.current || '');
  const last = input.lastResult || null;
  const checkedAt = Number(input.checkedAt || 0);
  const interval = Number(input.intervalMs || UPDATE_INTERVAL_MS);

  // 1) 有上次结果且确实有新版本 → 直接给出「更新」按钮，不需要联网
  if (last && last.latest && Updater.compareVer(last.latest, cur) > 0) {
    const ago = fmtAgo(checkedAt);
    return {
      cls: 'is-new',
      text: `${vTag(cur)} → ${vTag(last.latest)}  有新版本` + (ago ? `（${ago}检查）` : ''),
      button: 'btnApplyUpdate',
      stale: false
    };
  }

  // 2) 距上次检查还在节流窗口内 → 显示上次结论，不联网
  if (checkedAt && Date.now() - checkedAt < interval) {
    return {
      cls: '',
      text: `${vTag(cur)} · 已是最新（${fmtAgo(checkedAt)}检查）`,
      button: 'btnCheckUpdate',
      stale: false
    };
  }

  // 3) 需要联网检查
  return {
    cls: '',
    text: `${vTag(cur)} · 正在检查…`,
    button: null,
    stale: true
  };
}

/**
 * 检查更新。
 * @param {boolean} manual true 时忽略节流，失败时弹 toast
 */
async function checkUpdate(manual) {
  if (updateBusy) return;
  if (!window.Updater) {
    setUpdateLine('is-error', '更新模块未加载，请重新加载扩展');
    showOnly('btnCheckUpdate');
    if (manual) toast('更新模块未加载，请重新加载扩展', true);
    return;
  }

  updateBusy = true;
  const btn = $('btnCheckUpdate');
  btn.disabled = true;
  // 自动检查也要显示进行中，否则界面看起来毫无反应
  setUpdateLine('', `${vTag(curVer())} · 正在检查…`);
  showOnly(null);

  try {
    const r = await Updater.check();

    if (r.error) {
      setUpdateLine('is-error', `检查失败：${r.error}`);
      showOnly('btnCheckUpdate');
      setNotes('');
      if (manual) toast('检查更新失败：' + r.error, true);
      return;
    }

    const now = Date.now();
    await chrome.storage.local.set({
      [UPDATE_STAMP_KEY]: now,
      [UPDATE_CACHE_KEY]: {
        current: r.current,
        latest: r.latest,
        hasUpdate: r.hasUpdate,
        notes: (r.release && r.release.notes) || '',
        at: now
      }
    });

    if (r.hasUpdate) {
      pendingRelease = r.release;
      setUpdateLine('is-new', `${vTag(r.current)} → ${vTag(r.latest)}  有新版本`);
      showOnly('btnApplyUpdate');
      $('btnApplyUpdate').textContent = `更新到 ${vTag(r.latest)}`;
      setNotes(r.release.notes || '（该版本没有更新说明）');
      if (manual) toast(`发现新版本 ${vTag(r.latest)}`);
    } else {
      pendingRelease = null;
      setUpdateLine('', `${vTag(r.current)} · 已是最新（刚刚检查）`);
      showOnly('btnCheckUpdate');
      setNotes('');
      if (manual) toast('已是最新版本');
    }
  } catch (e) {
    setUpdateLine('is-error', `检查失败：${e.message}`);
    showOnly('btnCheckUpdate');
    if (manual) toast('检查更新失败：' + e.message, true);
  } finally {
    updateBusy = false;
    btn.disabled = false;
  }
}

async function applyUpdate() {
  if (updateBusy) return;
  if (!window.Updater) { toast('更新模块未加载', true); return; }
  if (busy) { toast('正在签到，请等签到结束后再更新', true); return; }

  updateBusy = true;
  const btn = $('btnApplyUpdate');
  btn.disabled = true;

  let rel = pendingRelease;
  let verTag = rel ? vTag(rel.version) : '';
  try {
    // 优先用缓存的版本信息
    if (!rel) {
      const cached = await readUpdateCache();
      const latest = cached && cached.latest;
      if (!latest || Updater.compareVer(latest, curVer()) <= 0) {
        toast('没有可更新的版本，请先检查更新', true);
        return;
      }
      try {
        const fresh = await Updater.fetchLatest();
        if (Updater.compareVer(fresh.version, curVer()) <= 0) {
          toast('已是最新版本', true);
          return;
        }
        rel = fresh;
        verTag = vTag(rel.version);
      } catch (e) {
        toast('获取更新包失败：' + e.message, true);
        return;
      }
    }

    const sure = confirm(
      `更新到 ${verTag}？\n\n` +
      '· 只覆盖安装包内的文件，不删除目录里的其他文件\n' +
      '· 旧文件会备份到 backups/\n' +
      '· 首次需要你指定一次扩展所在目录，之后会记住'
    );
    if (!sure) return;

    const r = await Updater.apply(rel, {
      backup: true,
      onProgress: (t) => setUpdateLine('is-new', t)
    });
    setUpdateLine('is-new', `已更新到 ${vTag(r.version)} · 需重新加载生效`);
    showOnly('btnReloadExt');
    setNotes('');
    pendingRelease = null;
    toast('更新完成，点「重新加载」生效');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      setUpdateLine('is-new', `${vTag(curVer())} → ${verTag}  已取消，可重试`);
      showOnly('btnApplyUpdate');
      return;
    }
    const m = String(e && e.message || e);
    setUpdateLine('is-error', `更新失败：${m}`);
    showOnly('btnCheckUpdate');
    toast('更新失败：' + m, true);
  } finally {
    updateBusy = false;
    btn.disabled = false;
  }
}

async function readUpdateCache() {
  try {
    const raw = await chrome.storage.local.get([UPDATE_STAMP_KEY, UPDATE_CACHE_KEY]);
    return Object.assign({ at: Number(raw[UPDATE_STAMP_KEY]) || 0 }, raw[UPDATE_CACHE_KEY] || {});
  } catch (e) {
    return null;
  }
}

/** 先用缓存渲染，过期再联网检查。 */
async function initUpdateBar() {
  if (!window.Updater) {
    setUpdateLine('is-error', '更新模块未加载，请重新加载扩展');
    showOnly('btnCheckUpdate');
    return;
  }

  const s = STATE.settings || {};
  const enabled = s.updateCheckEnabled !== false;
  const cached = await readUpdateCache();

  const view = decideUpdateView({
    current: curVer(),
    lastResult: cached,
    checkedAt: cached ? cached.at : 0,
    intervalMs: UPDATE_INTERVAL_MS
  });

  // 先渲染缓存结论：有新版本时断网也能看到「更新」按钮
  if (view.cls === 'is-new' || (cached && cached.latest)) {
    setUpdateLine(view.cls, view.text);
    showOnly(view.button);
    if (view.cls === 'is-new') {
      pendingRelease = null;   // 让 applyUpdate 走 fetchLatest 或缓存
      $('btnApplyUpdate').textContent = `更新到 ${vTag(cached.latest)}`;
      setNotes(cached.notes || '（该版本没有更新说明）');
    }
  } else {
    setUpdateLine('', `${vTag(curVer())} · 尚未检查`);
    showOnly('btnCheckUpdate');
  }

  if (!enabled) {
    if (!view.cls) {
      setUpdateLine('', `${vTag(curVer())} · 已关闭自动检查`);
      showOnly('btnCheckUpdate');
    }
    return;
  }

  // 进入联网态
  if (view.stale) {
    await checkUpdate(false);
  }
}
// ---- 加载/刷新 ----
async function reload() {
  const resp = await send('getState');
  STATE = resp.state;
  TODAY = resp.today;

  const mv = chrome.runtime.getManifest().version;
  const brandVersion = $('brandVersion');
  if (brandVersion) brandVersion.textContent = 'v' + mv;
  if (!resp.version || resp.version !== mv) {
    const el = $('versionWarn');
    if (el) {
      el.hidden = false;
      el.textContent =
        `⚠ 扩展未重新加载：后台运行 ${resp.version || '未知（旧版）'}，` +
        `界面 ${mv}。请到 chrome://extensions 点击「重新加载」，否则改动不生效。`;
    }
  }

  renderAccounts();
  renderSites();
  if (!settingsDirty) {
    renderSchedule();
    renderPush();
  }
  renderLogs();
  fillCalAccounts();
}

// ---- 账号弹窗 ----
/** 切换弹窗内的认证方式 UI */
function applyModeUI() {
  document.querySelectorAll('#accMode .seg-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === accMode);
  });
  $('cookieFields').hidden = accMode === 'session';
  $('modeHint').textContent = MODE_HINT[accMode] || '';
  $('modalTitle').textContent = (editingId ? '编辑账号' : '添加账号') +
    (accMode === 'session' ? ' · 浏览器登录态' : ' · Cookie');
}

function openModal(accountId) {
  editingId = accountId || null;
  const acc = editingId ? STATE.accounts.find((a) => a.id === editingId) : null;

  $('accName').value = acc ? (acc.name || '') : '';
  $('accName').placeholder = `留空自动命名为 ${nextAccountName(STATE.accounts)}`;
  $('accCookie').value = acc ? (acc.cookie || '') : '';
  $('accUa').value = acc ? (acc.userAgent || '') : '';
  $('accExchange').value = acc && acc.exchangePlan ? acc.exchangePlan : 'none';
  $('accEnabled').checked = acc ? acc.enabled !== false : true;

  // 新账号默认走浏览器登录态；编辑时按已有配置判断
  accMode = acc ? authModeOf(acc) : 'session';

  const sel = $('accSite');
  sel.innerHTML = (STATE.sites || [])
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.domain)}${
      s.enabled === false ? '（已停用，不会自动签到）' : ''
    }</option>`)
    .join('');
  if (acc && acc.siteId) sel.value = acc.siteId;

  applyModeUI();
  $('modalMask').hidden = false;
  setTimeout(() => (accMode === 'session' ? $('accName') : $('accCookie')).focus(), 30);
}

function closeModal() {
  $('modalMask').hidden = true;
  editingId = null;
}

async function saveAccount() {
  const name = $('accName').value.trim();
  const siteId = $('accSite').value;
  const cookie = $('accCookie').value.trim()
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/\s*\n\s*/g, ' ');
  const userAgent = $('accUa').value.trim();
  const exchangePlan = $('accExchange').value || 'none';
  const enabled = $('accEnabled').checked;

  if (!siteId) { toast('请先选择一个站点', true); return; }

  // 站点停用时账号不会被调度，保存前提示
  const chosenSite = (STATE.sites || []).find((s) => s.id === siteId);
  if (chosenSite && chosenSite.enabled === false) {
    if (!confirm(`站点「${chosenSite.domain}」当前处于停用状态，保存后该账号不会被自动签到。仍要保存吗？`)) {
      return;
    }
  }

  if (accMode === 'cookie') {
    if (!cookie) { toast('Cookie 模式必须填写 Cookie', true); return; }
    if (!hasSessionPair(cookie)) {
      toast('Cookie 缺少成对的 gld:sess/gld:sess.sig 或 koa:sess/koa:sess.sig', true);
      return;
    }
  }

  // 同一站点若已有另一个 session 账号，单独提示（浏览器只有一个登录态）
  if (accMode === 'session') {
    const clash = (STATE.accounts || []).find(
      (a) => a.id !== editingId && a.siteId === siteId && authModeOf(a) === 'session' && a.enabled !== false
    );
    if (clash) {
      toast(`「${clash.name}」已占用该站点的浏览器登录态；多账号请用 Cookie 模式`, true);
      return;
    }
  }

  const accounts = (STATE.accounts || []).slice();
  const finalName = name || nextAccountName(accounts);
  if (editingId) {
    const i = accounts.findIndex((a) => a.id === editingId);
    if (i >= 0) {
      accounts[i] = Object.assign({}, accounts[i], {
        name: finalName, siteId, cookie, userAgent, exchangePlan, enabled,
        authMode: accMode,
        // 从 cookie 切到 session 时清掉旧 Cookie，避免又走注入
        ...(accMode === 'session' ? { cookie: '' } : {})
      });
    }
  } else {
    accounts.push({
      id: 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: finalName,
      siteId, cookie, userAgent, exchangePlan, enabled, authMode: accMode,
      last: null, snapshot: null, createdAt: Date.now()
    });
  }

  await send('saveState', { patch: { accounts } });
  closeModal();
  await reload();
  toast('已保存');
}

// ---- 登录态探测 ----
async function probeLogin() {
  const btn = $('btnProbeLogin');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检测中…';

  const lines = [];
  try {
    // 只检查当前账号实际使用的站点，避免固定探测无关域名。
    let domains = [...new Set((STATE.accounts || [])
      .filter((acc) => acc.enabled !== false)
      .map((acc) => {
        const site = siteOf(acc);
        return site ? site.domain : '';
      })
      .filter(Boolean))];
    if (!domains.length) domains = ['glados.cloud'];

    for (const domain of domains) {
      let r;
      try {
        const resp = await send('probeLogin', { domain });
        r = resp.result || {};
      } catch (e) {
        lines.push(`[${domain}] 调用失败：${e.message}`);
        continue;
      }

      if (!r.reachable) {
        lines.push(`[${domain}] 无法访问：${r.reason || '未知'}`);
        continue;
      }

      if (r.error) {
        lines.push(`[${domain}] 请求异常：${r.error}`);
        continue;
      }

      if (r.code === 0 && r.email) {
        lines.push(`[${domain}] ✅ 已登录  ${r.email}  剩余 ${r.leftDays} 天  会员 ${planLabel(r.vip)}`);
        lines.push(`        当前页面：${r.path}`);
      } else if (r.code !== undefined) {
        lines.push(`[${domain}] ❌ 未登录  code=${r.code}  ${r.message || ''}`);
        lines.push(`        当前页面：${r.path}`);
      } else {
        lines.push(`[${domain}] ⚠️ 响应异常`);
      }

    }

    lines.push('');
    lines.push('该检测只验证「浏览器自己的登录态」，不读 Cookie、不测试签到或 Turnstile。');
    lines.push('因此 COOKIE 模式的账号可能在此显示未登录 —— 那是正常的，');
    lines.push('用账号卡上的「立即签到」才能验证 Cookie 是否有效。');

    showDiag(lines.join('\n'), '登录态检测');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---- 读取当前登录 ----
/** 所有可能存放登录态的域名（含别名），用于兜底扫描 */
const COOKIE_SCAN_DOMAINS = [
  'glados.cloud', 'glados.network', 'glados.rocks',
  'glados.one', 'glados.space', 'glados.vip',
  'railgun.info', 'glados-facility.com'
];

/** 多方式读取某域名的 cookie 并去重（不同 Chrome 版本行为有差异）。 */
async function collectCookies(domain) {
  const seen = new Map(); // `${host}|${name}` -> cookie

  const addAll = (list) => {
    (list || []).forEach((c) => {
      const key = c.domain + '|' + c.name + '|' + (c.path || '');
      if (!seen.has(key)) seen.set(key, c);
    });
  };

  // 方式一：url 过滤（推荐，包含 host-only 与父域 cookie）
  for (const scheme of ['https']) {
    try {
      addAll(await chrome.cookies.getAll({ url: `${scheme}://${domain}/` }));
    } catch (e) { /* 忽略，继续下一种 */ }
  }

  // 方式二：domain 过滤
  try {
    addAll(await chrome.cookies.getAll({ domain }));
  } catch (e) { /* 忽略 */ }

  // 方式三：全量枚举后按域名后缀过滤
  try {
    const all = await chrome.cookies.getAll({});
    addAll(all.filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '');
      return d === domain || d.endsWith('.' + domain) || domain.endsWith('.' + d);
    }));
  } catch (e) { /* 忽略 */ }

  return Array.from(seen.values());
}

/**
 * 把 cookie 列表拼成请求头字符串，按服务端习惯的顺序排列。
 * @returns {{header:string, found:string[], missing:string[], raw:Array}}
 */
function buildCookieHeader(cookies) {
  const byName = {};
  cookies.forEach((c) => {
    // 同名 cookie 可能存在多个 path，取 path 最长的那个（更具体）
    const prev = byName[c.name];
    if (!prev || (c.path || '').length > (prev.path || '').length) byName[c.name] = c;
  });

  const found = COOKIE_NAMES.filter((n) => byName[n]);
  const missing = COOKIE_NAMES.filter((n) => !byName[n]);
  const header = found.map((n) => `${n}=${byName[n].value}`).join('; ');

  return { header, found, missing, byName };
}

/** 列出所有相关域名的 cookie，用于定位登录状态。 */
async function diagnoseCookies() {
  const lines = [];
  lines.push('浏览器: ' + navigator.userAgent.slice(0, 80));
  lines.push('');

  let totalAll = 0;
  try {
    const all = await chrome.cookies.getAll({});
    totalAll = all.length;
  } catch (e) {
    lines.push('★ chrome.cookies 不可用: ' + e.message);
  }
  lines.push(`可读取的 cookie 总数: ${totalAll}`);
  lines.push('');

  let anyFound = false;
  for (const d of COOKIE_SCAN_DOMAINS) {
    let list = [];
    try {
      list = await collectCookies(d);
    } catch (e) {
      lines.push(`[${d}] 读取异常: ${e.message}`);
      continue;
    }
    const { found, missing } = buildCookieHeader(list);
    if (!list.length) {
      lines.push(`[${d}] 0 条`);
      continue;
    }
    anyFound = true;
    lines.push(`[${d}] ${list.length} 条 → 已有 ${found.length}/6，缺 ${missing.join(',') || '无'}`);
    list.slice(0, 12).forEach((c) => {
      lines.push(`    ${c.domain}  ${c.name}  path=${c.path}  httpOnly=${c.httpOnly}`);
    });
    if (list.length > 12) lines.push(`    …另有 ${list.length - 12} 条`);
  }

  if (!anyFound) {
    lines.push('');
    lines.push('★ 所有 GLaDOS 域名都没有可读取的 cookie。');
    lines.push('  常见原因：没有 cookies/host 权限、Cookie 分区、域名不匹配，');
    lines.push('  或者你在别的浏览器/用户配置里登录。');
    lines.push('  处理办法：不用纠结 Cookie —— 账号认证方式选「浏览器登录态」，');
    lines.push('  或先用「测登录态」确认这个浏览器确实登录有效。');
  }

  return lines.join('\n');
}

async function readCurrentCookie() {
  const siteId = $('accSite').value;
  const site = (STATE.sites || []).find((s) => s.id === siteId);
  if (!site) { toast('请先选择站点', true); return; }

  let list = [];
  try {
    list = await collectCookies(site.domain);
  } catch (e) {
    toast('读取失败：' + e.message, true);
    return;
  }

  const { header, found, missing } = buildCookieHeader(list);

  if (!found.length) {
    // 该域名没读到，尝试扫描其他别名
    const alt = [];
    for (const d of COOKIE_SCAN_DOMAINS) {
      if (d === site.domain) continue;
      try {
        const l = await collectCookies(d);
        const r = buildCookieHeader(l);
        if (r.found.length) alt.push({ domain: d, ...r });
      } catch (e) { /* ignore */ }
    }

    if (alt.length) {
      const best = alt.sort((a, b) => b.found.length - a.found.length)[0];
      // 不自动填入其他域名的 Cookie，避免把 A 站会话保存到 B 站账号上。
      $('cookieHint').textContent =
        `已在 ${best.domain} 找到登录态（${best.found.length} 项），但该域名与所选站点（${site.domain}）不同。` +
        '请先在正确域名登录，或把「所属站点」改成该域名后再读取。';
      toast(`登录态在 ${best.domain}，不是 ${site.domain}`, true);
      return;
    }

    const detail = await diagnoseCookies();
    showDiag(detail);
    toast('读不到 Cookie 属正常现象，可改用「浏览器登录态」模式', true);
    return;
  }

  $('accCookie').value = header;

  if (missing.length) {
    $('cookieHint').textContent =
      `已读取 ${found.length} 项，缺少：${missing.join('、')}。` +
      '若服务端要求完整会话，请确认已登录且页面已完全加载';
    toast(`已读取 ${found.length} 项，但缺少 ${missing.length} 项`, true);
  } else {
    $('cookieHint').textContent = `已读取完整会话（${found.length} 项）`;
    toast('已读取当前登录态');
  }
}

function showDiag(text, title) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-head">
        <h2>${escapeHtml(title || 'Cookie 诊断')}</h2>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </header>
      <div class="modal-body">
        <textarea class="input textarea" rows="16" readonly></textarea>
        <div class="field-hint" style="margin-top:8px">
          把这段内容发给开发者可帮助定位问题。其中只包含 cookie 名称，不含 cookie 值。
        </div>
      </div>
      <footer class="modal-foot">
        <button class="btn btn-ghost" data-copy>复制</button>
        <button class="btn btn-primary" data-close>知道了</button>
      </footer>
    </div>`;
  const ta = mask.querySelector('textarea');
  ta.value = text;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.hasAttribute('data-close')) close();
    if (e.target.hasAttribute('data-copy')) {
      ta.select();
      try { document.execCommand('copy'); toast('已复制'); } catch (err) { /* ignore */ }
    }
  });
}

function readCurrentUa() {
  $('accUa').value = navigator.userAgent;
  toast('已填入当前浏览器 User-Agent');
}

// ---- 执行签到 ----
async function runOne(accountId, btnEl) {
  if (busy) return;
  busy = true;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '签到中…'; }

  try {
    const resp = await send('runOne', { accountId });
    const r = resp.result || {};
    const label = STATUS_LABEL[r.status] || r.status || '完成';
    toast(`${r.accountName || ''} ${label}${r.points > 0 ? ' +' + r.points : ''}`,
          r.status !== 'success' && r.status !== 'repeat');
    await reload();
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy = false;
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '立即签到'; }
  }
}

async function runAll(btnEl) {
  if (busy) return;
  const accounts = (STATE.accounts || []).filter((a) => a.enabled !== false);
  if (!accounts.length) { toast('没有启用中的账号', true); return; }

  busy = true;
  const old = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = `签到中… (${accounts.length})`;

  try {
    const resp = await send('runAll', { force: true });
    if (resp.busy) {
      toast('已有签到任务正在运行，请稍后再试', true);
      await reload();
      return;
    }
    const results = resp.results || [];
    const okCount = results.filter((r) => r.status === 'success' || r.status === 'repeat').length;
    toast(`完成 ${results.length} 个，成功/已签 ${okCount} 个`, okCount !== results.length);
    await reload();
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy = false;
    btnEl.disabled = false;
    btnEl.textContent = old;
  }
}

// ---- 事件绑定 ----
function bindEvents() {
  // 导航
  $('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('is-active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    const panel = $('panel-' + btn.dataset.tab);
    if (panel) panel.classList.add('is-active');

    // 首次进入日历页自动读一次
    if (btn.dataset.tab === 'calendar' && !calendarLoaded) {
      loadCalendar().catch((err) => toast(err.message, true));
    }
  });

  // 服务器日历
  $('btnCalRefresh').addEventListener('click', () => {
    calendarLoaded = false;
    loadCalendar().catch((err) => toast(err.message, true));
  });
  $('calAccount').addEventListener('change', () => {
    calendarLoaded = false;
    $('calGrid').innerHTML = '';
    loadCalendar().catch((err) => toast(err.message, true));
  });

  // 更新
  $('btnCheckUpdate').addEventListener('click', () => {
    checkUpdate(true).catch((e) => toast(e.message, true));
  });
  $('btnApplyUpdate').addEventListener('click', () => {
    applyUpdate().catch((e) => toast(e.message, true));
  });
  $('btnReloadExt').addEventListener('click', () => {
    // 文件已替换到磁盘，重载即可加载新代码；设置页会随之关闭
    chrome.runtime.reload();
  });
  $('btnToggleNotes').addEventListener('click', () => {
    notesOpen = !notesOpen;
    $('btnToggleNotes').textContent = notesOpen ? '收起说明' : '更新说明';
    $('updateNotes').hidden = !notesOpen;
  });

  // 账号
  $('btnAddAccount').addEventListener('click', () => openModal(null));

  $('accountList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === 'edit') openModal(id);
    else if (btn.dataset.act === 'checkin') runOne(id, btn);
    else if (btn.dataset.act === 'del') {
      const acc = STATE.accounts.find((a) => a.id === id);
      if (!confirm(`删除账号「${acc ? acc.name : id}」？此操作不可撤销。`)) return;
      const accounts = STATE.accounts.filter((a) => a.id !== id);
      send('saveState', { patch: { accounts } }).then(reload).then(() => toast('已删除'));
    }
  });

  // 认证方式切换
  $('accMode').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    accMode = btn.dataset.mode === 'cookie' ? 'cookie' : 'session';
    applyModeUI();
  });

  // 模态框
  $('btnCloseModal').addEventListener('click', closeModal);
  $('btnCancelModal').addEventListener('click', closeModal);
  $('btnSaveAccount').addEventListener('click', () => saveAccount().catch((e) => toast(e.message, true)));
  $('btnReadCookie').addEventListener('click', (e) => {
    // 按钮位于 <label> 内，阻止 label 的默认聚焦行为
    e.preventDefault();
    e.stopPropagation();
    readCurrentCookie().catch((err) => toast(err.message, true));
  });
  $('btnReadUa').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    readCurrentUa();
  });
  $('btnProbeLogin').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    probeLogin().catch((err) => toast('检测失败：' + err.message, true));
  });
  $('modalMask').addEventListener('click', (e) => {
    if (e.target === $('modalMask')) closeModal();
  });

  // 站点
  $('siteList').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = el.dataset.id;
    if (el.dataset.act === 'site-del') {
      const site = STATE.sites.find((s) => s.id === id);
      if (!site) return;
      const used = (STATE.accounts || []).some((a) => a.siteId === id);
      if (used) { toast('该站点下还有账号，请先删除账号', true); return; }
      if (!confirm(`删除站点「${site.domain}」？`)) return;
      const sites = STATE.sites.filter((s) => s.id !== id);
      send('saveState', { patch: { sites } }).then(reload).then(() => toast('已删除'));
    }
  });

  $('siteList').addEventListener('change', (e) => {
    const el = e.target.closest('[data-act="site-toggle"]');
    if (!el) return;
    const id = el.dataset.id;
    const sites = STATE.sites.map((s) => s.id === id ? Object.assign({}, s, { enabled: el.checked }) : s);
    send('saveState', { patch: { sites } }).then(reload);
  });

  const markDirty = () => { settingsDirty = true; };
  $('panel-settings').addEventListener('input', markDirty);
  $('panel-settings').addEventListener('change', markDirty);

  // 调度
  $('autoClickTurnstile').addEventListener('change', (e) => {
    if (!e.target.checked) return;
    if (!confirm('自动点击 Cloudflare 验证框会使用 Chrome 调试接口，可能短暂显示“正在调试此浏览器”。图片验证仍需手动完成。是否继续？')) {
      e.target.checked = false;
    }
  });

  $('btnSaveSchedule').addEventListener('click', async () => {
    const settings = {
      targetHour: Math.max(0, Math.min(23, parseInt($('targetHour').value, 10) || 0)),
      maxDelayMinutes: Math.max(1, Math.min(59, parseInt($('maxDelay').value, 10) || 45)),
      minStayMs: Math.min(30000, Math.max(2500, parseInt($('minStay').value, 10) || 4500)),
      maxStayMs: Math.min(30000, Math.max(2500, parseInt($('maxStay').value, 10) || 6500)),
      skipIfDone: $('skipIfDone').checked,
      notifyEnabled: $('notifyEnabled').checked,
      autoClickTurnstile: $('autoClickTurnstile').checked,
      foregroundOnManual: $('foregroundOnManual').checked,
      humanVerify: $('humanVerify').checked,
      keepTabOnVerify: $('keepTabOnVerify').checked,
      updateCheckEnabled: $('updateCheckEnabled').checked
    };
    if (settings.maxStayMs < settings.minStayMs) {
      toast('停留上限不能小于下限', true);
      return;
    }
    await send('saveState', { patch: { settings } });
    settingsDirty = false;
    await reload();
    toast('设置已保存；旧随机计划已取消，将在下次巡检重新安排');
  });

  $('btnTestNotify').addEventListener('click', async () => {
    try {
      const r = await send('testNotification');
      toast(`测试通知已发送（系统权限：${r.permissionLevel || '未知'}）`);
    } catch (e) {
      toast('测试通知失败：' + e.message, true);
    }
  });

  // 推送
  $('btnSavePush').addEventListener('click', async () => {
    const settings = Object.assign({}, STATE.settings || {}, {
      pushdeerKey: $('pushdeerKey').value.trim(),
      serverchanKey: $('serverchanKey').value.trim()
    });
    await send('saveState', { patch: { settings } });
    settingsDirty = false;
    await reload();
    toast('推送配置已保存');
  });

  $('btnTestPush').addEventListener('click', async () => {
    try {
      const r = await send('testPush');
      if (!r.ok) {
        toast(r.error || '推送未配置或发送失败', true);
        return;
      }
      const names = (r.results || []).filter((x) => x.ok).map((x) => x.provider).join('、');
      toast(`测试推送已发送：${names || '成功'}`);
    } catch (e) {
      toast('测试推送失败：' + e.message, true);
    }
  });

  // 日志
  $('btnClearLogs').addEventListener('click', async () => {
    if (!confirm('清空全部日志？')) return;
    await send('clearLogs');
    await reload();
    toast('已清空');
  });

  // 全部签到
  $('btnRunAll').addEventListener('click', (e) => runAll(e.currentTarget));

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modalMask').hidden) closeModal();
    document.querySelectorAll('.modal-mask:not(#modalMask):not([hidden])').forEach((m) => m.remove());
  });
}

// ---- 启动 ----
(async function init() {
  // 更新条先渲染，避免 reload 失败时空白
  try {
    setUpdateLine('', `v${curVer()} · 尚未检查`);
    showOnly('btnCheckUpdate');
  } catch (e) { /* 元素缺失时忽略 */ }

  try {
    bindEvents();
    await reload();
  } catch (e) {
    console.error(e);
    toast('初始化失败：' + e.message, true);
  }

  // 更新检查失败不影响设置页其它功能
  initUpdateBar().catch((e) => {
    console.warn('[update]', e);
    try {
      setUpdateLine('is-error', `检查失败：${e.message}`);
      showOnly('btnCheckUpdate');
    } catch (err) { /* ignore */ }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.logs && !changes.accounts) return;
    // 手动签到期间不自动刷新，避免按钮状态被重置
    if (busy) return;
    reload().catch(() => {});
  });
})();
