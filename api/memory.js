// Vercel serverless function — /api/memory
// Memory (знайди пару) network game state у Upstash Redis.
//
// 4×4 board (16 карток = 8 пар), Minecraft-блоки emoji.
// Гравці по черзі: перевертаєш 2 картки. Match → твої + ще хід.
// No-match → видно ~3 сек обом, потім ховаються і хід наступного.
//
// Actions:
//   GET  /api/memory?room=<roomid>                  → read state (lazy-clears expired peek)
//   POST /api/memory { action, room, playerId, ... } → mutate
//     - action: "join"   {name}        → assign slot p1 / p2 / observer
//     - action: "flip"   {idx}         → перевернути картку (0..15)
//     - action: "rename" {name}        → update my name
//     - action: "new"                  → re-shuffle, reset board, alternate first
//     - action: "reset"                → reset усе (score + round)
//     - action: "leave"                → звільнити slot
//
// State:
//   {
//     p1, p2: { id, name } | null,
//     cards: [ {emoji, owner: null|'p1'|'p2'} × 16 ],
//     peekFirst: null | idx,                 // перша перевернута картка цього ходу
//     peekTwo:   null | [i1, i2],            // після no-match: обидві видно ~3с
//     peekUntil: null | ms-timestamp,        // коли peekTwo автоhide-ся
//     turn: 'p1' | 'p2',
//     first: 'p1' | 'p2',                    // хто починає поточний раунд (чергується)
//     round: number,
//     score: { p1, p2 },
//     winner: null | 'p1' | 'p2' | 'tie',
//     updatedAt: ISO,
//   }

const STATE_KEY_PREFIX = 'mem:room:';
const DEFAULT_ROOM = 'default';
const STATE_TTL_SEC = 60 * 60 * 24;
const PEEK_MS = 3000;
const TILES = ['🧱', '⛏️', '💎', '🌳', '🐔', '💧', '⚙️', '🐺'];

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

function shuffleCards() {
  const all = [];
  for (const t of TILES) {
    all.push({ emoji: t, owner: null });
    all.push({ emoji: t, owner: null });
  }
  // Fisher-Yates
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function emptyState() {
  return {
    p1: null,
    p2: null,
    cards: shuffleCards(),
    peekFirst: null,
    peekTwo: null,
    peekUntil: null,
    turn: 'p1',
    first: 'p1',
    round: 1,
    score: { p1: 0, p2: 0 },
    winner: null,
    updatedAt: new Date().toISOString(),
  };
}

function lazyExpirePeek(state) {
  // Якщо peek timeout пройшов — ховаємо картки і swap turn
  if (state.peekTwo && state.peekUntil && Date.now() >= state.peekUntil) {
    state.peekTwo = null;
    state.peekUntil = null;
    state.turn = state.turn === 'p1' ? 'p2' : 'p1';
  }
}

function checkGameOver(state) {
  // Усі картки забрані?
  if (state.cards.every(c => c.owner !== null)) {
    const { p1, p2 } = state.score;
    if (p1 > p2) state.winner = 'p1';
    else if (p2 > p1) state.winner = 'p2';
    else state.winner = 'tie';
  }
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

function sanitizeName(n) {
  return String(n || '').slice(0, 16).replace(/[<>"'&`]/g, '').trim() || 'Гравець';
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

    if (req.method === 'GET') {
      let state = await readState(room);
      const wasPeek = !!state.peekTwo;
      lazyExpirePeek(state);
      if (wasPeek && !state.peekTwo) {
        // expire was just applied → persist
        state = await writeState(room, state);
      }
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
    lazyExpirePeek(state);

    if (action === 'join') {
      const name = sanitizeName(body.name);
      if (state.p1?.id === playerId) state.p1.name = name;
      else if (state.p2?.id === playerId) state.p2.name = name;
      else if (!state.p1) state.p1 = { id: playerId, name };
      else if (!state.p2) state.p2 = { id: playerId, name };
      else {
        return res.status(200).json({ ok: true, state, slot: 'observer' });
      }
      state = await writeState(room, state);
      const slot = state.p1?.id === playerId ? 'p1' : 'p2';
      return res.status(200).json({ ok: true, state, slot });
    }

    if (action === 'flip') {
      const idx = Number.isInteger(body.idx) ? body.idx : -1;
      if (idx < 0 || idx > 15) {
        return res.status(400).json({ ok: false, error: 'idx must be 0..15' });
      }
      let slot = null;
      if (state.p1?.id === playerId) slot = 'p1';
      else if (state.p2?.id === playerId) slot = 'p2';
      else return res.status(403).json({ ok: false, error: 'not in this room' });

      if (!state.p1 || !state.p2) return res.status(409).json({ ok: false, error: 'wait for second player', state });
      if (state.winner) return res.status(409).json({ ok: false, error: 'game over', state });
      if (state.peekTwo) return res.status(409).json({ ok: false, error: 'wait until peek clears', state });
      if (state.turn !== slot) return res.status(409).json({ ok: false, error: 'not your turn', state });
      if (state.cards[idx].owner !== null) return res.status(409).json({ ok: false, error: 'card taken', state });
      if (state.peekFirst === idx) return res.status(409).json({ ok: false, error: 'pick a different card', state });

      if (state.peekFirst === null) {
        // Перша картка цього ходу
        state.peekFirst = idx;
      } else {
        // Друга картка — порівнюємо
        const i1 = state.peekFirst;
        const i2 = idx;
        if (state.cards[i1].emoji === state.cards[i2].emoji) {
          // MATCH
          state.cards[i1].owner = slot;
          state.cards[i2].owner = slot;
          state.score[slot]++;
          state.peekFirst = null;
          // Перевіряємо game-over
          checkGameOver(state);
          // Якщо НЕ game-over — тот же гравець продовжує (turn НЕ swap)
        } else {
          // NO-MATCH — peek visible ~3s, потім автоhide + swap turn
          state.peekFirst = null;
          state.peekTwo = [i1, i2];
          state.peekUntil = Date.now() + PEEK_MS;
        }
      }
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

    if (action === 'new') {
      if (state.p1?.id !== playerId && state.p2?.id !== playerId) {
        return res.status(403).json({ ok: false, error: 'not in this room' });
      }
      state.cards = shuffleCards();
      state.peekFirst = null;
      state.peekTwo = null;
      state.peekUntil = null;
      state.winner = null;
      state.round++;
      state.first = state.first === 'p1' ? 'p2' : 'p1';
      state.turn = state.first;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'reset') {
      if (state.p1?.id !== playerId && state.p2?.id !== playerId) {
        return res.status(403).json({ ok: false, error: 'not in this room' });
      }
      state.cards = shuffleCards();
      state.peekFirst = null;
      state.peekTwo = null;
      state.peekUntil = null;
      state.turn = 'p1';
      state.first = 'p1';
      state.round = 1;
      state.score = { p1: 0, p2: 0 };
      state.winner = null;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'leave') {
      if (state.p1?.id === playerId) state.p1 = null;
      else if (state.p2?.id === playerId) state.p2 = null;
      if (!state.p1 && !state.p2) state = emptyState();
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('memory error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
