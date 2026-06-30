// Vercel serverless function — /api/bell
// «Не дзвони у дзвіночок» — реактивна гра на двох (Upstash Redis state).
//
// Механіка (узгоджено з Олексієм):
//   - Дзвіночок під стаканчиком. У кожного 3 ♥.
//   - Після старту автоматична анімація: руки по черзі "торкаються" стаканчика
//     (beat), темп зростає (інтервал між beat скорочується).
//   - Гравець керує лише своїми двома кнопками:
//       💚 raise — на своєму НАСТУПНОМУ beat рука підіймає стаканчик → дзвіночок видно.
//       🛑 stop  — на своєму наступному beat рука НЕ торкається (захист).
//   - Як підняв X — небезпечний beat = наступний (опонента Y). Якщо Y не натиснув 🛑
//     на цей beat → 🔔 дзвінок → Y втрачає ♥. Якщо встиг 🛑 → захист, темп reset, гра триває.
//   - Хто перший втратив усі 3 ♥ — програв.
//   - Cooldown 3с PER-BUTTON (варіант A): натиснув 💚 → замерзає лише 💚, 🛑 ще працює.
//   - Стаканчик — ресурс на двох: 💚 first-click-wins; другий впусту (але cooldown йде).
//
// Resolution — лінива, server-authoritative: на кожному GET/POST сервер рахує
//   поточний beat від roundStartAt і вирішує підняття/дзвінок/захист.
//
// Actions:
//   GET  /api/bell?room=<id>                         → read (advance) state
//   POST { action, room, playerId, ... }
//     join   {name}   → assign slot p1/p2/observer
//     ready           → проголосувати "почати"; коли обидва → старт раунду
//     raise           → підняти стаканчик на своєму наступному beat
//     stop            → пропустити свій наступний beat (захист)
//     rename {name}
//     rematch         → reset ♥ + lobby (рестарт матчу)
//     leave

const STATE_KEY_PREFIX = 'bell:room:';
const DEFAULT_ROOM = 'default';
const STATE_TTL_SEC = 60 * 60 * 24; // 24 год

// --- ігрові константи ---
const HEARTS_START = 3;
const SPEED = { start: 1500, step: 70, min: 820 }; // інтервал beat, мс
const COOLDOWN_MS = 3000;
const RING_PAUSE_MS = 1800;
const INITIAL_LEAD = 1800; // "Готуйсь" перед першим beat
const RESTART_LEAD = 1200; // пауза перед новим прогоном після reset темпу
const SAFETY_BEATS = 200000;

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
    hearts: { p1: HEARTS_START, p2: HEARTS_START },
    phase: 'lobby', // lobby | playing | ringpause | gameover
    round: 0,
    starter: 'p1', // хто торкається на beat 0 поточного прогону
    startVotes: { p1: false, p2: false },
    roundStartAt: null, // ms; може бути у майбутньому (lead)
    cup: null, // { raisedBy, raiseBeat, dangerBeat, resolved }
    stops: { p1: null, p2: null }, // beat який гравець пропускає
    cooldown: { p1: { raise: 0, stop: 0 }, p2: { raise: 0, stop: 0 } },
    lastEvent: null, // { type, loser?, by?, at }
    pauseUntil: null,
    winner: null,
    speed: SPEED,
    updatedAt: new Date().toISOString(),
  };
}

async function readState(room) {
  const key = STATE_KEY_PREFIX + room;
  const { result } = await redisCmd(['GET', key]);
  if (!result) return emptyState();
  try {
    const s = JSON.parse(result);
    if (!s.speed) s.speed = SPEED; // міграція
    return s;
  } catch {
    return emptyState();
  }
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

const other = (slot) => (slot === 'p1' ? 'p2' : 'p1');

// --- beat-арифметика (детермінована від roundStartAt) ---
function intervalAt(b, speed) {
  return Math.max(speed.min, speed.start - b * speed.step);
}
// час початку beat b (мс)
function beatStartMs(roundStartAt, b, speed) {
  let t = roundStartAt;
  for (let k = 0; k < b; k++) t += intervalAt(k, speed);
  return t;
}
// поточний beat у момент now
function currentBeat(roundStartAt, now, speed) {
  if (roundStartAt == null) return 0;
  let t = roundStartAt;
  let b = 0;
  while (b < SAFETY_BEATS) {
    const iv = intervalAt(b, speed);
    if (t + iv > now) return b;
    t += iv;
    b++;
  }
  return b;
}
// найближчий МАЙБУТНІЙ beat гравця (beatStart > now)
function nextOwnBeat(state, player, now) {
  let b = currentBeat(state.roundStartAt, now, state.speed);
  for (let i = 0; i < SAFETY_BEATS; i++) {
    const bs = beatStartMs(state.roundStartAt, b, state.speed);
    const owner = b % 2 === 0 ? state.starter : other(state.starter);
    if (bs > now && owner === player) return b;
    b++;
  }
  return b;
}

// почати новий прогін (зберігає ♥; toggleStarter — чергувати хто перший)
function beginRun(state, now, lead, toggleStarter) {
  if (toggleStarter) state.starter = other(state.starter);
  state.round++;
  state.roundStartAt = now + lead;
  state.cup = null;
  state.stops = { p1: null, p2: null };
  state.phase = 'playing';
  state.pauseUntil = null;
}

// лінива резолюція; повертає true якщо стейт змінився
function advance(state, now) {
  let dirty = false;

  // вийти з паузи після дзвінка → новий прогін з reset темпу
  if (state.phase === 'ringpause' && state.pauseUntil != null && now >= state.pauseUntil) {
    beginRun(state, now, RESTART_LEAD, true);
    dirty = true;
  }

  if (state.phase === 'playing' && state.cup && !state.cup.resolved) {
    const cb = currentBeat(state.roundStartAt, now, state.speed);
    if (cb >= state.cup.dangerBeat) {
      const X = state.cup.raisedBy; // підняв
      const Y = other(X); // у небезпеці
      state.cup.resolved = true;
      dirty = true;
      if (state.stops[Y] === state.cup.dangerBeat) {
        // захистився
        state.lastEvent = { type: 'defended', by: Y, at: now };
        beginRun(state, now, RESTART_LEAD, true);
      } else {
        // 🔔 дзвінок
        state.hearts[Y] = Math.max(0, state.hearts[Y] - 1);
        if (state.hearts[Y] <= 0) {
          state.phase = 'gameover';
          state.winner = X;
          state.lastEvent = { type: 'ring', loser: Y, fatal: true, at: now };
          state.roundStartAt = null;
        } else {
          state.phase = 'ringpause';
          state.pauseUntil = now + RING_PAUSE_MS;
          state.lastEvent = { type: 'ring', loser: Y, at: now };
        }
      }
    }
  }

  return dirty;
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
    const now = Date.now();

    if (req.method === 'GET') {
      let state = await readState(room);
      const dirty = advance(state, now);
      if (dirty) state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, now });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;
    const playerId = String(body.playerId || '').slice(0, 64);
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId required' });

    let state = await readState(room);
    advance(state, now); // спершу довести стейт до актуального

    const slotOf = () => (state.p1?.id === playerId ? 'p1' : state.p2?.id === playerId ? 'p2' : null);

    if (action === 'join') {
      const name = sanitizeName(body.name);
      if (state.p1?.id === playerId) state.p1.name = name;
      else if (state.p2?.id === playerId) state.p2.name = name;
      else if (!state.p1) state.p1 = { id: playerId, name };
      else if (!state.p2) state.p2 = { id: playerId, name };
      else return res.status(200).json({ ok: true, state, slot: 'observer', now });
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, slot: slotOf(), now });
    }

    if (action === 'rename') {
      const slot = slotOf();
      if (!slot) return res.status(403).json({ ok: false, error: 'not in this room' });
      state[slot].name = sanitizeName(body.name);
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, now });
    }

    if (action === 'ready') {
      const slot = slotOf();
      if (!slot) return res.status(403).json({ ok: false, error: 'not in this room' });
      if (state.phase !== 'lobby') return res.status(200).json({ ok: true, state, now });
      state.startVotes[slot] = true;
      if (state.p1 && state.p2 && state.startVotes.p1 && state.startVotes.p2) {
        state.hearts = { p1: HEARTS_START, p2: HEARTS_START };
        state.starter = 'p1';
        state.winner = null;
        state.lastEvent = null;
        state.cooldown = { p1: { raise: 0, stop: 0 }, p2: { raise: 0, stop: 0 } };
        beginRun(state, now, INITIAL_LEAD, false);
        state.round = 1;
      }
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, now });
    }

    if (action === 'raise' || action === 'stop') {
      const slot = slotOf();
      if (!slot) return res.status(403).json({ ok: false, error: 'not in this room' });
      if (state.phase !== 'playing' || state.roundStartAt == null) {
        return res.status(200).json({ ok: true, state, now, ignored: 'not-playing' });
      }
      const btn = action === 'raise' ? 'raise' : 'stop';
      const cdLeft = state.cooldown[slot][btn] + COOLDOWN_MS - now;
      if (cdLeft > 0) {
        return res.status(200).json({ ok: true, state, now, ignored: 'cooldown', cooldownLeft: cdLeft });
      }
      state.cooldown[slot][btn] = now;
      const b = nextOwnBeat(state, slot, now);
      if (action === 'raise') {
        // стаканчик ще не піднятий → перший хто натиснув піднімає (first-click-wins)
        if (!state.cup) {
          state.cup = { raisedBy: slot, raiseBeat: b, dangerBeat: b + 1, resolved: false };
        }
        // інакше — впусту, але cooldown вже зафіксовано вище
      } else {
        state.stops[slot] = b; // пропустити цей beat
      }
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, now });
    }

    if (action === 'rematch') {
      if (!slotOf()) return res.status(403).json({ ok: false, error: 'not in this room' });
      const keep = { p1: state.p1, p2: state.p2 };
      state = emptyState();
      state.p1 = keep.p1;
      state.p2 = keep.p2;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, now });
    }

    if (action === 'leave') {
      if (state.p1?.id === playerId) state.p1 = null;
      else if (state.p2?.id === playerId) state.p2 = null;
      if (!state.p1 && !state.p2) state = emptyState();
      else {
        // лишився один — у лоббі
        state.phase = 'lobby';
        state.startVotes = { p1: false, p2: false };
        state.cup = null;
        state.roundStartAt = null;
        state.winner = null;
      }
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, now });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('bell error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
