/**
 * inject.js —— 在页面主世界（MAIN world）执行
 *
 * 两件事：让后台标签页保持可见状态（否则 Turnstile 不下发 token），
 * 以及旁听官网自己发出的 /api/user/checkin 响应。
 * 本脚本不构造、不伪造、不重放任何签到请求。
 */
(function () {
  'use strict';

  if (window.__gcdInjected) return;
  window.__gcdInjected = true;

  window.__gcdResults = [];
  window.__gcdLast = null;

  // ---- 1. 保持页面可见 ----
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: function () { return 'visible'; }
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: function () { return false; }
    });
    Object.defineProperty(document, 'webkitHidden', {
      configurable: true,
      get: function () { return false; }
    });
    document.dispatchEvent(new Event('visibilitychange'));
    if (typeof window.focus === 'function') {
      try { window.focus(); } catch (e) { /* 部分环境禁止 */ }
    }
  } catch (e) {
    /* 伪装失败不影响后续流程，仅记录 */
    window.__gcdVisibilityPatched = false;
  }

  function isCheckinAPI(url) {
    if (!url) return false;
    var s = String(url);
    return s.indexOf('/api/user/checkin') !== -1 && s.indexOf('/challenge') === -1;
  }

  function capture(payload) {
    try {
      if (!payload || typeof payload !== 'object') return;
      window.__gcdLast = payload;
      window.__gcdResults.push({ at: Date.now(), data: payload });
      if (window.__gcdResults.length > 20) window.__gcdResults.shift();
    } catch (e) { /* ignore */ }
  }

  // ---- 2. 旁听 XHR（官网 axios 底层走 XHR） ----
  try {
    var rawOpen = XMLHttpRequest.prototype.open;
    var rawSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__gcdUrl = url; } catch (e) { /* ignore */ }
      return rawOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      var url;
      try { url = this.__gcdUrl; } catch (e) { url = ''; }
      if (isCheckinAPI(url)) {
        try {
          this.addEventListener('load', function () {
            try {
              // responseType='json' 时 response 已经是对象；普通 XHR 才读 responseText。
              const data = this.response && typeof this.response === 'object'
                ? this.response
                : JSON.parse(this.responseText);
              capture(data);
            } catch (e) { /* 非 JSON */ }
          });
        } catch (e) { /* ignore */ }
      }
      return rawSend.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  // ---- 3. 旁听 fetch（兜底） ----
  try {
    var rawFetch = window.fetch;
    if (typeof rawFetch === 'function') {
      window.fetch = function () {
        var arg = arguments[0];
        var url = typeof arg === 'string'
          ? arg
          : (arg && (arg.url || arg.href)) || '';
        var p = rawFetch.apply(this, arguments);
        if (isCheckinAPI(url) && p && typeof p.then === 'function') {
          p.then(function (resp) {
            try {
              resp.clone().json().then(capture).catch(function () { /* ignore */ });
            } catch (e) { /* ignore */ }
          }).catch(function () { /* ignore */ });
        }
        return p;
      };
    }
  } catch (e) { /* ignore */ }
})();
