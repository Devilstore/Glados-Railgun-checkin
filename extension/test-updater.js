/**
 * 校验版本比较、zip 解压与路径安全（写盘前必须挡住目录穿越）。
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const zlib = require('zlib');

const code = fs.readFileSync(path.join(__dirname, 'updater.js'), 'utf8');

// 极简 IndexedDB 替身：只需要能存取目录句柄
const kvStore = new Map();
const fakeIndexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        close() {},
        transaction() {
          const tx = {};
          setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
          tx.objectStore = () => ({
            get(k) {
              const r = {};
              setTimeout(() => {
                r.result = kvStore.get(k);
                if (r.onsuccess) r.onsuccess();
              }, 0);
              return r;
            },
            put(v, k) { kvStore.set(k, v); }
          });
          return tx;
        }
      };
      req.result = db;
      if (req.onsuccess) req.onsuccess();
    }, 0);
    return req;
  }
};

const sandbox = {
  console,
  window: {},
  indexedDB: fakeIndexedDB,
  chrome: { runtime: { getManifest: () => ({ version: '1.0.7' }) } },
  fetch: async () => { throw new Error('test 不联网'); },
  DecompressionStream,
  Response,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  DataView,
  ArrayBuffer,
  Promise,
  Number,
  String,
  Math,
  Date,
  JSON,
  Object,
  Array,
  Error,
  setTimeout,
  clearTimeout,
  AbortController,
  confirm: () => true
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'updater.js' });

const U = sandbox.window.Updater;
if (!U) {
  console.error('❌ 未能取到 window.Updater');
  process.exit(1);
}

// ---- 造一个真实 zip ----
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data == null ? '' : e.data, 'utf8');
    const method = e.method === 0 ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);          // flag: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);              // CRC（解析器不校验）
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.uncompSize != null ? e.uncompSize : data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const all = Buffer.concat([...locals, cdBuf, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const rows = [];
let pass = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  rows.push(`${cond ? '[OK  ]' : '[FAIL]'} ${name}${cond ? '' : '  → ' + (extra || '')}`);
}

// ---- 内存文件系统 ----
// 用来验证 apply() 真的把内容写对位置，而不只是"没抛异常"。
function makeDir(name) {
  return {
    kind: 'directory',
    name,
    children: new Map(),
    async getDirectoryHandle(n, opt) {
      const c = this.children.get(n);
      if (c && c.kind === 'directory') return c;
      if (c && c.kind === 'file') {
        const e = new Error('The path supplied exists, but was not an entry of requested type.');
        e.name = 'TypeMismatchError';
        throw e;
      }
      if (!opt || !opt.create) throw new Error('NotFound: ' + n);
      const d = makeDir(n);
      this.children.set(n, d);
      return d;
    },
    async getFileHandle(n, opt) {
      const c = this.children.get(n);
      if (c && c.kind === 'file') return c;
      if (c && c.kind === 'directory') {
        const e = new Error('The path supplied exists, but was not an entry of requested type.');
        e.name = 'TypeMismatchError';
        throw e;
      }
      if (!opt || !opt.create) throw new Error('NotFound: ' + n);
      const f = makeFile(n, null);
      this.children.set(n, f);
      return f;
    }
  };
}

function makeFile(name, content) {
  return {
    kind: 'file',
    name,
    _c: content,
    async getFile() {
      const self = this;
      return {
        async arrayBuffer() {
          if (self._c == null) throw new Error('NotFound');
          const u8 = new TextEncoder().encode(self._c);
          return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        }
      };
    },
    async createWritable() {
      const self = this;
      let pending = null;
      return {
        async write(d) { pending = d; },
        async close() {
          self._c = pending == null ? '' : new TextDecoder().decode(pending);
        }
      };
    }
  };
}

function walk(dir, base, out) {
  for (const [n, c] of dir.children.entries()) {
    const p = base ? base + '/' + n : n;
    if (c.kind === 'directory') walk(c, p, out);
    else out.set(p, c._c);
  }
  return out;
}
function snapshot(dir) { return walk(dir, '', new Map()); }
function readFile(dir, p) {
  const m = snapshot(dir);
  return m.has(p) ? m.get(p) : null;
}
function keysOf(dir) { return [...snapshot(dir).keys()]; }

async function putFile(dir, p, content) {
  const parts = p.split('/');
  let node = dir;
  for (let i = 0; i < parts.length - 1; i++) node = await node.getDirectoryHandle(parts[i], { create: true });
  const fh = await node.getFileHandle(parts[parts.length - 1], { create: true });
  fh._c = content;
  return fh;
}

(async () => {
  // ---- 1. 版本比较 ----
  check('1.1.0 > 1.0.7', U.compareVer('1.1.0', '1.0.7') === 1);
  check('1.0.7 == v1.0.7', U.compareVer('v1.0.7', '1.0.7') === 0);
  check('1.10.0 > 1.9.9（按段比较而非字典序）', U.compareVer('1.10.0', '1.9.9') === 1);
  check('1.0 == 1.0.0（缺省补零）', U.compareVer('1.0', '1.0.0') === 0);
  check('1.0.6 < 1.0.7', U.compareVer('1.0.6', '1.0.7') === -1);
  check('非法版本号返回 null', U.parseVer('abc') === null);
  check('1.2.3.4 解析为四段',
    JSON.stringify(U.parseVer('1.2.3.4')) === '[1,2,3,4]',
    JSON.stringify(U.parseVer('1.2.3.4')));
  check('1.2.3.4 > 1.2.3.3', U.compareVer('1.2.3.4', '1.2.3.3') === 1);
  check('isValidVer 识别合法与非法版本',
    U.isValidVer('1.2.3.4') === true && U.isValidVer('v2') === true && U.isValidVer('abc') === false);

  // ---- 2. 解压 ----
  const manifest = JSON.stringify({ manifest_version: 3, version: '1.1.0', name: 't' });
  const zipBuf = buildZip([
    { name: 'manifest.json', data: manifest, method: 8 },   // deflate
    { name: 'background.js', data: 'console.log(1);', method: 8 },
    { name: 'icons/icon16.png', data: 'PNGDATA', method: 0 }, // store
    { name: 'icons/', data: '', method: 0 }                   // 目录项应被跳过
  ]);

  const files = await U.unzip(zipBuf);
  check('解压得到 3 个文件（目录项被跳过）', files.length === 3, `got=${files.length}`);

  const byPath = new Map(files.map((f) => [f.path, Buffer.from(f.data).toString('utf8')]));
  check('deflate 条目内容正确', byPath.get('manifest.json') === manifest);
  check('store 条目内容正确', byPath.get('icons/icon16.png') === 'PNGDATA');
  check('嵌套路径保持原样', byPath.has('icons/icon16.png'));

  const bombBuf = buildZip([{ name: 'bomb.txt', data: 'x', method: 8, uncompSize: 60 * 1024 * 1024 }]);
  let bombErr = null;
  try { await U.unzip(bombBuf); } catch (e) { bombErr = e.message; }
  check('压缩炸弹（单文件解压 >50MB）被拒绝', /50MB/.test(bombErr || ''), bombErr || 'no error');

  const many = [];
  for (let i = 0; i < 5; i++) many.push({ name: `b${i}.txt`, data: 'x', method: 8, uncompSize: 45 * 1024 * 1024 });
  let totalErr = null;
  try { await U.unzip(buildZip(many)); } catch (e) { totalErr = e.message; }
  check('解压总量 >200MB 被拒绝', /200MB/.test(totalErr || ''), totalErr || 'no error');

  const badLocal = new Uint8Array(buildZip([{ name: 'manifest.json', data: '{}' }]));
  badLocal.set(Buffer.from('manifesX.json'), 30);
  let mismatchErr = null;
  try { await U.unzip(badLocal.buffer); } catch (e) { mismatchErr = e.message; }
  check('本地头文件名与中央目录不一致时拒绝', /不一致/.test(mismatchErr || ''), mismatchErr || 'no error');

  const realZip = new Uint8Array(buildZip([{ name: 'manifest.json', data: '{}' }]));
  const fakeEocd = Buffer.alloc(22);
  fakeEocd.writeUInt32LE(0x06054b50, 0);
  fakeEocd.writeUInt16LE(0xffff, 20);
  const withFake = new Uint8Array(realZip.length + fakeEocd.length);
  withFake.set(realZip, 0);
  withFake.set(fakeEocd, realZip.length);
  let fakeOk = false;
  try { fakeOk = (await U.unzip(withFake.buffer)).length === 1; } catch (e) { fakeOk = false; }
  check('EOCD 假签名（非法 commentLen）被跳过', fakeOk);

  // ---- 3. 顶层目录剥离 ----
  const nested = U.normalizeFiles([
    { path: 'extension/manifest.json', data: new Uint8Array([1]) },
    { path: 'extension/background.js', data: new Uint8Array([2]) }
  ]);
  check('统一顶层目录被剥离',
    nested.map((f) => f.path).sort().join(',') === 'background.js,manifest.json',
    nested.map((f) => f.path).join(','));

  const notNested = U.normalizeFiles([
    { path: 'manifest.json', data: new Uint8Array([1]) },
    { path: 'extension/background.js', data: new Uint8Array([2]) }
  ]);
  check('已有根 manifest.json 时不剥离',
    notNested.some((f) => f.path === 'extension/background.js'));

  const mixed = U.normalizeFiles([
    { path: 'LICENSE', data: new Uint8Array([1]) },
    { path: 'Repo-main/extension/manifest.json', data: new Uint8Array([2]) },
    { path: 'Repo-main/extension/background.js', data: new Uint8Array([3]) },
    { path: '__MACOSX/._junk', data: new Uint8Array([4]) }
  ]);
  const mixedPaths = mixed.map((f) => f.path).sort().join(',');
  check('顶层混入 LICENSE + 子目录 manifest 时正确剥离',
    mixedPaths === 'LICENSE,background.js,manifest.json', mixedPaths);

  const twoLevel = U.normalizeFiles([
    { path: 'Repo-main/extension/manifest.json', data: new Uint8Array([1]) },
    { path: 'Repo-main/extension/popup.html', data: new Uint8Array([2]) }
  ]);
  check('两层前缀被剥离',
    twoLevel.map((f) => f.path).sort().join(',') === 'manifest.json,popup.html',
    twoLevel.map((f) => f.path).join(','));

  // ---- 4. 路径安全 ----
  const evil = U.normalizeFiles([
    { path: '../evil.js', data: new Uint8Array([1]) },
    { path: '/etc/passwd', data: new Uint8Array([1]) },
    { path: 'C:/Windows/x.dll', data: new Uint8Array([1]) },
    { path: 'a/../../b.js', data: new Uint8Array([1]) },
    { path: 'background.js', data: new Uint8Array([1]) }
  ]);
  check('目录穿越与绝对路径被全部拒绝',
    evil.length === 1 && evil[0].path === 'background.js',
    evil.map((f) => f.path).join(','));

  const withBackup = U.normalizeFiles([
    { path: 'backups/v1.0.7/background.js', data: new Uint8Array([1]) },
    { path: 'background.js', data: new Uint8Array([1]) }
  ]);
  check('备份目录被跳过（避免把备份再写回去）',
    withBackup.length === 1 && withBackup[0].path === 'background.js');

  const backslash = U.normalizeFiles([{ path: 'icons\\icon16.png', data: new Uint8Array([1]) }]);
  check('反斜杠路径被规范为正斜杠',
    backslash.length === 1 && backslash[0].path === 'icons/icon16.png');

  // ---- 5. 端到端：用内存文件系统模拟写盘 ----
  const root = makeDir('extension');
  await putFile(root, 'background.js', 'OLD-CODE');
  await putFile(root, 'manifest.json', JSON.stringify({ version: '1.0.7' }));
  await putFile(root, 'keep-me.txt', 'user file');

  sandbox.window.showDirectoryPicker = async () => root;
  sandbox.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => zipBuf });

  const release = { version: '1.1.0', zip: { name: 'x.zip', url: 'https://example/x.zip' } };
  const res = await U.apply(release, { backup: true });
  check('覆盖已存在的普通文件不被误判为冲突', res.written === 3, `written=${res.written}`);
  check('root manifest.json 已更新', readFile(root, 'manifest.json').includes('1.1.0'));
  check('background.js 已覆盖为新内容', readFile(root, 'background.js') === 'console.log(1);');
  check('新文件 icons/icon16.png 已创建', readFile(root, 'icons/icon16.png') === 'PNGDATA');
  check('目录里的其他文件未被删除', readFile(root, 'keep-me.txt') === 'user file');
  check('旧文件已备份到 backups/v1.0.7/',
    (readFile(root, 'backups/v1.0.7/background.js') || '') === 'OLD-CODE',
    JSON.stringify(keysOf(root)));

  // 版本不一致 / 不比当前新 时必须中止
  const stale = {
    version: '1.1.0',
    zip: { name: 'y.zip', url: 'https://example/y.zip' }
  };
  sandbox.fetch = async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => buildZip([{ name: 'manifest.json', data: JSON.stringify({ version: '1.0.0' }) }])
  });
  let threw = null;
  try { await U.apply(stale, { backup: false }); } catch (e) { threw = e.message; }
  check('包内版本与 Release 不一致时中止', /不一致/.test(threw || ''), threw || 'no error');

  sandbox.fetch = async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => buildZip([{ name: 'manifest.json', data: JSON.stringify({ version: '1.0.7' }) }])
  });
  threw = null;
  try { await U.apply({ version: '1.0.7', zip: { name: 'z.zip', url: 'https://example/z.zip' } }, { backup: false }); } catch (e) { threw = e.message; }
  check('包内版本不比当前新时中止', /不比当前/.test(threw || ''), threw || 'no error');

  // Content-Length 超限
  sandbox.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => '300000000' },
    arrayBuffer: async () => zipBuf
  });
  let lenErr = null;
  try { await U.apply(release, { backup: false }); } catch (e) { lenErr = e.message; }
  check('Content-Length 超过 200MB 时拒绝下载', /200MB/.test(lenErr || ''), lenErr || 'no error');

  // 非法版本使双闸失效
  sandbox.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    arrayBuffer: async () => buildZip([{ name: 'manifest.json', data: JSON.stringify({ version: '1.1.0' }) }])
  });
  let illegalErr = null;
  try {
    await U.apply({ version: 'abc', zip: { name: 'i.zip', url: 'https://example/i.zip' } }, { backup: false });
  } catch (e) { illegalErr = e.message; }
  check('非法 Release 版本中止更新', /非法/.test(illegalErr || ''), illegalErr || 'no error');

  // 写盘前类型冲突预检：中间分量是文件
  const conflictRoot = makeDir('conflict');
  await putFile(conflictRoot, 'background.js', 'OLD');
  await putFile(conflictRoot, 'manifest.json', JSON.stringify({ version: '1.1.0' }));
  await putFile(conflictRoot, 'icons', 'not a dir');
  sandbox.window.showDirectoryPicker = async () => conflictRoot;
  sandbox.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => zipBuf });
  let conflictErr = null;
  try { await U.apply(release, { backup: false }); } catch (e) { conflictErr = e.message; }
  check('中间分量是文件时中止', /冲突/.test(conflictErr || ''), conflictErr || 'no error');
  check('冲突时未写任何文件',
    readFile(conflictRoot, 'icons/icon16.png') === null && readFile(conflictRoot, 'background.js') === 'OLD');

  // 写盘前类型冲突预检：末分量是目录
  const conflictRoot2 = makeDir('conflict2');
  await putFile(conflictRoot2, 'manifest.json', JSON.stringify({ version: '1.1.0' }));
  await putFile(conflictRoot2, 'background.js/x', 'x');
  sandbox.window.showDirectoryPicker = async () => conflictRoot2;
  let conflict2Err = null;
  try { await U.apply(release, { backup: false }); } catch (e) { conflict2Err = e.message; }
  check('末分量是目录时中止', /冲突/.test(conflict2Err || ''), conflict2Err || 'no error');
  check('冲突2 时未写任何新文件', readFile(conflictRoot2, 'icons/icon16.png') === null);

  // 备份失败必须中止更新（非 NotFoundError）
  const backupFailRoot = makeDir('backupfail');
  await putFile(backupFailRoot, 'manifest.json', JSON.stringify({ version: '1.0.7' }));
  await putFile(backupFailRoot, 'background.js', 'OLD');
  const origGetFile = backupFailRoot.getFileHandle.bind(backupFailRoot);
  backupFailRoot.getFileHandle = async (n, opt) => {
    if (n === 'background.js' && (!opt || !opt.create)) throw new Error('EACCES: 读取旧文件失败');
    return origGetFile(n, opt);
  };
  sandbox.window.showDirectoryPicker = async () => backupFailRoot;
  let backupErr = null;
  try { await U.apply(release, { backup: true }); } catch (e) { backupErr = e.message; }
  check('备份失败时中止更新', /EACCES/.test(backupErr || ''), backupErr || 'no error');
  check('备份失败时不写入新文件', readFile(backupFailRoot, 'background.js') === 'OLD');

  // prompt 权限下请求成功则复用句柄
  const reuse = makeDir('reuse');
  reuse.queryPermission = async () => 'prompt';
  let asked = false;
  reuse.requestPermission = async () => { asked = true; return 'granted'; };
  kvStore.set('extensionDirHandle', reuse);
  const reused = await U.ensureDir();
  check('prompt 权限下 requestPermission 成功后复用句柄', reused === reuse && asked);
  kvStore.set('extensionDirHandle', null);

  console.log('=== 更新模块测试 ===\n');
  rows.forEach((l) => console.log('  ' + l));
  console.log(`\n${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
