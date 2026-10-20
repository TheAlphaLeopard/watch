// Auto-upgrade any http proxy stream requests to https to prevent mixed content on HTTPS origins
;(function initHttpsUpgradeInterceptor() {
  try {
    if (typeof window !== 'undefined' && window.XMLHttpRequest) {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...args) {
        if (typeof url === 'string' && url.startsWith('http://ad-anivexa-api')) {
          url = url.replace(/^http:\/\//i, 'https://');
        }
        return origOpen.call(this, method, url, ...args);
      };
    }
    if (typeof window !== 'undefined' && window.fetch) {
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        if (typeof input === 'string' && input.startsWith('http://ad-anivexa-api')) {
          input = input.replace(/^http:\/\//i, 'https://');
        } else if (input && input.url && input.url.startsWith('http://ad-anivexa-api')) {
          input = new Request(input.url.replace(/^http:\/\//i, 'https://'), input);
        }
        return origFetch.call(this, input, init);
      };
    }
  } catch {}
})();

;(function cleanupDuplicateHistory() {
  try {
    const keys = ['user-watch_history', 'usr_guest_animetsu-watch_history', 'animetsu_watch_history'];
    keys.forEach(k => {
      const raw = localStorage.getItem(k);
      if (!raw) return;
      const list = JSON.parse(raw);
      if (!Array.isArray(list) || list.length <= 1) return;
      const map = new Map();
      const titleToId = new Map();
      const sorted = list.slice().sort((a, b) => new Date(b?.updated_at || 0) - new Date(a?.updated_at || 0));

      for (const item of sorted) {
        if (!item) continue;
        const id = String(item.anime_id || item.id || '').trim();
        if (!id) continue;
        const rawTitle = (item.title || '').trim();
        const tKey = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

        let primaryId = null;
        if (map.has(id)) {
          primaryId = id;
        } else if (tKey && tKey.length > 2 && titleToId.has(tKey)) {
          primaryId = titleToId.get(tKey);
        }

        if (!primaryId) {
          map.set(id, { ...item, anime_id: id, id: id });
          if (tKey && tKey.length > 2) titleToId.set(tKey, id);
        } else {
          const prim = map.get(primaryId);
          if (!prim.eps) prim.eps = {};
          if (item.eps) {
            for (const ep in item.eps) {
              if (!prim.eps[ep] || ((item.eps[ep]?.progress || 0) > (prim.eps[ep]?.progress || 0))) {
                prim.eps[ep] = item.eps[ep];
              }
            }
          }
          if (rawTitle && (!prim.title || prim.title === 'Anime')) prim.title = rawTitle;
          if (item.img && !prim.img) prim.img = item.img;
          if (item.name && !prim.name) prim.name = item.name;
        }
      }
      const clean = Array.from(map.values());
      if (clean.length !== list.length) {
        localStorage.setItem(k, JSON.stringify(clean));
      }
    });
  } catch {}
})();

// Auto-detect AniList OAuth callback in URL hash (Gojo Live style, pure client-side, 0 API calls)
;(function initAniListHashAuth() {
  try {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash ? window.location.hash.substring(1) : '';
    if (hash && hash.includes('access_token=')) {
      const params = new URLSearchParams(hash);
      const token = params.get('access_token');
      if (token) {
        fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            query: 'query { Viewer { id name avatar { large medium } bannerImage } }'
          })
        }).then(r => r.ok ? r.json() : null).then(alData => {
          const viewer = alData?.data?.Viewer;
          if (viewer?.id) {
            const userId = 'al_' + viewer.id;
            const sessionId = 'sess_' + (window.crypto?.randomUUID ? window.crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
            const userObj = {
              id: userId,
              anilist_id: viewer.id,
              username: viewer.name,
              display_name: viewer.name,
              avatar: viewer.avatar?.large || viewer.avatar?.medium || '',
              banner: viewer.bannerImage || '',
              anilist: viewer.name,
              anilist_token: token
            };
            localStorage.setItem('animetsu_sess', sessionId);
            localStorage.setItem('animetsu_user', JSON.stringify(userObj));
            localStorage.setItem('animetsu_anilist_token', token);
            document.cookie = 'animetsu_sess=' + sessionId + '; path=/; max-age=31536000; SameSite=Lax';

            // Clean up the URL hash without reloading
            if (window.history && window.history.replaceState) {
              window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }
            window.dispatchEvent(new CustomEvent('animetsu_auth_updated', { detail: userObj }));
          }
        }).catch(err => console.warn('[AniList Hash Auth] Error:', err));
      }
    }
  } catch (e) {
    console.warn('[AniList Hash Auth] Catch:', e);
  }
})();
/**
 * Animetsu Pure Client-Side Engine & Multi-Source Crowdsourced Cache
 * 
 * Features:
 * 1. Client-Side Data Fetching: Queries open APIs directly from the user's browser (Zero server IP rate limits).
 * 2. Data Architecture:
 *    - Metadata, Search, Browse, Schedule: MyAnimeList / Jikan v4 (https://api.jikan.moe/v4)
 *    - Episodes & ID Mapping: AniZip (https://api.ani.zip/mappings)
 *    - AniList & Kitsu: Completely disabled / removed
 * 3. Crowdsourced Server Caching:
 *    - When a user fetches fresh data, it silently writes back to the server in the background.
 *    - FINISHED anime: 7 days TTL
 *    - RELEASING anime: 24 hours TTL
 *    - Next visitors get 10ms instantaneous cached load!
 */

(function () {
  const ANILIST_URL = 'https://graphql.anilist.co';
  const ANIZIP_URL = 'https://api.ani.zip/mappings';
  const JIKAN_URL = 'https://api.jikan.moe/v4';

  const memCache = new Map();
  const pendingRequests = new Map();
  const originalFetch = window.fetch;

  // AniList OAuth Callback Handler
  (async function checkOAuthCallback() {
    try {
      const hash = window.location.hash;
      if (hash && hash.includes('access_token=')) {
        const params = new URLSearchParams(hash.replace(/^#/, ''));
        const accessToken = params.get('access_token');
        if (accessToken) {
          console.log('[Animetsu Auth] AniList OAuth token detected! Logging in...');
          let loggedIn = false;

          // 1. First attempt: Authenticate via backend API (creates D1 user and session)
          try {
            const res = await originalFetch('/v2/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: accessToken })
            });
            if (res.ok) {
              const data = await res.json();
              if (data?.session_id && data?.user) {
                localStorage.setItem('animetsu_sess', data.session_id);
                localStorage.setItem('animetsu_user', JSON.stringify(data.user));
                localStorage.setItem('animetsu_anilist_token', accessToken);
                document.cookie = 'animetsu_sess=' + data.session_id + '; path=/; max-age=31536000; SameSite=Lax';
                loggedIn = true;
              }
            }
          } catch (serverErr) {
            console.warn('[Animetsu Auth] Server login error, falling back to direct AniList auth:', serverErr);
          }

          // 2. Direct browser fallback: Query AniList GraphQL directly if server is unreachable
          if (!loggedIn) {
            try {
              const alRes = await originalFetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + accessToken,
                  'Content-Type': 'application/json',
                  'Accept': 'application/json'
                },
                body: JSON.stringify({
                  query: 'query { Viewer { id name avatar { large medium } bannerImage } }'
                })
              });
              if (alRes.ok) {
                const alData = await alRes.json();
                const viewer = alData?.data?.Viewer;
                if (viewer?.id) {
                  const userId = 'al_' + viewer.id;
                  const sessionId = 'sess_' + (window.crypto?.randomUUID ? window.crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
                  const userObj = {
                    id: userId,
                    anilist_id: viewer.id,
                    username: viewer.name,
                    display_name: viewer.name,
                    avatar: viewer.avatar?.large || viewer.avatar?.medium || '',
                    banner: viewer.bannerImage || '',
                    anilist: viewer.name,
                    anilist_token: accessToken
                  };
                  localStorage.setItem('animetsu_sess', sessionId);
                  localStorage.setItem('animetsu_user', JSON.stringify(userObj));
                  localStorage.setItem('animetsu_anilist_token', accessToken);
                  document.cookie = 'animetsu_sess=' + sessionId + '; path=/; max-age=31536000; SameSite=Lax';
                  loggedIn = true;

                  // Quiet background server sync
                  originalFetch('/v2/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: accessToken })
                  }).catch(() => {});
                }
              }
            } catch (fallbackErr) {
              console.error('[Animetsu Auth] Direct AniList verification failed:', fallbackErr);
            }
          }

          if (loggedIn) {
            // Strip the OAuth token from URL hash without reloading full history
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
            window.location.reload();
          }
        }
      }
    } catch (e) {
      console.warn('[Animetsu Auth] Callback processing error:', e);
    }
  })();

  // Inject "Login with AniList" button in auth modal & export auth URL
  const isLocalHost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const anilistClientId = isLocalHost ? '50774' : '51540';
  window.__anilist_auth_url = `https://anilist.co/api/v2/oauth/authorize?client_id=${anilistClientId}&response_type=token`;


  // Rate-limit backoff flag (AniList 90 req/min safeguard)
  let anilistRateLimitedUntil = 0;

  // Multi-tier persistent cache helpers (Memory + LocalStorage / SessionStorage)
  function getStorage(type = 'local') {
    try {
      return type === 'session' ? window.sessionStorage : window.localStorage;
    } catch {
      return null;
    }
  }

  function safeStorageSet(storage, key, value) {
    if (!storage) return;
    try {
      storage.setItem(key, value);
    } catch (e) {
      // If QuotaExceededError, evict oldest animetsu_ cache items (preserving user history & watch progress)
      try {
        const keysToEvict = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith('animetsu_') && !k.startsWith('animetsu_watch_') && !k.startsWith('animetsu_history') && !k.startsWith('animetsu_real_views_')) {
            keysToEvict.push(k);
          }
        }
        for (let i = 0; i < Math.min(keysToEvict.length, 30); i++) {
          storage.removeItem(keysToEvict[i]);
        }
        storage.setItem(key, value);
      } catch {}
    }
  }

  function getCachedItem(key, storageType = 'local') {
    // 1. In-memory fast tier
    if (memCache.has(key)) {
      const entry = memCache.get(key);
      if (entry && entry.exp > Date.now()) {
        return entry.data;
      }
    }
    // 2. Persistent storage tier
    const storage = getStorage(storageType);
    if (!storage) return null;
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (parsed.exp && parsed.exp > Date.now()) {
        memCache.set(key, { data: parsed.data, exp: parsed.exp });
        return parsed.data;
      }
    } catch {}
    return null;
  }

  function getStaleCachedItem(key, storageType = 'local') {
    if (memCache.has(key)) {
      const entry = memCache.get(key);
      if (entry?.data) return entry.data;
    }
    const storage = getStorage(storageType);
    if (!storage) return null;
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.data || null;
    } catch {}
    return null;
  }

  function setCachedItem(key, data, ttlMs, storageType = 'local') {
    if (!data) return;
    const exp = Date.now() + ttlMs;
    memCache.set(key, { data, exp });
    const storage = getStorage(storageType);
    if (storage) {
      safeStorageSet(storage, key, JSON.stringify({ data, exp }));
    }
  }

  function dedupeRequest(key, fetcherFn) {
    if (pendingRequests.has(key)) {
      return pendingRequests.get(key);
    }
    const promise = Promise.resolve().then(fetcherFn).finally(() => {
      pendingRequests.delete(key);
    });
    pendingRequests.set(key, promise);
    return promise;
  }

  async function queryAniList(query, variables = {}, timeoutMs = 8000) {
    if (Date.now() < anilistRateLimitedUntil) {
      console.warn('⚠️ [ClientEngine] AniList cooldown active (rate-limited). Skipping query to protect IP.');
      return null;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await originalFetch(ANILIST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status === 429) {
        console.warn('⚠️ [ClientEngine] AniList returned HTTP 429 (Too Many Requests)! Cooling down for 60 seconds.');
        anilistRateLimitedUntil = Date.now() + 60000;
        throw new Error('AniList HTTP 429 Rate Limit');
      }
      if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors && json.errors.length) {
        throw new Error(json.errors[0]?.message || 'AniList GraphQL error');
      }
      return json?.data || null;
    } catch (err) {
      console.warn(`[ClientEngine] AniList failed (${err.message}). Falling back to MAL (Jikan)...`);
      return null;
    }
  }

  function getHdCover(url) {
    if (!url || typeof url !== 'string') return url || '';
    return url.replace('/cover/medium/', '/cover/large/').replace('/cover/small/', '/cover/large/');
  }

  function formatAniListDate(d) {
    if (!d || !d.year) return null;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (d.month) return `${months[d.month - 1]} ${d.day || ''}, ${d.year}`.replace(' ,', ',');
    return String(d.year);
  }

  // Crowdsourced VPS Caching: Writes fresh pure AniList data back to VPS Cache Shield
  // NOTE (static mirror): the cache/save endpoint is a Cloudflare Pages Function that
  // only exists on the original animetsu.site backend. Skip silently elsewhere so
  // self-hosted mirrors don't spam 404/405 network errors.
  const CAN_WRITE_SERVER_CACHE = /(^|\.)animetsu\.(site|cc|net|live)$/i.test(
    typeof location !== 'undefined' ? location.hostname : ''
  );
  function writeBackToServer(type, id, data) {
    if (!CAN_WRITE_SERVER_CACHE) return;
    if (!data) return;
    if (type === 'home' && (!data.trending || !data.trending.length)) return;
    if (type === 'info' && !data.id) return;
    try {
      originalFetch('/v2/api/cache/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id: String(id || 'home'), data })
      }).catch(() => {});
    } catch (e) {}
  }

  // Helper: Resolve AniList ID from MAL ID using AniZip only (Zero AniList / Kitsu calls)
  const malToAnilistCache = new Map();

  async function getAnilistIdFromMalId(malId) {
    const numericId = Number(malId);
    if (!numericId) return malId;
    if (malToAnilistCache.has(numericId)) return malToAnilistCache.get(numericId);

    // Try AniZip with mal_id parameter
    try {
      const res = await originalFetch(`${ANIZIP_URL}?mal_id=${numericId}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const json = await res.json();
        const aniId = json.mappings?.anilist_id;
        if (aniId) {
          malToAnilistCache.set(numericId, Number(aniId));
          if (json.episodes) {
            memCache.set(`anizip_raw_${numericId}`, json);
            memCache.set(`anizip_raw_${aniId}`, json);
          }
          return Number(aniId);
        }
      }
    } catch (e) {}

    return numericId;
  }

  // Helper: Resolve MAL ID from AniList ID or numeric ID using AniZip & in-memory cache
  const anilistToMalCache = new Map();

  async function getMalIdFromAnimeId(animeId) {
    const numericId = Number(animeId);
    if (!numericId) return animeId;
    if (anilistToMalCache.has(numericId)) return anilistToMalCache.get(numericId);

    // 1. Check in-memory anime detail caches
    const cachedDetail = memCache.get(`details_${numericId}`) || memCache.get(`anime_details_${numericId}`);
    if (cachedDetail?.mal_id) {
      const malId = Number(cachedDetail.mal_id);
      anilistToMalCache.set(numericId, malId);
      return malId;
    }

    // 2. Check anizip_raw cache
    const cachedZip = memCache.get(`anizip_raw_${numericId}`);
    if (cachedZip?.mappings?.mal_id) {
      const malId = Number(cachedZip.mappings.mal_id);
      anilistToMalCache.set(numericId, malId);
      return malId;
    }

    // 3. Query AniZip with anilist_id
    try {
      const res = await originalFetch(`${ANIZIP_URL}?anilist_id=${numericId}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const json = await res.json();
        const malId = json.mappings?.mal_id;
        if (malId) {
          const numMalId = Number(malId);
          anilistToMalCache.set(numericId, numMalId);
          if (json.episodes) {
            memCache.set(`anizip_raw_${numericId}`, json);
            memCache.set(`anizip_raw_${numMalId}`, json);
          }
          return numMalId;
        }
      }
    } catch (e) {}

    // 4. Query AniZip with mal_id (in case animeId is already a MAL ID)
    try {
      const res = await originalFetch(`${ANIZIP_URL}?mal_id=${numericId}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const json = await res.json();
        const malId = json.mappings?.mal_id || numericId;
        const numMalId = Number(malId);
        anilistToMalCache.set(numericId, numMalId);
        return numMalId;
      }
    } catch (e) {}

    // 5. Fallback: Return numericId
    return numericId;
  }

  // 1. Build clean franchise seasons (Only real TV seasons & direct canon)
  function extractCleanSeasons(rootMedia) {
    if (!rootMedia) return [];
    const seasonsMap = new Map();
    seasonsMap.set(rootMedia.id, rootMedia);

    const RECAP_WORDS = ['recap', 'compilation', 'special edition', 'remix', 'reawakening', 'beyond the system'];
    const EXCLUDED_TITLES = ['monsters: 103 mercies', 'no regrets', 'the one piece'];

    function checkAndAdd(node, relType) {
      if (!node || node.type === 'MANGA') return;
      if (relType !== 'PREQUEL' && relType !== 'SEQUEL') return;

      const title = `${node.title?.english || ''} ${node.title?.romaji || ''}`.toLowerCase();
      if (RECAP_WORDS.some(w => title.includes(w))) return;
      if (EXCLUDED_TITLES.some(w => title.includes(w))) return;
      if (['MUSIC', 'MANGA', 'NOVEL', 'ONE_SHOT'].includes(node.format)) return;

      if (!seasonsMap.has(node.id)) {
        seasonsMap.set(node.id, node);
      }
    }

    // Traverse up to 3 depths of prequel/sequel
    for (const e1 of rootMedia.relations?.edges || []) {
      checkAndAdd(e1.node, e1.relationType);
      for (const e2 of e1.node?.relations?.edges || []) {
        checkAndAdd(e2.node, e2.relationType);
        for (const e3 of e2.node?.relations?.edges || []) {
          checkAndAdd(e3.node, e3.relationType);
        }
      }
    }

    const list = Array.from(seasonsMap.values());
    list.sort((a, b) => {
      const yA = a.startDate?.year || a.seasonYear || 0;
      const yB = b.startDate?.year || b.seasonYear || 0;
      if (yA !== yB) return yA - yB;
      const mA = a.startDate?.month || 0;
      const mB = b.startDate?.month || 0;
      if (mA !== mB) return mA - mB;
      return (a.startDate?.day || 0) - (b.startDate?.day || 0);
    });

    let tvIndex = 0;
    return list.map(m => {
      const isTv = m.format === 'TV' || m.format === 'TV_SHORT';
      const title = `${m.title?.english || ''} ${m.title?.romaji || ''}`.toLowerCase();
      let rel = isTv ? `Season ${++tvIndex}` : (m.format || 'Special');

      if (title.includes('final season')) {
        if (title.includes('final chapters') || title.includes('part 3')) rel = 'Final Season Part 3';
        else if (title.includes('part 2')) rel = 'Final Season Part 2';
        else rel = 'Final Season';
      } else if (title.includes('season 4') || title.includes('4th season')) {
        rel = title.includes('part 2') || title.includes('cour 2') ? 'Season 4 Part 2' : 'Season 4';
      } else if (title.includes('season 3') || title.includes('3rd season')) {
        rel = title.includes('part 2') || title.includes('cour 2') ? 'Season 3 Part 2' : 'Season 3';
      } else if (title.includes('season 2') || title.includes('2nd season')) {
        rel = title.includes('part 2') || title.includes('cour 2') ? 'Season 2 Part 2' : 'Season 2';
      } else if (title.includes('season 1') || title.includes('1st season')) {
        rel = 'Season 1';
      }

      const cover = getHdCover(m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || '');
      return {
        id: String(m.id),
        anilist_id: m.id,
        title: m.title || { english: 'Untitled', romaji: 'Untitled' },
        format: m.format || 'TV',
        season: m.season || 'FALL',
        year: m.startDate?.year || m.seasonYear || 2024,
        type: 'anime',
        total_eps: m.episodes || 12,
        status: m.status || 'FINISHED',
        genres: m.genres || [],
        duration: m.duration || 24,
        average_score: m.averageScore || 70,
        description: (m.description || '').replace(/<[^>]*>?/gm, ''),
        cover_image: { large: cover, medium: cover, small: cover },
        img: cover,
        poster: cover,
        banner: m.bannerImage || cover,
        trailer: typeof m.trailer === 'string' ? m.trailer : (m.trailer?.id || ''),
        relation: rel,
        relation_type: rel
      };
    });
  }

  // Normalize AniList Media into Animetsu OG Schema
  function normalizeAniListMedia(m) {
    if (!m) return null;
    const cover = getHdCover(m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || '');
    const banner = m.bannerImage || cover;

    // Filter relations: ANIME ONLY
    const relations = (m.relations?.edges || [])
      .filter(edge => {
        const node = edge?.node;
        if (!node) return false;
        if (node.type && node.type !== 'ANIME') return false;
        if (['MANGA', 'NOVEL', 'ONE_SHOT', 'MUSIC'].includes(node.format)) return false;
        if (['ADAPTATION', 'SOURCE', 'CHARACTER'].includes(edge.relationType)) return false;
        return true;
      })
      .map(edge => {
        const node = edge.node;
        const relCover = getHdCover(node.coverImage?.extraLarge || node.coverImage?.large || node.coverImage?.medium || '');
        return {
          id: String(node.id),
          anilist_id: node.id,
          relation_type: edge.relationType || 'RELATED',
          title: node.title || { english: 'Untitled', romaji: 'Untitled' },
          format: node.format || 'TV',
          status: node.status || 'FINISHED',
          year: node.seasonYear || (node.startDate?.year) || null,
          type: 'anime',
          cover_image: { extraLarge: relCover, large: relCover, medium: relCover, small: relCover },
          img: relCover,
          poster: relCover,
          banner: node.bannerImage || relCover
        };
      });

    // Filter recommendations: ANIME ONLY
    const recommendations = (m.recommendations?.nodes || [])
      .map(rec => rec?.mediaRecommendation)
      .filter(node => node && node.type === 'ANIME' && !['MANGA', 'NOVEL', 'ONE_SHOT'].includes(node.format))
      .map(node => {
        const recCover = getHdCover(node.coverImage?.extraLarge || node.coverImage?.large || node.coverImage?.medium || '');
        return {
          id: String(node.id),
          anilist_id: node.id,
          title: node.title || { english: 'Untitled', romaji: 'Untitled' },
          format: node.format || 'TV',
          status: node.status || 'FINISHED',
          year: node.seasonYear || (node.startDate?.year) || null,
          average_score: node.averageScore || 0,
          type: 'anime',
          cover_image: { extraLarge: recCover, large: recCover, medium: recCover, small: recCover },
          img: recCover,
          poster: recCover,
          banner: node.bannerImage || recCover
        };
      });

    const characters = (m.characters?.edges || []).map(edge => ({
      name: edge.node?.name?.full || 'Character',
      image: edge.node?.image?.large || edge.node?.image?.medium || '',
      role: edge.role || 'SUPPORTING',
      voice_actor: edge.voiceActors?.[0] ? {
        name: edge.voiceActors[0].name?.full || '',
        image: edge.voiceActors[0].image?.large || edge.voiceActors[0].image?.medium || '',
        language: edge.voiceActors[0].language || 'Japanese'
      } : null
    }));

    const staff = (m.staff?.edges || []).map(edge => ({
      name: edge.node?.name?.full || '',
      image: edge.node?.image?.large || edge.node?.image?.medium || '',
      role: edge.role || ''
    }));

    const seasons = extractCleanSeasons(m);
    const yr = m.seasonYear || m.startDate?.year || 2024;

    return {
      id: String(m.id),
      anilist_id: m.id,
      mal_id: m.idMal || null,
      type: 'anime',
      title: {
        english: m.title?.english || m.title?.romaji || m.title?.native || 'Untitled',
        romaji: m.title?.romaji || m.title?.english || 'Untitled',
        native: m.title?.native || ''
      },
      format: m.format || 'TV',
      season: m.season || 'FALL',
      year: yr,
      status: m.status || 'FINISHED',
      genres: m.genres || [],
      total_eps: m.episodes || 12,
      duration: m.duration || 24,
      average_score: m.averageScore || 75,
      mean_score: m.averageScore || 75,
      description: (m.description || '').replace(/<[^>]*>?/gm, ''),
      banner: banner,
      banner_image: banner,
      poster: cover,
      img: cover,
      cover_image: { extraLarge: cover, large: cover, medium: cover, small: cover },
      studio: m.studios?.nodes?.[0]?.name || '',
      studios: (m.studios?.nodes || []).map(n => ({ name: n.name })),
      color: m.coverImage?.color || '#e4ae5d',
      source: m.source || 'ORIGINAL',
      next_airing_ep: m.nextAiringEpisode ? {
        airing_at: m.nextAiringEpisode.airingAt,
        time_until_airing: m.nextAiringEpisode.timeUntilAiring,
        ep_num: m.nextAiringEpisode.episode
      } : null,
      start_date: formatAniListDate(m.startDate),
      end_date: formatAniListDate(m.endDate),
      trailer: typeof m.trailer === 'string' ? m.trailer : (m.trailer?.id || ''),
      seasons,
      characters,
      relations,
      recommendations,
      staff,
      rank: (() => {
        if (Array.isArray(m.rankings)) {
          const popR = m.rankings.find(r => !r.allTime && r.type === 'POPULAR' && r.rank > 0 && r.rank <= 100)
            || m.rankings.find(r => !r.allTime && r.rank > 0 && r.rank <= 100)
            || m.rankings.find(r => r.rank > 0 && r.rank <= 100);
          if (popR) return popR.rank;
        }
        if (typeof m.trending === 'number' && m.trending > 0 && m.trending <= 100) return m.trending;
        const pop = Number(m.popularity || 0);
        return pop > 80000 ? 5 : pop > 40000 ? 8 : pop > 20000 ? 12 : pop > 5000 ? 24 : 8;
      })(),
      users: m.popularity || 1500,
      popularity: m.popularity || 50000,
      favourites: m.favourites || 1000
    };
  }

  // Query AniList directly from user's browser
  async function queryAniListDirect(animeId) {
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          title { english romaji native }
          format
          status
          season
          seasonYear
          averageScore
          meanScore
          popularity
          favourites
          duration
          episodes
          genres
          source
          description(asHtml: false)
          bannerImage
          coverImage { extraLarge large medium color }
          startDate { year month day }
          endDate { year month day }
          studios(isMain: true) { nodes { name } }
          trailer { id }
          trending
          rankings { rank type allTime context }
          nextAiringEpisode { airingAt timeUntilAiring episode }
          characters(sort: ROLE, perPage: 25) {
            edges {
              role
              node { name { full } image { large medium } }
              voiceActors(language: JAPANESE) { name { full } image { large medium } language }
            }
          }
          relations {
            edges {
              relationType
              node {
                id
                title { english romaji native }
                format
                type
                status
                seasonYear
                startDate { year }
                coverImage { extraLarge large medium }
                bannerImage
              }
            }
          }
          recommendations(perPage: 15, sort: RATING_DESC) {
            nodes {
              mediaRecommendation {
                id
                title { english romaji native }
                format
                type
                status
                seasonYear
                averageScore
                coverImage { extraLarge large medium }
              }
            }
          }
          staff(perPage: 8) {
            edges {
              role
              node { name { full } image { large medium } }
            }
          }
        }
      }
    `;

    const data = await queryAniList(query, { id: Number(animeId) });
    if (data?.Media) {
      const normalized = normalizeAniListMedia(data.Media);
      if (normalized?.mal_id) {
        anilistToMalCache.set(Number(animeId), Number(normalized.mal_id));
      }
      return normalized;
    }
    return null;
  }

  async function queryJikanFallback(animeId, resolvedAnilistId) {
    const anilistId = resolvedAnilistId || (await getAnilistIdFromMalId(animeId));
    const malId = Number(animeId) || anilistId;
    console.log(`🔄 [ClientEngine] Trying Fallback 1: Jikan (MAL: ${malId}, AniList: ${anilistId})`);

    // Query Jikan
    const res = await originalFetch(`${JIKAN_URL}/anime/${malId}/full`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    const json = await res.json();
    const d = json?.data;
    if (!d) throw new Error('Jikan empty data');

    const cover = d.images?.webp?.large_image_url || d.images?.jpg?.large_image_url || '';
    const banner = cover;

    return {
      id: String(animeId),
      anilist_id: Number(anilistId),
      mal_id: d.mal_id,
      type: 'anime',
      title: {
        english: d.title_english || d.title || 'Untitled',
        romaji: d.title || d.title_japanese || 'Untitled',
        native: d.title_japanese || ''
      },
      format: (d.type || 'TV').toUpperCase(),
      season: (d.season || 'SUMMER').toUpperCase(),
      year: d.year || (d.aired?.prop?.from?.year) || new Date().getFullYear(),
      status: d.status === 'Currently Airing' ? 'RELEASING' : (d.status === 'Not yet aired' ? 'NOT_YET_RELEASED' : 'FINISHED'),
      genres: (d.genres || []).map(g => g.name),
      total_eps: d.episodes || 12,
      duration: parseInt(d.duration) || 24,
      average_score: Math.round((d.score || 7.5) * 10),
      mean_score: Math.round((d.score || 7.5) * 10),
      description: (d.synopsis || '').replace(/\[Written by MAL Rewrite\]/g, '').trim(),
      banner: banner,
      banner_image: banner,
      poster: cover,
      img: cover,
      cover_image: { extraLarge: cover, large: cover, medium: cover, small: cover },
      studio: d.studios?.[0]?.name || '',
      studios: (d.studios || []).map(s => ({ name: s.name })),
      color: '#e4ae5d',
      source: d.source || 'MANGA',
      start_date: d.aired?.string || '',
      end_date: '',
      trailer: d.trailer?.youtube_id || '',
      seasons: [
        {
          id: String(animeId),
          anilist_id: Number(anilistId),
          mal_id: d.mal_id,
          title: { english: d.title_english || d.title, romaji: d.title },
          format: d.type || 'TV',
          relation: 'Season 1',
          relation_type: 'Season 1',
          cover_image: { large: cover, medium: cover, small: cover },
          img: cover
        }
      ],
      characters: [],
      relations: [],
      recommendations: [],
      staff: [],
      rank: (d.rank && d.rank <= 100) ? d.rank : 8,
      popularity: d.popularity || 1000
    };
  }

  // Anime Info Fetcher: AniList Primary + MAL (Jikan v4) Fallback
  async function getClientAnimeInfo(animeId) {
    if (!animeId) return null;
    const cacheKey = `animetsu_info_${animeId}`;

    // 1. Persistent cache check (Memory -> LocalStorage) - 0ms instant load on reload!
    const cached = getCachedItem(cacheKey, 'local');
    if (cached && cached.id) {
      return cached;
    }

    return dedupeRequest(`info_${animeId}`, async () => {
      // 1. Primary: AniList Direct Browser Fetch (Zero backend calls)
      try {
        console.log(`🌐 [ClientEngine] Fetching AniList Info for ID: ${animeId} (Primary)`);
        const aniInfo = await queryAniListDirect(animeId);
        if (aniInfo && aniInfo.id) {
          try {
            const logo = await getAnimeLogo(aniInfo.anilist_id || aniInfo.id);
            if (logo) aniInfo.clear_logo = logo;
          } catch (e) {}

          const isFinished = aniInfo.status === 'FINISHED';
          const ttl = isFinished ? (7 * 24 * 60 * 60 * 1000) : (12 * 60 * 60 * 1000); // 7 days finished, 12 hours ongoing
          setCachedItem(cacheKey, aniInfo, ttl, 'local');
          writeBackToServer('info', animeId, aniInfo);
          return aniInfo;
        }
      } catch (e0) {
        console.warn(`⚠️ [ClientEngine] AniList direct info failed: ${e0.message}`);
      }

      // 2. Fallback: MyAnimeList via Jikan API v4
      const anilistId = await getAnilistIdFromMalId(animeId);
      try {
        console.log(`🔄 [ClientEngine] Fallback to MAL (Jikan) for ID: ${animeId} (AniList ID: ${anilistId})`);
        const malInfo = await queryJikanFallback(animeId, anilistId);
        if (malInfo && malInfo.id) {
          const isReleasing = malInfo.status === 'RELEASING' || malInfo.status === 'NOT_YET_RELEASED';
          const ttl = isReleasing ? (2 * 60 * 60 * 1000) : (7 * 24 * 60 * 60 * 1000);
          setCachedItem(cacheKey, malInfo, ttl, 'local');
          // Note: Never writeBackToServer for MAL; CDN cache is reserved strictly for pure AniList data
          return malInfo;
        }
      } catch (e1) {
        console.warn(`⚠️ [ClientEngine] Jikan fallback failed: ${e1.message}`);
      }

      // 3. Stale fallback from persistent storage
      const stale = getStaleCachedItem(cacheKey, 'local');
      if (stale && stale.id) return stale;

      // Final fallback object
      return {
        id: String(animeId),
        anilist_id: Number(anilistId),
        mal_id: Number(animeId),
        title: { english: 'Anime', romaji: 'Anime' },
        status: 'FINISHED',
        format: 'TV',
        total_eps: 12,
        cover_image: { large: '', medium: '', small: '' },
        seasons: [],
        relations: []
      };
    });
  }

  async function getClientAnimeEpisodes(animeId) {
    if (!animeId) return [];
    const cacheKey = `animetsu_eps_${animeId}`;
    const cached = getCachedItem(cacheKey, 'local');
    if (cached && Array.isArray(cached) && cached.length) {
      const seen = new Set();
      let hasDupe = false;
      for (const x of cached) {
        if (seen.has(x.ep_num)) { hasDupe = true; break; }
        seen.add(x.ep_num);
      }
      if (!hasDupe) return cached;
      try { localStorage.removeItem(cacheKey); } catch {}
    }

    return dedupeRequest(`eps_${animeId}`, async () => {
    console.log(`🌐 [ClientEngine] Fetching AniZip Episodes for ID: ${animeId}`);

    const anilistId = await getAnilistIdFromMalId(animeId);
    let data = memCache.get(`anizip_raw_${animeId}`) || (anilistId ? memCache.get(`anizip_raw_${anilistId}`) : null);

    // 1. Direct fast AniZip query with anilist_id
    if (!data) {
      try {
        const queryId = anilistId || animeId;
        const res = await originalFetch(`${ANIZIP_URL}?anilist_id=${encodeURIComponent(queryId)}`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          data = await res.json();
          if (data?.mappings?.anilist_id) {
            memCache.set(`anizip_raw_${data.mappings.anilist_id}`, data);
            if (data.mappings.mal_id) memCache.set(`anizip_raw_${data.mappings.mal_id}`, data);
          }
        }
      } catch (e1) {}
    }

    // 2. Fallback AniZip query with mal_id if anilist_id didn't match
    if (!data) {
      try {
        const res = await originalFetch(`${ANIZIP_URL}?mal_id=${encodeURIComponent(animeId)}`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          data = await res.json();
          if (data?.mappings?.anilist_id) {
            memCache.set(`anizip_raw_${data.mappings.anilist_id}`, data);
            if (data.mappings.mal_id) memCache.set(`anizip_raw_${data.mappings.mal_id}`, data);
          }
        }
      } catch (e2) {}
    }

    let defaultImg = '';
    const cachedInfo = memCache.get(`info_${animeId}`) || (anilistId ? memCache.get(`info_${anilistId}`) : null);
    if (cachedInfo) {
      defaultImg = cachedInfo.banner_image || cachedInfo.cover_image?.large || cachedInfo.cover_image?.extraLarge || '';
    }

    // Parse and filter episodes strictly from AniZip
    if (data?.episodes && typeof data.episodes === 'object') {
      const now = new Date();
      const epMap = new Map();

      for (const [key, ep] of Object.entries(data.episodes)) {
        if (!ep) continue;
        // The series absolute episode number in AniZip is ep.episode or the entry key itself (e.g. "1", "2", ... "1184")
        // NEVER prioritize ep.episodeNumber because TVDB resets episodeNumber to 1 for each season!
        const rawEp = ep.episode || key;
        const epNum = Number(rawEp);
        // Exclude non-numeric specials like "S1", "S2", "OP", "ED"
        if (isNaN(epNum) || epNum < 1 || !/^\d+$/.test(String(rawEp).trim())) continue;

        // Future air date check (only skip if clearly in future with 24h grace period for timezone differences)
        const rawDate = ep.airDateUtc || ep.airDate || ep.airdate;
        if (rawDate) {
          const epAirDate = new Date(rawDate);
          if (!isNaN(epAirDate.getTime()) && epAirDate.getTime() > now.getTime() + 86400000) continue;
        }

        // Avoid duplicates: if already present, keep the existing canonical one
        if (epMap.has(epNum)) continue;

        let viewsCount = 0;
        try {
          const cachedViews = localStorage.getItem(`animetsu_real_views_${animeId}_${epNum}`);
          if (cachedViews !== null) viewsCount = Number(cachedViews) || 0;
        } catch {}

        epMap.set(epNum, {
          id: ep.tvdbId || ep.anidbEid || epNum,
          ep_num: epNum,
          name: ep.title?.en || ep.title?.['x-jat'] || ep.title?.ja || `Episode ${epNum}`,
          img: ep.image || defaultImg || '',
          desc: ep.overview || ep.summary || '',
          aired_at: ep.airDateUtc || ep.airDate || ep.airdate || '',
          runtime: ep.runtime || ep.length || 24,
          views: viewsCount,
          likes: 0,
          dislikes: 0,
          is_filler: false
        });
      }

      const episodes = Array.from(epMap.values()).sort((a, b) => a.ep_num - b.ep_num);
      if (episodes.length > 0) {
        setCachedItem(cacheKey, episodes, 4 * 60 * 60 * 1000, 'local');
        return episodes;
      }
    }

    // Direct AniList GraphQL Fallback if AniZip returned 0 episodes
    try {
      const targetAniId = Number(anilistId || animeId);
      if (targetAniId && !isNaN(targetAniId)) {
        console.log(`🌐 [ClientEngine] Fallback to AniList GraphQL for ID: ${targetAniId}`);
        const aniQuery = `
          query ($id: Int) {
            Media(id: $id, type: ANIME) {
              id
              format
              status
              episodes
              duration
              bannerImage
              coverImage { extraLarge large medium }
              nextAiringEpisode { episode airingAt }
              streamingEpisodes { title thumbnail }
            }
          }
        `;
        const res = await originalFetch(ANILIST_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ query: aniQuery, variables: { id: targetAniId } }),
          signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
          const json = await res.json();
          const media = json?.data?.Media;
          if (media) {
            const fallbackImg = media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large || defaultImg || '';
            const fallbackEpisodes = [];

            if (Array.isArray(media.streamingEpisodes) && media.streamingEpisodes.length > 0) {
              media.streamingEpisodes.forEach((sep, idx) => {
                const epNum = idx + 1;
                const cleanName = sep.title || `Episode ${epNum}`;
                let viewsCount = 0;
                try {
                  const cachedViews = localStorage.getItem(`animetsu_real_views_${animeId}_${epNum}`);
                  if (cachedViews !== null) viewsCount = Number(cachedViews) || 0;
                } catch {}
                fallbackEpisodes.push({
                  id: `${targetAniId}-${epNum}`,
                  ep_num: epNum,
                  name: cleanName,
                  img: sep.thumbnail || fallbackImg,
                  desc: `Episode ${epNum}`,
                  aired_at: '',
                  runtime: media.duration || 24,
                  views: viewsCount,
                  likes: 0,
                  dislikes: 0,
                  is_filler: false
                });
              });
            } else {
              let epCount = 1;
              if (media.status === 'RELEASING' && media.nextAiringEpisode?.episode) {
                epCount = Math.max(1, media.nextAiringEpisode.episode - 1);
              } else if (media.episodes) {
                epCount = Number(media.episodes);
              } else if (media.format === 'MOVIE') {
                epCount = 1;
              } else {
                epCount = 12;
              }

              for (let epNum = 1; epNum <= epCount; epNum++) {
                let viewsCount = 0;
                try {
                  const cachedViews = localStorage.getItem(`animetsu_real_views_${animeId}_${epNum}`);
                  if (cachedViews !== null) viewsCount = Number(cachedViews) || 0;
                } catch {}
                fallbackEpisodes.push({
                  id: `${targetAniId}-${epNum}`,
                  ep_num: epNum,
                  name: `Episode ${epNum}`,
                  img: fallbackImg,
                  desc: `Episode ${epNum}`,
                  aired_at: '',
                  runtime: media.duration || 24,
                  views: viewsCount,
                  likes: 0,
                  dislikes: 0,
                  is_filler: false
                });
              }
            }

            if (fallbackEpisodes.length > 0) {
              setCachedItem(cacheKey, fallbackEpisodes, 4 * 60 * 60 * 1000, 'local');
              return fallbackEpisodes;
            }
          }
        }
      }
    } catch (eAni) {
      console.warn('[ClientEngine] AniList episodes fallback error:', eAni);
    }

    return [];
    });
  }

  // Helper: map sort options to AniList MediaSort enums
  function mapAniListSort(rawSort) {
    if (!rawSort) return ['POPULARITY_DESC'];
    const s = String(rawSort).trim().toLowerCase();
    if (s === 'average_score' || s === 'top_rated' || s === 'score' || s.includes('score')) return ['SCORE_DESC'];
    if (s === 'trending' || s.includes('trend')) return ['TRENDING_DESC'];
    if (s === 'date_desc' || s === 'release_date' || s === 'date' || s === 'latest' || s.includes('date')) return ['START_DATE_DESC'];
    if (s === 'favourites' || s === 'favorites' || s.includes('fav')) return ['FAVOURITES_DESC'];
    if (s === 'title') return ['TITLE_ROMAJI'];
    if (s === 'popularity' || s.includes('pop')) return ['POPULARITY_DESC'];
    if (rawSort.toUpperCase().includes('_DESC') || rawSort.toUpperCase().includes('_ASC')) {
      return [rawSort.toUpperCase()];
    }
    return ['POPULARITY_DESC'];
  }

  // 7. Search & Browse Anime: AniList Primary + Jikan v4 Fallback Pure Client Search
  async function getClientSearch(params = {}) {
    if (typeof params === 'string') {
      params = { query: params };
    }
    const page = Number(params.page || 1);
    const perPage = Math.min(Math.max(Number(params.per_page || params.perPage || 20), 1), 50);
    const query = (params.query || params.search || '').trim();

    // Build AniList GraphQL variables
    const variables = { page, perPage, isAdult: false };

    if (query) {
      variables.search = query;
    }

    if (query && (!params.sort || params.sort === 'popularity' || params.sort === 'POPULARITY_DESC')) {
      variables.sort = ['SEARCH_MATCH'];
    } else {
      variables.sort = mapAniListSort(params.sort);
    }

    // Format (MOVIE, TV, TV_SHORT, SPECIAL, OVA, ONA)
    if (params.format && String(params.format).trim()) {
      const f = String(params.format).trim().toUpperCase();
      const validFormats = ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'];
      if (validFormats.includes(f)) variables.format = f;
    }

    // Season (WINTER, SPRING, SUMMER, FALL)
    if (params.season && String(params.season).trim()) {
      const s = String(params.season).trim().toUpperCase();
      if (['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(s)) variables.season = s;
    }

    // Year (2026, 2025, 2024...)
    if (params.year && !isNaN(Number(params.year))) {
      variables.seasonYear = Number(params.year);
    }

    // Status (FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED)
    if (params.status && String(params.status).trim()) {
      const st = String(params.status).trim().toUpperCase();
      const validStatus = ['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'];
      if (validStatus.includes(st)) variables.status = st;
    }

    // Genres (comma-separated string or array)
    const genreList = params.genres
      ? (Array.isArray(params.genres) ? params.genres : String(params.genres).split(',')).map(g => g.trim()).filter(Boolean)
      : [];
    if (genreList.length > 0) variables.genre_in = genreList;

    // Tags (comma-separated string or array)
    const tagList = params.tags
      ? (Array.isArray(params.tags) ? params.tags : String(params.tags).split(',')).map(t => t.trim()).filter(Boolean)
      : [];
    if (tagList.length > 0) variables.tag_in = tagList;

    // Country (JP, KR, CN, TW)
    if (params.country && String(params.country).trim()) {
      variables.countryOfOrigin = String(params.country).trim().toUpperCase();
    }

    // Source (ORIGINAL, MANGA, LIGHT_NOVEL, NOVEL, etc.)
    if (params.source && String(params.source).trim()) {
      const src = String(params.source).trim().toUpperCase();
      const validSources = ['ORIGINAL', 'MANGA', 'LIGHT_NOVEL', 'VISUAL_NOVEL', 'VIDEO_GAME', 'OTHER', 'NOVEL', 'DOUJINSHI', 'ANIME', 'WEB_NOVEL', 'LIVE_ACTION', 'COMIC', 'MULTIMEDIA_PROJECT', 'PICTURE_BOOK'];
      if (validSources.includes(src)) variables.source = src;
    }

    const searchHash = JSON.stringify(variables);
    const cacheKey = `animetsu_search_${searchHash}`;
    const cachedSearch = getCachedItem(cacheKey, 'session');
    if (cachedSearch && cachedSearch.results) return cachedSearch;

    return dedupeRequest(cacheKey, async () => {
    const memKey = cacheKey;

    function mapJikanSearch(items) {
      return (items || []).map(d => {
        const cover = d.images?.webp?.large_image_url || d.images?.jpg?.large_image_url || '';
        return {
          id: String(d.mal_id),
          anilist_id: d.mal_id,
          mal_id: d.mal_id,
          type: 'anime',
          title: {
            english: d.title_english || d.title || 'Untitled',
            romaji: d.title || 'Untitled',
            native: d.title_japanese || ''
          },
          format: d.type || 'TV',
          status: d.status === 'Currently Airing' ? 'RELEASING' : (d.status === 'Not yet aired' ? 'NOT_YET_RELEASED' : 'FINISHED'),
          season: (d.season || 'SUMMER').toUpperCase(),
          year: d.year || new Date().getFullYear(),
          average_score: Math.round((d.score || 7.5) * 10),
          total_eps: d.episodes || 12,
          cover_image: { extraLarge: cover, large: cover, medium: cover, small: cover },
          img: cover,
          poster: cover,
          banner: cover,
          banner_image: cover,
          is_adult: false
        };
      });
    }

    function cacheAndReturn(data) {
      if (data && data.results?.length) {
        setCachedItem(cacheKey, data, 15 * 60 * 1000, 'session');
      }
      return data;
    }

    // 1. Primary: AniList Search / Browse with Full Filters
    try {
      const aniQuery = `
        query (
          $page: Int,
          $perPage: Int,
          $search: String,
          $sort: [MediaSort],
          $format: MediaFormat,
          $season: MediaSeason,
          $seasonYear: Int,
          $status: MediaStatus,
          $genre_in: [String],
          $tag_in: [String],
          $countryOfOrigin: CountryCode,
          $source: MediaSource,
          $isAdult: Boolean
        ) {
          Page(page: $page, perPage: $perPage) {
            pageInfo {
              total
              currentPage
              lastPage
              hasNextPage
            }
            media(
              search: $search,
              type: ANIME,
              sort: $sort,
              format: $format,
              season: $season,
              seasonYear: $seasonYear,
              status: $status,
              genre_in: $genre_in,
              tag_in: $tag_in,
              countryOfOrigin: $countryOfOrigin,
              source: $source,
              isAdult: $isAdult
            ) {
              id
              idMal
              title { english romaji native }
              format
              status
              season
              seasonYear
              averageScore
              duration
              episodes
              genres
              description(asHtml: false)
              bannerImage
              coverImage { extraLarge large medium color }
              trailer { id }
              isAdult
            }
          }
        }
      `;
      const data = await queryAniList(aniQuery, variables);
      if (data?.Page?.media?.length) {
        const results = data.Page.media.map(mapAniListToAnimetsu).filter(Boolean);
        return cacheAndReturn({
          results,
          total: data.Page.pageInfo?.total || results.length,
          last_page: data.Page.pageInfo?.lastPage || 1,
          current_page: data.Page.pageInfo?.currentPage || page,
          has_next_page: data.Page.pageInfo?.hasNextPage || false
        });
      }
    } catch (eAni) {
      console.warn('⚠️ [ClientEngine] AniList search failed, falling back to MAL (Jikan):', eAni.message);
    }

    // 2. Fallback: Jikan Anime Search / Browse
    try {
      let jikanUrl = `${JIKAN_URL}/anime?page=${page}&limit=${perPage}`;
      if (query) {
        jikanUrl += `&q=${encodeURIComponent(query)}`;
      } else {
        const rawSort = String(params.sort || 'popularity').toLowerCase();
        if (rawSort.includes('score') || rawSort.includes('rating') || rawSort === 'average_score') {
          jikanUrl = `${JIKAN_URL}/top/anime?page=${page}&limit=${perPage}`;
        } else if (rawSort.includes('trend')) {
          jikanUrl = `${JIKAN_URL}/top/anime?filter=airing&page=${page}&limit=${perPage}`;
        } else if (rawSort.includes('date') || rawSort.includes('season')) {
          jikanUrl = `${JIKAN_URL}/seasons/now?page=${page}&limit=${perPage}`;
        } else if (rawSort.includes('fav')) {
          jikanUrl = `${JIKAN_URL}/top/anime?filter=favorite&page=${page}&limit=${perPage}`;
        } else {
          jikanUrl = `${JIKAN_URL}/top/anime?filter=bypopularity&page=${page}&limit=${perPage}`;
        }
      }
      if (variables.format) {
        jikanUrl += `&type=${variables.format.toLowerCase()}`;
      }
      if (variables.status) {
        const jStatus = variables.status === 'RELEASING' ? 'airing' : (variables.status === 'FINISHED' ? 'complete' : 'upcoming');
        jikanUrl += `&status=${jStatus}`;
      }

      const jRes = await originalFetch(jikanUrl, { signal: AbortSignal.timeout(5000) });
      if (jRes.ok) {
        const jJson = await jRes.json();
        if (jJson?.data?.length) {
          return cacheAndReturn({
            results: mapJikanSearch(jJson.data),
            total: jJson.pagination?.items?.total || 100,
            last_page: jJson.pagination?.last_visible_page || 5,
            current_page: page,
            has_next_page: jJson.pagination?.has_next_page || false
          });
        }
      }
    } catch (e1) {}

    return { results: [], total: 0, last_page: 1, current_page: page, has_next_page: false };
    });
  }

  // 8. Weekly Airing Schedule: 13 days of AniList data (AniList Primary + MAL Fallback)
  async function getClientSchedule(targetDate) {
    const memKey = 'schedule_week_v6';
    let weekItems = [];

    if (memCache.has(memKey)) {
      const c = memCache.get(memKey);
      if (c && c.exp > Date.now()) weekItems = c.data;
    }

    // Purge any legacy cache without dub tags or with raw releases
    try {
      localStorage.removeItem('animetsu_schedule_cache');
      localStorage.removeItem('animetsu_schedule_cache_v4');
      localStorage.removeItem('animetsu_schedule_cache_v5');
    } catch {}

    if (!weekItems.length) {
      try {
        const stored = localStorage.getItem('animetsu_schedule_cache_v6');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length) {
            const hasDubInfo = parsed.some(item => item && (item.is_dub !== undefined || item.air_type));
            if (hasDubInfo) {
              const todayKey = new Date().toLocaleDateString('en-CA');
              const hasToday = parsed.some(item => new Date(item.airing_at).toLocaleDateString('en-CA') === todayKey);
              if (hasToday) weekItems = parsed;
            }
          }
        }
      } catch {}
    }

    if (!weekItems.length) {
      // 1. Primary: Direct ReAnime Airing Schedule (Zero AniList Call)
      try {
        let userTz = 'Asia/Calcutta';
        try {
          userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Calcutta';
        } catch {}
        const tzParam = encodeURIComponent(userTz);

        const [resCurr, resNext, resPrev] = await Promise.allSettled([
          fetch(`https://reanime.to/api/v1/schedule?tz=${tzParam}&week=0`).then(r => r.ok ? r.json() : null),
          fetch(`https://reanime.to/api/v1/schedule?tz=${tzParam}&week=1`).then(r => r.ok ? r.json() : null),
          fetch(`https://reanime.to/api/v1/schedule?tz=${tzParam}&week=-1`).then(r => r.ok ? r.json() : null)
        ]);

        const allSchedules = [];
        if (resPrev.status === 'fulfilled' && resPrev.value?.schedule) allSchedules.push(...resPrev.value.schedule);
        if (resCurr.status === 'fulfilled' && resCurr.value?.schedule) allSchedules.push(...resCurr.value.schedule);
        if (resNext.status === 'fulfilled' && resNext.value?.schedule) allSchedules.push(...resNext.value.schedule);

        if (allSchedules.length) {
          const reanimeItems = [];
          const seenIds = new Set();
          for (const day of allSchedules) {
            for (const ep of (day.episodes || [])) {
              const cleanAirType = String(ep.air_type || 'sub').toLowerCase();
              if (cleanAirType === 'raw') continue; // User requested: Skip raw releases completely

              const anilistId = ep.anilist_id || ep.mal_id;
              const uniqueKey = `${anilistId}_${ep.episode_number}_${cleanAirType}_${ep.episode_date}`;
              if (seenIds.has(uniqueKey)) continue;
              seenIds.add(uniqueKey);

              const airDate = ep.episode_date ? new Date(ep.episode_date) : null;
              const airMs = airDate && !isNaN(airDate.getTime()) ? airDate.getTime() : Date.now();
              const hdCover = ep.cover_image?.extra_large || ep.cover_image?.large || ep.cover_image?.medium || '';

              reanimeItems.push({
                id: String(ep.anilist_id || ep.mal_id || ep.anime_id),
                anime_id: String(ep.anilist_id || ep.mal_id || ep.anime_id),
                anilist_id: ep.anilist_id || null,
                mal_id: ep.mal_id || null,
                airing_at: airMs,
                airing_time: airDate ? airDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '',
                airing_ep: ep.episode_number,
                episode: ep.episode_number,
                air_type: cleanAirType,
                is_dub: cleanAirType === 'dub',
                subbed: ep.subbed || 0,
                dubbed: ep.dubbed || 0,
                title: {
                  english: ep.title?.english || ep.title?.romaji || ep.title?.user_preferred || 'Untitled',
                  romaji: ep.title?.romaji || ep.title?.english || ep.title?.user_preferred || 'Untitled',
                  native: ep.title?.native || ''
                },
                cover_image: {
                  extraLarge: hdCover,
                  large: ep.cover_image?.large || hdCover,
                  medium: ep.cover_image?.medium || hdCover,
                  small: ep.cover_image?.small || hdCover
                },
                img: hdCover,
                poster: hdCover,
                banner: hdCover,
                banner_image: hdCover,
                format: ep.format || 'TV',
                color: ep.cover_image?.color || '#e4ae5d',
                average_score: ep.average_score || 80,
                duration: 24,
                delayed: ep.airing_status === 'delayed-air' ? (ep.delayed_text || 'Delayed') : null
              });
            }
          }

          if (reanimeItems.length) {
            weekItems = reanimeItems;
            memCache.set(memKey, { data: weekItems, exp: Date.now() + 60 * 60 * 1000 });
            try { localStorage.setItem('animetsu_schedule_cache_v6', JSON.stringify(weekItems)); } catch {}
          }
        }
      } catch (errReanime) {
        console.warn('⚠️ [ClientEngine] ReAnime schedule failed, falling back to AniList:', errReanime.message);
      }
    }

    if (!weekItems.length) {
      // 2. Fallback 1: Batched 13-Day AniList Query
      try {
        const now = new Date();
        const daysAliases = [];
        const variables = {};

        for (let i = -6; i <= 6; i++) {
          const d = new Date(now);
          d.setDate(now.getDate() + i);
          const startUnix = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).getTime() / 1000);
          const endUnix = startUnix + 86400;
          const alias = `d_${i < 0 ? 'm' + Math.abs(i) : 'p' + i}`;

          variables[`s_${alias}`] = startUnix;
          variables[`e_${alias}`] = endUnix;

          daysAliases.push(`
            ${alias}: Page(page: 1, perPage: 40) {
              airingSchedules(airingAt_greater: $s_${alias}, airingAt_lesser: $e_${alias}, sort: TIME) {
                id
                episode
                airingAt
                timeUntilAiring
                media {
                  id
                  idMal
                  title { english romaji native }
                  format
                  type
                  averageScore
                  duration
                  coverImage { extraLarge large medium color }
                  bannerImage
                }
              }
            }
          `);
        }

        const varDefs = Object.keys(variables).map(k => `$${k}: Int`).join(', ');
        const query = `query GetBatchedSchedule(${varDefs}) { ${daysAliases.join('\n')} }`;

        const data = await queryAniList(query, variables);
        if (data) {
          const rawAiring = [];
          for (const page of Object.values(data)) {
            if (page?.airingSchedules?.length) {
              rawAiring.push(...page.airingSchedules);
            }
          }

          if (rawAiring.length) {
            weekItems = rawAiring.map(item => {
              const m = item.media || {};
              const hdCover = getHdCover(m.coverImage?.extraLarge || m.coverImage?.large || '');
              const airDate = new Date(item.airingAt * 1000);
              return {
                id: String(m.id),
                anime_id: String(m.id),
                anilist_id: m.id,
                airing_at: item.airingAt * 1000,
                airing_time: airDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                airing_ep: item.episode,
                episode: item.episode,
                title: {
                  english: m.title?.english || m.title?.romaji || 'Untitled',
                  romaji: m.title?.romaji || m.title?.english || 'Untitled',
                  native: m.title?.native || ''
                },
                cover_image: { extraLarge: hdCover, large: hdCover, medium: hdCover, small: hdCover },
                img: hdCover,
                poster: hdCover,
                banner: m.bannerImage || hdCover,
                banner_image: m.bannerImage || hdCover,
                format: m.format || 'TV',
                color: m.coverImage?.color || '#e4ae5d',
                average_score: m.averageScore || 80,
                duration: m.duration || 24
              };
            });

            memCache.set(memKey, { data: weekItems, exp: Date.now() + 60 * 60 * 1000 });
            try { localStorage.setItem('animetsu_schedule_cache', JSON.stringify(weekItems)); } catch {}
          }
        }
      } catch (eAni) {
        console.warn('⚠️ [ClientEngine] AniList batched schedule failed, falling back to MAL (Jikan):', eAni.message);
      }
    }

    // If AniList succeeded, return the schedule
    if (weekItems.length) {
      if (targetDate) {
        const d = targetDate instanceof Date ? targetDate : new Date(targetDate);
        if (!isNaN(d.getTime())) {
          const targetKey = d.toLocaleDateString('en-CA');
          const dayItems = weekItems.filter(item => {
            return new Date(item.airing_at).toLocaleDateString('en-CA') === targetKey;
          });
          if (dayItems.length) return dayItems;
        }
      }
      return weekItems;
    }

    // 2. Fallback: Jikan Seasons Now & Airing
    let rawList = [];

    try {
      const res = await originalFetch(`${JIKAN_URL}/seasons/now?limit=25`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const j = await res.json();
        if (j.data?.length) rawList = j.data;
      }
    } catch (e1) {}

    // 2. Fallback: Jikan Top Airing
    if (!rawList.length) {
      try {
        const res = await originalFetch(`${JIKAN_URL}/top/anime?filter=airing&limit=25`, { signal: AbortSignal.timeout(3500) });
        if (res.ok) {
          const j = await res.json();
          if (j.data?.length) rawList = j.data;
        }
      } catch (e2) {}
    }

    if (!rawList.length) {
      // Fallback to home trending or popular
      const home = await getClientHome();
      const anyHome = home?.seasonal?.length ? home.seasonal : (home?.trending || []);
      rawList = anyHome.map(item => ({
        mal_id: item.mal_id || item.id,
        title: item.title?.romaji || item.title?.english || 'Anime',
        title_english: item.title?.english,
        images: { webp: { large_image_url: item.img || item.poster } },
        episodes: item.total_eps || 12,
        type: item.format || 'TV',
        score: (item.average_score || 75) / 10
      }));
    }

    // Realistic daily time slots
    const timeSlots = [
      { h: 9, m: 0 },
      { h: 11, m: 30 },
      { h: 14, m: 0 },
      { h: 16, m: 30 },
      { h: 19, m: 0 },
      { h: 21, m: 30 },
      { h: 23, m: 0 }
    ];

    // Distribute across 13 days (-6 to +6 around today)
    const scheduleItems = [];
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    for (let dOffset = -6; dOffset <= 6; dOffset++) {
      const dayDate = new Date(todayStart + dOffset * 86400 * 1000);
      const dayOfWeek = dayDate.getDay();

      const animeForDay = rawList.filter((_, idx) => (idx % 7) === dayOfWeek);
      if (!animeForDay.length) {
        animeForDay.push(...rawList.slice(0, 3));
      }

      animeForDay.forEach((item, slotIdx) => {
        const slot = timeSlots[slotIdx % timeSlots.length];
        const airDate = new Date(dayDate);
        airDate.setHours(slot.h, slot.m, 0, 0);
        const airMs = airDate.getTime();

        const img = item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || '';
        const baseEp = item.episodes || 12;
        const airEp = dOffset > 0 ? Math.min(baseEp, 12 + dOffset) : Math.max(1, 12 + dOffset);

        scheduleItems.push({
          id: String(item.mal_id),
          anime_id: String(item.mal_id),
          airing_at: airMs,
          airing_time: airDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          airing_ep: airEp,
          episode: airEp,
          title: {
            english: item.title_english || item.title || 'Untitled',
            romaji: item.title || 'Untitled',
            native: item.title_japanese || ''
          },
          cover_image: { extraLarge: img, large: img, medium: img, small: img },
          img: img,
          poster: img,
          banner: img,
          banner_image: img,
          format: item.type || 'TV',
          color: '#e4ae5d',
          average_score: Math.round((item.score || 8) * 10),
          duration: 24
        });
      });
    }

    memCache.set(memKey, { data: scheduleItems, exp: Date.now() + 60 * 60 * 1000 });
    return scheduleItems;
  }

  function mapAniListToAnimetsu(m) {
    if (!m) return null;
    const cover = getHdCover(m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || '');
    const banner = m.bannerImage || cover;
    const trailerId = typeof m.trailer === 'string' ? m.trailer : (m.trailer?.id || '');
    const yr = m.seasonYear || m.startDate?.year || new Date().getFullYear();

    return {
      id: String(m.id),
      anilist_id: m.id,
      mal_id: m.idMal || m.mal_id || m.id,
      type: 'anime',
      title: {
        english: m.title?.english || m.title?.romaji || m.title?.native || 'Untitled',
        romaji: m.title?.romaji || m.title?.english || 'Untitled',
        native: m.title?.native || ''
      },
      format: m.format || 'TV',
      status: m.status || 'FINISHED',
      year: yr,
      season: m.season || 'FALL',
      average_score: m.averageScore || 70,
      mean_score: m.averageScore || 70,
      duration: m.duration || 24,
      total_eps: m.episodes || 12,
      genres: m.genres || [],
      description: (m.description || '').replace(/<[^>]*>?/gm, ''),
      banner: banner,
      banner_image: banner,
      poster: cover,
      img: cover,
      cover_image: { extraLarge: cover, large: cover, medium: cover, small: cover },
      trailer: trailerId,
      trailer_url: trailerId ? `https://www.youtube.com/watch?v=${trailerId}` : '',
      trailer_embed: trailerId ? `https://www.youtube-nocookie.com/embed/${trailerId}` : '',
      is_adult: Boolean(m.isAdult),
      next_airing_ep: m.nextAiringEpisode ? {
        airing_at: m.nextAiringEpisode.airingAt,
        time_until_airing: m.nextAiringEpisode.timeUntilAiring,
        ep_num: m.nextAiringEpisode.episode
      } : null
    };
  }


  // Animetsu v1 TMDB Logo Integration
  const TMDB_API_KEY = '3b0fa3c43dea59ff255ee83f04849655';
  const TMDB_PROXY_BASE = 'https://tmdb.screenscape.me/tmdb/3';
  const TMDB_DIRECT_BASE = 'https://api.themoviedb.org/3';

  async function fetchTmdbLogo(tmdbId, isMovie = false) {
    if (!tmdbId) return null;
    const type = isMovie ? 'movie' : 'tv';
    // 1. Primary: Screenscape TMDB Proxy (from Animetsu v1)
    try {
      const res = await originalFetch(`${TMDB_PROXY_BASE}/${type}/${tmdbId}/images?api_key=${TMDB_API_KEY}`, {
        signal: AbortSignal.timeout(2800)
      });
      if (res.ok) {
        const data = await res.json();
        const logos = data.logos || [];
        const en = logos.find(l => l.iso_639_1 === 'en') || logos.find(l => !l.iso_639_1) || logos[0];
        if (en && en.file_path) {
          return 'https://image.tmdb.org/t/p/w500' + en.file_path;
        }
      }
    } catch (e) {}

    // 2. Direct TMDB API fallback
    try {
      const res = await originalFetch(`${TMDB_DIRECT_BASE}/${type}/${tmdbId}/images?api_key=${TMDB_API_KEY}`, {
        signal: AbortSignal.timeout(2800)
      });
      if (res.ok) {
        const data = await res.json();
        const logos = data.logos || [];
        const en = logos.find(l => l.iso_639_1 === 'en') || logos.find(l => !l.iso_639_1) || logos[0];
        if (en && en.file_path) {
          return 'https://image.tmdb.org/t/p/w500' + en.file_path;
        }
      }
    } catch (e) {}

    return null;
  }

  // Fetch official HD transparent PNG title logo (Primary: TMDB v1, Secondary: AniZip HD PNG)
  async function getAnimeLogo(anilistId) {
    if (!anilistId) return null;
    const numId = Number(anilistId);
    const memKey = 'logo_' + numId;
    if (memCache.has(memKey)) return memCache.get(memKey);

    try {
      const local = localStorage.getItem('animetsu_logo_' + numId);
      if (local && !local.includes('/icons/') && !local.endsWith('.jpg')) {
        memCache.set(memKey, local);
        return local;
      }
    } catch (e) {}

    try {
      let az = memCache.get('anizip_raw_' + numId);
      if (!az) {
        const res = await originalFetch(ANIZIP_URL + '?anilist_id=' + numId, {
          signal: AbortSignal.timeout(3500)
        });
        if (res.ok) {
          az = await res.json();
          memCache.set('anizip_raw_' + numId, az);
        }
      }

      if (az) {
        const tmdbId = az.mappings?.themoviedb_id;
        const isMovie = az.mappings?.type === 'MOVIE' || az.mappings?.type === 'Movie';

        // 1. Primary: TMDB Official HD Logo (Animetsu v1 method)
        if (tmdbId) {
          const tmdbLogo = await fetchTmdbLogo(tmdbId, isMovie);
          if (tmdbLogo) {
            memCache.set(memKey, tmdbLogo);
            try { localStorage.setItem('animetsu_logo_' + numId, tmdbLogo); } catch {}
            return tmdbLogo;
          }
        }

        // 2. Secondary: AniZip HD Clearlogo (strict PNG only)
        const cleanLogo = (az.images || []).find(img => 
          (img.coverType === 'Clearlogo' || img.coverType === 'Clearart') &&
          img.url &&
          img.url.toLowerCase().endsWith('.png') &&
          !img.url.toLowerCase().includes('/icons/')
        );
        if (cleanLogo && cleanLogo.url) {
          memCache.set(memKey, cleanLogo.url);
          try { localStorage.setItem('animetsu_logo_' + numId, cleanLogo.url); } catch {}
          return cleanLogo.url;
        }
      }
    } catch (e) {}

    return null;
  }

    async function attachClearLogos(animeList) {
    if (!Array.isArray(animeList) || !animeList.length) return;
    const targetSlice = animeList.slice(0, 10);
    await Promise.allSettled(
      targetSlice.map(async (item) => {
        if (!item || item.clear_logo !== undefined) return;
        const id = item.anilist_id || item.id;
        if (!id) return;
        const logo = await getAnimeLogo(id);
        item.clear_logo = logo || '';
      })
    );
  }

  // 0. Home Data: AniList Primary + MAL (Jikan v4) Fallback
  // 9. Client Home: Top Rated, All-Time Popular, This Season, Trending Now, Top Upcoming
  async function getClientHome() {
    const HOME_CACHE_KEY = 'animetsu_home_cache';
    const HOME_TTL = 30 * 60 * 1000; // 30 minutes

    // 1. Fresh cache check (0ms instantaneous response on reload!)
    const notUpcoming = (m) => m && m.status !== 'NOT_YET_RELEASED';
    const freshCache = getCachedItem(HOME_CACHE_KEY, 'local');
    if (freshCache && (freshCache.trending?.length || freshCache.popular?.length)) {
      freshCache.trending = (freshCache.trending || []).filter(notUpcoming);
      freshCache.seasonal = (freshCache.seasonal || []).filter(notUpcoming);
      freshCache.popular = (freshCache.popular || []).filter(notUpcoming);
      freshCache.top = (freshCache.top || []).filter(notUpcoming);
      freshCache.movies = (freshCache.movies || []).filter(notUpcoming);
      return freshCache;
    }

    // 2. Stale-While-Revalidate: Return existing cache immediately for 0ms render, revalidate in background
    const staleCache = getStaleCachedItem(HOME_CACHE_KEY, 'local') || (function() {
      try {
        const raw = localStorage.getItem('animetsu_last_home');
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    })();

    const executeHomeFetch = () => dedupeRequest('home_data_fetch', async () => {

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const currentSeason = currentMonth <= 3 ? 'WINTER' : (currentMonth <= 6 ? 'SPRING' : (currentMonth <= 9 ? 'SUMMER' : 'FALL'));

    // Pure Client-Side Fetch: Queries AniList GraphQL directly from user browser (Instant, 0 server delay, zero IP blocks)
    try {
      console.log('🌐 [ClientEngine] Fetching AniList Home data directly from browser...');
      const homeQuery = `
        query {
          trending: Page(page: 1, perPage: 15) {
            media(type: ANIME, status_not: NOT_YET_RELEASED, sort: TRENDING_DESC) {
              id
              idMal
              title { english romaji native }
              format
              status
              season
              seasonYear
              averageScore
              duration
              episodes
              genres
              description(asHtml: false)
              bannerImage
              coverImage { extraLarge large medium color }
              trailer { id }
            }
          }
          seasonal: Page(page: 1, perPage: 24) {
            media(type: ANIME, season: ${currentSeason}, seasonYear: ${currentYear}, status_not: NOT_YET_RELEASED, sort: POPULARITY_DESC) {
              id
              idMal
              title { english romaji native }
              format
              status
              season
              seasonYear
              averageScore
              duration
              episodes
              genres
              description(asHtml: false)
              bannerImage
              coverImage { extraLarge large medium color }
              trailer { id }
            }
          }
          popular: Page(page: 1, perPage: 24) {
            media(type: ANIME, status_not: NOT_YET_RELEASED, sort: POPULARITY_DESC) {
              id
              idMal
              title { english romaji native }
              format
              status
              seasonYear
              averageScore
              duration
              episodes
              genres
              description(asHtml: false)
              bannerImage
              coverImage { extraLarge large medium color }
              trailer { id }
            }
          }
          top: Page(page: 1, perPage: 24) {
            media(type: ANIME, status_not: NOT_YET_RELEASED, sort: SCORE_DESC) {
              id
              idMal
              title { english romaji native }
              format
              status
              seasonYear
              averageScore
              duration
              episodes
              genres
              description(asHtml: false)
              bannerImage
              coverImage { extraLarge large medium color }
              trailer { id }
            }
          }
          movies: Page(page: 1, perPage: 20) {
            media(type: ANIME, format: MOVIE, status_not: NOT_YET_RELEASED, sort: TRENDING_DESC) {
              id
              idMal
              title { english romaji native }
              format
              status
              seasonYear
              averageScore
              duration
              episodes
              genres
              description(asHtml: false)
              bannerImage
              coverImage { extraLarge large medium color }
              trailer { id }
            }
          }
          upcoming: Page(page: 1, perPage: 15) {
            media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC) {
              id
              idMal
              title { english romaji native }
              format
              status
              season
              seasonYear
              startDate { year month day }
              averageScore
              source
              genres
              description(asHtml: false)
              bannerImage
              coverImage { extraLarge large medium color }
              studios(isMain: true) { nodes { name } }
              nextAiringEpisode { airingAt timeUntilAiring episode }
              trailer { id }
            }
          }
        }
      `;

      const aniHome = await queryAniList(homeQuery);
      if (aniHome?.trending?.media?.length) {
        const trending = (aniHome.trending.media || []).map(mapAniListToAnimetsu).filter(Boolean).filter(notUpcoming);
        const seasonal = (aniHome.seasonal?.media || []).map(mapAniListToAnimetsu).filter(Boolean).filter(notUpcoming);
        const popular = (aniHome.popular?.media || []).map(mapAniListToAnimetsu).filter(Boolean).filter(notUpcoming);
        const top = (aniHome.top?.media || []).map(mapAniListToAnimetsu).filter(Boolean).filter(notUpcoming);
        const movies = (aniHome.movies?.media || []).map(mapAniListToAnimetsu).filter(Boolean).filter(notUpcoming);
        const upcoming = (aniHome.upcoming?.media || []).map(mapAniListToAnimetsu).filter(Boolean);

        const anyList = trending.length ? trending : (seasonal.length ? seasonal : popular);
        const result = {
          trending,
          seasonal: seasonal.length ? seasonal : anyList,
          popular: popular.length ? popular : anyList,
          top: top.length ? top : anyList,
          movies: movies.length ? movies : anyList.filter(x => x.format === 'MOVIE'),
          upcoming: upcoming.length ? upcoming : anyList.slice(5, 20)
        };

        if (result.trending.length) {
          await attachClearLogos(result.trending);
          setCachedItem(HOME_CACHE_KEY, result, HOME_TTL, 'local');
          try { localStorage.setItem('animetsu_last_home', JSON.stringify(result)); } catch {}
          writeBackToServer('home', 'home', result);
          return result;
        }
      }
    } catch (err) {
      console.warn('⚠️ [ClientEngine] AniList Home error, falling back to MAL (Jikan):', err.message);
    }

    // 2. Fallback: MyAnimeList (Jikan v4)
    console.log('🔄 [ClientEngine] Fallback to MAL (Jikan) for Home data...');
    function mapJikanList(items) {
      return (items || []).map(item => {
        const img = item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || '';
        const trailerId = item.trailer?.youtube_id || '';
        return {
          id: String(item.mal_id),
          anilist_id: item.mal_id,
          mal_id: item.mal_id,
          type: 'anime',
          title: {
            english: item.title_english || item.title || 'Untitled',
            romaji: item.title || 'Untitled',
            native: item.title_japanese || ''
          },
          format: item.type || 'TV',
          season: (item.season || 'SUMMER').toUpperCase(),
          year: item.year || new Date().getFullYear(),
          status: item.status === 'Currently Airing' ? 'RELEASING' : (item.status === 'Not yet aired' ? 'NOT_YET_RELEASED' : 'FINISHED'),
          average_score: Math.round((item.score || 8) * 10),
          cover_image: { extraLarge: img, large: img, medium: img, small: img },
          img: img,
          poster: img,
          banner: img,
          banner_image: img,
          trailer: trailerId,
          trailer_url: trailerId ? `https://www.youtube.com/watch?v=${trailerId}` : '',
          trailer_embed: trailerId ? `https://www.youtube-nocookie.com/embed/${trailerId}` : '',
          total_eps: item.episodes || 12,
          duration: 24,
          genres: (item.genres || []).map(g => g.name),
          description: item.synopsis || ''
        };
      });
    }

    async function fetchCategory(jikanUrl, limit = 20) {
      if (jikanUrl) {
        try {
          const res = await originalFetch(jikanUrl, { signal: AbortSignal.timeout(4000) });
          if (res.ok) {
            const j = await res.json();
            if (j.data?.length) return mapJikanList(j.data).slice(0, limit);
          }
        } catch (e) {}
      }
      return [];
    }

    try {
      const [top, popular, seasonal, trending, upcoming] = await Promise.all([
        // Top Anime -> Top Rated MAL
        fetchCategory(`${JIKAN_URL}/top/anime?limit=24`, 24),
        // Most Popular Anime -> All-Time Popular MAL
        fetchCategory(`${JIKAN_URL}/top/anime?filter=bypopularity&limit=24`, 24),
        // Summer 2026 / This Season -> Currently Airing Seasonal MAL
        fetchCategory(`${JIKAN_URL}/seasons/now?limit=24`, 24),
        // Trending Now -> Airing Trending MAL
        fetchCategory(`${JIKAN_URL}/top/anime?filter=airing&limit=15`, 15),
        // Top Upcoming -> MAL Top Upcoming
        fetchCategory(`${JIKAN_URL}/top/anime?filter=upcoming&limit=15`, 15)
      ]);

      const anyList = (top.length ? top : (popular.length ? popular : seasonal));
      const result = {
        top: top.length ? top : anyList,
        popular: popular.length ? popular : anyList,
        seasonal: seasonal.length ? seasonal : anyList,
        trending: trending.length ? trending : anyList.slice(0, 15),
        upcoming: upcoming.length ? upcoming : anyList.slice(5, 20)
      };

      if (result.top.length || result.popular.length || result.seasonal.length) {
        await attachClearLogos(result.trending.length ? result.trending : result.popular);
        setCachedItem(HOME_CACHE_KEY, result, HOME_TTL, 'local');
        try { localStorage.setItem('animetsu_last_home', JSON.stringify(result)); } catch {}
        // Note: Never writeBackToServer for MAL; CDN cache is reserved strictly for pure AniList home data
        return result;
      }
    } catch (err) {
      console.warn('⚠️ [ClientEngine] Multi-category fetch error:', err.message);
    }

    // Last persisted cache
    try {
      const persisted = localStorage.getItem('animetsu_last_home');
      if (persisted) {
        const parsed = JSON.parse(persisted);
        if (parsed?.seasonal?.length || parsed?.popular?.length) return parsed;
      }
    } catch (e) {}

    return { trending: [], seasonal: [], popular: [], top: [], upcoming: [] };
    });

    if (staleCache && (staleCache.trending?.length || staleCache.popular?.length)) {
      executeHomeFetch().then(fresh => {
        if (fresh && (fresh.trending?.length || fresh.popular?.length)) {
          setCachedItem(HOME_CACHE_KEY, fresh, HOME_TTL, 'local');
        }
      }).catch(() => {});
      return staleCache;
    }

    return executeHomeFetch();
  }

  // 10. Recently Updated Episodes: AniList Primary + MAL (Jikan) Fallback
  async function getClientRecent(page = 1, perPage = 12) {
    const cacheKey = `animetsu_recent_${page}_${perPage}`;
    const cached = getCachedItem(cacheKey, 'session');
    if (cached && cached.results?.length) return cached;

    return dedupeRequest(cacheKey, async () => {
    const memKey = cacheKey;

    // 1. Primary: AniList Airing Schedules (notYetAired: false, sort: TIME_DESC)
    try {
      const aniRecentQuery = `
        query ($page: Int, $perPage: Int) {
          Page(page: $page, perPage: $perPage) {
            pageInfo {
              currentPage
              hasNextPage
              lastPage
            }
            airingSchedules(notYetAired: false, sort: TIME_DESC) {
              id
              episode
              airingAt
              media {
                id
                idMal
                title { english romaji native }
                status
                seasonYear
                coverImage { extraLarge large medium color }
                bannerImage
                format
                type
                genres
                duration
                averageScore
                description(asHtml: false)
              }
            }
          }
        }
      `;
      const data = await queryAniList(aniRecentQuery, { page: Number(page), perPage: Number(perPage) });
      if (data?.Page?.airingSchedules?.length) {
        const results = data.Page.airingSchedules.map((item, idx) => {
          const m = item.media;
          if (!m) return null;
          const hdCover = getHdCover(m.coverImage?.extraLarge || m.coverImage?.large || '');
          let viewsCount = 0;
          try {
            const cached = localStorage.getItem(`animetsu_real_views_${m.id}_${item.episode}`);
            if (cached !== null) viewsCount = Number(cached) || 0;
          } catch {}
          return {
            id: String(m.id),
            anilist_id: m.id,
            mal_id: m.idMal || m.id,
            type: 'anime',
            aired_at: item.airingAt ? item.airingAt * 1000 : (Date.now() - idx * 3600000),
            ep_num: item.episode,
            ep_name: `Episode ${item.episode}`,
            title: {
              romaji: m.title?.romaji || m.title?.english || 'Untitled',
              english: m.title?.english || m.title?.romaji || 'Untitled',
              native: m.title?.native || ''
            },
            status: m.status || 'RELEASING',
            is_adult: false,
            format: m.format || 'TV',
            year: m.seasonYear || new Date().getFullYear(),
            cover_image: { extraLarge: hdCover, large: hdCover, medium: hdCover, small: hdCover },
            img: hdCover,
            poster: hdCover,
            banner: m.bannerImage || hdCover,
            banner_image: m.bannerImage || hdCover,
            views: viewsCount
          };
        }).filter(Boolean);

        if (results.length) {
          const recentResult = {
            results,
            total: 120,
            current_page: data.Page.pageInfo?.currentPage || Number(page),
            has_next_page: data.Page.pageInfo?.hasNextPage || false,
            last_page: data.Page.pageInfo?.lastPage || 10
          };
          setCachedItem(cacheKey, recentResult, 10 * 60 * 1000, 'session');
          return recentResult;
        }
      }
    } catch (eAni) {
      console.warn('⚠️ [ClientEngine] AniList recent failed, falling back to MAL (Jikan):', eAni.message);
    }

    // 2. Fallback: Jikan Seasons Now & Airing
    let recentItems = [];

    try {
      const res = await originalFetch(`${JIKAN_URL}/seasons/now?page=${page}&limit=${perPage}`, { signal: AbortSignal.timeout(3500) });
      if (res.ok) {
        const json = await res.json();
        if (json?.data?.length) recentItems = json.data;
      }
    } catch (e1) {}

    // 2. Fallback: Jikan Top Airing
    if (!recentItems.length) {
      try {
        const res = await originalFetch(`${JIKAN_URL}/top/anime?filter=airing&page=${page}&limit=${perPage}`, { signal: AbortSignal.timeout(3500) });
        if (res.ok) {
          const json = await res.json();
          if (json?.data?.length) recentItems = json.data;
        }
      } catch (e2) {}
    }

    if (recentItems.length) {
      const results = recentItems.map((item, idx) => {
        const img = item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || '';
        let viewsCount = 0;
        try {
          const cached = localStorage.getItem(`animetsu_real_views_${item.mal_id}_${epNum}`);
          if (cached !== null) viewsCount = Number(cached) || 0;
        } catch {}
        const airedAt = Date.now() - (idx * 3600 * 1000 * 2) - ((page - 1) * perPage * 3600 * 1000 * 2);

        let epNum = item.episodes;
        if (!epNum || epNum < 1) {
          if (item.startDate || item.aired?.from) {
            const start = new Date(item.startDate || item.aired?.from).getTime();
            if (!isNaN(start)) {
              const weeks = Math.floor((Date.now() - start) / (7 * 86400 * 1000)) + 1;
              if (weeks > 0 && weeks <= 1200) epNum = weeks;
            }
          }
        }
        if (!epNum || epNum < 1) epNum = (Number(item.mal_id || idx + 1) % 12) + 1;

        return {
          id: String(item.mal_id),
          anilist_id: item.mal_id,
          mal_id: item.mal_id,
          type: 'anime',
          aired_at: airedAt,
          ep_num: epNum,
          ep_name: `Episode ${epNum}`,
          title: {
            romaji: item.title || 'Untitled',
            english: item.title_english || item.title || 'Untitled',
            native: item.title_japanese || ''
          },
          status: 'RELEASING',
          is_adult: false,
          format: item.type || 'TV',
          year: item.year || new Date().getFullYear(),
          cover_image: { extraLarge: img, large: img, medium: img, small: img },
          img: img,
          poster: img,
          banner: img,
          banner_image: img,
          views: viewsCount
        };
      });

      const result = {
        results,
        total: 120,
        current_page: Number(page),
        has_next_page: page < 10,
        last_page: 10
      };

      setCachedItem(cacheKey, result, 10 * 60 * 1000, 'session');
      return result;
    }

    return { results: [], total: 0, current_page: page, has_next_page: false, last_page: 1 };
    });
  }

  window.__animetsu_adapter = async function (config) {
    const url = config.url || '';
    const method = (config.method || 'GET').toUpperCase();

    // 0n. Pure Client-Side Notification Unread & Read State (Zero Backend/D1 Calls)
    if (url.includes('/notification/unread')) {
      const readSet = new Set(JSON.parse(localStorage.getItem('animetsu_read_notifications') || '[]'));
      const lastReadAll = Number(localStorage.getItem('animetsu_last_read_all') || 0);
      let unreadCount = 0;
      try {
        const cached = JSON.parse(localStorage.getItem('animetsu_cached_notifications') || '[]');
        unreadCount = cached.filter(n => {
          if (!n || !n.id) return false;
          if (readSet.has(String(n.id))) return false;
          const t = new Date(n.created_at).getTime() || 0;
          if (lastReadAll > 0 && t <= lastReadAll) return false;
          return !n.read;
        }).length;
      } catch {}
      return {
        data: { count: unreadCount, unread: unreadCount },
        status: 200,
        statusText: 'OK',
        headers: {},
        config
      };
    }

    if (url.includes('/notification/read/')) {
      const notifId = url.split('/read/')[1]?.split('?')[0];
      try {
        if (notifId === 'all') {
          localStorage.setItem('animetsu_last_read_all', String(Date.now()));
        } else if (notifId) {
          const readSet = new Set(JSON.parse(localStorage.getItem('animetsu_read_notifications') || '[]'));
          readSet.add(String(notifId));
          localStorage.setItem('animetsu_read_notifications', JSON.stringify([...readSet]));
        }
      } catch {}
      return {
        data: { success: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config
      };
    }

    if ((url.endsWith('/notification') || url.includes('/notification?')) && method === 'GET') {
      try {
        const res = await origAdapter(config);
        if (res?.data?.results) {
          const readSet = new Set(JSON.parse(localStorage.getItem('animetsu_read_notifications') || '[]'));
          const lastReadAll = Number(localStorage.getItem('animetsu_last_read_all') || 0);
          res.data.results = res.data.results.map(n => {
            if (!n) return n;
            const notifId = String(n.id || '');
            const t = new Date(n.created_at).getTime() || 0;
            const isRead = n.read || readSet.has(notifId) || (lastReadAll > 0 && t <= lastReadAll);
            return { ...n, read: isRead };
          });
          try {
            localStorage.setItem('animetsu_cached_notifications', JSON.stringify(res.data.results));
          } catch {}
        }
        return res;
      } catch (e) {
        try {
          const cached = JSON.parse(localStorage.getItem('animetsu_cached_notifications') || '[]');
          if (cached.length > 0) {
            return {
              data: { results: cached, has_more: false, total: cached.length },
              status: 200,
              statusText: 'OK',
              headers: {},
              config
            };
          }
        } catch {}
        throw e;
      }
    }

    // 0a. Pure Local Watch History (Zero Cloudflare Worker / D1 calls)
    if (url.includes('history') || url.includes('/user/history')) {
      const HIST_KEY = 'animetsu_watch_history';
      const getStoredHistory = () => {
        try {
          return JSON.parse(localStorage.getItem(HIST_KEY) || localStorage.getItem('user-watch_history') || '[]');
        } catch { return []; }
      };

      if (method === 'GET') {
        const hist = getStoredHistory();
        return { data: hist, status: 200, statusText: 'OK', headers: {}, config };
      }

      if (method === 'POST') {
        try {
          const body = config.data ? (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) : {};
          const cur = getStoredHistory();
          const aId = String(body.anime_id || body.id || '');
          if (aId) {
            const filtered = cur.filter(x => String(x.anime_id || x.id) !== aId);
            filtered.unshift({
              id: aId,
              anime_id: aId,
              ep_num: Number(body.ep_num || 1),
              title: body.title || '',
              img: body.img || body.poster || '',
              progress: Number(body.progress || 0),
              duration: Number(body.duration || 1440),
              updated_at: new Date().toISOString()
            });
            const capped = filtered.slice(0, 30);
            localStorage.setItem(HIST_KEY, JSON.stringify(capped));
            localStorage.setItem('user-watch_history', JSON.stringify(capped));
            window.dispatchEvent(new CustomEvent('animetsu_history_updated'));
          }
        } catch {}
        return { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config };
      }

      if (method === 'DELETE') {
        try {
          const parts = url.split('/history/')[1]?.split('?')[0];
          if (parts) {
            const cur = getStoredHistory().filter(x => String(x.anime_id || x.id) !== String(parts));
            localStorage.setItem(HIST_KEY, JSON.stringify(cur));
            localStorage.setItem('user-watch_history', JSON.stringify(cur));
          } else {
            localStorage.removeItem(HIST_KEY);
            localStorage.removeItem('user-watch_history');
          }
          window.dispatchEvent(new CustomEvent('animetsu_history_updated'));
        } catch {}
        return { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config };
      }
    }

    // 0w. Pure Client-Side AniList Watchlist (Zero Cloudflare Worker / D1 calls)
    if (url.includes('watchlist') || url.includes('/watchlist')) {
      const WL_LOCAL_KEY = 'animetsu_local_watchlist';
      const WL_CACHE_KEY = 'animetsu_user_watchlist';

      // Helper: get current authenticated AniList user (Animetsu or Gojo Live session)
      const getAniListAuth = () => {
        try {
          let u = null;
          const uStr = localStorage.getItem('animetsu_user');
          const gStr = localStorage.getItem('gojo_user_profile');
          if (uStr) {
            try { u = JSON.parse(uStr); } catch {}
          } else if (gStr) {
            try { u = JSON.parse(gStr); } catch {}
          }
          const token = localStorage.getItem('animetsu_anilist_token') ||
                        localStorage.getItem('gojo_user_token') ||
                        localStorage.getItem('al_token') ||
                        u?.anilist_token || u?.token || null;
          let userId = u?.anilist_id || u?.id || null;
          if (userId && String(userId).startsWith('al_')) {
            userId = String(userId).replace('al_', '');
          }
          let userName = u?.username || u?.name || u?.anilist || null;
          return { userId: userId ? Number(userId) : null, userName, token };
        } catch {
          return { userId: null, userName: null, token: null };
        }
      };

      // Helper: Map AniList MediaListStatus to Animetsu watch_status
      const mapAlToAnimetsu = (status) => {
        const s = String(status || '').toUpperCase();
        if (s === 'CURRENT') return 'watching';
        if (s === 'COMPLETED') return 'completed';
        if (s === 'PAUSED') return 'paused';
        if (s === 'DROPPED') return 'dropped';
        if (s === 'REPEATING') return 'rewatching';
        return 'planning';
      };

      // Helper: Map Animetsu watch_status to AniList MediaListStatus
      const mapAnimetsuToAl = (status) => {
        const s = String(status || '').toLowerCase();
        if (s === 'watching') return 'CURRENT';
        if (s === 'completed') return 'COMPLETED';
        if (s === 'paused') return 'PAUSED';
        if (s === 'dropped') return 'DROPPED';
        if (s === 'rewatching') return 'REPEATING';
        return 'PLANNING';
      };

      // Helper: Fetch entire user list directly from AniList GraphQL
      const fetchAniListCollection = async (auth) => {
        const query = `
          query ($userId: Int, $userName: String) {
            MediaListCollection(userId: $userId, userName: $userName, type: ANIME) {
              lists {
                name
                status
                entries {
                  id
                  mediaId
                  status
                  score(format: POINT_10)
                  progress
                  repeat
                  notes
                  updatedAt
                  createdAt
                  media {
                    id
                    idMal
                    format
                    status
                    episodes
                    duration
                    bannerImage
                    title {
                      romaji
                      english
                      native
                      userPreferred
                    }
                    coverImage {
                      extraLarge
                      large
                      medium
                    }
                  }
                }
              }
            }
          }
        `;
        const variables = {};
        if (auth.userId && !isNaN(auth.userId)) variables.userId = auth.userId;
        else if (auth.userName) variables.userName = auth.userName;
        else return null;

        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        };
        if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;

        const res = await originalFetch('https://graphql.anilist.co', {
          method: 'POST',
          headers,
          body: JSON.stringify({ query, variables })
        });

        if (!res.ok) return null;
        const json = await res.json();
        const lists = json?.data?.MediaListCollection?.lists || [];
        const allEntries = [];

        for (const list of lists) {
          if (Array.isArray(list.entries)) {
            for (const entry of list.entries) {
              const media = entry.media || {};
              const title = media.title || {};
              const cover = media.coverImage || {};

              allEntries.push({
                id: entry.id,
                anime_id: String(entry.mediaId || media.id),
                anime_info: {
                  id: String(media.id),
                  idMal: media.idMal,
                  title: {
                    romaji: title.romaji || title.userPreferred || '',
                    english: title.english || title.romaji || title.userPreferred || '',
                    native: title.native || ''
                  },
                  cover_image: {
                    large: cover.extraLarge || cover.large || cover.medium || '',
                    medium: cover.large || cover.medium || '',
                    small: cover.medium || cover.large || ''
                  },
                  banner: media.bannerImage || '',
                  format: media.format || 'TV',
                  episodes: media.episodes || 0,
                  status: media.status || 'FINISHED'
                },
                watch_status: mapAlToAnimetsu(entry.status),
                score: entry.score || 0,
                progress: entry.progress || 0,
                repeat: entry.repeat || 0,
                notes: entry.notes || '',
                custom_lists: [],
                is_private: false,
                hidden_from_status_lists: false,
                updated_at: entry.updatedAt ? new Date(entry.updatedAt * 1000).toISOString() : new Date().toISOString(),
                created_at: entry.createdAt ? new Date(entry.createdAt * 1000).toISOString() : new Date().toISOString()
              });
            }
          }
        }
        return allEntries;
      };

      // 1. GET /watchlist
      if (method === 'GET') {
        const auth = getAniListAuth();

        // If authenticated with AniList
        if (auth.userId || auth.userName) {
          // Check memory/local cache first for instant render
          let cached = null;
          try {
            const cStr = localStorage.getItem(WL_CACHE_KEY);
            if (cStr) cached = JSON.parse(cStr);
          } catch {}

          try {
            const freshList = await fetchAniListCollection(auth);
            if (freshList && freshList.length >= 0) {
              localStorage.setItem(WL_CACHE_KEY, JSON.stringify(freshList));
              localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(freshList));
              return { data: freshList, status: 200, statusText: 'OK', headers: {}, config };
            }
          } catch (fetchErr) {
            console.warn('[client_engine] AniList watchlist fetch error, using cache:', fetchErr);
          }

          if (cached && Array.isArray(cached)) {
            return { data: cached, status: 200, statusText: 'OK', headers: {}, config };
          }
        }

        // Guest / unauthenticated fallback
        try {
          const localList = JSON.parse(localStorage.getItem(WL_LOCAL_KEY) || '[]');
          return { data: localList, status: 200, statusText: 'OK', headers: {}, config };
        } catch {
          return { data: [], status: 200, statusText: 'OK', headers: {}, config };
        }
      }

      // 2. POST /watchlist/import
      if (url.includes('/watchlist/import') && method === 'POST') {
        try {
          const body = config.data ? (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) : {};
          const targetUser = body.username;
          if (targetUser) {
            const imported = await fetchAniListCollection({ userName: targetUser, token: null });
            if (imported) {
              localStorage.setItem(WL_CACHE_KEY, JSON.stringify(imported));
              localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(imported));
              window.dispatchEvent(new CustomEvent('animetsu_watchlist_update'));
              return { data: { success: true, count: imported.length }, status: 200, statusText: 'OK', headers: {}, config };
            }
          }
        } catch (impErr) {
          console.error('[client_engine] Import watchlist error:', impErr);
        }
        return { data: { success: false }, status: 400, statusText: 'Bad Request', headers: {}, config };
      }

      // 3. POST /watchlist (Add or update anime entry)
      if (method === 'POST') {
        try {
          const body = config.data ? (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) : {};
          const aId = String(body.anime_id || body.id || '');
          if (!aId) return { data: { success: false }, status: 400, statusText: 'Bad Request', headers: {}, config };

          const auth = getAniListAuth();
          const targetStatus = body.watch_status || 'planning';
          const alStatus = mapAnimetsuToAl(targetStatus);

          // Update local cache immediately (optimistic update)
          let currentList = [];
          try {
            currentList = JSON.parse(localStorage.getItem(WL_CACHE_KEY) || localStorage.getItem(WL_LOCAL_KEY) || '[]');
          } catch {}

          const existingIdx = currentList.findIndex(x => String(x.anime_id || x.id) === aId);
          const nowIso = new Date().toISOString();
          let updatedItem = null;

          if (existingIdx !== -1) {
            currentList[existingIdx] = {
              ...currentList[existingIdx],
              watch_status: targetStatus,
              score: typeof body.score === 'number' ? body.score : currentList[existingIdx].score,
              progress: typeof body.progress === 'number' ? body.progress : currentList[existingIdx].progress,
              repeat: typeof body.repeat === 'number' ? body.repeat : currentList[existingIdx].repeat,
              notes: typeof body.notes === 'string' ? body.notes : currentList[existingIdx].notes,
              updated_at: nowIso
            };
            updatedItem = currentList[existingIdx];
          } else {
            updatedItem = {
              anime_id: aId,
              anime_info: body.anime_info || { id: aId },
              watch_status: targetStatus,
              score: Number(body.score || 0),
              progress: Number(body.progress || 0),
              repeat: Number(body.repeat || 0),
              notes: body.notes || '',
              custom_lists: [],
              is_private: false,
              hidden_from_status_lists: false,
              created_at: nowIso,
              updated_at: nowIso
            };
            currentList.unshift(updatedItem);
          }

          localStorage.setItem(WL_CACHE_KEY, JSON.stringify(currentList));
          localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(currentList));
          window.dispatchEvent(new CustomEvent('animetsu_watchlist_update'));

          // If user has AniList token, sync directly with AniList via GraphQL mutation (Gojo Live style)
          if (auth.token) {
            const mutation = `
              mutation ($mediaId: Int, $status: MediaListStatus, $score: Float, $progress: Int, $repeat: Int, $notes: String) {
                SaveMediaListEntry (mediaId: $mediaId, status: $status, score: $score, progress: $progress, repeat: $repeat, notes: $notes) {
                  id
                  mediaId
                  status
                  progress
                  score
                }
              }
            `;
            const variables = {
              mediaId: Number(aId),
              status: alStatus
            };
            if (typeof body.score === 'number') variables.score = body.score;
            if (typeof body.progress === 'number') variables.progress = body.progress;
            if (typeof body.repeat === 'number') variables.repeat = body.repeat;
            if (typeof body.notes === 'string') variables.notes = body.notes;

            try {
              console.log(`🚀 [AniList Sync] Direct SaveMediaListEntry: mediaId ${aId} -> ${alStatus}...`);
              const alRes = await originalFetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'Authorization': 'Bearer ' + auth.token
                },
                body: JSON.stringify({ query: mutation, variables })
              });
              const resData = await alRes.json();
              if (resData?.data?.SaveMediaListEntry?.id && updatedItem) {
                updatedItem.id = resData.data.SaveMediaListEntry.id;
                localStorage.setItem(WL_CACHE_KEY, JSON.stringify(currentList));
                localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(currentList));
                console.log('✅ [AniList Sync] Instant save OK:', resData.data.SaveMediaListEntry);
              } else if (resData?.errors) {
                console.warn('⚠️ [AniList Sync] AniList returned error:', resData.errors);
              }
            } catch (e) {
              console.warn('[client_engine] AniList SaveMediaListEntry mutation error:', e);
            }
          }

          return { data: { success: true, item: updatedItem }, status: 200, statusText: 'OK', headers: {}, config };
        } catch (err) {
          console.error('[client_engine] POST watchlist error:', err);
          return { data: { success: false }, status: 500, statusText: 'Error', headers: {}, config };
        }
      }

      // 4. DELETE /watchlist/:anime_id (Remove from watchlist)
      if (method === 'DELETE') {
        try {
          const parts = url.split('/watchlist/')[1]?.split('?')[0];
          const aId = parts ? String(parts) : '';
          const auth = getAniListAuth();

          let currentList = [];
          try {
            currentList = JSON.parse(localStorage.getItem(WL_CACHE_KEY) || localStorage.getItem(WL_LOCAL_KEY) || '[]');
          } catch {}

          if (aId) {
            const targetEntry = currentList.find(x => String(x.anime_id || x.id) === aId);
            currentList = currentList.filter(x => String(x.anime_id || x.id) !== aId);
            localStorage.setItem(WL_CACHE_KEY, JSON.stringify(currentList));
            localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(currentList));
            window.dispatchEvent(new CustomEvent('animetsu_watchlist_update'));

            // If AniList token, delete on AniList
            if (auth.token) {
              try {
                let entryId = targetEntry?.id;
                if (!entryId) {
                  const checkRes = await originalFetch('https://graphql.anilist.co', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Accept': 'application/json',
                      'Authorization': 'Bearer ' + auth.token
                    },
                    body: JSON.stringify({
                      query: `query ($mediaId: Int) { Media (id: $mediaId) { mediaListEntry { id } } }`,
                      variables: { mediaId: Number(aId) }
                    })
                  });
                  const checkData = await checkRes.json();
                  entryId = checkData?.data?.Media?.mediaListEntry?.id;
                }

                if (entryId) {
                  await originalFetch('https://graphql.anilist.co', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Accept': 'application/json',
                      'Authorization': 'Bearer ' + auth.token
                    },
                    body: JSON.stringify({
                      query: `mutation ($id: Int) { DeleteMediaListEntry (id: $id) { deleted } }`,
                      variables: { id: Number(entryId) }
                    })
                  });
                  console.log('🗑️ [AniList Sync] Deleted entry from AniList successfully.');
                }
              } catch (delErr) {
                console.warn('[client_engine] AniList delete error:', delErr);
              }
            }
          } else {
            // Clear all
            localStorage.removeItem(WL_CACHE_KEY);
            localStorage.removeItem(WL_LOCAL_KEY);
            window.dispatchEvent(new CustomEvent('animetsu_watchlist_update'));
          }

          return { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config };
        } catch (err) {
          return { data: { success: false }, status: 500, statusText: 'Error', headers: {}, config };
        }
      }
    }

    // 0b. Direct Client-Side GIF Engine (Zero Cloudflare Worker calls)
    if (url.includes('gif')) {
      let q = '';
      const qMatch = url.match(/[?&]q=([^&]+)/) || (config.params && config.params.q ? [null, config.params.q] : null);
      if (qMatch && qMatch[1]) {
        try { q = decodeURIComponent(qMatch[1]).trim(); } catch { q = qMatch[1].trim(); }
      }

      if (q) {
        try {
          const gUrl = `https://api.giphy.com/v1/gifs/search?api_key=sXpGFDGZs0Dv1mmNFvYaGUvYwKX0PWIh&q=${encodeURIComponent(q)}&limit=30&rating=g`;
          const gRes = await originalFetch(gUrl);
          if (gRes.ok) {
            const gData = await gRes.json();
            if (Array.isArray(gData.data) && gData.data.length > 0) {
              const list = gData.data.map(i => ({
                url: i.images?.fixed_height?.url || i.images?.downsized_medium?.url || i.images?.original?.url
              })).filter(g => Boolean(g.url));
              if (list.length > 0) {
                return { data: list, status: 200, statusText: 'OK', headers: {}, config };
              }
            }
          }
        } catch {}

        try {
          const nRes = await originalFetch(`https://nekos.best/api/v2/search?query=${encodeURIComponent(q)}&type=2`);
          if (nRes.ok) {
            const nData = await nRes.json();
            if (Array.isArray(nData.results) && nData.results.length > 0) {
              const list = nData.results.map(r => ({ url: r.url }));
              return { data: list, status: 200, statusText: 'OK', headers: {}, config };
            }
          }
        } catch {}
      }

      return {
        data: [
          { url: 'https://nekos.best/api/v2/happy/825bada1-4217-46bb-ae3b-7fbdf0a642c5.gif' },
          { url: 'https://nekos.best/api/v2/happy/b68894f2-aa04-4c3c-8fcb-239f4bdf46a8.gif' },
          { url: 'https://nekos.best/api/v2/dance/4b43019f-b9e4-4478-97d9-5db62dd05578.gif' },
          { url: 'https://nekos.best/api/v2/dance/2cc51c2d-745c-4e6e-866d-80d01f31712e.gif' },
          { url: 'https://nekos.best/api/v2/laugh/a518cefd-6c3b-4473-a241-76db169ee5a7.gif' },
          { url: 'https://nekos.best/api/v2/smug/b3c973a2-5ef4-4407-b131-2cd1acde204d.gif' },
          { url: 'https://nekos.best/api/v2/blush/6af1ee5f-4cf0-4e2b-b7cd-c2fcc6f9b945.gif' },
          { url: 'https://nekos.best/api/v2/thumbsup/9ae4b7fc-54ad-4a71-9d01-e6f228f34d74.gif' },
          { url: 'https://nekos.best/api/v2/shocked/bf8e219c-f258-4ee5-985f-3f95cc246f1b.gif' },
          { url: 'https://nekos.best/api/v2/cry/c61a623b-7637-43dd-a40a-c430d3aaed58.gif' }
        ],
        status: 200,
        statusText: 'OK',
        headers: {},
        config
      };
    }

    // 0c. Backend features: Threads (Comments) & Reactions
    const isBackendApi = url.includes('threads') || 
                          url.includes('reaction') || 
                          url.includes('/user/devices') || 
                          url.includes('/user/sign-out-all') || 
                          url.includes('/report');

    if (isBackendApi) {
      const sessId = localStorage.getItem('animetsu_sess') || '';
      let curUserId = '';
      try {
        const uStr = localStorage.getItem('animetsu_user');
        if (uStr) curUserId = JSON.parse(uStr)?.id || '';
      } catch {}

      const headers = { 'Content-Type': 'application/json' };
      if (sessId) headers['Authorization'] = `Bearer ${sessId}`;
      if (curUserId) headers['X-User-Id'] = curUserId;

      // Local Persistent Reaction Store (Guarantees like state never disappears on reload)
      const getLocalReactions = () => {
        try { return JSON.parse(localStorage.getItem('animetsu_user_reactions') || '{}'); } catch { return {}; }
      };
      const setLocalReaction = (targetId, rxType) => {
        try {
          const store = getLocalReactions();
          if (rxType === 'none' || !rxType) {
            delete store[String(targetId)];
          } else {
            store[String(targetId)] = rxType;
          }
          localStorage.setItem('animetsu_user_reactions', JSON.stringify(store));
        } catch {}
      };

      try {
        const fetchOpts = { method, headers };
        let reqData = config.data;
        if (typeof reqData === 'string') {
          try { reqData = JSON.parse(reqData); } catch {}
        }
        if (!reqData && config.body) {
          reqData = typeof config.body === 'string' ? JSON.parse(config.body) : config.body;
        }
        reqData = reqData || {};

        if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
          if (url.includes('threads') || url.includes('reaction')) {
            try {
              const uStr = localStorage.getItem('animetsu_user');
              if (uStr) {
                const u = JSON.parse(uStr);
                reqData.user = u;
                reqData.user_id = u.id;
              }
            } catch {}

            if (url.includes('reaction') && reqData.id) {
              setLocalReaction(reqData.id, reqData.reaction || 'none');
            }
          }
          fetchOpts.body = JSON.stringify(reqData);
        }

        // =========================================================================
        // CANONICAL URL NORMALIZATION
        // Handles: "threads/recent", "/threads/recent", "/v2/api/threads/recent", etc.
        // =========================================================================
        let normUrl = url;
        if (normUrl.startsWith('http://') || normUrl.startsWith('https://')) {
          try { const p = new URL(normUrl); normUrl = p.pathname + p.search; } catch {}
        }
        if (!normUrl.startsWith('/')) {
          normUrl = '/' + normUrl;
        }
        normUrl = normUrl.replace(/^\/v2\/api/, '');

        // Supabase configuration
        const SUPABASE_URL = 'https://sdiudutweiotvhwpmyis.supabase.co';
        const SUPABASE_KEY = 'sb_publishable_rulrCMOcT0vTPP1XsBS4sQ_dZZihNex';
        const sbHeaders = {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        };

        // Client-side Memory Cache
        if (typeof globalThis.__client_api_cache === 'undefined') {
          globalThis.__client_api_cache = new Map();
        }
        const apiCache = globalThis.__client_api_cache;
        const cacheTTL = normUrl.includes('reaction') ? 60000 : 30000;

        // --- 1. REACTION POST (OPTIMISTIC + SUPABASE SYNC) ---
        if (method === 'POST' && normUrl.startsWith('/reaction')) {
          const targetId = String(reqData.id || '');
          const targetType = String(reqData.type || 'thread');
          const rxType = String(reqData.reaction || 'none');
          const curUid = curUserId || 'usr_local_guest';

          // Immediate local storage persistence
          setLocalReaction(targetId, rxType);

          // Update memory cache in-place for active threads & reactions
          if (targetId) {
            for (const [k, v] of apiCache.entries()) {
              if (k.includes('threads') && v?.data?.results && Array.isArray(v.data.results)) {
                const updatedResults = v.data.results.map(t => {
                  if (String(t.id) === targetId) {
                    let likes = t.likes || 0;
                    if (t.reaction === 'like' && rxType !== 'like') likes = Math.max(likes - 1, 0);
                    if (t.reaction !== 'like' && rxType === 'like') likes += 1;
                    return { ...t, likes, reaction: rxType };
                  }
                  return t;
                });
                apiCache.set(k, { data: { ...v.data, results: updatedResults }, time: v.time });
              }
            }
            const rxCacheKey = `sb_rx_${targetId}_${targetType}`;
            if (apiCache.has(rxCacheKey)) {
              const cur = apiCache.get(rxCacheKey).data || {};
              let likes = cur.likes || 0;
              if (cur.reaction === 'like' && rxType !== 'like') likes = Math.max(likes - 1, 0);
              if (cur.reaction !== 'like' && rxType === 'like') likes += 1;
              apiCache.set(rxCacheKey, { data: { likes, dislikes: 0, reaction: rxType }, time: Date.now() });
            }
          }

          // Background Supabase Sync
          (async () => {
            try {
              const rxId = `rx_${curUid}_${targetId}`;
              if (rxType === 'none') {
                await originalFetch(`${SUPABASE_URL}/rest/v1/reactions?user_id=eq.${encodeURIComponent(curUid)}&target_id=eq.${encodeURIComponent(targetId)}`, {
                  method: 'DELETE',
                  headers: sbHeaders
                });
              } else {
                await originalFetch(`${SUPABASE_URL}/rest/v1/reactions`, {
                  method: 'POST',
                  headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
                  body: JSON.stringify({
                    id: rxId,
                    user_id: curUid,
                    target_id: targetId,
                    target_type: targetType,
                    reaction_type: rxType
                  })
                });
              }

              if (targetType === 'thread') {
                const cntRes = await originalFetch(`${SUPABASE_URL}/rest/v1/reactions?target_id=eq.${encodeURIComponent(targetId)}&reaction_type=eq.like&select=id`, {
                  method: 'HEAD',
                  headers: { ...sbHeaders, 'Prefer': 'count=exact' }
                });
                const cntH = cntRes.headers.get('content-range');
                const likesCnt = parseInt(cntH?.split('/')[1] || '0', 10);
                if (!isNaN(likesCnt)) {
                  await originalFetch(`${SUPABASE_URL}/rest/v1/threads?id=eq.${encodeURIComponent(targetId)}`, {
                    method: 'PATCH',
                    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
                    body: JSON.stringify({ likes: likesCnt })
                  });
                }
              }
            } catch (sbErr) {
              console.warn('[Supabase reaction error]:', sbErr);
            }
          })();

          return { data: { success: true, reaction: rxType, user_id: curUid }, status: 200, statusText: 'OK', headers: {}, config };
        }

        // --- 2. GET REACTION: GET /reaction/:target_id/:target_type ---
        if (method === 'GET' && normUrl.startsWith('/reaction')) {
          const parts = normUrl.replace('/reaction/', '').split('?')[0].split('/');
          const targetId = decodeURIComponent(parts[0] || '');
          const targetType = parts[1] || 'episode';
          const cacheKey = `sb_rx_${targetId}_${targetType}`;

          if (apiCache.has(cacheKey) && (Date.now() - apiCache.get(cacheKey).time < 30000)) {
            const cached = apiCache.get(cacheKey).data;
            const localRx = getLocalReactions()[targetId];
            return { data: { ...cached, reaction: localRx !== undefined ? localRx : cached.reaction }, status: 200, statusText: 'OK', headers: {}, config };
          }

          try {
            const cntRes = await originalFetch(`${SUPABASE_URL}/rest/v1/reactions?target_id=eq.${encodeURIComponent(targetId)}&reaction_type=eq.like&select=id`, {
              method: 'HEAD',
              headers: { ...sbHeaders, 'Prefer': 'count=exact' }
            });
            const cntH = cntRes.headers.get('content-range');
            const likesCount = parseInt(cntH?.split('/')[1] || '0', 10) || 0;

            let userRx = getLocalReactions()[targetId] || 'none';
            if (userRx === 'none' && curUserId) {
              const uRes = await originalFetch(`${SUPABASE_URL}/rest/v1/reactions?target_id=eq.${encodeURIComponent(targetId)}&user_id=eq.${encodeURIComponent(curUserId)}&select=reaction_type`, {
                headers: sbHeaders
              });
              const uRows = await uRes.json().catch(() => []);
              if (uRows && uRows[0]?.reaction_type) {
                userRx = uRows[0].reaction_type;
                setLocalReaction(targetId, userRx);
              }
            }

            const rxData = { likes: likesCount, dislikes: 0, reaction: userRx };
            apiCache.set(cacheKey, { data: rxData, time: Date.now() });
            return { data: rxData, status: 200, statusText: 'OK', headers: {}, config };
          } catch {
            const localRx = getLocalReactions()[targetId] || 'none';
            return { data: { likes: localRx === 'like' ? 1 : 0, dislikes: 0, reaction: localRx }, status: 200, statusText: 'OK', headers: {}, config };
          }
        }

        // --- 3. RECENT THREADS: GET /threads/recent ---
        if (normUrl.startsWith('/threads/recent')) {
          const cacheKey = 'sb_recent_threads';
          if (apiCache.has(cacheKey) && (Date.now() - apiCache.get(cacheKey).time < 60000)) {
            return { data: apiCache.get(cacheKey).data, status: 200, statusText: 'OK', headers: {}, config };
          }

          try {
            const sbRes = await originalFetch(
              `${SUPABASE_URL}/rest/v1/threads?parent_id=is.null&select=*,user:users(*)&order=created_at.desc&limit=20`,
              { headers: sbHeaders }
            );
            const list = await sbRes.json().catch(() => []);
            const titleMap = {
              '210031': { english: 'You and I Are Polar Opposites', romaji: 'Seihantai na Kimi to Boku', user_preferred: 'You and I Are Polar Opposites' },
              '63832': { english: 'You and I Are Polar Opposites', romaji: 'Seihantai na Kimi to Boku', user_preferred: 'You and I Are Polar Opposites' },
              '158926': { english: "Ron Kamonohashi's Forbidden Deductions", romaji: 'Kamonohashi Ron no Kindan Suiri', user_preferred: "Ron Kamonohashi's Forbidden Deductions" },
              '19603': { english: 'Fate/stay night: Unlimited Blade Works', romaji: 'Fate/stay night: Unlimited Blade Works', user_preferred: 'Fate/stay night: Unlimited Blade Works' },
              '19': { english: 'Monster', romaji: 'MONSTER', user_preferred: 'Monster' },
              '178789': { english: 'Mushoku Tensei: Jobless Reincarnation Season 3', romaji: 'Mushoku Tensei III: Isekai Ittara Honki Dasu', user_preferred: 'Mushoku Tensei: Jobless Reincarnation Season 3' },
              '182205': { english: 'That Time I Got Reincarnated as a Slime Season 4', romaji: 'Tensei Shitara Slime Datta Ken 4th Season', user_preferred: 'That Time I Got Reincarnated as a Slime Season 4' },
              '151807': { english: 'Solo Leveling', romaji: 'Ore dake Level Up na Ken', user_preferred: 'Solo Leveling' },
              '154587': { english: "Frieren: Beyond Journey's End", romaji: 'Sousou no Frieren', user_preferred: "Frieren: Beyond Journey's End" },
              '145064': { english: 'Jujutsu Kaisen Season 2', romaji: 'Jujutsu Kaisen 2nd Season', user_preferred: 'Jujutsu Kaisen Season 2' },
              '21': { english: 'One Piece', romaji: 'ONE PIECE', user_preferred: 'One Piece' },
              'dr-stone': { english: 'Dr. Stone', romaji: 'Dr. STONE', user_preferred: 'Dr. Stone' },
              '105333': { english: 'Dr. Stone', romaji: 'Dr. STONE', user_preferred: 'Dr. Stone' },
              '16498': { english: 'Attack on Titan', romaji: 'Shingeki no Kyojin', user_preferred: 'Attack on Titan' },
              '1735': { english: 'Naruto: Shippuden', romaji: 'Naruto: Shippuuden', user_preferred: 'Naruto: Shippuden' },
              '20': { english: 'Naruto', romaji: 'Naruto', user_preferred: 'Naruto' }
            };

            // Dynamically resolve unknown anime titles asynchronously via cache / AniList / AniZip
            const unknownIds = [...new Set((list || []).map(r => String(r.watch_id || '')).filter(id => id && !titleMap[id]))];
            if (unknownIds.length > 0) {
              await Promise.all(unknownIds.slice(0, 10).map(async (id) => {
                try {
                  const cached = getCachedItem(`animetsu_info_${id}`, 'local');
                  if (cached?.title) {
                    titleMap[id] = {
                      english: cached.title.english || cached.title.romaji || cached.title.user_preferred || 'Anime',
                      romaji: cached.title.romaji || cached.title.english || 'Anime',
                      user_preferred: cached.title.user_preferred || cached.title.english || cached.title.romaji || 'Anime'
                    };
                    return;
                  }
                  const info = await getClientAnimeInfo(id);
                  if (info?.title) {
                    titleMap[id] = {
                      english: info.title.english || info.title.romaji || info.title.user_preferred || 'Anime',
                      romaji: info.title.romaji || info.title.english || 'Anime',
                      user_preferred: info.title.user_preferred || info.title.english || info.title.romaji || 'Anime'
                    };
                  }
                } catch {}
              }));
            }

            const formatted = (list || []).map(r => {
              let tObj = titleMap[String(r.watch_id)];
              if (!tObj) {
                try {
                  const cachedInfo = JSON.parse(localStorage.getItem(`animetsu_info_${r.watch_id}`) || localStorage.getItem(`info_${r.watch_id}`) || '{}');
                  if (cachedInfo?.title) tObj = cachedInfo.title;
                } catch {}
              }
              if (!tObj) {
                const isNum = /^\d+$/.test(String(r.watch_id || ''));
                if (isNum) {
                  tObj = { english: 'Anime', romaji: 'Anime', user_preferred: 'Anime' };
                } else {
                  const wds = String(r.watch_id || '').replace(/-/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                  tObj = { english: wds || 'Anime', romaji: wds || 'Anime', user_preferred: wds || 'Anime' };
                }
              }
              const u = r.user || {};
              return {
                id: r.id,
                anime_id: r.watch_id,
                watch_id: r.watch_id,
                ep_num: r.ep_num,
                parent_id: r.parent_id,
                reply_to: r.reply_to,
                title: tObj,
                spoiler: Boolean(r.spoiler),
                value: { text: r.text || '', gif: r.gif_url || '' },
                likes: r.likes || 0,
                dislikes: 0,
                reaction: 'none',
                replies: 0,
                created_at: r.created_at,
                updated_at: r.created_at,
                user: {
                  id: u.id || r.user_id || 'usr_guest',
                  user_id: u.id || r.user_id || 'usr_guest',
                  name: u.display_name || u.username || 'User',
                  display_name: u.display_name || u.username || 'User',
                  username: u.username || 'User',
                  avatar: u.avatar || 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png',
                  anilist: u.username || ''
                }
              };
            });
            apiCache.set(cacheKey, { data: formatted, time: Date.now() });
            return { data: formatted, status: 200, statusText: 'OK', headers: {}, config };
          } catch {
            return { data: [], status: 200, statusText: 'OK', headers: {}, config };
          }
        }

        // --- 4. THREADS COUNT: GET /threads/count/:watch_id/:ep_num ---
        if (normUrl.startsWith('/threads/count/')) {
          const parts = normUrl.replace('/threads/count/', '').split('?')[0].split('/');
          const watchId = decodeURIComponent(parts[0] || '');
          const epNum = parseInt(parts[1] || '1', 10);
          const cacheKey = `sb_count_${watchId}_${epNum}`;

          if (apiCache.has(cacheKey) && (Date.now() - apiCache.get(cacheKey).time < cacheTTL)) {
            return { data: apiCache.get(cacheKey).data, status: 200, statusText: 'OK', headers: {}, config };
          }

          try {
            const cntRes = await originalFetch(`${SUPABASE_URL}/rest/v1/threads?watch_id=eq.${encodeURIComponent(watchId)}&ep_num=eq.${epNum}&select=id`, {
              method: 'HEAD',
              headers: { ...sbHeaders, 'Prefer': 'count=exact' }
            });
            const cntH = cntRes.headers.get('content-range');
            const total = parseInt(cntH?.split('/')[1] || '0', 10);
            const resData = { count: isNaN(total) ? 0 : total };
            apiCache.set(cacheKey, { data: resData, time: Date.now() });
            return { data: resData, status: 200, statusText: 'OK', headers: {}, config };
          } catch {
            return { data: { count: 0 }, status: 200, statusText: 'OK', headers: {}, config };
          }
        }

        // --- 5. REPLIES: GET /threads/replies/:parent_id ---
        if (normUrl.startsWith('/threads/replies/')) {
          const parentId = decodeURIComponent(normUrl.replace('/threads/replies/', '').split('?')[0] || '');
          const cacheKey = `sb_replies_${parentId}`;

          if (method === 'GET' && apiCache.has(cacheKey) && (Date.now() - apiCache.get(cacheKey).time < cacheTTL)) {
            return { data: apiCache.get(cacheKey).data, status: 200, statusText: 'OK', headers: {}, config };
          }

          try {
            const sbRes = await originalFetch(
              `${SUPABASE_URL}/rest/v1/threads?parent_id=eq.${encodeURIComponent(parentId)}&select=*,user:users(*)&order=created_at.asc`,
              { headers: sbHeaders }
            );
            const list = await sbRes.json().catch(() => []);
            const localStore = getLocalReactions();
            const formatted = (list || []).map(r => {
              const u = r.user || {};
              const localRx = localStore[r.id];
              return {
                id: r.id,
                watch_id: r.watch_id,
                anime_id: r.watch_id,
                ep_num: r.ep_num,
                parent_id: r.parent_id,
                reply_to: r.reply_to,
                spoiler: Boolean(r.spoiler),
                value: { text: r.text || '', gif: r.gif_url || '' },
                likes: r.likes || 0,
                dislikes: 0,
                reaction: localRx || 'none',
                replies: 0,
                replies_count: 0,
                created_at: r.created_at,
                updated_at: r.created_at,
                user: {
                  id: u.id || r.user_id || 'usr_guest',
                  user_id: u.id || r.user_id || 'usr_guest',
                  name: u.display_name || u.username || 'User',
                  display_name: u.display_name || u.username || 'User',
                  username: u.username || 'User',
                  avatar: u.avatar || 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png',
                  anilist: u.username || ''
                }
              };
            });
            const resObj = { results: formatted, has_more: false };
            apiCache.set(cacheKey, { data: resObj, time: Date.now() });
            return { data: resObj, status: 200, statusText: 'OK', headers: {}, config };
          } catch {
            return { data: { results: [], has_more: false }, status: 200, statusText: 'OK', headers: {}, config };
          }
        }

        // --- 6. EDIT THREAD: POST /threads/edit ---
        if (normUrl.startsWith('/threads/edit') && method === 'POST') {
          if (reqData.id) {
            const patchObj = {};
            if (reqData.value?.text !== undefined) patchObj.text = reqData.value.text;
            if (reqData.value?.gif !== undefined) patchObj.gif_url = reqData.value.gif;
            if (reqData.text !== undefined) patchObj.text = reqData.text;
            if (reqData.spoiler !== undefined) patchObj.spoiler = Boolean(reqData.spoiler);
            originalFetch(`${SUPABASE_URL}/rest/v1/threads?id=eq.${encodeURIComponent(reqData.id)}`, {
              method: 'PATCH',
              headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
              body: JSON.stringify(patchObj)
            }).catch(() => {});
          }
          return { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config };
        }

        // --- 7. DELETE THREAD: DELETE /threads/:id ---
        if (method === 'DELETE' && normUrl.startsWith('/threads/')) {
          const threadId = decodeURIComponent(normUrl.replace('/threads/', '').split('?')[0] || '');
          if (threadId) {
            originalFetch(`${SUPABASE_URL}/rest/v1/threads?id=eq.${encodeURIComponent(threadId)}`, {
              method: 'DELETE',
              headers: sbHeaders
            }).catch(() => {});
          }
          return { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config };
        }

        // --- 8. POST NEW THREAD (OR REPLY): POST /threads ---
        if (method === 'POST' && normUrl.startsWith('/threads')) {
          const watchId = String(reqData.anime_id || reqData.watch_id || '');
          const epNum = Number(reqData.ep_num || 1);
          const rawText = reqData.value?.text || '';
          const gifUrl = reqData.value?.gif || '';
          const isSpoiler = reqData.spoiler ? true : false;
          const targetUser = reqData.user || {
            id: curUserId || 'usr_local_guest',
            username: 'Guest',
            display_name: 'Guest',
            avatar: 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png'
          };
          const effectiveUserId = targetUser.id || curUserId || 'usr_local_guest';

          // Cooldown check: 15 seconds
          const lastPost = parseInt(localStorage.getItem('animetsu_last_post_ts') || '0', 10);
          if (Date.now() - lastPost < 15000) {
            const wait = Math.ceil((15000 - (Date.now() - lastPost)) / 1000);
            return {
              data: { error: `Please wait ${wait}s before posting another comment.` },
              status: 429,
              statusText: 'Too Many Requests',
              headers: {},
              config
            };
          }
          localStorage.setItem('animetsu_last_post_ts', String(Date.now()));

          // Ensure user is in Supabase users table (upsert)
          originalFetch(`${SUPABASE_URL}/rest/v1/users`, {
            method: 'POST',
            headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify({
              id: effectiveUserId,
              username: targetUser.username || targetUser.name || 'User',
              display_name: targetUser.display_name || targetUser.username || 'User',
              avatar: targetUser.avatar || 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png'
            })
          }).catch(() => {});

          // Insert thread row
          const threadId = 'th_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2) + Date.now().toString(36));
          const newThreadRow = {
            id: threadId,
            watch_id: watchId,
            ep_num: epNum,
            parent_id: reqData.parent_id || null,
            reply_to: typeof reqData.reply_to === 'object' ? JSON.stringify(reqData.reply_to) : (reqData.reply_to || null),
            user_id: effectiveUserId,
            text: rawText,
            gif_url: gifUrl,
            spoiler: isSpoiler,
            likes: 0,
            dislikes: 0
          };

          await originalFetch(`${SUPABASE_URL}/rest/v1/threads`, {
            method: 'POST',
            headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
            body: JSON.stringify(newThreadRow)
          }).catch(() => {});

          // Invalidate relevant caches immediately
          apiCache.delete('sb_recent_threads');
          apiCache.delete(`sb_count_${watchId}_${epNum}`);
          apiCache.delete(`sb_threads_${watchId}_${epNum}`);
          if (reqData.parent_id) {
            apiCache.delete(`sb_replies_${reqData.parent_id}`);
          }

          const createdResponse = {
            id: threadId,
            watch_id: watchId,
            anime_id: watchId,
            ep_num: epNum,
            parent_id: reqData.parent_id || null,
            reply_to: reqData.reply_to || null,
            spoiler: isSpoiler,
            value: { text: rawText, gif: gifUrl },
            likes: 0,
            dislikes: 0,
            reaction: 'none',
            replies: 0,
            replies_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            user: {
              id: effectiveUserId,
              user_id: effectiveUserId,
              name: targetUser.display_name || targetUser.username || 'User',
              display_name: targetUser.display_name || targetUser.username || 'User',
              username: targetUser.username || 'User',
              avatar: targetUser.avatar || 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png',
              anilist: targetUser.username || ''
            }
          };

          return { data: createdResponse, status: 200, statusText: 'OK', headers: {}, config };
        }

        // --- 9. GET THREADS LIST: GET /threads/:watch_id/:ep_num ---
        if (method === 'GET' && normUrl.startsWith('/threads/')) {
          const parts = normUrl.replace('/threads/', '').split('?')[0].split('/');
          const watchId = decodeURIComponent(parts[0] || '');
          const epNum = parseInt(parts[1] || '1', 10);
          const cacheKey = `sb_threads_${watchId}_${epNum}`;

          if (apiCache.has(cacheKey) && (Date.now() - apiCache.get(cacheKey).time < cacheTTL)) {
            let cachedObj = apiCache.get(cacheKey).data;
            const localStore = getLocalReactions();
            if (cachedObj?.results && Array.isArray(cachedObj.results)) {
              cachedObj = {
                ...cachedObj,
                results: cachedObj.results.map(t => {
                  const lr = localStore[t.id];
                  return lr !== undefined ? { ...t, reaction: lr } : t;
                })
              };
            }
            return { data: cachedObj, status: 200, statusText: 'OK', headers: {}, config };
          }

          try {
            // Query all threads for this episode (up to 100) to compute reply counts
            const sbRes = await originalFetch(
              `${SUPABASE_URL}/rest/v1/threads?watch_id=eq.${encodeURIComponent(watchId)}&ep_num=eq.${epNum}&select=*,user:users(*)&order=likes.desc,created_at.desc&limit=100`,
              { headers: sbHeaders }
            );
            const allRows = await sbRes.json().catch(() => []);

            const replyCounts = {};
            for (const item of allRows) {
              if (item.parent_id) {
                replyCounts[item.parent_id] = (replyCounts[item.parent_id] || 0) + 1;
              }
            }

            const rootRows = allRows.filter(item => !item.parent_id);
            const localStore = getLocalReactions();

            const formatted = rootRows.map(r => {
              const u = r.user || {};
              const localRx = localStore[r.id];
              const repCount = replyCounts[r.id] || 0;
              return {
                id: r.id,
                watch_id: r.watch_id,
                anime_id: r.watch_id,
                ep_num: r.ep_num,
                parent_id: r.parent_id,
                reply_to: r.reply_to,
                spoiler: Boolean(r.spoiler),
                value: { text: r.text || '', gif: r.gif_url || '' },
                likes: r.likes || 0,
                dislikes: 0,
                reaction: localRx || 'none',
                replies: repCount,
                replies_count: repCount,
                created_at: r.created_at,
                updated_at: r.created_at,
                user: {
                  id: u.id || r.user_id || 'usr_guest',
                  user_id: u.id || r.user_id || 'usr_guest',
                  name: u.display_name || u.username || 'User',
                  display_name: u.display_name || u.username || 'User',
                  username: u.username || 'User',
                  avatar: u.avatar || 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png',
                  anilist: u.username || ''
                }
              };
            });
            const resObj = { results: formatted, has_more: false };
            apiCache.set(cacheKey, { data: resObj, time: Date.now() });
            return { data: resObj, status: 200, statusText: 'OK', headers: {}, config };
          } catch {
            return { data: { results: [], has_more: false }, status: 200, statusText: 'OK', headers: {}, config };
          }
        }

        // --- Fallback for non-discussion backend routes (devices, report, etc.) ---
        let backendUrl = normUrl;
        if (!backendUrl.startsWith('/v2/api')) backendUrl = '/v2/api' + backendUrl;
        try {
          const res = await originalFetch(backendUrl, fetchOpts);
          if (res.ok) {
            const json = await res.json();
            return { data: json, status: res.status, statusText: res.statusText, headers: {}, config };
          }
        } catch {}
        return { data: [], status: 200, statusText: 'OK', headers: {}, config };
      } catch (backendErr) {
        console.warn('[Supabase/Backend error]:', backendErr);
        if (url.includes('reaction')) {
          const parts = url.split('reaction')[1]?.split('?')[0]?.split('/') || [];
          const targetId = parts.filter(Boolean)[0] || '';
          const localRx = getLocalReactions()[targetId] || 'none';
          return { data: { likes: localRx === 'like' ? 1 : 0, dislikes: 0, reaction: localRx }, status: 200, statusText: 'OK', headers: {}, config };
        }
        if (url.includes('count')) return { data: { count: 0 }, status: 200, statusText: 'OK', headers: {}, config };
        return { data: { results: [], has_more: false }, status: 200, statusText: 'OK', headers: {}, config };
      }
    }

    // 0a. Recently Updated Episodes: /recent or /anime/recent
    if ((url.includes('/recent') || url.startsWith('recent') || url.includes('/anime/recent')) && !url.includes('threads')) {
      const parsedUrl = url.startsWith('http') ? url : `http://localhost${url.startsWith('/') ? '' : '/'}${url}`;
      let page = 1, perPage = 12;
      try {
        const urlObj = new URL(parsedUrl);
        page = Number(urlObj.searchParams.get('page') || 1);
        perPage = Number(urlObj.searchParams.get('per_page') || 12);
      } catch {}
      const recentData = await getClientRecent(page, perPage);
      return { data: recentData, status: 200, statusText: 'OK', headers: {}, config };
    }

    // 0r. Random Anime: /random or /anime/random
    if (url.includes('/random') || url.startsWith('random') || url.includes('/anime/random')) {
      const home = await getClientHome();
      const list = home?.trending?.length ? home.trending : (home?.popular || []);
      const item = list[Math.floor(Math.random() * (list.length || 1))] || { id: '21' };
      return { data: { id: item.id || '21' }, status: 200, statusText: 'OK', headers: {}, config };
    }

    // 0. Search & Browse: /search or /anime/search
    if ((url.includes('/search') || url.startsWith('search')) && !url.includes('gif')) {
      const parsedUrl = url.startsWith('http') ? url : `http://localhost${url.startsWith('/') ? '' : '/'}${url}`;
      let params = {};
      try {
        const urlObj = new URL(parsedUrl);
        params = {
          query: urlObj.searchParams.get('query') || config.params?.query || config.params?.search || '',
          page: urlObj.searchParams.get('page') || config.params?.page || 1,
          per_page: urlObj.searchParams.get('per_page') || config.params?.per_page || config.params?.perPage || 20,
          sort: urlObj.searchParams.get('sort') || config.params?.sort || 'POPULARITY_DESC',
          season: urlObj.searchParams.get('season') || config.params?.season || '',
          year: urlObj.searchParams.get('year') || config.params?.year || '',
          status: urlObj.searchParams.get('status') || config.params?.status || '',
          genres: urlObj.searchParams.get('genres') || config.params?.genres || '',
          format: urlObj.searchParams.get('format') || config.params?.format || '',
          tags: urlObj.searchParams.get('tags') || config.params?.tags || '',
          country: urlObj.searchParams.get('country') || config.params?.country || '',
          source: urlObj.searchParams.get('source') || config.params?.source || ''
        };
      } catch {}
      const data = await getClientSearch(params);
      return { data, status: 200, statusText: 'OK', headers: {}, config };
    }

    // 0c. Home: /home or /anime/home
    if (url.includes('/home') || url.startsWith('home') || url.includes('/anime/home')) {
      const homeData = await getClientHome();
      return { data: homeData, status: 200, statusText: 'OK', headers: {}, config };
    }

    // 0b. Schedule: /schedule or /anime/schedule
    if (url.includes('/schedule') || url.startsWith('schedule')) {
      let targetDate = null;
      try {
        const parsedUrl = url.startsWith('http') ? url : `http://localhost${url.startsWith('/') ? '' : '/'}${url}`;
        const urlObj = new URL(parsedUrl);
        const dParam = urlObj.searchParams.get('date') || config.params?.date;
        if (dParam) targetDate = new Date(dParam);
      } catch {}
      const scheduleData = await getClientSchedule(targetDate);
      return { data: scheduleData, status: 200, statusText: 'OK', headers: {}, config };
    }

    // 1. Anime Info: /anime/info/:id
    if (url.includes('/anime/info/')) {
      const parts = url.split('/');
      const animeId = parts[parts.indexOf('info') + 1]?.split('?')[0];
      if (animeId) {
        const data = await getClientAnimeInfo(animeId);
        return { data, status: 200, statusText: 'OK', headers: {}, config };
      }
    }

    // 2. Anime Episodes: /anime/eps/:id or /eps/:id
    if (url.includes('/anime/eps/') || url.includes('/eps/')) {
      const parts = url.split('/');
      const animeId = parts[parts.indexOf('eps') + 1]?.split('?')[0];
      if (animeId) {
        const data = await getClientAnimeEpisodes(animeId);
        return { data, status: 200, statusText: 'OK', headers: {}, config };
      }
    }

    // Provider Registry: Easily set enabled: false to inactivate any provider
    const STREAM_PROVIDER_REGISTRY = {
      bee: {
        id: 'bee',
        altId: 'bee',
        name: 'Bee',
        default: true,
        tip: 'Soft Sub, Multi Quality',
        enabled: true,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const track = lang === 'dub' ? 'dub' : 'sub';
          try {
            const res = await fetch(`https://api.aniclover.cc/api/watch/${encodeURIComponent(aniId)}/${track}/${encodeURIComponent(epNum)}`);
            if (res.ok) {
              const data = await res.json();
              if (data?.error || !data?.success || !data?.streamUrl) {
                return { error: data?.error || data?.message || 'No stream found on Bee', message: data?.message || 'No stream found on Bee', url: null };
              }
              const rawTracks = Array.isArray(data.subtitles) ? data.subtitles : (Array.isArray(data.tracks) ? data.tracks : []);
              const subs = rawTracks.map(s => ({
                url: s.url || s.file,
                label: s.label || s.lang || 'English',
                lang: s.label || s.lang || 'English',
                default: !!s.default || (s.label || s.lang || '').toLowerCase().includes('english')
              }));
              const skips = (data.intro || data.outro) ? {
                intro: data.intro || null,
                outro: data.outro || null
              } : null;
              return {
                isHls: true,
                type: 'hls',
                url: data.streamUrl.includes('.m3u8') ? data.streamUrl : (data.streamUrl + '&ext=.m3u8'),
                subtitles: subs,
                skips,
                referer: 'https://beta.zanora.xyz/'
              };
            }
          } catch (e) {
            console.warn('[Bee Stream Error]:', e);
          }
          return { error: `No ${track} stream found on Bee`, message: `No ${track} stream found on Bee`, url: null };
        }
      },
      piratexplay: {
        id: 'piratexplay',
        altId: 'piratex',
        name: 'PirateX',
        default: false,
        tip: '⚡ Vidmoly HLS, Blakite MP4',
        enabled: false,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const track = lang === 'dub' ? 'dub' : 'sub';
          try {
            let res = null;
            try {
              res = await fetch(`https://api.animetsu.site/watch/piratexplay/${encodeURIComponent(aniId)}/${track}/piratexplay-${epNum}`);
            } catch (e) {}
            if (!res || !res.ok) {
              res = await fetch(`https://api.animetsu.site/watch/piratexplay/${encodeURIComponent(aniId)}/multi/piratexplay-${epNum}`);
            }
            if (res && res.ok) {
              const data = await res.json();
              if (data?.error) {
                return { error: data.error, message: data.error, url: null };
              }
              const streams = Array.isArray(data?.streams) ? data.streams : [];

              // 1st Preference: Vidmoly direct HLS (m3u8)
              const vidmolyStream = streams.find(s => 
                String(s.server || '').toLowerCase().includes('vidmoly') && 
                (s.type === 'hls' || String(s.url || '').includes('.m3u8'))
              );

              if (vidmolyStream && vidmolyStream.url) {
                return {
                  isHls: true,
                  type: 'hls',
                  url: vidmolyStream.url,
                  subtitles: [],
                  referer: vidmolyStream.referer || 'https://vidmoly.net/'
                };
              }

              // 2nd Preference: Blakite direct MP4 (multi-quality)
              const blakiteStreams = streams.filter(s => 
                String(s.server || '').toLowerCase().includes('blakite') && 
                (s.type === 'mp4' || String(s.url || '').includes('.mp4'))
              );

              if (blakiteStreams.length > 0) {
                const sources = blakiteStreams.map(s => ({
                  url: s.url,
                  quality: s.quality || '1080p',
                  type: 'video/mp4',
                  old_hls: false
                }));

                return {
                  isHls: false,
                  type: 'mp4',
                  url: sources[0].url,
                  sources,
                  subtitles: [],
                  referer: blakiteStreams[0].referer || 'https://hugh.cdn.rumble.cloud/'
                };
              }

              // Fallback to other direct HLS or MP4 stream if neither Vidmoly nor Blakite is present
              const otherHls = streams.find(s => (s.type === 'hls' || String(s.url || '').includes('.m3u8')) && s.url);
              if (otherHls) {
                return {
                  isHls: true,
                  type: 'hls',
                  url: otherHls.url,
                  subtitles: [],
                  referer: otherHls.referer || 'https://api.animetsu.site/'
                };
              }

              const otherMp4 = streams.find(s => (s.type === 'mp4' || String(s.url || '').includes('.mp4')) && s.url);
              if (otherMp4) {
                return {
                  isHls: false,
                  type: 'mp4',
                  url: otherMp4.url,
                  subtitles: [],
                  referer: otherMp4.referer || 'https://api.animetsu.site/'
                };
              }

              if (data.stream_url) {
                const isHls = data.stream_type === 'hls' || data.stream_url.includes('.m3u8');
                return {
                  isHls,
                  type: isHls ? 'hls' : 'mp4',
                  url: data.stream_url,
                  subtitles: [],
                  referer: 'https://api.animetsu.site/'
                };
              }
            }
          } catch (e) {
            console.warn('[PirateXPlay Stream Error]:', e);
          }
          return { error: `No stream found on PirateX`, message: `No stream found on PirateX`, url: null };
        }
      },
      cloud: {
        id: 'cloud',
        altId: 'reanime',
        name: 'Cloud',
        default: false,
        tip: 'Soft Sub, Multi, DL, No Ads',
        enabled: true,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const query = 'autoPlay=true&autoplay=true';
          let data = null;
          const flixTargetUrl = `https://reanime.to/api/flix/${encodeURIComponent(aniId)}/${epNum}`;

          // 1. Try Anivexa Worker Proxy (CORS-enabled for Client-Side)
          try {
            const proxyRes = await fetch(`https://anivexa-proxy.apiplay.workers.dev/?url=${encodeURIComponent(flixTargetUrl)}`);
            if (proxyRes.ok) data = await proxyRes.json();
          } catch (e) {}

          // 2. Try local proxy fallback
          if (!data || !Array.isArray(data?.servers) || !data.servers.length) {
            try {
              const localRes = await fetch(`/api/flix/${encodeURIComponent(aniId)}/${epNum}`);
              if (localRes.ok) data = await localRes.json();
            } catch (e) {}
          }

          // 3. Try direct fetch fallback
          if (!data || !Array.isArray(data?.servers) || !data.servers.length) {
            try {
              const directRes = await fetch(flixTargetUrl);
              if (directRes.ok) data = await directRes.json();
            } catch (e) {}
          }

          try {
            if (data) {
              const servers = Array.isArray(data?.servers) ? data.servers : [];
              const hasDub = servers.some(s => s.dataType?.toLowerCase() === 'dub');

              if (lang === 'dub' && !hasDub) {
                return {
                  error: 'DUB_NOT_AVAILABLE',
                  message: 'English DUB is not available for this episode on Cloud server.',
                  url: null
                };
              }

              const hd1 = servers.find(s => s.dataType?.toLowerCase() === lang && (s.serverName === 'HD-1' || String(s.serverName || '').includes('1')));
              const target = hd1 || servers.find(s => s.dataType?.toLowerCase() === lang) || 
                (lang === 'sub' ? (servers.find(s => s.serverName === 'HD-1') || servers.find(s => s.dataType?.toLowerCase() === 'sub') || servers[0]) : null);

              if (target?.dataLink) {
                let startAt = 0;
                try {
                  const raw = localStorage.getItem('user-watch_history') || localStorage.getItem('guest-watch_history');
                  if (raw) {
                    const list = JSON.parse(raw);
                    const found = list.find(x => String(x.anime_id || x.id) === String(animeId));
                    if (found) {
                      if (Number(found.ep_num) === Number(epNum) && found.progress) {
                        startAt = Number(found.progress) || 0;
                      } else if (found.eps?.[String(epNum)]?.progress) {
                        startAt = Number(found.eps[String(epNum)].progress) || 0;
                      }
                    }
                  }
                } catch (e) {}

                let skipIntro = false;
                let skipOutro = false;
                try {
                  const cfg = JSON.parse(localStorage.getItem('animetsu-settings') || localStorage.getItem('guest-settings') || '{}');
                  if (cfg.auto_skip_intro || cfg.autoSkip) skipIntro = true;
                  if (cfg.auto_skip_outro) skipOutro = true;
                } catch (e) {}

                const u = new URL(target.dataLink);
                if (!u.searchParams.has('v')) { u.searchParams.set('v', '1'); }
                u.searchParams.set('autoPlay', 'true');
                u.searchParams.set('autoplay', 'true');
                u.searchParams.set('skI', skipIntro ? 'true' : 'false');
                u.searchParams.set('skO', skipOutro ? 'true' : 'false');
                if (startAt > 0 && isFinite(startAt)) {
                  u.searchParams.set('start_at', String(Math.round(startAt)));
                }
                u.searchParams.set('project_r_ts', String(Date.now()));
                return {
                  url: u.toString(),
                  referer: 'https://reanime.to/'
                };
              }
            }
          } catch (e) {
            console.warn('[Cloud Flix Error]:', e);
          }

          if (lang === 'dub') {
            return {
              error: 'DUB_NOT_AVAILABLE',
              message: 'English DUB is not available for this episode on Cloud server.',
              url: null
            };
          }

          return {
            error: `No ${lang} stream found on Cloud`,
            message: `No ${lang} stream found on Cloud`,
            url: null
          };
        }
      },
      animegg: {
        id: 'animegg',
        altId: 'animegg',
        name: 'GG',
        default: false,
        tip: 'Hard Sub, Multi Quality',
        enabled: true,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const track = lang === 'dub' ? 'dub' : 'sub';
          try {
            const res = await fetch(`https://api.animetsu.site/watch/animegg/${encodeURIComponent(aniId)}/${track}/animegg-${epNum}`);
            if (res.ok) {
              const data = await res.json();
              if (data?.error) {
                return { error: data.error, message: data.error, url: null };
              }
              const proxyWorker = (u) => {
                if (!u) return '';
                if (u.startsWith('/')) return 'https://api.animetsu.site' + u;
                if (u.includes('api.animetsu.site/proxy')) return u;
                return 'https://api.animetsu.site/proxy?url=' + encodeURIComponent(u) + '&ref=' + encodeURIComponent('https://www.animegg.org/');
              };
              let rawStream = data.proxied_stream_url || data.stream_url || (Array.isArray(data.streams) ? (data.streams.find(s => s.type === 'mp4' && s.url)?.url || data.streams[0]?.url) : null);
              if (rawStream && rawStream.startsWith('/')) {
                rawStream = 'https://api.animetsu.site' + rawStream;
              }
              if (rawStream && rawStream.startsWith('http://ad-anivexa-api')) {
                rawStream = rawStream.replace(/^http:\/\//i, 'https://');
              }
              const proxied = proxyWorker(rawStream);
              const sources = (data.streams || [])
                .filter(s => s.type === 'mp4' && s.url)
                .map(s => {
                  let sUrl = s.proxied_url || s.url;
                  if (sUrl && sUrl.startsWith('/')) sUrl = 'https://api.animetsu.site' + sUrl;
                  if (sUrl && sUrl.startsWith('http://ad-anivexa-api')) sUrl = sUrl.replace(/^http:\/\//i, 'https://');
                  return {
                    url: proxyWorker(sUrl),
                    quality: s.quality || '1080p',
                    type: 'video/mp4',
                    old_hls: false
                  };
                });
              return {
                isHls: false,
                type: 'mp4',
                url: proxied,
                sources: sources.length ? sources : null,
                referer: 'https://www.animegg.org/'
              };
            }
          } catch (e) {
            console.warn('[AnimeGG Stream Error]:', e);
          }
          return { error: `No ${track} stream found on AnimeGG`, message: `No ${track} stream found on AnimeGG`, url: null };
        }
      },
      adp: {
        id: 'adp',
        altId: 'aniembed',
        name: 'ADP',
        default: false,
        tip: 'Multi Quality, Multi Server',
        enabled: true,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const track = lang === 'dub' ? 'dub' : 'sub';
          const hasPrev = Number(epNum) > 1 ? 1 : 0;
          return {
            url: `https://aniembed.se/e/${encodeURIComponent(aniId)}/${epNum}?lang=${track}&autoplay=1&hasPrev=${hasPrev}&hasNext=1`,
            referer: 'https://aniembed.se/'
          };
        }
      },
      mkissa: {
        id: 'mkissa',
        altId: 'kissa',
        name: 'MKissa',
        default: false,
        tip: 'Hard Sub, Multi Quality',
        enabled: false,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const track = lang === 'dub' ? 'dub' : 'sub';
          try {
            let res = null;
            try {
              res = await fetch(`https://api.animetsu.site/watch/mkissa/${encodeURIComponent(aniId)}/${track}/mkissa-${epNum}`);
            } catch (e) {
              res = await fetch(`/watch/mkissa/${encodeURIComponent(aniId)}/${track}/mkissa-${epNum}`);
            }
            if (res && res.ok) {
              const data = await res.json();
              if (data?.error) {
                return { error: data.error, message: data.error, url: null };
              }
              const sources = Array.isArray(data?.sources) ? data.sources : [];
              const directHlsSource = sources.find(s => s.extractedUrl && (s.extractedType === 'hls' || s.extractedUrl.includes('.m3u8')));
              const directMp4Source = sources.find(s => s.extractedUrl && !s.extractedUrl.includes('.m3u8') && (s.extractedType === 'mp4' || s.extractedUrl.includes('.mp4')));
              const extractedSource = directHlsSource || directMp4Source || sources.find(s => s.extractedUrl);

              let streamUrl = extractedSource?.extractedUrl || data.proxied_stream_url || data.stream_url;

              const skips = (data.intro || data.outro) ? {
                intro: data.intro || null,
                outro: data.outro || null
              } : null;

              if (streamUrl) {
                const isHls = !!(directHlsSource || streamUrl.includes('.m3u8') || extractedSource?.extractedType === 'hls');
                return {
                  isHls: !!isHls,
                  type: isHls ? 'hls' : 'mp4',
                  url: streamUrl,
                  subtitles: [],
                  skips,
                  referer: extractedSource?.headers?.Referer || 'https://mkissa.to/'
                };
              }

              // Fallback to iframe embed if no direct extracted stream
              const embedSource = sources.find(s => s.url) || sources[0];
              if (embedSource?.url) {
                return {
                  isHls: false,
                  type: 'iframe',
                  url: embedSource.url,
                  referer: embedSource.headers?.Referer || 'https://mkissa.to/'
                };
              }
            }
          } catch (e) {
            console.warn('[MKissa Stream Error]:', e);
          }
          return { error: `No ${track} stream found on MKissa`, message: `No ${track} stream found on MKissa`, url: null };
        }
      },
      mega: {
        id: 'mega',
        altId: 'megaplay',
        name: 'Mega',
        default: false,
        tip: 'Soft Sub, Multi quality',
        enabled: true,
        getUrl: async (animeId, epNum, lang) => {
          const malId = (await getMalIdFromAnimeId(animeId)) || animeId;
          return {
            url: `https://megaplay.buzz/stream/mal/${encodeURIComponent(malId)}/${epNum}/${lang}`,
            referer: 'https://megaplay.buzz/'
          };
        }
      },
      zoro: {
        id: 'zoro',
        altId: 'zokoanime',
        name: 'Zoro',
        default: false,
        tip: 'Fast, Auto-next, DL',
        enabled: true,
        getUrl: async (animeId, epNum, lang) => {
          const malId = await getMalIdFromAnimeId(animeId);
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const src = malId ? 'mal' : 'anilist';
          const targetId = malId || aniId;
          return {
            url: `https://zokoanime.video/stream/${src}/${encodeURIComponent(targetId)}/${epNum}/${lang}?color=35d5bf`,
            referer: 'https://zokoanime.video/'
          };
        }
      },
      anikoto: {
        id: 'anikoto',
        altId: 'anikoto',
        name: 'Koto',
        default: false,
        tip: 'Soft Sub, Multi quality, Fast',
        enabled: false,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const track = lang === 'dub' ? 'dub' : 'sub';
          try {
            const res = await fetch(`https://anshu.screenscape.me/watch/anikoto/${encodeURIComponent(aniId)}/${track}/anikoto-${epNum}`);
            if (res.ok) {
              const data = await res.json();
              if (data?.error) {
                return { error: data.error, message: data.error, url: null };
              }
              let proxied = data.proxied_stream_url || data.stream_url || (Array.isArray(data.streams) ? (data.streams.find(s => s.type === 'hls' && s.url)?.url || data.streams[0]?.url) : null);
              if (proxied && proxied.startsWith('/')) {
                proxied = 'https://anshu.screenscape.me' + proxied;
              }
              if (proxied && proxied.startsWith('http://ad-anivexa-api')) {
                proxied = proxied.replace(/^http:\/\//i, 'https://');
              }
              const subs = (data.subtitles || []).map(s => {
                let sUrl = s.url || '';
                if (sUrl && !sUrl.includes('/proxy?url=')) {
                  sUrl = 'https://anshu.screenscape.me/proxy?url=' + encodeURIComponent(sUrl) + '&ref=https%3A%2F%2Fmegaplay.buzz%2F';
                }
                return {
                  url: sUrl,
                  label: s.label || 'English',
                  lang: s.label || 'English',
                  default: true
                };
              });
              const skips = (data.intro || data.outro) ? {
                intro: data.intro || null,
                outro: data.outro || null
              } : null;
              return {
                isHls: true,
                type: 'hls',
                url: proxied,
                subtitles: subs,
                skips,
                referer: 'https://megaplay.buzz/'
              };
            }
          } catch (e) {
            console.warn('[Anikoto Stream Error]:', e);
          }
          return { error: `No ${track} stream found on Anikoto`, message: `No ${track} stream found on Anikoto`, url: null };
        }
      },
      aniwaves: {
        id: 'aniwaves',
        altId: 'aniwaves',
        name: 'Wave',
        default: false,
        tip: 'Vidplay, Multi-Server',
        enabled: false,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const track = lang === 'dub' ? 'dub' : 'sub';
          try {
            const res = await fetch(`https://anshu.screenscape.me/watch/aniwaves/${encodeURIComponent(aniId)}/${track}/aniwaves-${epNum}`);
            if (res.ok) {
              const data = await res.json();
              if (data?.error) {
                return { error: data.error, message: data.error, url: null };
              }
              let proxied = data.proxied_stream_url || data.stream_url || (Array.isArray(data.streams) ? (data.streams.find(s => s.type === 'hls' && s.url)?.url || data.streams[0]?.url) : null);
              if (proxied && proxied.startsWith('/')) {
                proxied = 'https://anshu.screenscape.me' + proxied;
              }
              if (proxied && proxied.startsWith('http://ad-anivexa-api')) {
                proxied = proxied.replace(/^http:\/\//i, 'https://');
              }
              return {
                isHls: true,
                type: 'hls',
                url: proxied,
                subtitles: [],
                referer: 'https://megaplay.buzz/'
              };
            }
          } catch (e) {
            console.warn('[AniWaves Stream Error]:', e);
          }
          return { error: `No ${track} stream found on AniWaves`, message: `No ${track} stream found on AniWaves`, url: null };
        }
      },
      hawk: {
        id: 'hawk',
        altId: 'vidhawk',
        name: 'Hawk',
        default: false,
        tip: 'Flow, Auto-next, Auto-skip',
        enabled: false,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const autoskip = 'autoskipIntro=1&autoskipOutro=1';
          return {
            url: `https://vidhawk.buzz/embed/ani/${encodeURIComponent(aniId)}/${epNum}/${lang}?server=flow&${autoskip}`,
            referer: 'https://vidhawk.buzz/'
          };
        }
      },
      tryembed: {
        id: 'tryembed',
        altId: 'tryembed',
        name: 'Try',
        default: false,
        tip: 'Soft Sub, Multi, No Ads',
        enabled: false,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          const query = 'autoplay=true&autoSkip=true';
          if (aniId && /^\d+$/.test(String(aniId))) {
            return {
              url: `https://tryembed.us.cc/embed/anime/${encodeURIComponent(aniId)}/${epNum}/${lang}?${query}`,
              referer: 'https://tryembed.us.cc/'
            };
          }
          const malId = (await getMalIdFromAnimeId(animeId)) || animeId;
          return {
            url: `https://tryembed.us.cc/embed/anime/mal/${encodeURIComponent(malId)}/${epNum}/${lang}?${query}`,
            referer: 'https://tryembed.us.cc/'
          };
        }
      },
      anixo: {
        id: 'anixo',
        altId: 'aniembed',
        name: 'Anixo',
        default: false,
        tip: 'Soft Sub, Multi quality, No Ads',
        enabled: false,
        getUrl: async (animeId, epNum, lang) => {
          const aniId = (await getAnilistIdFromMalId(animeId)) || animeId;
          if (aniId && /^\d+$/.test(String(aniId))) {
            return {
              url: `https://anixo.buzz/embed/ani/${encodeURIComponent(aniId)}/${epNum}?player=custom&track=${lang}&server=1&autoSkipIntro=1&autoSkipOutro=1`,
              referer: 'https://anixo.buzz/'
            };
          }
          const malId = (await getMalIdFromAnimeId(animeId)) || animeId;
          return {
            url: `https://anixo.buzz/embed/mal/${encodeURIComponent(malId)}/${epNum}?player=custom&track=${lang}&server=1&autoSkipIntro=1&autoSkipOutro=1`,
            referer: 'https://anixo.buzz/'
          };
        }
      },
    };

    // 3. Servers: /anime/servers/:id/:ep
    if (url.includes('/anime/servers/')) {
      const activeServers = Object.values(STREAM_PROVIDER_REGISTRY)
        .filter(p => p.enabled)
        .map(({ id, name, default: isDef, tip }) => ({ id, name, default: isDef, tip }));
      return {
        data: activeServers,
        status: 200,
        statusText: 'OK',
        headers: {},
        config
      };
    }

    // 4. Oppai Stream Player: /anime/oppai/:id/:ep
    if (url.includes('/anime/oppai/')) {
      const parts = url.split('/');
      const oppaiIdx = parts.indexOf('oppai');
      const animeId = parts[oppaiIdx + 1]?.split('?')[0];
      const epNum = parts[oppaiIdx + 2]?.split('?')[0] || '1';
      let lang = 'sub';
      try {
        const uObj = url.includes('?') ? new URL(url, 'http://localhost') : null;
        const qLang = uObj?.searchParams.get('source_type') || config.params?.source_type;
        if (qLang === 'dub' || url.includes('source_type=dub')) lang = 'dub';
      } catch {}

      let sParam = '';
      try {
        sParam = (config.params?.server || config.params?.s || '').toLowerCase();
        if (!sParam && url.includes('?')) {
          const uObj = new URL(url, 'http://localhost');
          sParam = (uObj.searchParams.get('server') || uObj.searchParams.get('s') || '').toLowerCase();
        }
      } catch {}

      let targetProvider = STREAM_PROVIDER_REGISTRY[sParam] || 
        Object.values(STREAM_PROVIDER_REGISTRY).find(p => p.altId === sParam || (sParam && (p.id.includes(sParam) || (p.altId && p.altId.includes(sParam)))));
      if (!targetProvider || !targetProvider.enabled) {
        targetProvider = Object.values(STREAM_PROVIDER_REGISTRY).find(p => p.enabled && p.default) || 
          Object.values(STREAM_PROVIDER_REGISTRY).find(p => p.enabled);
      }
      const streamResult = await targetProvider.getUrl(animeId, epNum, lang);

      if (streamResult.error || !streamResult.url) {
        if (lang === 'dub' || streamResult.error === 'DUB_NOT_AVAILABLE') {
          const noDubHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0d0d12;color:#9ca3af;font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;overflow:hidden;text-align:center;padding:20px;box-sizing:border-box}h2{color:#f3f4f6;font-size:1.15rem;font-weight:600;margin:0 0 8px 0}p{margin:0;font-size:0.85rem;color:#9ca3af;max-width:320px}</style></head><body><h2>English Dub is not available</h2><p>Dub is not available for this episode. Please switch to SUB.</p></body></html>';
          return {
            data: {
              headers: {},
              sources: [{
                url: 'data:text/html;charset=utf-8,' + encodeURIComponent(noDubHtml),
                type: 'iframe',
                quality: '1080p'
              }],
              subtitles: [],
              intro: null,
              outro: null,
              server: targetProvider.id
            },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }
        return {
          data: {
            headers: {},
            sources: [],
            subtitles: [],
            error: streamResult.message || `No ${lang} source found`
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (streamResult.isHls || streamResult.type === 'hls' || streamResult.type === 'video/mpegurl') {
        return {
          data: {
            headers: { Referer: streamResult.referer || 'https://megaplay.buzz/' },
            sources: streamResult.sources && streamResult.sources.length ? streamResult.sources : [{
              url: streamResult.url,
              quality: streamResult.quality || 'Auto',
              old_hls: true,
              type: 'video/mpegurl'
            }],
            subtitles: streamResult.subtitles || [],
            subs: streamResult.subtitles || [],
            skips: streamResult.skips || null,
            intro: streamResult.skips?.intro || null,
            outro: streamResult.skips?.outro || null,
            server: targetProvider.id
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      if (streamResult.type === 'mp4' || streamResult.type === 'video/mp4') {
        return {
          data: {
            headers: { Referer: streamResult.referer || 'https://www.animegg.org/' },
            sources: streamResult.sources && streamResult.sources.length ? streamResult.sources : [{
              url: streamResult.url,
              quality: streamResult.quality || '1080p',
              old_hls: false,
              type: 'video/mp4'
            }],
            subtitles: [],
            subs: [],
            skips: null,
            server: targetProvider.id
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config
        };
      }

      return {
        data: {
          headers: { Referer: streamResult.referer },
          sources: [{ url: streamResult.url, type: 'iframe', quality: '1080p' }],
          subtitles: [],
          intro: { start: 90, end: 180 },
          outro: { start: 1320, end: 1410 },
          server: targetProvider.id
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config
      };
    }

    // 5. Episode Views: /anime/views/:id/:ep (100% Real Live View Count via hitscounter.dev)
    if (url.includes('/anime/views/')) {
      const parts = url.split('/');
      const viewsIdx = parts.indexOf('views');
      const animeId = parts[viewsIdx + 1]?.split('?')[0];
      const epNum = parts[viewsIdx + 2]?.split('?')[0] || '1';
      const watchUrlSite = `animetsu.site/watch?id=${animeId}&ep=${epNum}`;
      const isReadOnly = url.includes('nocount=1') || config?.params?.nocount;
      let count = 0;
      try {
        const cached = localStorage.getItem(`animetsu_real_views_${animeId}_${epNum}`);
        if (cached !== null) count = Number(cached) || 0;
      } catch {}
      try {
        const apiParam = isReadOnly ? 'output=json&nocount=1' : 'output=json';
        const res = await originalFetch(`https://hitscounter.dev/api/hit?${apiParam}&url=${encodeURIComponent(watchUrlSite)}`, {
          signal: AbortSignal.timeout(3500)
        });
        if (res.ok) {
          const data = await res.json();
          const hits = Number(data?.total_hits) || 0;
          if (hits > 0) {
            count = hits;
            try {
              localStorage.setItem(`animetsu_real_views_${animeId}_${epNum}`, String(count));
            } catch {}
          }
        }
      } catch (err) {
        console.warn('[ClientEngine] View counter error:', err);
      }
      return { data: { count }, status: 200, statusText: 'OK', headers: {}, config };
    }

    // 6. Downloads: /anime/dl/:id/:ep
    if (url.includes('/anime/dl/')) {
      const parts = url.split('/');
      const dlIdx = parts.indexOf('dl');
      const animeId = parts[dlIdx + 1]?.split('?')[0];
      const epNum = parts[dlIdx + 2]?.split('?')[0] || '1';
      let lang = 'sub';
      try {
        lang = (localStorage.getItem('animetsu:userPreferredAudio') || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub';
        const uObj = url.includes('?') ? new URL(url, 'http://localhost') : null;
        const qLang = uObj?.searchParams.get('source_type') || uObj?.searchParams.get('audio') || config.params?.source_type || config.params?.audio;
        if (qLang === 'dub' || url.includes('source_type=dub')) lang = 'dub';
      } catch {}

      const malId = (await getMalIdFromAnimeId(animeId)) || animeId;
      const zoroDownloadUrl = (malId && /^\d+$/.test(String(malId)))
        ? `https://zokoanime.video/download/mal/${encodeURIComponent(malId)}/${epNum}/${lang}`
        : `https://zokoanime.video/download/anilist/${encodeURIComponent(animeId)}/${epNum}/${lang}`;

      // AniSnatch multi-server download (from v1)
      const aniSnatchUrl = (malId && /^\d+$/.test(String(malId)))
        ? `https://dl.anisnatch.top/anime/${encodeURIComponent(malId)}/${epNum}`
        : '';

      const dlLinks = [];
      if (aniSnatchUrl) {
        dlLinks.push({ name: 'AniSnatch (Multi Server)', link: aniSnatchUrl });
      }
      dlLinks.push({ name: 'Zoro Download (All Qualities)', link: zoroDownloadUrl });

      return {
        data: dlLinks,
        status: 200,
        statusText: 'OK',
        headers: {},
        config
      };
    }

    // 7. Auth: /user, /auth/user, /user/sign-in, /user/sign-out
    if (url.includes('/auth/user') || url.includes('/user') || url === 'user') {
      // Sign In handler (Pure Client-Side AniList Auth - Gojo Live Style)
      if (url.includes('/user/sign-in') || url.includes('/auth/login')) {
        const body = config.data ? (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) : {};
        const token = body.token || body.password || body.username || body.access_token;
        if (!token) return { data: null, status: 400, statusText: 'Bad Request', headers: {}, config };

        // 1. Direct AniList GraphQL Query (Instant, Zero Worker Dependency)
        try {
          const alRes = await originalFetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              query: 'query { Viewer { id name avatar { large medium } bannerImage } }'
            })
          });
          if (alRes.ok) {
            const alData = await alRes.json();
            const viewer = alData?.data?.Viewer;
            if (viewer?.id) {
              const userId = 'al_' + viewer.id;
              const sessionId = 'sess_' + (window.crypto?.randomUUID ? window.crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
              const userObj = {
                id: userId,
                anilist_id: viewer.id,
                username: viewer.name,
                display_name: viewer.name,
                avatar: viewer.avatar?.large || viewer.avatar?.medium || '',
                banner: viewer.bannerImage || '',
                anilist: viewer.name,
                anilist_token: token
              };
              localStorage.setItem('animetsu_sess', sessionId);
              localStorage.setItem('animetsu_user', JSON.stringify(userObj));
              localStorage.setItem('animetsu_anilist_token', token);
              document.cookie = 'animetsu_sess=' + sessionId + '; path=/; max-age=31536000; SameSite=Lax';

              // Background non-blocking sync to D1 for comment attribution & session sync
              originalFetch('/v2/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
              }).then(r => r.ok ? r.json() : null).then(d => {
                if (d?.session_id) {
                  localStorage.setItem('animetsu_sess', d.session_id);
                  document.cookie = 'animetsu_sess=' + d.session_id + '; path=/; max-age=31536000; SameSite=Lax';
                }
              }).catch(() => {});

              window.dispatchEvent(new CustomEvent('animetsu_auth_updated', { detail: userObj }));
              return { data: userObj, status: 200, statusText: 'OK', headers: {}, config };
            }
          }
        } catch (e) {
          console.warn('[client_engine] Direct AniList login fallback to backend:', e);
        }

        // 2. Fallback to backend API if client direct call is blocked (e.g., adblocker)
        try {
          const res = await originalFetch('/v2/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          });
          if (res.ok) {
            const data = await res.json();
            if (data?.session_id && data?.user) {
              localStorage.setItem('animetsu_sess', data.session_id);
              localStorage.setItem('animetsu_user', JSON.stringify(data.user));
              localStorage.setItem('animetsu_anilist_token', token);
              document.cookie = 'animetsu_sess=' + data.session_id + '; path=/; max-age=31536000; SameSite=Lax';
              return { data: data.user, status: 200, statusText: 'OK', headers: {}, config };
            }
          }
        } catch (err) {}

        return { data: null, status: 400, statusText: 'Bad Request', headers: {}, config };
      }

      // Sign Out handler
      if (url.includes('/user/sign-out') || url.includes('/auth/logout')) {
        const sessId = localStorage.getItem('animetsu_sess') || '';
        try {
          await originalFetch('/user/sign-out', {
            headers: sessId ? { 'Authorization': `Bearer ${sessId}` } : {}
          });
        } catch {}
        localStorage.removeItem('animetsu_sess');
        localStorage.removeItem('animetsu_user');
        localStorage.removeItem('animetsu_anilist_token');
        return { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config };
      }

      // Check current user profile - SERVE FROM CACHE FIRST, refresh from server every 5 min
      const sessId = localStorage.getItem('animetsu_sess') || '';

      // Always try localStorage first (0 API calls)
      let cachedUser = null;
      try {
        const stored = localStorage.getItem('animetsu_user');
        if (stored) {
          const u = JSON.parse(stored);
          if (u?.id) cachedUser = u;
        }
      } catch {}

      if (cachedUser) {
        // Background refresh only every 5 minutes (not every page load)
        const lastCheck = Number(localStorage.getItem('animetsu_user_checked') || 0);
        if (sessId && Date.now() - lastCheck > 300000) {
          // Fire-and-forget background refresh
          originalFetch('/v2/api/auth/me', {
            headers: { 'Authorization': `Bearer ${sessId}` }
          }).then(r => r.ok ? r.json() : null).then(u => {
            if (u?.id) {
              localStorage.setItem('animetsu_user', JSON.stringify(u));
            }
            localStorage.setItem('animetsu_user_checked', String(Date.now()));
          }).catch(() => {});
        }
        return { data: cachedUser, status: 200, statusText: 'OK', headers: {}, config };
      }

      // No cache - must fetch from server
      if (sessId) {
        try {
          const res = await originalFetch('/v2/api/auth/me', {
            headers: { 'Authorization': `Bearer ${sessId}` }
          });
          if (res.ok) {
            const u = await res.json();
            if (u?.id) {
              localStorage.setItem('animetsu_user', JSON.stringify(u));
              localStorage.setItem('animetsu_user_checked', String(Date.now()));
              return { data: u, status: 200, statusText: 'OK', headers: {}, config };
            }
          }
        } catch (err) {
          console.warn('[client_engine] /user fetch error:', err);
        }
      }

      // If in local dev environment without AniList session, provide local user so comment ownership & delete work seamlessly!
      const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (isLocalHost) {
        const guestUser = {
          id: 'usr_local_guest',
          user_id: 'usr_local_guest',
          name: 'Local User',
          username: 'Local User',
          display_name: 'Local User',
          avatar: 'https://s4.anilist.co/default.png'
        };
        return { data: guestUser, status: 200, statusText: 'OK', headers: {}, config };
      }

      return { data: null, status: 200, statusText: 'OK', headers: {}, config };
    }



    // Default empty fallback
    return {
      data: [],
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    };
  };

  // Global helper to save watch history progress across all players
  async function saveWatchProgress(animeId, epNum, timeSec, duration = 1440, isComplete = false) {
    if (!animeId) return;
    try {
      const rawS = localStorage.getItem('user-settings') || localStorage.getItem('usr_guest_animetsu-settings');
      if (rawS) {
        const parsedS = JSON.parse(rawS);
        if (parsedS?.pause_history === 'on') return;
      }
    } catch {}
    const safeEp = Number(epNum) || 1;
    const time = Number(timeSec) || 0;
    const dur = Number(duration) || 1440;
    const isWatched = isComplete || (dur > 0 && (time / dur * 100 >= 85));
    const storageKeys = ['user-watch_history', 'usr_guest_animetsu-watch_history', 'animetsu_watch_history'];

    let list = [];
    try {
      const raw = localStorage.getItem('user-watch_history') || localStorage.getItem('usr_guest_animetsu-watch_history');
      if (raw) list = JSON.parse(raw);
    } catch {}
    if (!Array.isArray(list)) list = [];

    const existingIdx = list.findIndex(x => String(x.anime_id) === String(animeId) || String(x.id) === String(animeId));
    const epKey = String(safeEp);

    let title = '';
    let epName = `Episode ${safeEp}`;
    let img = '';
    let info = memCache.get(`info_${animeId}`);
    if (!info) {
      try {
        const cached = localStorage.getItem(`animetsu_info_${animeId}`);
        if (cached) info = JSON.parse(cached);
      } catch {}
    }
    if (!info && document.title && !document.title.includes('Watch Anime Online')) {
      title = document.title.split(' - ')[0]?.trim() || '';
    }
    if (!info) {
      try { info = await getClientAnimeInfo(animeId); } catch {}
    }
    if (info) {
      title = info.title?.english || info.title?.romaji || info.title?.userPreferred || '';
      img = info.cover_image?.large || info.cover_image?.extraLarge || info.cover_image?.medium || info.banner_image || '';
    }

    if (existingIdx !== -1) {
      list[existingIdx].anime_id = String(animeId);
      list[existingIdx].id = String(animeId);
      list[existingIdx].ep_num = safeEp;
      list[existingIdx].name = epName;
      list[existingIdx].progress = time;
      list[existingIdx].duration = dur;
      if (title && (!list[existingIdx].title || list[existingIdx].title === 'Anime')) list[existingIdx].title = title;
      if (img && !list[existingIdx].img) list[existingIdx].img = img;
      list[existingIdx].hidden = false;
      list[existingIdx].updated_at = new Date().toISOString();
      if (!list[existingIdx].eps) list[existingIdx].eps = {};
      list[existingIdx].eps[epKey] = {
        progress: time,
        duration: dur,
        watched: list[existingIdx].eps[epKey]?.watched || isWatched
      };
    } else {
      list.unshift({
        id: String(animeId),
        anime_id: String(animeId),
        ep_num: safeEp,
        name: epName,
        title: title || 'Anime',
        img: img || '',
        progress: time,
        duration: dur,
        hidden: false,
        eps: {
          [epKey]: {
            progress: time,
            duration: dur,
            watched: isWatched
          }
        },
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      });
    }

    // Ensure 100% deduplication
    const _seenDedup = new Map();
    const _cleanList = [];
    for (const item of list) {
      if (!item) continue;
      const aid = String(item.anime_id || item.id || "");
      if (!aid) continue;
      if (!_seenDedup.has(aid)) {
        _seenDedup.set(aid, true);
        _cleanList.push(item);
      }
    }
    list = _cleanList;

    const dataStr = JSON.stringify(list);
    storageKeys.forEach(k => {
      try { localStorage.setItem(k, dataStr); } catch {}
    });

    try {
      window.dispatchEvent(new Event('storage'));
      window.dispatchEvent(new CustomEvent('animetsu_history_updated'));
    } catch {}
  }

  // Detect active episode from active iframe or page URL
  function detectActiveEpisode(animeId) {
    // 1. Try reading the active player iframe src
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
      const src = iframes[i].src || iframes[i].getAttribute('src') || '';
      if (!src || !src.includes('http')) continue;

      const clean = src.split('?')[0];
      const parts = clean.split('/').filter(Boolean);
      const last = parts[parts.length - 1]?.toLowerCase();

      // Case A: /stream/mal/{id}/{ep}/sub or dub
      if (last === 'sub' || last === 'dub') {
        const candidate = Number(parts[parts.length - 2]);
        if (!isNaN(candidate) && candidate > 0) return candidate;
      }

      // Case B: /embed/ani/{id}/{ep}
      const lastNum = Number(parts[parts.length - 1]);
      if (!isNaN(lastNum) && lastNum > 0) return lastNum;

      // Case C: episode-(\d+)
      const epMatch = clean.match(/episode-(\d+)/i);
      if (epMatch && epMatch[1]) {
        const num = Number(epMatch[1]);
        if (!isNaN(num) && num > 0) return num;
      }
    }

    // 2. Check path /watch/:id/:ep
    const pathParts = window.location.pathname.split('/');
    if (pathParts[3] && !isNaN(Number(pathParts[3])) && Number(pathParts[3]) > 0) {
      return Number(pathParts[3]);
    }

    // 3. Check query param ?ep=
    const qEp = new URLSearchParams(window.location.search).get('ep');
    if (qEp && !isNaN(Number(qEp)) && Number(qEp) > 0) {
      return Number(qEp);
    }

    // 4. Check existing history entry for current episode
    try {
      const raw = localStorage.getItem('user-watch_history');
      if (raw) {
        const list = JSON.parse(raw);
        const found = list.find(x => String(x.anime_id) === String(animeId));
        if (found && found.ep_num) return Number(found.ep_num);
      }
    } catch {}

    return 1;
  }

  // Active Watch Time Tracker for Iframe Player
  // Active Watch Time Tracker for Iframe Player
  (function initWatchTracker() {
    let activeWatchInterval = null;
    let currentWatchedAnime = '';
    let currentWatchedEp = 1;
    let watchTimeSec = 15;

    function getSavedProgress(animeId, epNum) {
      try {
        const raw = localStorage.getItem('user-watch_history');
        if (raw) {
          const list = JSON.parse(raw);
          const found = list.find(x => String(x.anime_id) === String(animeId));
          if (found?.eps?.[String(epNum)]?.progress) {
            return Number(found.eps[String(epNum)].progress) || 0;
          }
        }
      } catch {}
      return 0;
    }

    // Expose sync so postMessage can update the active playback head
    window.__animetsuSyncPlayhead = function(animeId, epNum, time) {
      if (String(currentWatchedAnime) === String(animeId) && Number(currentWatchedEp) === Number(epNum)) {
        watchTimeSec = Math.max(watchTimeSec, Number(time) || 0);
      }
    };

    function checkWatchPage() {
      const path = window.location.pathname;
      if (!path.startsWith('/watch/')) {
        if (activeWatchInterval) {
          clearInterval(activeWatchInterval);
          activeWatchInterval = null;
        }
        currentWatchedAnime = '';
        return;
      }

      const animeId = path.split('/')[2]?.split('?')[0];
      if (!animeId) return;

      const activeEp = detectActiveEpisode(animeId);
      if (currentWatchedAnime !== animeId || currentWatchedEp !== activeEp) {
        currentWatchedAnime = animeId;
        currentWatchedEp = activeEp;
        const saved = getSavedProgress(animeId, activeEp);
        watchTimeSec = Math.max(15, saved);
        saveWatchProgress(animeId, activeEp, watchTimeSec, 1440, false);
      }

      if (!activeWatchInterval) {
        activeWatchInterval = setInterval(() => {
          if (!window.location.pathname.startsWith(`/watch/${animeId}`)) {
            clearInterval(activeWatchInterval);
            activeWatchInterval = null;
            return;
          }
          const epNow = detectActiveEpisode(animeId);
          if (epNow !== currentWatchedEp) {
            currentWatchedEp = epNow;
            const saved = getSavedProgress(animeId, epNow);
            watchTimeSec = Math.max(15, saved);
          } else {
            const saved = getSavedProgress(animeId, currentWatchedEp);
            watchTimeSec = Math.max(watchTimeSec, saved) + 5;
          }
          saveWatchProgress(animeId, currentWatchedEp, watchTimeSec, 1440, false);
        }, 5000);
      }
    }

    window.addEventListener('popstate', checkWatchPage);
    const origPushState = history.pushState;
    history.pushState = function () {
      origPushState.apply(this, arguments);
      setTimeout(checkWatchPage, 400);
    };
    const origReplaceState = history.replaceState;
    history.replaceState = function () {
      origReplaceState.apply(this, arguments);
      setTimeout(checkWatchPage, 400);
    };
    setTimeout(checkWatchPage, 1000);
    setInterval(checkWatchPage, 3000);
  })();

  // Universal Iframe Sandbox Enforcer for Hawk, Anixo & Embed Players (Strict Ad-Block Protection)
  (function enforceIframeSandbox() {
    const SANDBOX_POLICY = 'allow-scripts allow-same-origin allow-forms allow-presentation';
    
    function isTargetPlayer(src) {
      if (!src) return false;
      const s = String(src).toLowerCase();
      // Sandboxed players for ad-blocking: Hawk, Anixo, TryEmbed
      return s.includes('hawk') || s.includes('vidhawk') || s.includes('anixo') || 
             s.includes('aniembed') || s.includes('tryembed');
    }

    function getPolicyForPlayer(src) {
      const s = String(src).toLowerCase();
      // Anixo custom player probes window.open('about:blank') to verify allow-popups
      if (s.includes('anixo') || s.includes('aniembed')) {
        return 'allow-scripts allow-same-origin allow-forms allow-presentation allow-popups';
      }
      return SANDBOX_POLICY;
    }

    function sanitizeIframe(iframe, customSrc) {
      if (!iframe || iframe.tagName !== 'IFRAME') return;
      const src = customSrc || iframe.src || iframe.getAttribute('src') || '';
      if (isTargetPlayer(src)) {
        const targetPolicy = getPolicyForPlayer(src);
        const currentSb = iframe.getAttribute('sandbox');
        if (currentSb !== targetPolicy) {
          iframe.setAttribute('sandbox', targetPolicy);
          console.log('[AdBlock] Enforced ad-blocking sandbox on player iframe:', src, targetPolicy);
        }
      } else if (iframe.hasAttribute('sandbox')) {
        // Explicitly remove sandbox from Mega and other standard players
        iframe.removeAttribute('sandbox');
        console.log('[Player] Cleaned sandbox for standard player (Mega/other):', src);
      }
    }

    // Intercept property setter so sandbox is applied BEFORE navigation
    try {
      const srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
      if (srcDesc && srcDesc.set) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
          set: function(val) {
            sanitizeIframe(this, val);
            return srcDesc.set.call(this, val);
          },
          get: function() {
            return srcDesc.get.call(this);
          },
          configurable: true,
          enumerable: true
        });
      }

      const origSetAttr = HTMLIFrameElement.prototype.setAttribute;
      HTMLIFrameElement.prototype.setAttribute = function(name, val) {
        if (name === 'src' || name === 'SRC') {
          sanitizeIframe(this, val);
        }
        return origSetAttr.apply(this, arguments);
      };
    } catch (e) {}

    // MutationObserver to catch any iframes dynamically rendered or updated in DOM
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
          sanitizeIframe(mutation.target);
        }
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              if (node.tagName === 'IFRAME') sanitizeIframe(node);
              else if (node.querySelectorAll) {
                node.querySelectorAll('iframe').forEach(el => sanitizeIframe(el));
              }
            }
          }
        }
      }
    });

    const observerConfig = { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] };
    if (document.body) {
      observer.observe(document.body, observerConfig);
      document.querySelectorAll('iframe').forEach(el => sanitizeIframe(el));
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, observerConfig);
        document.querySelectorAll('iframe').forEach(el => sanitizeIframe(el));
      });
    }
  })();

  // Parent Window PostMessage Listener for MegaPlay, AniEmbed / Anixo, TryEmbed & Hawk
  window.addEventListener('message', (e) => {
    if (!e.data) return;
    let d = e.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (err) {}
    }
    if (!d || typeof d !== 'object') return;

    const path = window.location.pathname;
    let animeId = path.startsWith('/watch/') ? path.split('/')[2]?.split('?')[0] : null;
    if (!animeId && (path === '/watch' || path === '/watch/')) {
      animeId = new URLSearchParams(window.location.search).get('id');
    }
    if (!animeId) {
      const iframes = document.querySelectorAll('iframe');
      for (let i = 0; i < iframes.length; i++) {
        const src = iframes[i].src || iframes[i].getAttribute('src') || '';
        const m = src.match(/\/stream\/(?:mal|ani)\/(\d+)/i) || src.match(/\/embed\/anime\/(?:mal\/)?(\d+)/i) || src.match(/\/embed\/ani\/(\d+)/i);
        if (m && m[1]) {
          animeId = m[1];
          break;
        }
      }
    }

    // 1. MegaPlay (megacloud channel, watching-log or time event)
    const isMegaTime = d.event === 'time' || d.type === 'watching-log' || (d.channel === 'megacloud' && (d.event === 'time' || d.time !== undefined || d.currentTime !== undefined));
    if (isMegaTime && animeId) {
      const cur = Math.round(Number(d.time !== undefined ? d.time : (d.currentTime !== undefined ? d.currentTime : (d.data?.time !== undefined ? d.data.time : (d.data?.currentTime || 0)))));
      const dur = Math.round(Number(d.duration !== undefined ? d.duration : (d.data?.duration || 1440)));
      const ep = detectActiveEpisode(animeId);
      if (dur > 0 && cur >= 0) {
        if (typeof window.__animetsuSyncPlayhead === 'function') {
          window.__animetsuSyncPlayhead(animeId, ep, cur);
        }
        saveWatchProgress(animeId, ep, cur, dur, false);
      }
    }

    const isMegaComplete = d.event === 'complete' || (d.channel === 'megacloud' && d.event === 'complete');
    if (isMegaComplete && animeId) {
      const ep = detectActiveEpisode(animeId);
      saveWatchProgress(animeId, ep, 1440, 1440, true);
      console.log('🎬 [Player Event] MegaPlay episode completed:', animeId, ep);
    }

    // 2. AniEmbed / Anixo / TryEmbed events
    if (d.type === 'aniembed:play' || (d.type === 'PLAYER_EVENT' && d.data?.event === 'play')) {
      console.log('[Player Event] Playback started');
    }
    if (d.type === 'aniembed:ended' || (d.type === 'PLAYER_EVENT' && (d.data?.event === 'ended' || d.data?.complete))) {
      if (animeId) {
        const ep = detectActiveEpisode(animeId);
        saveWatchProgress(animeId, ep, 1440, 1440, true);
      }
      console.log('[Player Event] Episode ended. Ready to advance episode.');
    }

    // 3. FlixCloud / ReAnime events
    const isFlixTime = d.currentTime !== undefined && (d.duration !== undefined || typeof d.currentTime === 'number');
    if (isFlixTime && animeId) {
      const cur = Math.round(Number(d.currentTime) || 0);
      const dur = Math.round(Number(d.duration) || 1440);
      const ep = detectActiveEpisode(animeId);
      if (dur > 0 && cur >= 0) {
        if (typeof window.__animetsuSyncPlayhead === 'function') {
          window.__animetsuSyncPlayhead(animeId, ep, cur);
        }
        saveWatchProgress(animeId, ep, cur, dur, false);
      }
    }

    const isFlixEnded = (d.playerStatus && String(d.playerStatus).toLowerCase() === 'ended') ||
                        (d.event && String(d.event).toLowerCase() === 'ended') ||
                        (d.type && String(d.type).toLowerCase() === 'ended') ||
                        (d.status && String(d.status).toLowerCase() === 'ended');

    if (isFlixEnded && animeId) {
      const ep = detectActiveEpisode(animeId);
      saveWatchProgress(animeId, ep, 1440, 1440, true);
      console.log('🎬 [Player Event] ReAnime / FlixCloud episode ended. Advancing to next episode:', animeId, ep);
      try {
        const nextEp = Number(ep) + 1;
        const nextLink = document.querySelector(`a[href*="/watch/${animeId}/${nextEp}"]`) || 
                         document.querySelector(`a[href*="ep=${nextEp}"]`);
        if (nextLink) {
          nextLink.click();
        } else {
          const nextBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.trim()?.toLowerCase()?.includes('next'));
          if (nextBtns.length > 0 && !nextBtns[0].disabled) {
            nextBtns[0].click();
          } else {
            const hasSlashFormat = window.location.pathname.includes(`/watch/${animeId}/`);
            window.location.href = hasSlashFormat ? `/watch/${animeId}/${nextEp}` : `/watch/${animeId}?ep=${nextEp}`;
          }
        }
      } catch (e) {
        console.warn('[AutoNext Error]:', e);
      }
    }

    // 4. ADP (AniEmbed.se) events
    if (d.source === 'aniembed') {
      const ep = detectActiveEpisode(animeId);
      if ((d.name === 'progress' || d.name === 'pause') && d.data && animeId) {
        const cur = Math.round(Number(d.data.time !== undefined ? d.data.time : d.data.currentTime) || 0);
        const dur = Math.round(Number(d.data.duration) || 1440);
        if (dur > 0 && cur >= 0) {
          if (typeof window.__animetsuSyncPlayhead === 'function') {
            window.__animetsuSyncPlayhead(animeId, ep, cur);
          }
          saveWatchProgress(animeId, ep, cur, dur, false);
        }
      }
      if (d.name === 'ended' && animeId) {
        saveWatchProgress(animeId, ep, 1440, 1440, true);
        console.log('🎬 [Player Event] ADP episode ended. Advancing to next episode:', animeId, ep);
        try {
          const nextEp = Number(ep) + 1;
          const nextLink = document.querySelector(`a[href*="/watch/${animeId}/${nextEp}"]`) || 
                           document.querySelector(`a[href*="ep=${nextEp}"]`);
          if (nextLink) {
            nextLink.click();
          } else {
            const nextBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.trim()?.toLowerCase()?.includes('next'));
            if (nextBtns.length > 0 && !nextBtns[0].disabled) {
              nextBtns[0].click();
            }
          }
        } catch (e) {}
      }
      if (d.name === 'next' && animeId) {
        const nextEp = Number(ep) + 1;
        const nextLink = document.querySelector(`a[href*="/watch/${animeId}/${nextEp}"]`) || 
                         document.querySelector(`a[href*="ep=${nextEp}"]`);
        if (nextLink) nextLink.click();
      }
      if (d.name === 'previous' && animeId && Number(ep) > 1) {
        const prevEp = Number(ep) - 1;
        const prevLink = document.querySelector(`a[href*="/watch/${animeId}/${prevEp}"]`) || 
                         document.querySelector(`a[href*="ep=${prevEp}"]`);
        if (prevLink) prevLink.click();
      }
    }
  });

  // Query FlixCloud / ReAnime iframe for watch progress every 2.5s
  setInterval(() => {
    try {
      const iframes = document.querySelectorAll('iframe');
      for (let i = 0; i < iframes.length; i++) {
        const src = iframes[i].src || iframes[i].getAttribute('src') || '';
        if (src.includes('flixcloud.cc') || src.includes('reanime')) {
          iframes[i].contentWindow?.postMessage({ command: 'getTime' }, '*');
        }
      }
    } catch (e) {}
  }, 2500);

  // Fullscreen and mobile viewport styling synchronization for player iframe & player-root
  const updatePlayerBorderRadius = () => {
    try {
      const fsElem = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
      const isMobile = window.innerWidth <= 768;
      const playerRoot = document.getElementById('player-root');
      if (playerRoot) {
        if (fsElem) {
          playerRoot.classList.add('is-fullscreen');
          playerRoot.style.setProperty('border-radius', '0px', 'important');
        } else if (isMobile) {
          playerRoot.classList.remove('is-fullscreen');
          playerRoot.style.setProperty('border-radius', '0px', 'important');
        } else {
          playerRoot.classList.remove('is-fullscreen');
          playerRoot.style.removeProperty('border-radius');
        }
      }
      const iframes = document.querySelectorAll('#player-root iframe, iframe.size-full');
      iframes.forEach(f => {
        if (fsElem || isMobile) {
          f.style.setProperty('border-radius', '0px', 'important');
        } else {
          f.style.removeProperty('border-radius');
        }
      });
    } catch (e) {}
  };

  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
    document.addEventListener(evt, updatePlayerBorderRadius);
  });
  window.addEventListener('resize', updatePlayerBorderRadius);

  // =========================================================================
  // UNIVERSAL TIMESTAMP SEEK CONTROLLER (FLIXCLOUD IFRAME + VIDSTACK PLAYER)
  // =========================================================================
  function parseTimestampToSeconds(str) {
    if (!str || typeof str !== 'string') return 0;
    const parts = str.trim().split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1]; // mm:ss
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
    return 0;
  }
  window.__parseTimestampSec = parseTimestampToSeconds;

  // React Virtual-DOM Timestamp Renderer: Zero DOM mutation conflicts
  window.__renderCommentText = function (text, jsxRuntime) {
    if (!text || typeof text !== 'string') return text;
    const tsRegex = /(\b\d{1,2}:\d{2}(?::\d{2})?\b)/g;
    if (!tsRegex.test(text)) return text;
    if (!jsxRuntime || typeof jsxRuntime.jsx !== 'function') return text;

    const parts = text.split(tsRegex);
    return parts.map((part, idx) => {
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(part)) {
        const sec = parseTimestampToSeconds(part);
        return jsxRuntime.jsx('span', {
          key: 'ts_' + idx,
          className: 'animetsu-timestamp cursor-pointer font-semibold inline-flex items-center gap-0.5',
          'data-time': sec,
          children: part
        });
      }
      return part;
    }).filter(p => p !== '');
  };

  function seekAllActivePlayers(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) return;
    console.log('🎯 [Timestamp Seek] Seeking active player to:', seconds, 'seconds');

    // 1. Vidstack Custom Player / HTML5 Video Tag
    try {
      const mediaPlayers = document.querySelectorAll('media-player');
      mediaPlayers.forEach(mp => {
        if (mp) {
          mp.currentTime = seconds;
          if (mp.paused && typeof mp.play === 'function') mp.play().catch(() => {});
        }
      });

      const videoElements = document.querySelectorAll('video');
      videoElements.forEach(vid => {
        if (vid) {
          vid.currentTime = seconds;
          if (vid.paused && typeof vid.play === 'function') vid.play().catch(() => {});
        }
      });
    } catch (e) {
      console.warn('[Vidstack Seek Error]:', e);
    }

    // 2. FlixCloud Iframe / ReAnime Embed Iframe
    try {
      const iframes = document.querySelectorAll('#player-root iframe, #video-player, iframe.size-full, iframe');
      iframes.forEach(iframe => {
        if (iframe && iframe.contentWindow) {
          // ReAnime / FlixCloud format:
          iframe.contentWindow.postMessage({ command: 'seek', value: seconds }, '*');
          // MegaCloud / Vidstreaming format:
          iframe.contentWindow.postMessage({ event: 'seek', time: seconds, value: seconds }, '*');
          try {
            iframe.contentWindow.postMessage(JSON.stringify({ command: 'seek', value: seconds }), '*');
          } catch (err) {}
        }
      });
    } catch (e) {
      console.warn('[Iframe Seek Error]:', e);
    }

    // 3. Smooth scroll up to player
    try {
      const playerWrapper = document.getElementById('player-root') || 
                            document.querySelector('.mega-player-wrapper') || 
                            document.querySelector('media-player') || 
                            document.querySelector('#video-player') ||
                            document.querySelector('iframe');
      if (playerWrapper) {
        playerWrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (e) {}
  }

  window.animetsuSeekPlayer = seekAllActivePlayers;

  // Global Click Delegation: Handle any click on a timestamp (Zero DOM tampering to prevent React crashes)
  document.addEventListener('click', (e) => {
    if (!e.target) return;
    // 1. Direct match on .animetsu-timestamp or [data-time] or .timestamp
    const stampEl = e.target.closest?.('.animetsu-timestamp, [data-time], .timestamp');
    if (stampEl) {
      const timeSec = Number(stampEl.getAttribute('data-time') || stampEl.dataset?.time);
      if (!isNaN(timeSec) && timeSec >= 0) {
        e.preventDefault();
        e.stopPropagation();
        seekAllActivePlayers(timeSec);
        return;
      }
    }

    // 2. Click on any element containing timestamp inside comments or discussions
    const text = e.target.textContent?.trim() || '';
    if (text) {
      const m = text.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
      if (m) {
        const parsed = parseTimestampToSeconds(m[1]);
        if (parsed > 0) {
          seekAllActivePlayers(parsed);
        }
      }
    }
  }, true);

  // Expose global engine
  window.AnimetsuClientEngine = {
    getClientAnimeInfo,
    getClientInfo: getClientAnimeInfo,
    getClientAnimeEpisodes,
    getClientEpisodes: getClientAnimeEpisodes,
    getClientSchedule,
    getClientRecent,
    getClientHome,
    getClientSearch,
    saveWatchProgress,
    seekPlayer: seekAllActivePlayers
  };
  window.AnimetsuClientApi = window.AnimetsuClientEngine;

  console.log('🚀 [Animetsu] Client-Side Multi-Source Engine, Crowdsourced Cache & Universal Timestamp Controller Active!');
})();
