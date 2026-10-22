// =====================================================================
// WispNet (v2.10) — WISP-ONLY fallback network for Animetsu.
// =====================================================================
// Replicates the proven nanoweb/chemical.js stack exactly:
//   window.BareMux (assets/baremux/index.js)  -> BareMuxConnection
//   assets/baremux/worker.js (SharedWorker)   -> holds the transport
//   assets/libcurl/index.mjs                  -> LibcurlClient (default)
//   assets/epoxy/index.mjs                    -> Epoxy (optional)
// Requests go through `BareClient.fetch()` over wisp TCP/WebSocket streams
// (MercuryWorkshop wisp-protocol).
//
// Fallback chain policy: normal fetch() FIRST; wisp ONLY when the first
// fetch fails at the network/CORS level. No third-party CORS relay
// services are used — only wisp servers:
//   1. wss://truffled.lol/wisp/          (primary)
//   2. wss://wisp.mercurywork.shop/wisp/ (secondary, mercuryworkshop)
//
// Resilience: each server runs in its OWN SharedWorker (isolated identity),
// so a dead connection on one server never poisons the other. When a
// transport-level failure happens (wisp socket closed / MuxTaskEnded /
// broken pipe / request timeout), the transport is torn down and rebuilt
// on a FRESH SharedWorker once, before the server is marked failed.
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
    wispServer: null,              // optional single-server pin
    transport: 'libcurl',          // 'libcurl' (nanoweb-proven) or 'epoxy'
    transportPath: null,           // computed from transport
    timeoutMs: 15000,
    cooldownMs: 60000,             // base per-server cooldown after hard failure
    maxCooldownMs: 10 * 60 * 1000, // cooldown growth cap
    debug: false
  }, window.WISP_CONFIG || {});

  const TRANSPORT_PATHS = {
    libcurl: 'assets/libcurl/index.mjs',
    epoxy: 'assets/epoxy/index.mjs'
  };

  // Runtime overrides: localStorage pin first, then URL param.
  try {
    const saved = localStorage.getItem('@animetsu/wisp');
    if (saved && /^wss?:\/\//i.test(saved)) CFG.wispServers = [saved];
    const qp = new URLSearchParams(window.location.search || '').get('wisp');
    if (qp && /^wss?:\/\//i.test(qp)) CFG.wispServers = [qp];
    const tp = new URLSearchParams(window.location.search || '').get('transport');
    if (tp && TRANSPORT_PATHS[tp]) CFG.transport = tp;
    if (CFG.wispServer && /^wss?:\/\//i.test(CFG.wispServer)) CFG.wispServers = [CFG.wispServer];
  } catch {}

  // Normalize: always an array of sanitized wss/ws URLs (trailing slash kept —
  // the wisp spec requires the endpoint to end with '/').
  const SERVERS = (Array.isArray(CFG.wispServers) ? CFG.wispServers : [CFG.wispServers])
    .filter(u => typeof u === 'string' && /^wss?:\/\//i.test(u));
  if (SERVERS.length === 0) SERVERS.push.apply(SERVERS, DEFAULT_SERVERS);

  const state = new Map(); // server url -> { fails, failUntil }

  function entryFor(serverUrl) {
    if (!state.has(serverUrl)) {
      state.set(serverUrl, { url: serverUrl, fails: 0, failUntil: 0 });
    }
    return state.get(serverUrl);
  }

  function log() {
    if (CFG.debug) { try { console.log.apply(console, ['[WispNet]'].concat([].slice.call(arguments))); } catch {} }
  }
  function warn() {
    try { console.warn.apply(console, ['[WispNet]'].concat([].slice.call(arguments))); } catch {}
  }

  // Asset base: derived from THIS script's own src URL (…/assets/wisp-net.js)
  // and NOT from document.baseURI. The SPA router navigates client-side to
  // deep paths (e.g. /watch/watch/anime); resolving relative asset paths via
  // baseURI on such routes produced 404s and hard-killed both wisp servers
  // with "Failed to fetch dynamically imported module" — taking every
  // provider/stream fallback offline. The script tag always carries the
  // correct site root, so paths derived from it survive any client route.
  let ASSET_BASE = '';
  try {
    const me = (typeof document !== 'undefined' && document.querySelector) ?
      (document.querySelector('script[src*="wisp-net.js"]') || document.querySelector('script[src*="wisp-net?"]')) : null;
    if (me && me.src) {
      const u = new URL(me.src, (typeof location !== 'undefined' ? location.href : 'about:blank'));
      const clean = String(u.href).split('?')[0].split('#')[0];
      const idx = clean.toLowerCase().lastIndexOf('/assets/');
      if (idx > 0) ASSET_BASE = clean.slice(0, idx + 1); // ".../watch/" (site root)
    }
  } catch {}
  if (!ASSET_BASE) {
    try { ASSET_BASE = new URL('.', document.baseURI).href; } catch { ASSET_BASE = './'; }
  }

  function absRel(p) {
    try {
      if (/^(https?:)?\/\//i.test(p) || /^(data|blob):/i.test(p)) return p;
      return new URL(String(p).replace(/^\/+/, ''), ASSET_BASE).href;
    } catch { return p; }
  }
  function transportPath() {
    return CFG.transportPath || TRANSPORT_PATHS[CFG.transport] || TRANSPORT_PATHS.libcurl;
  }

  // ONE SharedWorker for the whole session (exactly like chemical.js in the
  // nanoweb project). Server switching is done by re-calling setTransport()
  // on the same connection — the nanoweb-faithful pattern. A single worker
  // also guarantees bare-mux's internal ping-recovery always keys to the
  // only worker that exists (its fallback re-reads a global localStorage
  // path, so one-worker-per-server would cross wires under failure).
  const GLOBAL_WORKER_PATH = absRel('assets/baremux/worker.js') + '?v=' + (window.WISP_BAREMUX_V || 'v2_9');

  // currentWorkerServer tracks which wisp url the transport inside the
  // SharedWorker is configured for right now.
  let gConn = null, gClient = null, gBootPromise = null, gCurrentServer = null;

  function serverCooling(en) { return en && Date.now() < (en.failUntil || 0); }

  // Fully down = every configured server is on cooldown.
  function isCoolingDown() {
    for (const s of SERVERS) if (!serverCooling(entryFor(s))) return false;
    return true;
  }

  function markServerSoftFail(en, err) {
    // e.g. one slow request (rate-limit backoff on the target, first-wasm
    // compile). Short pause only — the tunnel itself may be healthy.
    en.fails++;
    en.failUntil = Date.now() + 20000;
    if (CFG.debug || en.fails <= 1) {
      warn('slow request (' + (err && err.message || err) + '): ' + en.url + ' — soft pause 20s');
    }
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

  // Errors that mean "the wisp connection itself is dead/broken": rebuilding
  // the transport on a fresh worker may genuinely fix these.
  const HARD_CONNECT_RE = /did not open|ERR_CERT|ERR_NAME|handshake|certificate/i;

  function isTransportDead(err) {
    const m = String(err && err.message || err || '');
    return /MuxTaskEnded|broken pipe|connection error|WebSocket|timed out|closure invoked/i.test(m);
  }

  async function loadBareMux() {
    if (window.BareMux) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = absRel('assets/baremux/index.js') + '?v=' + (window.WISP_BAREMUX_V || 'v2_9');
      s.onload = resolve;
      s.onerror = () => reject(new Error('failed to load baremux client script'));
      document.head.appendChild(s);
    });
    if (!window.BareMux) throw new Error('BareMux did not initialize');
  }

  // Boot the single SharedWorker + BareClient pair (once per page load).
  function boot() {
    if (gClient) return Promise.resolve(gClient);
    if (gBootPromise) return gBootPromise;
    gBootPromise = (async () => {
      await loadBareMux();
      log('booting bare-mux worker', GLOBAL_WORKER_PATH);
      gConn = new window.BareMux.BareMuxConnection(GLOBAL_WORKER_PATH);
      gClient = new window.BareMux.BareClient(GLOBAL_WORKER_PATH);
      log('bare-mux worker ready');
      return gClient;
    })().catch(err => {
      gBootPromise = null;
      gConn = null;
      gClient = null;
      gCurrentServer = null;
      throw err;
    });
    return gBootPromise;
  }

  // Configure (or re-configure) the transport inside the SharedWorker for a
  // given wisp server. Switching servers re-runs setTransport on the same
  // connection — fresh transport instance, fresh wisp WebSocket.
  async function configure(serverUrl) {
    const client = await boot();
    if (gCurrentServer === serverUrl) return client;
    log('switching transport wisp to', serverUrl);
    await gConn.setTransport(absRel(transportPath()), [{ wisp: serverUrl }]);
    gCurrentServer = serverUrl;
    return client;
  }

  // Mark the currently-configured transport as suspect so the next call to
  // configure() re-runs setTransport (fresh transport + fresh wisp socket).
  function invalidateCurrent() {
    gCurrentServer = null;
  }

  async function rawFetch(client, url, init) {
    return await client.fetch(String(url), init);
  }

  // Thin wrapper: a per-request timeout is applied by the caller's loop.
  function send(client, url, init, ms) {
    return withTimeout(rawFetch(client, url, init), ms);
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
  // Failover order: configured servers in order (skipping cooled-down ones).
  // Transport-level failures get ONE same-server rebuild+retry (setTransport
  // is re-run, giving a fresh transport + wisp WebSocket) before the server
  // is cooled down and the next server is tried.
  async function fetch(url, init = {}, timeoutMs) {
    if (!/^(https?:|wisp:?\/?\/?)/i.test(String(url || ''))) {
      throw new Error('only absolute http(s) URLs can route through wisp');
    }
    const ms = Math.max(3000, Number(timeoutMs) || CFG.timeoutMs);
    const method = (init && init.method || 'GET').toUpperCase();
    const headers = (init && init.headers) || {};
    let body = init && init.body;
    if (body && typeof body === 'object' && typeof body.json !== 'function' &&
        !(typeof Blob !== 'undefined' && body instanceof Blob) &&
        !(typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) &&
        !(typeof Uint8Array !== 'undefined' && body instanceof Uint8Array)) {
      try { body = JSON.stringify(body); } catch {}
    }
    const reqInit = { method, body, headers, redirect: 'follow' };

    let lastErr = null;
    for (const serverUrl of SERVERS) {
      const en = entryFor(serverUrl);
      if (serverCooling(en)) { lastErr = lastErr || new Error('wisp server cooling down'); continue; }

      let client;
      try {
        client = await configure(serverUrl);
      } catch (err) {
        lastErr = err;
        const msg = String(err && err.message || err);
        if (HARD_CONNECT_RE.test(msg) && !/wasm/i.test(msg)) {
          markServerFail(en, err);
          continue;
        }
        if (/dynamically imported module|failed to import/i.test(msg)) {
          // Our own asset failed to load (request asset/base-path issue), not
          // the wisp server's fault. Brief soft pause + try the next server;
          // hard-cooling here used to take wisp offline for minutes.
          markServerSoftFail(en, err);
          continue;
        }
        // Soft boot-level failure: force a transport rebuild on retry.
        invalidateCurrent();
        try {
          client = await configure(serverUrl);
        } catch (err2) {
          lastErr = err2;
          if (/dynamically imported module|failed to import/i.test(String(err2 && err2.message || err2))) {
            markServerSoftFail(en, err2);
          } else {
            markServerFail(en, err2);
          }
          continue;
        }
      }

      try {
        const res = await send(client, url, reqInit, ms);
        markServerOK(en);
        return res;
      } catch (err) {
        const msg = String(err && err.message || err);
        log('request failed via', en.url, '-', msg);
        invalidateCurrent(); // dead transport: force fresh transport before any further use

        if (HARD_CONNECT_RE.test(msg)) { markServerFail(en, err); lastErr = err; continue; }

        // Plain timeout: transport may still be healthy; don't burn a whole
        // cooldown on one slow response. Short soft pause, next server.
        if (/\btimed out\b/i.test(msg)) {
          markServerSoftFail(en, err);
          lastErr = err;
          break;
        }

        // Soft (transport-level) failure: rebuild once and retry.
        try {
          log('rebuilding transport for', en.url, 'and retrying');
          client = await configure(serverUrl);
          const res2 = await send(client, url, reqInit, ms);
          markServerOK(en);
          return res2;
        } catch (err2) {
          lastErr = err2;
          if (/dynamically imported module|failed to import/i.test(String(err2 && err2.message || err2))) {
            markServerSoftFail(en, err2);
          } else {
            markServerFail(en, err2);
          }
        }
      }
    }
    throw lastErr || new Error('no wisp servers configured');
  }

  // Fetch an image/asset through wisp and hand back an object URL for <img src>.
  // -----------------------------------------------------------------
  // Image recovery QUEUE: every recovered image is one HTTP request tunneled
  // through the single shared wisp WebSocket. Unbounded parallel image
  // recovery strangles the tunnel (the "wisp is slow" effect), so image jobs
  // run with a small concurrency cap, a payload size cap, an in-flight/done
  // memo (identical broken URLs never refetch), and a per-host failure
  // cooldown. API/data calls always outrank these image jobs.
  // -----------------------------------------------------------------
  const IMG_CONCURRENCY = 2;
  const IMG_MAX_BYTES = 1.5 * 1024 * 1024;   // don't tunnel big payloads
  const IMG_MEMO_MAX = 240;                  // remembered urls (blob urls kept)
  const IMG_HOST_FAIL_PAUSE = 5 * 60 * 1000; // per-host skip after repeated fails
  const imgMemo = new Map();                 // url -> 'FAIL' | blobURL | pendingPromise
  const imgHostFails = new Map();            // host -> { fails, until }
  let imgActive = 0;
  const imgQueue = [];

  function imgHostInfo(raw) {
    try {
      const host = new URL(raw).host;
      const f = imgHostFails.get(host);
      if (f && f.until && Date.now() < f.until) return null; // host is cooling
      return { host: host };
    } catch { return null; }
  }
  function imgHostFail(host) {
    try {
      const f = imgHostFails.get(host) || { fails: 0, until: 0 };
      f.fails++;
      if (f.fails >= 3) { f.fails = 0; f.until = Date.now() + IMG_HOST_FAIL_PAUSE; }
      imgHostFails.set(host, f);
    } catch {}
  }
  async function imgDoFetch(raw, info) {
    try {
      const res = await fetch(raw, {}, 12000);
      if (!res.ok) throw new Error('wisp image HTTP ' + res.status);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > IMG_MAX_BYTES) throw new Error('wisp image too large');
      const blob = await res.blob();
      if (!blob || !blob.size || blob.size > IMG_MAX_BYTES) throw new Error('wisp image too large');
      const f = imgHostFails.get(info.host);
      if (f) f.fails = 0;
      return URL.createObjectURL(blob);
    } catch (e) {
      imgHostFail(info.host);
      return null;
    }
  }
  function runImgNext() {
    while (imgActive < IMG_CONCURRENCY && imgQueue.length) {
      const job = imgQueue.shift();
      imgActive++;
      job().then(() => { imgActive--; runImgNext(); }, () => { imgActive--; runImgNext(); });
    }
  }
  function recoverImg(raw) {
    let entry = imgMemo.get(raw);
    if (entry === 'FAIL') return Promise.resolve(null);
    if (entry) return entry; // pending promise (dedupe identical urls)
    const info = imgHostInfo(raw);
    if (!info) { imgMemo.set(raw, 'FAIL'); return Promise.resolve(null); }
    entry = new Promise(function (resolve) {
      imgQueue.push(function () {
        return imgDoFetch(raw, info).then(function (u) { resolve(u); }, function () { resolve(null); });
      });
    });
    imgMemo.set(raw, entry);
    if (imgMemo.size > IMG_MEMO_MAX) {
      const firstKey = imgMemo.keys().next().value;
      if (firstKey !== undefined) imgMemo.delete(firstKey); // drop (no revoke: img may still use it)
    }
    runImgNext();
    return entry;
  }
  async function blobObjectURL(url, timeoutMs) {
    try {
      const info = imgHostInfo(url);
      if (!info) return null;
      const u = await imgDoFetch(String(url), info);
      return (u && typeof u === 'string') ? u : null;
    } catch { return null; }
  }

  window.WispNet = {
    config: CFG,
    servers: SERVERS,
    fetch: fetch,
    blobObjectURL: blobObjectURL,
    isReady() { return SERVERS.some(s => gCurrentServer === s && !!gClient); },
    isCoolingDown: isCoolingDown,
    status() {
      return {
        enabled: !!CFG.enabled,
        transport: CFG.transport,
        worker: GLOBAL_WORKER_PATH,
        currentServer: gCurrentServer,
        serverCount: SERVERS.length,
        servers: SERVERS.map(u => {
          const e = entryFor(u);
          return { url: u, cooling: serverCooling(e), fails: e.fails };
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
        recoverImg(raw).then(function (u) { if (u) { img.src = u; log('image recovered via wisp:', raw); } }).catch(function () {});
      } catch (_) {}
    }, true);
  }

  // -----------------------------------------------------------------
  // Pre-warm: boot the SharedWorker + libcurl wasm and open the first
  // available wisp tunnel right after page load so real API calls later
  // never race the multi-second first compile.
  // -----------------------------------------------------------------
  if (CFG.enabled) {
    const warm = function () {
      try {
        const first = SERVERS.find(s => !serverCooling(entryFor(s)));
        if (!first) return;
        configure(first).then(async function () {
          try {
            // A real lightweight fetch proves the tunnel (wasm compile +
            // wss connect + TLS) is fully ready before real traffic arrives.
            const res = await send(gClient, 'https://example.com/', { method: 'GET' }, 12000);
            if (res && (res.status >= 200 && res.status < 500)) markServerOK(entryFor(first));
            log('pre-warm complete for', first, 'status', res && res.status);
          } catch (e) {
            log('pre-warm probe failed:', e && e.message);
          }
        }, function () {});
      } catch {}
    };
    if (document.readyState === 'loading') {
      window.addEventListener('load', function () { setTimeout(warm, 800); });
    } else {
      setTimeout(warm, 800);
    }
  }

  // -----------------------------------------------------------------
  // Suppress the harmless "closure invoked after being dropped" errors
  // that the epoxy WASM glue throws when a wisp WebSocket disconnects.
  // They are a teardown artifact of the transport, not real failures.
  // -----------------------------------------------------------------
  if (window.addEventListener) {
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
