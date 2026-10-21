// =====================================================================
// WispNet (v2.7) — WISP-ONLY fallback network for Animetsu.
// =====================================================================
// Implements the wisp protocol (MercuryWorkshop wisp-protocol v1/v2,
// https://github.com/MercuryWorkshop/wisp-protocol) through the
// self-contained epoxy transport from the nano client
// (assets/epoxy/index.mjs — WASM inlined) to issue plain HTTP(S)
// requests over a single multiplexed WebSocket.
//
// Fallback chain policy: normal fetch() FIRST; wisp ONLY when the first
// fetch fails at the network/CORS level. No third-party CORS relay
// services are used — only wisp servers:
//   1. wss://truffled.lol/wisp/          (primary)
//   2. wss://wisp.mercurywork.shop/wisp/ (secondary, mercuryworkshop)
// A server that fails is put on its own cooldown and the next one is
// tried; when all are down the caller's original error is rethrown so
// the engine keeps its existing behavior.
//
// Overrides: localStorage '@animetsu/wisp' or ?wisp=<url> pins a single
// server. config/wisp.js holds the defaults.
// =====================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.WispNet) return; // don't double-install

  const DEFAULT_SERVERS = [
    'wss://truffled.lol/wisp/',
    'wss://wisp.mercurywork.shop/wisp/'
  ];

  const CFG = Object.assign({
    enabled: true,
    wispServers: DEFAULT_SERVERS.slice(),
    wispServer: null,              // optional single-server pin (is overridden too)
    transportPath: 'assets/epoxy/index.mjs',
    timeoutMs: 10000,
    cooldownMs: 60000,             // base per-server cooldown after a failure
    maxCooldownMs: 10 * 60 * 1000, // cooldown growth cap
    debug: false
  }, window.WISP_CONFIG || {});

  // Runtime overrides: localStorage pin first, then URL param.
  try {
    const saved = localStorage.getItem('@animetsu/wisp');
    if (saved && /^wss?:\/\//i.test(saved)) CFG.wispServers = [saved];
    const qp = new URLSearchParams(window.location.search || '').get('wisp');
    if (qp && /^wss?:\/\//i.test(qp)) CFG.wispServers = [qp];
    if (CFG.wispServer && /^wss?:\/\//i.test(CFG.wispServer) && CFG.wispServers[0] !== CFG.wispServer) {
      CFG.wispServers = [CFG.wispServer];
    }
  } catch {}

  // Normalize: always an array of sanitized wss/ws URLs (trailing slash kept —
  // the wisp spec requires the endpoint to end with '/').
  const SERVERS = (Array.isArray(CFG.wispServers) ? CFG.wispServers : [CFG.wispServers])
    .filter(u => typeof u === 'string' && /^wss?:\/\//i.test(u));
  if (SERVERS.length === 0) SERVERS.push.apply(SERVERS, DEFAULT_SERVERS);

  const state = new Map(); // server url -> { transport, ready, bootPromise, fails, failUntil }

  function entryFor(serverUrl) {
    if (!state.has(serverUrl)) {
      state.set(serverUrl, {
        url: serverUrl,
        transport: null,
        ready: false,
        booting: false,
        bootPromise: null,
        fails: 0,
        failUntil: 0
      });
    }
    return state.get(serverUrl);
  }

  function log() {
    if (CFG.debug) { try { console.log.apply(console, ['[WispNet]'].concat([].slice.call(arguments))); } catch {} }
  }
  function warn() {
    try { console.warn.apply(console, ['[WispNet]'].concat([].slice.call(arguments))); } catch {}
  }

  function serverCooling(ms) { return Date.now() < (ms && ms.failUntil || 0); }

  // Fully down = every configured server is on cooldown.
  function isCoolingDown() {
    for (const s of SERVERS) if (!serverCooling(entryFor(s))) return false;
    return true;
  }

  function markServerFail(en, err) {
    en.fails++;
    const ms = Math.min(CFG.cooldownMs * Math.pow(2, Math.max(0, en.fails - 1)), CFG.maxCooldownMs);
    en.failUntil = Date.now() + ms;
    if (CFG.debug || en.fails <= 2) {
      warn('server unavailable (' + (err && err.message || err) + '): ' + en.url + ' — pausing ' + Math.round(ms / 1000) + 's');
    }
  }
  function markServerOK(en) {
    if (en.fails) en.fails = 0;
    en.failUntil = 0;
  }

  // Boot (or reuse) the epoxy transport for one wisp server. The transport
  // performs the wisp handshake internally (INFO/CONTINUE per protocol spec).
  function boot(en) {
    if (en.transport && en.ready) return Promise.resolve(en.transport);
    if (en.bootPromise) return en.bootPromise;
    en.booting = true;
    en.bootPromise = (async () => {
      const href = new URL(CFG.transportPath, document.baseURI).href;
      log('booting epoxy transport for', en.url, '(', href, ')');
      const mod = await import(href);
      const TransportCtor = mod.default || mod.EpoxyTransport || mod.LibcurlClient;
      if (typeof TransportCtor !== 'function') throw new Error('transport module has no default export');
      const transport = new TransportCtor({ wisp: en.url, redirect_limit: 8 });
      await transport.init();
      en.transport = transport;
      en.ready = true;
      en.booting = false;
      log('transport ready for', en.url);
      return transport;
    })().catch(err => {
      en.bootPromise = null;
      en.booting = false;
      markServerFail(en, err);
      throw err;
    });
    return en.bootPromise;
  }

  function normalizeHeaders(raw) {
    if (raw instanceof Headers) return raw;
    const h = new Headers();
    if (!raw) return h;
    try {
      if (Array.isArray(raw)) {
        if (raw.length && Array.isArray(raw[0])) {
          for (const kv of raw) { if (Array.isArray(kv) && kv[0]) h.set(String(kv[0]), String(kv[1] == null ? '' : kv[1])); }
        } else {
          for (let i = 0; i + 1 < raw.length; i += 2) { if (raw[i]) h.set(String(raw[i]), String(raw[i + 1] == null ? '' : raw[i + 1])); }
        }
      } else if (typeof raw === 'object') {
        for (const k in raw) {
          if (Object.prototype.hasOwnProperty.call(raw, k) && raw[k] != null) h.set(String(k), String(raw[k]));
        }
      }
    } catch {}
    return h;
  }

  async function wrapWispResponse(out) {
    if (out instanceof Response) return out;
    const status = Number(out && out.status) || 0;
    const headers = normalizeHeaders(out && out.headers);
    const body = out && out.body != null ? out.body : null;
    const init = { status, statusText: (out && out.statusText) || '', headers };
    try { return new Response(body, init); } catch { return new Response(null, init); }
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('wisp fetch timed out after ' + ms + 'ms')), ms);
      promise.then(
        v => { clearTimeout(t); resolve(v); },
        e => { clearTimeout(t); reject(e); }
      );
    });
  }

  // Issue one HTTP(S) request through the first available wisp server.
  // Tries each config-specified server in order (skipping cooled-down
  // ones) and returns a real Response. Throws when all servers are
  // unavailable or the request itself failed everywhere.
  async function fetch(url, init = {}, timeoutMs) {
    if (!/^(https?:|wisp:\/?\/?)/i.test(String(url || ''))) {
      throw new Error('only absolute http(s) URLs can route through wisp');
    }
    const ms = Math.max(1000, Number(timeoutMs) || CFG.timeoutMs);
    const method = (init && init.method || 'GET').toUpperCase();
    const headers = (init && init.headers) || {};
    let body = init && init.body;
    if (body && typeof body === 'object' && typeof body.json !== 'function' &&
        !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
      try { body = JSON.stringify(body); } catch {}
    }

    let lastErr = null;
    for (const serverUrl of SERVERS) {
      const en = entryFor(serverUrl);
      if (serverCooling(en)) { lastErr = lastErr || new Error('wisp server cooling down'); continue; }
      try {
        const transport = await boot(en); // dedupes concurrent boots; throws on failure
        const client = transport.client || transport;
        let p;
        if (client && typeof client.fetch === 'function') {
          // wasm EpoxyClient.fetch(url, {method, body, headers, redirect}) -> real Response
          p = client.fetch(String(url), { method, body, headers, redirect: 'manual' });
        } else {
          // generic transport shape (bare-mux style)
          p = transport.request(new URL(String(url)), method, body, headers, undefined);
        }
        const res = await withTimeout(p, ms);
        markServerOK(en);
        return await wrapWispResponse(res);
      } catch (err) {
        lastErr = err;
        markServerFail(en, err);
      }
    }
    throw lastErr || new Error('no wisp servers configured');
  }

  // Fetch an image/asset through wisp and hand back an object URL for <img src>.
  async function blobObjectURL(url, timeoutMs) {
    try {
      const res = await fetch(String(url), {}, Math.max(4000, Number(timeoutMs) || 15000));
      if (!res.ok) return null;
      const blob = await res.blob();
      return (blob && blob.size) ? URL.createObjectURL(blob) : null;
    } catch { return null; }
  }

  window.WispNet = {
    config: CFG,
    servers: SERVERS,
    fetch: fetch,
    blobObjectURL: blobObjectURL,
    isReady() { return SERVERS.some(s => { const e = state.get(s); return e && e.ready; }); },
    isCoolingDown: isCoolingDown,
    status() {
      return {
        enabled: !!CFG.enabled,
        servers: SERVERS.map(u => {
          const e = state.get(u) || entryFor(u);
          return { url: u, ready: e.ready, cooling: serverCooling(e), fails: e.fails };
        })
      };
    }
  };

  // -----------------------------------------------------------------
  // <img> fallback: capture-phase error listener. When an <img> fails to
  // load from the CDN (blocked wifi, dead mirror), refetch that exact URL
  // once through wisp and swap in a blob URL. Only engages when wisp is
  // not fully cooling down, and each element at most once.
  // -----------------------------------------------------------------
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('error', function (e) {
      const img = e && e.target;
      try {
        if (!img || img.tagName !== 'IMG') return;
        if (img.dataset && img.dataset.wispFb) return;                 // already tried
        if (!CFG.enabled || isCoolingDown()) return;
        const raw = img.getAttribute('src') || '';
        if (!/^https?:\/\//i.test(raw)) return;
        if ((img.src || '').startsWith('blob:')) return;
        if (img.dataset) img.dataset.wispFb = '1';
        blobObjectURL(raw).then(function (u) { if (u) { img.src = u; log('image recovered via wisp:', raw); } }).catch(function () {});
      } catch (_) {}
    }, true);
  }

  // -----------------------------------------------------------------
  // Suppress the harmless "closure invoked after being dropped" errors
  // that the epoxy WASM glue throws when a wisp WebSocket disconnects.
  // They are a teardown artifact of the transport, not real failures.
  // -----------------------------------------------------------------
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('error', function (e) {
      try {
        const msg = (e && (e.message || (e.error && e.error.message))) || '';
        if (String(msg).indexOf('closure invoked after being dropped') !== -1) {
          if (e && typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          if (e && e.preventDefault) e.preventDefault();
        }
      } catch {}
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      try {
        const r = e && e.reason;
        const msg = (r && (r.message || r)) || '';
        if (String(msg).indexOf('closure invoked after being dropped') !== -1) {
          if (e && e.preventDefault) e.preventDefault();
        }
      } catch {}
    });
  }
})();
