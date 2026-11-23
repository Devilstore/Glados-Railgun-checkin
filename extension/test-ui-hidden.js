/**
 * 校验更新区任何时刻只有一个按钮可见，以及自动检查的触发条件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'options.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'options.js'), 'utf8');

const rows = [];
let pass = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  rows.push(`${cond ? '[OK  ]' : '[FAIL]'} ${name}${cond ? '' : '  → ' + (extra || '')}`);
}

// ---- 1. 全局兜底规则 ----
check('options.css 有 [hidden] !important 兜底',
  /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/.test(css));

const popupCss = fs.readFileSync(path.join(__dirname, 'popup.css'), 'utf8');
check('popup.css 也有同样的兜底',
  /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/.test(popupCss));

// ---- 2. 更新区只保留一个按钮 ----
check('存在 showOnly() 互斥函数', /function showOnly\(/.test(js));

const triple = js.match(/for \(const id of \[([^\]]+)\]\)/);
check('showOnly 覆盖全部三个更新按钮',
  !!triple && ['btnCheckUpdate', 'btnApplyUpdate', 'btnReloadExt']
    .every((id) => triple[1].includes(id)),
  triple ? triple[1] : 'not found');

check('showOnly 逻辑是"只有匹配项可见"',
  /\.hidden\s*=\s*id\s*!==\s*name/.test(js));

// ---- 3. 各状态都调用了 showOnly ----
const stateCalls = [
  ['初始（内容脚本启动）', /setUpdateLine\('', `v\$\{curVer\(\)\} · 尚未检查`\);\s*\n\s*showOnly\('btnCheckUpdate'\)/],
  ['有新版本', /setUpdateLine\('is-new'[^\n]*\n\s*showOnly\('btnApplyUpdate'\)/],
  ['已是最新', /showOnly\('btnCheckUpdate'\)/],
  ['更新成功', /setUpdateLine\('is-new'[^\n]*需重新加载[^\n]*\n\s*showOnly\('btnReloadExt'\)/],
  ['检查失败', /setUpdateLine\('is-error'[^\n]*\n\s*showOnly\('btnCheckUpdate'\)/]
];
for (const [name, re] of stateCalls) {
  check(`${name} 时指定了唯一按钮`, re.test(js));
}

// ---- 4. HTML 初始状态：只有「检查更新」不带 hidden ----
const line = html.match(/<div class="update-line" id="updateBar">([\s\S]*?)<\/div>\s*\n/);
check('找到更新行容器', !!line);
if (line) {
  const btns = [...line[1].matchAll(/<button([^>]*)>([^<]*)<\/button>/g)]
    .map((m) => ({ attrs: m[1], text: m[2] }));
  const actionBtns = btns.filter((b) => /class="btn /.test(b.attrs));
  const visible = btns.filter((b) => !/\shidden(\s|>|$)/.test(b.attrs));
  check('更新行内动作按钮共 3 个（另有一个「更新说明」文字按钮）',
    actionBtns.length === 3, `got=${actionBtns.length}, total=${btns.length}`);
  check('初始只有「检查更新」可见',
    visible.length === 1 && visible[0].text.includes('检查更新'),
    visible.map((b) => b.text).join('|'));
}

// ---- 5. 已删除的控件不应留下引用 ----
check('已移除 btnUpdateDir 的引用', !/btnUpdateDir/.test(js) && !/btnUpdateDir/.test(html));
check('已移除 updateBackup 的引用',
  !/updateBackup/.test(js) && !/updateBackup/.test(html));

// ---- 6. 自动检查：必须有可见进行中状态 + 独立错误处理 ----
check('存在 initUpdateBar（自动检查入口）', /async function initUpdateBar\(/.test(js));
check('init 中调用了 initUpdateBar', /initUpdateBar\(\)\.catch/.test(js));
check('不再有旧的 autoCheckUpdate 残留', !/function autoCheckUpdate/.test(js));
check('自动检查也显示「正在检查…」（不再仅 manual）',
  /setUpdateLine\('', `\$\{vTag\(curVer\(\)\)\} · 正在检查…`\);\s*\n\s*showOnly\(null\);/.test(js));
check('更新检查有独立的 catch 兜底', /initUpdateBar\(\)\.catch\(\(e\) => \{[\s\S]{0,240}setUpdateLine\('is-error'/.test(js));
check('updater 的 fetch 带超时', /function fetchWithTimeout\(/.test(
  fs.readFileSync(path.join(__dirname, 'updater.js'), 'utf8')));

// ---- 7. decideUpdateView 状态机（核心：解决"看不出有没有检查"） ----
// 用 vm 单独加载这一段逻辑做行为验证
const vm = require('vm');
const noop = () => {};
const sandbox = {
  console, Date, Math, Number, String, JSON, Object, Array, Error, Promise, setTimeout, clearTimeout,
  Updater: {
    parseVer: (v) => {
      const m = String(v == null ? '' : v).trim().replace(/^v/i, '')
        .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
      return m ? [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)] : null;
    },
    compareVer: (a, b) => {
      const pa = sandbox.Updater.parseVer(a);
      const pb = sandbox.Updater.parseVer(b);
      if (!pa || !pb) return 0;
      for (let i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return 1;
        if (pa[i] < pb[i]) return -1;
      }
      return 0;
    }
  },
  chrome: { runtime: { getManifest: () => ({ version: '1.1.7' }) } },
  window: {}
};
sandbox.window.Updater = sandbox.Updater;
sandbox.$ = () => ({ hidden: false, textContent: '', className: '' });
vm.createContext(sandbox);

// 只取出需要的几个函数与常量
const src = js.slice(js.indexOf('const UPDATE_STAMP_KEY'), js.indexOf('async function checkUpdate'));
vm.runInContext(src + '\n;this.__decide = decideUpdateView; this.__vTag = vTag;', sandbox);
const decide = sandbox.__decide;

const hour = 3600 * 1000;
const now = Date.now();

const c1 = decide({ current: '1.1.7', lastResult: null, checkedAt: 0, intervalMs: hour });
check('从未检查 → 进入联网态（stale=true 且无按钮）',
  c1.stale === true && c1.button === null, JSON.stringify(c1));

const c2 = decide({
  current: '1.1.7',
  lastResult: { latest: '1.1.8', hasUpdate: true },
  checkedAt: now - 2 * hour,
  intervalMs: hour
});
check('缓存里已有新版本 → 直接给「更新」按钮且不联网',
  c2.button === 'btnApplyUpdate' && c2.cls === 'is-new' && c2.stale === false, JSON.stringify(c2));

const c3 = decide({
  current: '1.1.7',
  lastResult: { latest: '1.1.7', hasUpdate: false },
  checkedAt: now - 10 * 60 * 1000,
  intervalMs: hour
});
check('刚查过且已是最新 → 不联网，显示「已是最新」',
  c3.stale === false && c3.button === 'btnCheckUpdate' && c3.text.includes('已是最新'),
  JSON.stringify(c3));

const c4 = decide({
  current: '1.1.7',
  lastResult: { latest: '1.1.7', hasUpdate: false },
  checkedAt: now - 3 * hour,
  intervalMs: hour
});
check('超过节流窗口 → 重新进入联网态',
  c4.stale === true, JSON.stringify(c4));

const c5 = decide({
  current: '1.1.7',
  lastResult: { latest: '1.1.0', hasUpdate: false },   // 远端比本地旧
  checkedAt: now - 2 * hour,
  intervalMs: hour
});
check('远端版本比本地旧 → 不误报有新版本',
  c5.button !== 'btnApplyUpdate' && c5.stale === true, JSON.stringify(c5));

console.log('=== 更新区 UI 可见性测试 ===\n');
rows.forEach((l) => console.log('  ' + l));
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
