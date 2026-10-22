// Wisp network config (loaded before assets/wisp-net.js).
// WISP-ONLY fallback: when a normal fetch fails at the network/CORS level
// (school & public wifi filters, CORS-less hosts), the request is retried
// through one of these wisp servers (protocol: MercuryWorkshop wisp-protocol,
// https://github.com/MercuryWorkshop/wisp-protocol) using the same stack as
// the nanoweb project: BareMux SharedWorker + LibcurlClient over wisp.
// No third-party CORS relay/proxy services are used.
window.WISP_CONFIG = {
  // Master switch — set false to fully disable wisp fallback.
  enabled: true,

  // Wisp servers in priority order. The first healthy one is used; a server
  // that fails gets its own cooldown and the next one takes over. Each
  // server runs in its own SharedWorker, so one bad connection can't
  // poison the other.
  wispServers: [
    'wss://truffled.lol/wisp/',
    'wss://wisp.mercurywork.shop/wisp/'
  ],

  // Transport module: 'libcurl' (the nanoweb-proven default) or 'epoxy'.
  transport: 'libcurl',

  // Per-request timeout through the wisp tunnel (ms).
  timeoutMs: 15000,

  // Base per-server cooldown after a failed connect/fetch (ms); grows x2 per
  // consecutive failure, capped at 10 minutes. Transport-level failures
  // (dead wisp socket) are rebuilt once on a fresh worker FIRST, before a
  // cooldown applies.
  cooldownMs: 60000,

  // Debug logging (per state change).
  debug: false
};
