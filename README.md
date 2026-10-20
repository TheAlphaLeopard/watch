# Animetsu — Static Frontend Mirror

Complete static snapshot of the animetsu.site frontend (SPA), made
**location-independent**: it works served from a domain root, a subpath
(GitHub Pages project sites, parent-folder dev servers), or any static file
server — no build step, no dependencies, no configuration.

## What's included

| File | Purpose |
|------|---------|
| `index.html` | App shell (relative asset paths + base auto-detection bootstrap) |
| `assets/index.js` | Main application bundle (React build, patched for any base path) |
| `assets/index.css` | Application stylesheet |
| `assets/client_engine.js` | Client-side data/stream engine ("multi-source engine") |
| `assets/gang.ttf` | Bundled font |
| `config/ads.js` | Ad/smartlink configuration — **all ads disabled** (`enabled: false`) |
| `animetsu-a-white.png`, `favicon.ico`, `apple-touch-icon.png`, `android-chrome-*.png` | Icons/branding |
| `manifest.json` | PWA manifest (relative `start_url`/`scope`/icons) |
| `404.html` | Deep-link recovery redirector (GitHub Pages project sites) |
| `_redirects` | Netlify/Cloudflare Pages SPA fallback rule (`/* -> /index.html 200`) |
| `fiveserver.config.js` | VS Code "Five Server" extension config (serves this folder as root) |
| `robots.txt`, `sitemap.xml` | Crawler files (still reference the original domain — see notes) |

## Works anywhere — hosting matrix

The app detects its own install prefix at runtime (from the module bundle's
URL), so no matter where the folder is dropped, paths resolve correctly:

| Hosting condition | Homepage | Client-side navigation | Deep-link refresh |
|---|---|---|---|
| Domain root (Netlify, Cloudflare Pages, Vercel, nginx, custom domain) | ✅ | ✅ | ✅ (via `_redirects` / server rewrite) |
| GitHub Pages **project site** (`user.github.io/repo/`) | ✅ | ✅ | ✅ (via `404.html` redirector) |
| GitHub Pages **user site** (`user.github.io/`) | ✅ | ✅ | ✅ (via `404.html` redirector) |
| Subpath on any static server (`/some/folder/`) | ✅ | ✅ | only if the server falls back to `index.html` |
| `python -m http.server` / `npx serve` from inside the folder | ✅ | ✅ | refresh on deep URL = plain 404 (server has no SPA fallback — navigate from home instead) |
| VS Code Five Server with this folder as workspace | ✅ | ✅ | ✅ (with included config) |
| VS Code Five Server serving a **parent** folder | ✅ (site under `/subfolder/`) | ✅ | same subpath caveat |

How it works:

1. **All document-referenced assets use relative paths** (`assets/index.js`,
   `manifest.json`, …), so files resolve no matter what prefix the server adds.
2. A tiny **bootstrap in `index.html`** derives the install prefix from the
   module bundle URL and exposes it as `window.__ANIMETSU_BASE__`; the bundle's
   router reads it as its basename, and JS-injected asset URLs use
   `window.ANIMETSU_ASSET_BASE`.
3. On hosts without SPA fallback that serve `404.html` for missing routes
   (GitHub Pages), the included `404.html` **redirector** bounces to the app
   directory and the bootstrap restores the deep-link route from
   `sessionStorage`.

## Static hosting setup (optional SPA fallback)

The site runs without any of these — the fallback only improves deep-link
refreshes on root-hosted deployments.

**Netlify / Cloudflare Pages** — `_redirects` included; drag and drop. Done.

**Vercel** — add `vercel.json`:
```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

**GitHub Pages** — push the folder to a repo and enable Pages. `404.html`
handles deep links automatically. Done.

**nginx**:
```nginx
server {
  listen 80;
  root /var/www/animetsu;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
}
```

**Apache** — include an `.htaccess` with:
```apache
RewriteEngine On
RewriteBase /
RewriteRule ^index\.html$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.html [L]
```

**Caddy**:
```
animetsu.example.com {
  root * /var/www/animetsu
  try_files {path} /index.html
  file_server
}
```

## How the site works (architecture notes)

- The React bundle sets its API base from `window.b = location.origin + "/v2"`.
- However, networking is fully replaced by `window.__animetsu_adapter`
  (defined in `assets/client_engine.js`). Almost all data endpoints
  (home, search, browse, schedule, episodes, watchlist, history,
  notifications, settings) are resolved **client-side** from third-party
  public sources (AniList GraphQL, Jikan/MAL, TMDB, ani.zip mappings) and
  crowd-cached in `localStorage`.
- Video stream resolution happens client-side against the provider endpoints
  hard-coded in `client_engine.js` (e.g. `api.animetsu.site/watch/...`,
  `api.aniclover.cc`, `anixo.buzz`, `anshu.screenscape.me`, plus HLS via
  `hls.js` loaded from jsDelivr).
- A few engine code paths have same-origin fallbacks (`/api/flix/...`,
  `/watch/mkissa/...`) used only when third-party sources fail — these will
  simply 404 on your host and the engine moves on to the next source.
- `window.p = "https://swiftstream.top/proxy"` is the stream proxy base.

## Notes & customization

- **Ads**: disabled in this package (`config/ads.js` has every `enabled` flag
  set to `false`). To re-enable, flip the flags back.
- **Domain references**: `index.html` contains canonical/OG URLs pointing at
  `animetsu.site`, and `robots.txt`/`sitemap.xml` reference the original
  domain. Replace occurrences of `animetsu.site` with your own domain if you
  want them correct for SEO/social previews.
- **PWA**: `manifest.json` uses relative paths, so installation works on any
  host and any subpath as-is.
- **Diagnostics**: if static assets ever fail to load, `index.html` prints a
  console warning explaining the serving problem.
- Snapshot taken from the live site; assets are version-stable
  (`?v=v2_4` / `?v=smart_3m` query strings are ignored by static hosts).
