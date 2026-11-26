/**
 * updater.js —— 检查 GitHub Release 并就地更新本地（未打包）扩展目录。
 * 扩展无法写自己的安装目录，只能由用户授权一次目录句柄（存 IndexedDB 复用）。
 */

'use strict';

(function () {
  const REPO = 'Devilstore/Glados-Railgun-checkin';
  const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

  const IDB_NAME = 'glados-updater';
  const IDB_STORE = 'kv';
  const DIR_KEY = 'extensionDirHandle';

  const BACKUP_DIR = 'backups';
  const SKIP_PATHS = new Set([BACKUP_DIR]);
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

  // ---- 小工具 ----
  function isNotFound(e) {
    return !!(e && (e.name === 'NotFoundError' || /not\s*found/i.test(e.message || '')));
  }

  function isTypeMismatch(e) {
    return !!(e && (e.name === 'TypeMismatchError' ||
      /not an entry of requested type/i.test(e.message || '')));
  }

  function parseVer(v) {
    const m = String(v == null ? '' : v).trim().replace(/^v/i, '')
      .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return null;
    return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0), Number(m[4] || 0)];
  }

  function isValidVer(v) {
    return parseVer(v) != null;
  }

  /** @returns {number} a>b 返回 1，相等 0，a<b 返回 -1 */
  function compareVer(a, b) {
    const pa = parseVer(a);
    const pb = parseVer(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 4; i++) {
      if (pa[i] > pb[i]) return 1;
      if (pa[i] < pb[i]) return -1;
    }
    return 0;
  }

  // ---- IndexedDB：存目录句柄 ----
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error || new Error('事务中止'));
      });
    } finally {
      db.close();
    }
  }

  async function idbSet(key, value) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('事务中止'));
      });
    } finally {
      db.close();
    }
  }

  // ---- 版本检查 ----
  /** 带超时的 fetch；避免 GitHub 挂起时 UI 一直停在「正在检查…」。 */
  async function fetchWithTimeout(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    try {
      return await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(`请求超时（${Math.round((timeoutMs || 15000) / 1000)} 秒未响应）`);
      }
      throw new Error(`网络请求失败：${e.message || e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 拉取最新正式 Release。
   * @returns {{version:string,name:string,notes:string,htmlUrl:string,publishedAt:string,zip:object|null}}
   */
  async function fetchLatest() {
    const resp = await fetchWithTimeout(API_LATEST, {
      headers: { accept: 'application/vnd.github+json' },
      cache: 'no-store'
    }, 15000);
    if (resp.status === 404) throw new Error('仓库还没有正式 Release');
    if (resp.status === 403) throw new Error('GitHub API 限流，请稍后再试');
    if (!resp.ok) throw new Error(`GitHub API 返回 ${resp.status}`);

    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error('GitHub 返回的不是有效 JSON');
    }
    const version = String(data.tag_name || '').replace(/^v/i, '');
    if (!version) throw new Error('Release 里没有 tag_name');

    const assets = (data.assets || []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size
    }));
    // 优先取名字里带版本号的 zip，其次任意 zip
    let zip = assets.find((a) => /\.zip$/i.test(a.name) && a.name.includes(version));
    if (!zip) zip = assets.find((a) => /\.zip$/i.test(a.name)) || null;

    return {
      version,
      name: data.name || data.tag_name || '',
      notes: data.body || '',
      htmlUrl: data.html_url || '',
      publishedAt: data.published_at || '',
      assets,
      zip
    };
  }

  /**
   * 检查是否有新版本。
   * @returns {{current:string, latest:string|null, hasUpdate:boolean, release:object|null, error:string|null}}
   */
  async function check() {
    const current = chrome.runtime.getManifest().version;
    try {
      const release = await fetchLatest();
      const hasUpdate = compareVer(release.version, current) > 0;
      return { current, latest: release.version, hasUpdate, release, error: null };
    } catch (e) {
      return { current, latest: null, hasUpdate: false, release: null, error: e.message || String(e) };
    }
  }

  // ---- 目录授权 ----
  async function pickDir() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持目录选择（需要 Chrome/Edge 103+）');
    }
    const handle = await window.showDirectoryPicker({ id: 'glados-extension-dir', mode: 'readwrite' });

    let hasManifest = false;
    try {
      await handle.getFileHandle('manifest.json');
      hasManifest = true;
    } catch (e) { /* 目录里没有 manifest.json */ }

    if (!hasManifest) {
      const ok = window.confirm(
        '所选目录里没有 manifest.json，可能不是扩展目录。\n' +
        '请选择你在「加载已解压的扩展程序」时选的那个文件夹。\n\n仍要使用这个目录吗？'
      );
      if (!ok) throw new Error('已取消：目录不正确');
    }

    await idbSet(DIR_KEY, handle);
    return handle;
  }

  /** 复用已授权目录；没有或权限失效则弹选择器。 */
  async function ensureDir() {
    let handle = null;
    try { handle = await idbGet(DIR_KEY); } catch (e) { handle = null; }

    if (handle && typeof handle.queryPermission === 'function') {
      try {
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') return handle;
        if (perm === 'prompt' && typeof handle.requestPermission === 'function') {
          const granted = await handle.requestPermission({ mode: 'readwrite' });
          if (granted === 'granted') return handle;
        }
      } catch (e) { /* 句柄失效，走选择器 */ }
    }
    return pickDir();
  }

  /** 忘记已授权目录（下次重新选择）。 */
  async function forgetDir() {
    try { await idbSet(DIR_KEY, null); } catch (e) { /* ignore */ }
  }

  // ---- ZIP 解压 ----
  async function inflateRaw(raw, limit) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持解压 API（需要 Chrome/Edge 103+）');
    }
    const max = limit == null ? MAX_FILE_BYTES : limit;
    const stream = new Response(raw).body.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) {
          await reader.cancel();
          throw new Error('解压数据超过上限，已中止');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }

  /**
   * 解析 zip 为 [{ path, data }]。仅支持 store(0) / deflate(8)，不引入第三方库。
   */
  async function unzip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    if (u8.length < 22) throw new Error('文件太小，不是 zip');

    // 找 EOCD（结尾可能有注释，最多回扫 65557 字节）
    let eocd = -1;
    const floor = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        const commentLen = dv.getUint16(i + 20, true);
        if (i + 22 + commentLen <= u8.length) { eocd = i; break; }
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');

    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const out = [];
    let total = 0;
    let declaredTotal = 0;

    for (let i = 0; i < count; i++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) {
        throw new Error('zip 中央目录损坏');
      }
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const uncompSize = dv.getUint32(off + 24, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder('utf-8').decode(u8.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/')) continue;                    // 目录项
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
        throw new Error('不支持 ZIP64 格式');
      }
      if (uncompSize > MAX_FILE_BYTES) throw new Error('解压文件超过 50MB 上限');
      declaredTotal += uncompSize;
      if (declaredTotal > MAX_TOTAL_BYTES) throw new Error('解压总量超过 200MB 上限');

      if (localOff + 30 > u8.length || dv.getUint32(localOff, true) !== 0x04034b50) {
        throw new Error('zip 本地头损坏');
      }
      const flags = dv.getUint16(localOff + 6, true);
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const lCompSize = dv.getUint32(localOff + 18, true);
      const lName = new TextDecoder('utf-8').decode(u8.subarray(localOff + 30, localOff + 30 + lNameLen));
      if (lName !== name) throw new Error('zip 本地头文件名与中央目录不一致');
      if (!(flags & 0x08) && lCompSize !== compSize) {
        throw new Error('zip 本地头压缩大小与中央目录不一致');
      }
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > u8.length) throw new Error('zip 数据越界');
      const raw = u8.subarray(dataStart, dataStart + compSize);

      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error(`不支持的压缩方式 ${method}（${name}）`);

      total += data.length;
      if (data.length > MAX_FILE_BYTES) throw new Error('解压文件超过 50MB 上限');
      if (total > MAX_TOTAL_BYTES) throw new Error('解压总量超过 200MB 上限');
      out.push({ path: name, data });
    }
    return out;
  }

  /**
   * 规范化文件列表：拒绝目录穿越与绝对路径，跳过备份目录，
   * 并在需要时剥离顶层前缀以得到根 manifest.json。
   */
  function normalizeFiles(files) {
    const safe = [];
    for (const f of files) {
      let p = String(f.path || '').replace(/\\/g, '/');
      if (!p) continue;
      if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) continue;
      const parts = p.split('/').filter((s) => s && s !== '.');
      if (!parts.length) continue;
      if (parts.some((s) => s === '..')) continue;
      if (SKIP_PATHS.has(parts[0]) || parts[0] === '__MACOSX') continue;
      if (parts[parts.length - 1] === '.DS_Store') continue;
      safe.push({ path: parts.join('/'), parts, data: f.data });
    }

    if (!safe.length || safe.some((f) => f.path === 'manifest.json')) return safe;

    const prefixes = [...new Set(safe.map((f) => f.parts[0]))];
    for (const prefix of prefixes) {
      for (const depth of [1, 2]) {
        const stripped = [];
        for (const f of safe) {
          const parts = f.parts[0] === prefix ? f.parts.slice(depth) : f.parts;
          if (!parts.length) continue;
          stripped.push({ path: parts.join('/'), parts, data: f.data });
        }
        if (stripped.some((f) => f.path === 'manifest.json')) return stripped;
      }
    }
    return safe;
  }

  // ---- 写入 ----
  async function readExisting(dir, parts) {
    let node = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      node = await node.getDirectoryHandle(parts[i], { create: false });
    }
    const fh = await node.getFileHandle(parts[parts.length - 1], { create: false });
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  }

  async function writeOne(root, parts, data) {
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node = await node.getDirectoryHandle(parts[i], { create: true });
    }
    const fh = await node.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data);
    } finally {
      await w.close();
    }
  }

  /** 写入前预检类型冲突，避免写了一半才失败。 */
  async function assertNoConflict(dir, files) {
    for (const f of files) {
      let node = dir;
      let exists = true;
      for (let i = 0; i < f.parts.length - 1; i++) {
        const name = f.parts[i];
        let child = null;
        try { child = await node.getDirectoryHandle(name, { create: false }); }
        catch (e) {
          if (isTypeMismatch(e)) throw new Error(`路径冲突：${name} 是文件，不能作为目录`);
          if (!isNotFound(e)) throw e;
          let asFile = null;
          try { asFile = await node.getFileHandle(name, { create: false }); }
          catch (e2) { if (!isNotFound(e2)) throw e2; }
          if (asFile) throw new Error(`路径冲突：${name} 是文件，不能作为目录`);
          exists = false;
          break;
        }
        node = child;
      }
      if (!exists) continue;
      const lastName = f.parts[f.parts.length - 1];
      let asDir = null;
      try { asDir = await node.getDirectoryHandle(lastName, { create: false }); }
      catch (e) {
        if (isTypeMismatch(e) || isNotFound(e)) continue;
        throw e;
      }
      if (asDir) throw new Error(`路径冲突：${lastName} 是目录，不能写入文件`);
    }
  }

  /** 把将被覆盖的旧文件复制到 backups/v<旧版本>/ 下。 */
  async function backupExisting(dir, files, oldVersion) {
    const prefix = `${BACKUP_DIR}/v${oldVersion || 'unknown'}`;
    let saved = 0;
    for (const f of files) {
      let old;
      try { old = await readExisting(dir, f.parts); }
      catch (e) { if (isNotFound(e)) continue; throw e; }
      await writeOne(dir, [...prefix.split('/'), ...f.parts], old);
      saved++;
    }
    return saved;
  }

  /**
   * 执行更新。
   * @param {object} opts { backup 是否备份, onProgress(text) 进度回调 }
   * @returns {{version:string, written:number, backupFiles:number}}
   */
  async function apply(release, opts) {
    const options = opts || {};
    const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    if (!release || !release.zip) throw new Error('该 Release 没有可用的 zip 附件');

    const dir = await ensureDir();
    const oldVersion = chrome.runtime.getManifest().version;

    progress('正在下载安装包…');
    let resp;
    try {
      resp = await fetchWithTimeout(release.zip.url, { cache: 'no-store' }, 60000);
    } catch (e) {
      throw new Error(`下载安装包失败：${e.message}（GitHub 下载域名需已授权，请确认扩展为最新版）`);
    }
    if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
    if (resp.headers && typeof resp.headers.get === 'function') {
      const len = Number(resp.headers.get('content-length'));
      if (len > MAX_TOTAL_BYTES) throw new Error('安装包超过 200MB 上限，已拒绝下载');
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_TOTAL_BYTES) throw new Error('安装包超过 200MB 上限，已拒绝下载');

    progress('正在解压…');
    const files = normalizeFiles(await unzip(buf));
    if (!files.length) throw new Error('压缩包是空的');

    const man = files.find((f) => f.path === 'manifest.json');
    if (!man) throw new Error('压缩包里没有 manifest.json，可能不是扩展包');

    // 包内版本必须等于 Release 版本，且比当前版本新
    let pkgVersion = '';
    try {
      pkgVersion = String(JSON.parse(new TextDecoder('utf-8').decode(man.data)).version || '');
    } catch (e) { /* 解析失败下面会报 */ }
    if (!pkgVersion) throw new Error('压缩包里的 manifest.json 无法解析');
    if (!isValidVer(pkgVersion) || !isValidVer(release.version)) {
      throw new Error('版本号非法，已中止更新');
    }
    if (compareVer(pkgVersion, release.version) !== 0) {
      throw new Error(`包内版本 ${pkgVersion} 与 Release ${release.version} 不一致，已中止`);
    }
    if (compareVer(pkgVersion, oldVersion) <= 0) {
      throw new Error(`包内版本 ${pkgVersion} 不比当前 ${oldVersion} 新，已中止`);
    }

    await assertNoConflict(dir, files);

    let backupFiles = 0;
    if (options.backup !== false) {
      progress('正在备份旧文件…');
      backupFiles = await backupExisting(dir, files, oldVersion);
    }

    progress(`正在写入 ${files.length} 个文件…`);
    let written = 0;
    for (const f of files) {
      await writeOne(dir, f.parts, f.data);
      written++;
    }

    return { version: pkgVersion, written, backupFiles };
  }

  // ---- 导出 ----
  window.Updater = {
    REPO,
    parseVer,
    isValidVer,
    compareVer,
    fetchLatest,
    fetchWithTimeout,
    check,
    apply,
    ensureDir,
    forgetDir,
    unzip,
    normalizeFiles,
    inflateRaw
  };
})();
