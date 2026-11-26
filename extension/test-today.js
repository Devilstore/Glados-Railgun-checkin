/**
 * 跨零点回归测试：昨天的签到回执不能被当成今天所得。
 * 截图场景：本地已过 00:00（TODAY=11-23），但 last.date=11-22，
 * 卡片却显示「Checkin! Got 14 Points +14」，看起来像今天刚签到。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, 'options.js'), 'utf8');

// 用字符串切片加载纯函数，避免执行整份 UI 代码。
const a = js.indexOf('function lastMessageOf');
const b = js.indexOf('function dotCls', a);
if (a < 0 || b < 0) {
  console.error('找不到 lastMessageOf / dotCls 锚点，测试失效');
  process.exit(1);
}
const sandbox = { String, Number, Boolean };
vm.createContext(sandbox);
vm.runInContext(js.slice(a, b) + '\n;this.f = lastMessageOf;', sandbox);
const f = sandbox.f;

const rows = [];
let pass = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  rows.push(`${cond ? '[OK  ]' : '[FAIL]'} ${name}${cond ? '' : '  → ' + (extra || '')}`);
}

// 截图场景：昨天的成功回执
const yesterday = {
  date: '2026-11-22', status: 'success', points: 14,
  message: 'Checkin! Got 14 Points', at: Date.now() - 3600e3
};
const r1 = f(yesterday, '2026-11-23');
check('跨零点后 last 判定为「非今天」', r1 && r1.isToday === false, JSON.stringify(r1));
check('昨天的 +14 不再高亮（boost=null）', r1 && r1.boost == null, JSON.stringify(r1));
check('昨天回执文案仍保留（供「上次 …」展示）',
  r1 && r1.message === 'Checkin! Got 14 Points', JSON.stringify(r1));

// 今天的成功回执：照常高亮 +N
const r2 = f(
  { date: '2026-11-23', status: 'success', points: 14, message: 'Checkin! Got 14 Points' },
  '2026-11-23'
);
check('今天的成功回执 isToday=true', r2 && r2.isToday === true, JSON.stringify(r2));
check('今天的成功回执高亮 +14', r2 && r2.boost === 14, JSON.stringify(r2));

// 今天的 repeat 不显示 +N
const r3 = f(
  { date: '2026-11-23', status: 'repeat', points: 2, message: '今日已签到' },
  '2026-11-23'
);
check('今天的重复签到不高亮 +N', r3 && r3.boost == null, JSON.stringify(r3));

// 没有历史记录
check('无 last 返回 null', f(null, '2026-11-23') === null);

// 渲染模板必须给非今天加「上次」前缀，且 boost 只在今天分支使用
check('模板对历史回执加「上次」前缀', /上次 \$\{escapeHtml\(lm\.message\)\}/.test(js));
check('模板 +N 高亮只在 isToday 分支',
  /lm\.isToday[\s\S]{0,160}lm\.boost != null/.test(js));

console.log('=== 今日状态判定测试 ===\n');
rows.forEach((l) => console.log('  ' + l));
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
