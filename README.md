# Кодомандри · Ігри на двох

Колекція маленьких мережевих ігор для уроків Кодомандрів. Двоє учнів заходять з різних пристроїв на одне URL, грають у тій самій кімнаті. State синхронізується через Upstash Redis (KV) на Vercel-бекенді. Polling 1.5s (без WebSocket — простіше і досить швидко для класного формату).

## Ігри

| Гра | Live | Опис |
|---|---|---|
| 🪨 Камінь · Ножиці · Папір | ✅ `/rps` | Швидка класика, ~30 сек на раунд |
| ❌⭕ Хрестики Нулики | 🔜 `/tic-tac-toe` | 3×3 turn-based |
| 🧠 Пам'ять | 🔜 `/memory` | Знайди пари (з Minecraft-блоками) |
| 🚢 Морський Бій | 🔜 `/battleship` | 6×6, 4 кораблі, спрощений |

## Live

- **Hub (вибір гри):** https://kodomandry-games.vercel.app/
- **Custom room:** додай `?room=<code>` до URL гри (наприклад `/rps?room=alex-vs-bob`) для приватної кімнати

Всі учасники з однаковим `room` грають у одній кімнаті. Перший заходить = `p1`, другий = `p2`, третій+ = observer (read-only).

Старий URL `kodomandry-rps.vercel.app` продовжує працювати як alias.

## Стек

| Шар | Що |
|---|---|
| Frontend | Один HTML файл на гру, vanilla JS, polling 1.5s |
| Backend | Vercel serverless (`api/<game>.js`), Node 24 runtime |
| State | Upstash Redis (KV), TTL 24h |
| Hosting | Vercel (free) |

## Файли

```
kodomandry-games/
├── index.html              landing з вибором гри
├── rps/index.html          UI камінь-ножиці-папір
├── tic-tac-toe/index.html  (TBD)
├── memory/index.html       (TBD)
├── battleship/index.html   (TBD)
├── api/
│   ├── rps.js              serverless для RPS
│   ├── tictactoe.js        (TBD)
│   ├── memory.js           (TBD)
│   └── battleship.js       (TBD)
├── shared/                 спільні стилі/helpers (TBD)
├── vercel.json             cleanUrls + rewrites
└── README.md
```

## RPS — API контракт

```
GET  /api/rps?room=<id>                         → { ok, state }
POST /api/rps   { action, playerId, room?, ... }
   action: "join"   {name}        → { ok, state, slot: 'p1'|'p2'|'observer' }
   action: "choose" {choice}      → { ok, state, slot }   choice ∈ {rock, paper, scissors}
   action: "rename" {name}        → { ok, state }
   action: "next"                 → { ok, state }   reset choices, round++
   action: "reset"                → { ok, state }   reset score + round
   action: "leave"                → { ok, state }   звільнити slot
```

State shape:

```json
{
  "p1": { "id": "p_xxx", "name": "Alex", "choice": "rock" },
  "p2": { "id": "p_yyy", "name": "Bob",  "choice": null },
  "round": 5,
  "score": { "p1": 2, "p2": 1, "tie": 1 },
  "updatedAt": "2026-06-06T08:00:00.000Z"
}
```

## Env (Vercel project settings)

```
UPSTASH_REDIS_REST_URL=https://<your-instance>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<token>
```

Альтернативні імена (теж читаються, для сумісності з Vercel marketplace):

```
KV_REST_API_URL
KV_REST_API_TOKEN
```

## Local dev

```bash
npm i -g vercel
vercel dev   # запустить локально + emulator серверлеса
```

Якщо нема Upstash локально — або підтягни prod env (`vercel env pull`), або set `UPSTASH_REDIS_REST_URL` руками у `.env.local`.

## Походження

- 2026-05-29 — прототип RPS у Andrew/Sales Analytics prototype-lab
- 2026-05-30 — перенесено у standalone `kodomandry-rps` repo + Vercel + власний Upstash
- 2026-06-06 — rename `kodomandry-rps` → `kodomandry-games`, додано landing-hub + skeleton для 3 нових ігор (tic-tac-toe / memory / battleship)
