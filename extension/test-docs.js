/**
 * 校验文档与代码一致性（防止 README 描述过时）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const manifest = JSON.parse(read('extension/manifest.json'));
const bg = read('extension/background.js');
const updater = read('extension/updater.js');
const optionsJs = read('extension/options.js');
const extReadme = read('extension/README.md');
const mainReadme = read('README.md');
const notes = read('release-notes.md');

const rows = [];
let pass = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  rows.push(`${cond ? '[OK  ]' : '[FAIL]'} ${name}${cond ? '' : '  → ' + (extra || '')}`);
}

const ver = manifest.version;

// ---- 1. 版本号三处一致 ----
const extVer = (bg.match(/const EXT_VERSION = '([^']+)'/) || [])[1];
check('manifest 与 background.js 版本一致', extVer === ver, `${extVer} vs ${ver}`);
check('extension/README 声明当前版本正确', extReadme.includes(`当前版本：\`${ver}\``));
check('主 README 声明当前版本正确', mainReadme.includes(`当前版本：\`${ver}\``));
check('主 README 的发布包名示例与版本匹配',
  mainReadme.includes(`glados-checkin-extension-v${ver}.zip`));
check('release-notes 标题版本匹配', notes.startsWith(`## GLaDOS 自动签到 v${ver}`));

// ---- 2. 更新相关数值与代码一致 ----
const interval = (optionsJs.match(/UPDATE_INTERVAL_MS = ([\d *]+);/) || [])[1];
const intervalMs = interval
  ? interval.split('*').reduce((a, s) => a * Number(s.trim()), 1)
  : NaN;
const intervalH = intervalMs / 3600000;
check('检查节流为 1 小时', intervalH === 1, `计算得 ${intervalH} 小时`);
check('extension/README 写的是 1 小时节流',
  /1 小时内最多一次/.test(extReadme));
check('extension/README 不再写过时的 6 小时',
  !/6 小时/.test(extReadme), '仍存在「6 小时」');
const timeout = (updater.match(/timeoutMs \|\| 15000/) || [])[0];
check('fetch 超时为 15 秒且文档一致',
  !!timeout && /15 秒超时/.test(extReadme));

// ---- 3. 设置项默认值与文档表格一致 ----
check('文档记录 updateCheckEnabled 默认开启',
  /打开设置页时检查更新 \| 开/.test(extReadme));
check('代码中 updateCheckEnabled 默认为 true',
  /updateCheckEnabled: true/.test(bg));
check('文档记录 autoClickTurnstile 默认关闭',
  /自动点击 Cloudflare 验证框 \| 关/.test(extReadme),
  '表格中未标注默认值');
check('代码中 autoClickTurnstile 默认为 false',
  /autoClickTurnstile: false/.test(bg));
check('文档记录今日已签则跳过默认开启',
  /今日已签则跳过 \| 开/.test(extReadme));

// ---- 4. 权限清单覆盖实际使用 ----
const perms = manifest.permissions || [];
const hosts = manifest.host_permissions || [];
const usesGithub = /api\.github\.com/.test(updater);
check('updater 访问 GitHub API 时 manifest 已授权',
  !usesGithub || hosts.some((h) => h.includes('api.github.com')),
  hosts.join(','));
check('manifest 覆盖 GitHub Release 下载域名（含重定向的 githubusercontent CDN）',
  hosts.some((h) => h.includes('githubusercontent.com')),
  hosts.join(','));
check('声明的最低 Chrome 版本为 103（deflate-raw 需要）',
  manifest.minimum_chrome_version === '103',
  String(manifest.minimum_chrome_version));
check('extension/README 说明需要 103+', /103\+/.test(extReadme));

// ---- 5. 死字段/已删功能不得在文档出现 ----
check('已删除的 logRetention 不再出现在代码', !/logRetention/.test(bg));
check('已删除的 updateBackup 不再出现在代码',
  !/updateBackup/.test(optionsJs) && !/updateBackup/.test(extReadme));
check('已删除的 btnUpdateDir 不再出现在文档', !/btnUpdateDir|选目录」常驻/.test(extReadme) ||
  /移除常驻的「选目录」/.test(extReadme));

// ---- 6. 测试清单与实际文件一致 ----
const testFiles = fs.readdirSync(path.join(root, 'extension'))
  .filter((f) => /^test-.*\.js$/.test(f)).sort();
const documented = [...extReadme.matchAll(/node (test-[\w-]+\.js)/g)].map((m) => m[1]);
check('extension/README 列出全部测试文件',
  testFiles.every((f) => documented.includes(f)),
  `缺: ${testFiles.filter((f) => !documented.includes(f)).join(',')}`);
check('文档中无失效的测试文件名',
  documented.every((f) => testFiles.includes(f)),
  `多余: ${documented.filter((f) => !testFiles.includes(f)).join(',')}`);

// ---- 7. 文件结构说明与实际文件一致 ----
for (const f of ['manifest.json', 'background.js', 'inject.js', 'updater.js']) {
  check(`文件结构说明包含 ${f}`, extReadme.includes(f));
}

console.log('=== 文档一致性测试 ===\n');
rows.forEach((l) => console.log('  ' + l));
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
