// Vercel serverless function — /api/rps
// RPS network game state у Upstash Redis (reuse KV з prototype-lab integration).
//
// Actions:
//   GET  /api/rps?room=<roomid>                  → read state
//   POST /api/rps { action, room, playerId, ... } → mutate state
//     - action: "join"     {name}                       → assign slot p1/p2/observer
//     - action: "choose"   {choice}                     → set my choice
//     - action: "rename"   {name}                       → update my name
//     - action: "next"                                  → reset choices, round++
//     - action: "reset"                                 → reset all (score+round)
//
// State shape:
//   {
//     p1: { id, name, choice }  or null
//     p2: { id, name, choice }  or null
//     round: number,
//     score: { p1, p2, tie },
//     updatedAt: ISO
//   }

const STATE_KEY_PREFIX = 'rps:room:';
const DEFAULT_ROOM = 'default';
const STATE_TTL_SEC = 60 * 60 * 24; // 24 год без активності → auto-cleanup

function kvCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash Redis env vars not set');
  return { url: url.replace(/\/+$/, ''), token };
}

async function redisCmd(cmd) {
  const { url, token } = kvCfg();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`KV ${cmd[0]} failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

function emptyState() {
  return {
    p1: null,
    p2: null,
    round: 1,
    score: { p1: 0, p2: 0, tie: 0 },
    updatedAt: new Date().toISOString(),
  };
}

async function readState(room) {
  const key = STATE_KEY_PREFIX + room;
  const { result } = await redisCmd(['GET', key]);
  if (!result) return emptyState();
  try { return JSON.parse(result); } catch { return emptyState(); }
}

async function writeState(room, state) {
  state.updatedAt = new Date().toISOString();
  const key = STATE_KEY_PREFIX + room;
  await redisCmd(['SET', key, JSON.stringify(state), 'EX', STATE_TTL_SEC]);
  return state;
}

const VALID_CHOICES = new Set(['rock', 'paper', 'scissors']);
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function sanitizeName(n) {
  return String(n || '').slice(0, 16).replace(/[<>"'&`]/g, '').trim() || 'Гравець';
}

function maybeResolveRound(state) {
  // Якщо обидва зробили вибір — нараховуємо очко
  if (state.p1?.choice && state.p2?.choice) {
    if (state.p1.choice === state.p2.choice) state.score.tie++;
    else if (BEATS[state.p1.choice] === state.p2.choice) state.score.p1++;
    else state.score.p2++;
    // не зачищаємо choices — фронт побачить reveal, тоді натисне "next"
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const room = (url.searchParams.get('room') || DEFAULT_ROOM).slice(0, 40);

    // GET — read only
    if (req.method === 'GET') {
      const state = await readState(room);
      return res.status(200).json({ ok: true, state });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;
    const playerId = String(body.playerId || '').slice(0, 64);
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId required' });

    let state = await readState(room);

    if (action === 'join') {
      const name = sanitizeName(body.name);
      // Якщо вже у грі — повертаємо slot
      if (state.p1?.id === playerId) state.p1.name = name;
      else if (state.p2?.id === playerId) state.p2.name = name;
      else if (!state.p1) state.p1 = { id: playerId, name, choice: null };
      else if (!state.p2) state.p2 = { id: playerId, name, choice: null };
      else {
        // обидва слоти зайняті — observer (не записуємо у state)
        return res.status(200).json({ ok: true, state, slot: 'observer' });
      }
      state = await writeState(room, state);
      const slot = state.p1?.id === playerId ? 'p1' : 'p2';
      return res.status(200).json({ ok: true, state, slot });
    }

    if (action === 'choose') {
      const c = body.choice;
      if (!VALID_CHOICES.has(c)) return res.status(400).json({ ok: false, error: 'invalid choice' });
      let slot = null;
      if (state.p1?.id === playerId) slot = 'p1';
      else if (state.p2?.id === playerId) slot = 'p2';
      else return res.status(403).json({ ok: false, error: 'not in this room' });
      if (state[slot].choice) {
        // вже обрав — ігноруємо повторний вибір цього раунду
        return res.status(200).json({ ok: true, state, slot });
      }
      state[slot].choice = c;
      maybeResolveRound(state);
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, slot });
    }

    if (action === 'rename') {
      const name = sanitizeName(body.name);
      if (state.p1?.id === playerId) state.p1.name = name;
      else if (state.p2?.id === playerId) state.p2.name = name;
      else return res.status(403).json({ ok: false, error: 'not in this room' });
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'next') {
      // тільки якщо гравець у грі
      if (state.p1?.id !== playerId && state.p2?.id !== playerId) {
        return res.status(403).json({ ok: false, error: 'not in this room' });
      }
      if (state.p1) state.p1.choice = null;
      if (state.p2) state.p2.choice = null;
      state.round++;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'reset') {
      if (state.p1?.id !== playerId && state.p2?.id !== playerId) {
        return res.status(403).json({ ok: false, error: 'not in this room' });
      }
      state.score = { p1: 0, p2: 0, tie: 0 };
      state.round = 1;
      if (state.p1) state.p1.choice = null;
      if (state.p2) state.p2.choice = null;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'leave') {
      // звільнити свій slot — інша людина зможе зайти
      if (state.p1?.id === playerId) state.p1 = null;
      else if (state.p2?.id === playerId) state.p2 = null;
      // якщо обидва вийшли — повний reset
      if (!state.p1 && !state.p2) state = emptyState();
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('rps error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
