// Wisp network config (loaded before assets/wisp-net.js).
// WISP-ONLY fallback: when a normal fetch fails at the network/CORS level
// (school & public wifi filters, CORS-less hosts), the request is retried
// through one of these wisp servers (protocol: MercuryWorkshop wisp-protocol,
// https://github.com/MercuryWorkshop/wisp-protocol — v1/v2 over a single
// multiplexed WebSocket, implemented by the epoxy transport in
// assets/epoxy/index.mjs).
// No third-party CORS relay/proxy services are used.
window.WISP_CONFIG = {
  // Master switch — set false to fully disable wisp fallback.
  enabled: true,

  // Wisp servers in priority order. The first healthy one is used; a server
  // that fails gets its own cooldown and the next one takes over.
  wispServers: [
    'wss://truffled.lol/wisp/'
  ],

  // Self-contained wisp transport module (Epoxy; WASM inlined, no sidecars).
  transportPath: 'assets/epoxy/index.mjs',

  // Per-request timeout through the wisp tunnel (ms).
  timeoutMs: 10000,

  // Base per-server cooldown after a failed connect/fetch (ms); grows x2 per
  // consecutive failure, capped at 10 minutes.
  cooldownMs: 60000,

  // Debug logging (per state change).
  debug: false
};
