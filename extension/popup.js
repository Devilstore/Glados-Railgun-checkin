/**
 * popup.js —— 快速状态面板
 */

'use strict';

const STATUS_LABEL = {
  success: '成功',
  repeat: '已签',
  turnstile: '验证失败',
  device: '设备不符',
  fail: '失败'
};

const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('无响应'));
      if (resp.ok === false) return reject(new Error(resp.error || '操作失败'));
      resolve(resp);
    });
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

let STATE = null;
let TODAY = '';
let busy = false;

function statusOf(acc) {
  const last = acc.last;
  if (!last || last.date !== TODAY) return { cls: 'idle', label: '未签', dot: '' };
  if (last.status === 'success') return { cls: 'success', label: '成功', dot: 'ok' };
  if (last.status === 'repeat') return { cls: 'repeat', label: '已签', dot: 'ok' };
  if (last.status === 'turnstile') return { cls: 'turnstile', label: '验证失败', dot: 'err' };
  if (last.status === 'device') return { cls: 'device', label: '设备不符', dot: 'err' };
  return { cls: 'fail', label: '失败', dot: 'err' };
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

function render() {
  const accounts = (STATE.accounts || []).filter((a) => a.enabled !== false);
  const sites = STATE.sites || [];

  const signed = accounts.filter((a) => {
    const s = statusOf(a);
    return s.cls === 'success' || s.cls === 'repeat';
  }).length;

  $('sumSigned').textContent = String(signed);
  $('sumTotal').textContent = String(accounts.length);

  let earnedTotal = 0;
  let earnedKnown = false;
  accounts.forEach((acc) => {
    const earned = todayEarned(acc);
    if (earned != null) {
      earnedTotal += earned;
      earnedKnown = true;
    }
  });
  $('sumEarned').textContent = earnedKnown
    ? `今日合计 +${earnedTotal} 分`
    : '今日合计 —';

  $('popEmpty').hidden = accounts.length > 0;
  $('accList').hidden = accounts.length === 0;

  $('accList').innerHTML = accounts.map((acc) => {
    const st = statusOf(acc);
    const site = sites.find((s) => s.id === acc.siteId);
    const snap = acc.snapshot || {};
    const earnedToday = todayEarned(acc);
    const stats = [];
    stats.push(
      `<span class="acc-today${earnedToday == null ? ' is-empty' : ''}">今日 ${
        earnedToday != null ? '+' + earnedToday : '—'
      }</span>`
    );
    if (snap.points != null) stats.push(`<span>总 ${esc(String(snap.points))} 分</span>`);
    if (snap.leftDays != null) stats.push(`<span>剩余 ${esc(String(snap.leftDays))} 天</span>`);
    stats.push(`<span>会员 ${esc(planLabel(snap.vip))}</span>`);
    return `
      <div class="acc-row ${acc.enabled === false ? 'is-off' : ''}">
        <span class="dot ${st.dot}"></span>
        <div class="acc-info">
          <div class="acc-head">
            <span class="acc-name">${esc(acc.name || '未命名')}</span>
            <span class="acc-site">${esc(site ? site.domain : '站点缺失')}</span>
            <span class="acc-mode">${acc.cookie ? 'Cookie' : '浏览器登录态'}</span>
            <span class="acc-tag ${st.cls}">${esc(st.label)}</span>
          </div>
          <div class="acc-stats">${stats.join('')}</div>
        </div>
      </div>
    `;
  }).join('');

  const btn = $('btnRun');
  btn.disabled = busy || accounts.length === 0;
}

async function reload() {
  const resp = await send('getState');
  STATE = resp.state;
  TODAY = resp.today;
  render();
}

async function runAll() {
  const btn = $('btnRun');
  if (busy || btn.disabled) return;
  busy = true;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '签到中…';
  $('footHint').textContent = '正在打开签到页，请稍候（每个账号约 10–30 秒）';

  try {
    const resp = await send('runAll', { force: true });
    if (resp.busy) {
      $('footHint').textContent = '已有签到任务正在运行，请稍后再试';
      await reload();
      return;
    }
    const results = resp.results || [];
    const ok = results.filter((r) => r.status === 'success' || r.status === 'repeat').length;
    $('footHint').textContent = results.length
      ? `完成 ${results.length} 个，成功/已签 ${ok} 个`
      : '没有需要签到的账号';
    await reload();
  } catch (e) {
    $('footHint').textContent = '失败：' + e.message;
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = old;
  }
}

$('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('btnToAdd').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('btnRun').addEventListener('click', runAll);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.accounts || changes.logs)) reload().catch(() => {});
});

reload().catch((e) => {
  $('footHint').textContent = '加载失败：' + e.message;
});
