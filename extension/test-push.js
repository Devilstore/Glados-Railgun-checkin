/**
 * 校验推送正文与 Python 版 Report.render 逐字一致。
 * 基准由真实 Python 代码生成，见 EXPECTED 常量。
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');

const noop = () => {};
const asyncNoop = async () => {};

// ---- 捕获推送请求体 ----
const captured = { pushdeer: null, serverchan: null };

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, Number, String, Array, Object, Map, Set,
  URLSearchParams, AbortController, URL,
  fetch: async (url, init) => {
    const params = init && init.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    if (String(url).includes('pushdeer')) {
      captured.pushdeer = {
        desp: params.get('desp'),
        type: params.get('type'),
        text: params.get('text')
      };
    } else if (String(url).includes('sctapi') || String(url).includes('.send')) {
      captured.serverchan = { desp: params.get('desp'), title: params.get('title'), url: String(url) };
    }
    return { ok: true, json: async () => ({ code: 0, data: {} }) };
  },
  chrome: {
    runtime: {
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      onMessage: { addListener: noop },
      getURL: (p) => p,
      getManifest: () => ({ version: '0.0.0' }),
      getPlatformInfo: (cb) => cb && cb({}),
      lastError: null
    },
    alarms: { onAlarm: { addListener: noop }, get: asyncNoop, create: noop, clear: asyncNoop },
    storage: { local: { get: async () => ({}), set: asyncNoop }, onChanged: { addListener: noop } },
    declarativeNetRequest: { updateSessionRules: asyncNoop, getSessionRules: async () => [] },
    notifications: { create: noop, getPermissionLevel: (cb) => cb && cb('granted') },
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

const notifySummary = sandbox.notifySummary;
if (typeof notifySummary !== 'function') {
  console.error('❌ 未能从 background.js 取到 notifySummary');
  process.exit(1);
}

// Python 真实输出（checkin.py Report.render）
const EXPECTED = {
  three: {
    title: 'GLaDOS 签到 · 成功 1 · 失败 1 · 重复 1',
    pushdeer:
      '#1  大号  ✅ 签到成功  glados.cloud  获得 10 积分 · 剩余 3935 天 · 总 409 积分\n' +
      '#2  未命名  🔄 重复签到  glados.cloud  获得 2 积分 · 剩余 15 天 · 总 20 积分\n' +
      '#3  旧站号  🔴 签到失败  railgun.info  获得 1 积分 · 剩余 0 天 · 总 3 积分',
    serverchan:
      '#1  大号  ✅ 签到成功  glados.cloud  获得 10 积分 · 剩余 3935 天 · 总 409 积分  \n' +
      '#2  未命名  🔄 重复签到  glados.cloud  获得 2 积分 · 剩余 15 天 · 总 20 积分  \n' +
      '#3  旧站号  🔴 签到失败  railgun.info  获得 1 积分 · 剩余 0 天 · 总 3 积分'
  },
  one: {
    title: 'GLaDOS 签到 · 成功 1 · 失败 0 · 重复 0',
    pushdeer: '#1  ✅ 签到成功  glados.cloud  获得 10 积分 · 剩余 3935 天 · 总 409 积分',
    serverchan: '#1  ✅ 签到成功  glados.cloud  获得 10 积分 · 剩余 3935 天 · 总 409 积分'
  }
};

const settings = { pushdeerKey: 'PDTEST', serverchanKey: 'SCTTEST', notifyEnabled: false };

const cases = [
  {
    name: '三账号（其中一个失败）',
    expect: 'three',
    results: [
      { accountName: '大号', domain: 'glados.cloud', status: 'success', points: 10, leftDays: 3935, pointsTotal: 409 },
      { accountName: '', domain: 'glados.cloud', status: 'repeat', points: 2, leftDays: 15, pointsTotal: 20 },
      { accountName: '旧站号', domain: 'railgun.info', status: 'fail', points: 1, leftDays: 0, pointsTotal: 3 }
    ]
  },
  {
    name: '单账号（不显示账号名）',
    expect: 'one',
    results: [
      { accountName: '大号', domain: 'glados.cloud', status: 'success', points: 10, leftDays: 3935, pointsTotal: 409 }
    ]
  }
];

(async () => {
  let pass = 0;
  const rows = [];

  for (const c of cases) {
    captured.pushdeer = null;
    captured.serverchan = null;
    await notifySummary(c.results, settings, 0);

    const exp = EXPECTED[c.expect];
    const checks = [
      ['PushDeer desp', captured.pushdeer && captured.pushdeer.desp, exp.pushdeer],
      ['PushDeer type', captured.pushdeer && captured.pushdeer.type, 'text'],
      ['PushDeer title', captured.pushdeer && captured.pushdeer.text, exp.title],
      ['ServerChan desp', captured.serverchan && captured.serverchan.desp, exp.serverchan],
      ['ServerChan title', captured.serverchan && captured.serverchan.title, exp.title]
    ];

    for (const [label, actual, expected] of checks) {
      const ok = actual === expected;
      if (ok) pass++;
      rows.push(`${ok ? '[OK  ]' : '[FAIL]'} ${c.name} · ${label}`);
      if (!ok) {
        rows.push(`        期望: ${JSON.stringify(expected)}`);
        rows.push(`        实际: ${JSON.stringify(actual)}`);
      }
    }
  }

  // Server酱 URL 拼接：只按 pathname 是否以 .send 结尾决定，保留 query
  const sendPush = sandbox.sendPushNotification;
  const urlCases = [
    ['纯 key', 'SCTABC', 'https://sctapi.ftqq.com/SCTABC.send'],
    ['完整 URL 无 .send', 'https://sctapi.ftqq.com/abc?foo=1',
      'https://sctapi.ftqq.com/abc.send?foo=1'],
    ['完整 URL 带 .send 和 query', 'https://sctapi.ftqq.com/abc.send?foo=1',
      'https://sctapi.ftqq.com/abc.send?foo=1'],
    ['完整 URL 带 .send 无 query', 'https://sctapi.ftqq.com/abc.send',
      'https://sctapi.ftqq.com/abc.send']
  ];
  for (const [name, key, expected] of urlCases) {
    captured.serverchan = null;
    await sendPush({ serverchanKey: key }, 't', ['l']);
    const ok = captured.serverchan && captured.serverchan.url === expected;
    if (ok) pass++;
    rows.push(`${ok ? '[OK  ]' : '[FAIL]'} ServerChan URL · ${name}`);
    if (!ok) {
      rows.push(`        期望: ${expected}`);
      rows.push(`        实际: ${captured.serverchan && captured.serverchan.url}`);
    }
  }
  captured.pushdeer = null;
  captured.serverchan = null;
  await notifySummary(cases[0].results, settings, 0);

  console.log('=== 推送格式对比（基准 = Python Report.render）===\n');
  rows.forEach((l) => console.log('  ' + l));
  const total = cases.length * 5 + 4;
  console.log(`\n${pass}/${total} 通过`);

  // 附：换行可视化，便于人眼确认
  if (captured.pushdeer) {
    console.log('\n--- PushDeer 正文（\\n 显示为 ⏎）---');
    console.log(captured.pushdeer.desp.replace(/\n/g, '⏎\n'));
    console.log('\n--- ServerChan 正文（行尾两空格显示为 ··）---');
    console.log(captured.serverchan.desp.replace(/  \n/g, '··⏎\n'));
  }

  process.exit(pass === total ? 0 : 1);
})();
