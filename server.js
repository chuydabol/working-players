// server.js — minimal EA aggregator like the original

const express = require('express');
const path = require('path');
const cors = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// --- Static + CORS ---
app.use(cors());
app.use(express.static(path.join(__dirname)));

// Optional local fallback (used only if EA fails everywhere)
let localPlayers = null;
try { localPlayers = require('./players.json'); } catch { /* optional */ }

// --- Config: default club list (override via env LEAGUE_CLUB_IDS) ---
const DEFAULT_CLUB_IDS = (process.env.LEAGUE_CLUB_IDS || `
576007,4933507,2491998,1969494,2086022,2462194,5098824,4869810,1527486,
4824736,481847,3050467,4154835,3638105,55408,4819681,35642
`).split(',').map(s => s.trim()).filter(Boolean);

// --- Fetch helpers (Node 18 has global fetch; fallback to node-fetch) ---
const fetch = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const controller = (global.AbortController) ? new AbortController() : null;
  const id = setTimeout(() => {
    if (controller) controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller ? controller.signal : undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 UPCL-LeagueBot/1.0',
        ...(opts.headers || {})
      }
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function retry(fn, attempts = 2, backoffMs = 400) {
  let lastErr;
  for (let i = 0; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i === attempts) break;
      await new Promise(r => setTimeout(r, backoffMs * (i + 1)));
    }
  }
  throw lastErr;
}

// --- Simple concurrency limiter so we don’t hammer EA ---
let inFlight = 0;
const MAX_CONCURRENCY = 3;
const queue = [];
function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      inFlight++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        inFlight--;
        const next = queue.shift();
        if (next) next();
      }
    };
    if (inFlight < MAX_CONCURRENCY) run();
    else queue.push(run);
  });
}

// --- Tiny caches (60s) ---
const CLUB_CACHE_TTL = 60_000;
const PLAYERS_CACHE_TTL = 60_000;
const clubCache = new Map(); // clubId -> {at, data}
let playersCache = { at: 0, data: null };

// --- EA calls ---
async function fetchPlayersForClub(clubId) {
  const cached = clubCache.get(clubId);
  if (cached && (Date.now() - cached.at) < CLUB_CACHE_TTL) return cached.data;

  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${encodeURIComponent(clubId)}`;
  const json = await retry(
    () => limit(async () => {
      const res = await fetchWithTimeout(url, {}, 10_000);
      if (!res.ok) throw new Error(`EA ${res.status} for club ${clubId}`);
      return res.json();
    }),
    2 // retries
  );

  clubCache.set(clubId, { at: Date.now(), data: json });
  return json;
}

// Role helper (optional)
function getRoleFromPosition(posId) {
  const n = Number(posId);
  if (!Number.isFinite(n)) return 'Unknown';
  if (n === 0) return 'Goalkeeper';
  if ([1,2,3,4,5,6].includes(n)) return 'Defender';
  if ([7,8,9,10,11,12,13,14,15].includes(n)) return 'Midfielder';
  if (n >= 16 && n <= 27) return 'Forward';
  return 'Unknown';
}

// --- Routes ---

// 1) Per-club proxy (useful for club panels)
app.get('/api/ea/clubs/:clubId/members', async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(String(clubId))) {
    return res.status(400).json({ error: 'Invalid clubId' });
  }
  try {
    const raw = await fetchPlayersForClub(clubId);
    let members = [];
    if (Array.isArray(raw)) members = raw;
    else if (Array.isArray(raw?.members)) members = raw.members;
    else if (raw?.members && typeof raw.members === 'object') members = Object.values(raw.members);
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ members });
  } catch (err) {
    const msg = err?.message || String(err);
    const status = /abort|timeout|timed out|ETIMEDOUT/i.test(msg) ? 504 : 502;
    return res.status(status).json({ error: 'EA API request failed', details: msg });
  }
});

// 2) League-wide aggregated players (the “original” behavior)
//    - No query required. Aggregates DEFAULT_CLUB_IDS by default.
//    - Returns { members: [...] } (unique by name), same as your old project.
app.get('/api/players', async (req, res) => {
  try {
    // Allow optional override via ?clubIds=1,2,3
    const q = req.query.clubId || req.query.clubIds || req.query.ids || '';
    let clubIds = Array.isArray(q) ? q : String(q).split(',').map(s => s.trim()).filter(Boolean);
    if (!clubIds.length) clubIds = DEFAULT_CLUB_IDS.slice();

    // short-circuit cache
    if (playersCache.data && (Date.now() - playersCache.at) < PLAYERS_CACHE_TTL) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(playersCache.data);
    }

    const results = await Promise.all(clubIds.map(id =>
      fetchPlayersForClub(id).catch(err => {
        if (NODE_ENV !== 'test') console.error('[EA]', id, err?.message || err);
        return null;
      })
    ));

    const allMembers = [];
    for (const raw of results) {
      if (!raw) continue;
      let members = [];
      if (Array.isArray(raw)) members = raw;
      else if (Array.isArray(raw?.members)) members = raw.members;
      else if (raw?.members && typeof raw.members === 'object') members = Object.values(raw.members);
      allMembers.push(...members);
    }

    // Unify by visible name
    const unique = new Map();
    for (const p of allMembers) {
      const name = p?.name || p?.playername || p?.personaName;
      if (!name || unique.has(name)) continue;
      const posId = p?.proPos ?? p?.preferredPosition ?? p?.position ?? null;
      unique.set(name, { ...p, name, role: getRoleFromPosition(posId) });
    }

    const payload = { members: Array.from(unique.values()) };

    // Cache + headers
    playersCache = { at: Date.now(), data: payload };
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(payload);
  } catch (err) {
    // Fallback to local file if present
    if (localPlayers) return res.json(localPlayers);
    return res.status(500).json({ error: 'Failed to fetch players', details: err?.message || String(err) });
  }
});

// 3) Simple health
app.get('/api/status', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// 4) Static index (optional)
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- Start ---
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (process.env.LEAGUE_CLUB_IDS) {
    console.log(`Using LEAGUE_CLUB_IDS: ${process.env.LEAGUE_CLUB_IDS}`);
  } else {
    console.log('Using built-in DEFAULT_CLUB_IDS (set LEAGUE_CLUB_IDS to override).');
  }
});
