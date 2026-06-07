# Кодомандри · Ігри на двох

Колекція маленьких мережевих ігор для уроків Кодомандрів. Двоє учнів заходять з різних пристроїв на одне URL, грають у тій самій кімнаті. State синхронізується через Upstash Redis (KV) на Vercel-бекенді. Polling 1.3–1.5s (без WebSocket — простіше і досить швидко для класного формату).

## 🎮 Ігри (всі live з 2026-06-06)

| Гра | URL | Опис |
|---|---|---|
| 🪨 Камінь · Ножиці · Папір | [`/rps`](https://kodomandry-games.vercel.app/rps) | Швидка класика, ~30 сек на раунд |
| ❌⭕ Хрестики Нулики | [`/tic-tac-toe`](https://kodomandry-games.vercel.app/tic-tac-toe) | 3×3 turn-based, X=синій, O=зелений |
| 🧠 Пам'ять | [`/memory`](https://kodomandry-games.vercel.app/memory) | 4×4 (16 карток, 8 пар) з Minecraft-блоками |
| 🚢 Морський Бій | [`/battleship`](https://kodomandry-games.vercel.app/battleship) | 6×6, 4 кораблі (3·2·2·1), спрощений |

## 🌐 Live

- **Hub (вибір гри):** https://kodomandry-games.vercel.app/
- **Альтернативний URL:** https://kodomandry-rps.vercel.app/ (alias з часів коли був тільки RPS, продовжує працювати)
- **Custom room:** додай `?room=<code>` до URL гри (наприклад `/rps?room=alex-vs-bob`) для приватної кімнати

Всі учасники з однаковим `room` грають у одній кімнаті. Перший заходить = `p1`, другий = `p2`, третій+ = observer (read-only).

## 🛠 Стек

| Шар | Що |
|---|---|
| Frontend | Один HTML файл на гру, vanilla JS, polling 1.3-1.5s |
| Backend | Vercel serverless (`api/<game>.js`), Node 24 runtime |
| State | Upstash Redis (KV), TTL 24h |
| Hosting | Vercel free tier |
| Repo | https://github.com/asemelinsky/kodomandry-games |

## 📁 Структура

```
kodomandry-games/
├── index.html              landing з 4 картками (1 row = 2 ігри)
├── rps/index.html          UI Камінь·Ножиці·Папір
├── tic-tac-toe/index.html  UI Хрестики Нулики
├── memory/index.html       UI Пам'ять
├── battleship/index.html   UI Морський Бій
├── api/
│   ├── rps.js              serverless RPS
│   ├── tictactoe.js        serverless TTT
│   ├── memory.js           serverless Memory
│   └── battleship.js       serverless Battleship
├── shared/                 (зарезервовано під спільні assets, поки порожнє)
├── reports/                changelogs + decision history
├── vercel.json             cleanUrls + rewrites per game
└── README.md
```

## 🔧 Спільні патерни

Всі 4 ігри використовують один і той же підхід:

- **Player identity:** UUID у `localStorage` (`<game>-player-id`) → refresh не вибиває з кімнати
- **Slot assignment:** перший заходить = `p1`, другий = `p2`, третій+ = observer (read-only)
- **State у KV** з префіксом per гра: `rps:room:`, `ttt:room:`, `mem:room:`, `bs:room:`
- **TTL 24 год** без активності → auto-cleanup
- **Polling 1.3-1.5s** через GET → клієнт переписує локальний state
- **Optimistic POST** на дії (move, shoot, flip) → server валідує + повертає новий state

## 🪨 RPS — API контракт

```
GET  /api/rps?room=<id>                         → { ok, state }
POST /api/rps   { action, playerId, room?, ... }
   action: "join"   {name}        → { ok, state, slot: 'p1'|'p2'|'observer' }
   action: "choose" {choice}      → { ok, state, slot }   choice ∈ {rock, paper, scissors}
   action: "rename" {name}        → { ok, state }
   action: "next"                 → { ok, state }   reset choices, round++
   action: "reset"                → { ok, state }   reset score + round
   action: "leave"                → { ok, state }
```

State:
```json
{
  "p1": { "id", "name", "choice": "rock"|null },
  "p2": { "id", "name", "choice": "paper"|null },
  "round": 5,
  "score": { "p1": 2, "p2": 1, "tie": 1 },
  "updatedAt": "ISO"
}
```

## ❌⭕ TTT — API контракт

```
GET  /api/tictactoe?room=<id>                   → { ok, state }
POST /api/tictactoe { action, playerId, ... }
   action: "join"   {name}   → { ok, state, slot }
   action: "move"   {idx}    → { ok, state, slot }   idx ∈ 0..8 (тільки на своєму ході)
   action: "rename" {name}
   action: "next"            → reset board, round++, swap who-starts
   action: "reset"           → reset усе
   action: "leave"
```

State:
```json
{
  "p1": { "id", "name" },              // X
  "p2": { "id", "name" },              // O
  "board": [null, "X", null, ...],     // 9 cells
  "turn": "p1"|"p2",
  "first": "p1"|"p2",                  // хто починав цей раунд (чергується для fairness)
  "round": 3,
  "score": { "p1": 1, "p2": 1, "tie": 0 },
  "winner": null|"p1"|"p2"|"tie",
  "winLine": [0,4,8]|null,             // індекси виграшної лінії для highlight
  "updatedAt": "ISO"
}
```

Win-detection: 8 ліній (3 рядки + 3 стовпці + 2 діагоналі). Tie = усі 9 cells занято без win.

## 🧠 Memory — API контракт

```
GET  /api/memory?room=<id>                       → { ok, state }   (lazy-clear expired peek)
POST /api/memory { action, playerId, ... }
   action: "join"   {name}   → { ok, state, slot }
   action: "flip"   {idx}    → { ok, state, slot }   idx ∈ 0..15
   action: "rename" {name}
   action: "new"             → re-shuffle, round++, alternate first
   action: "reset"           → reset усе
   action: "leave"
```

State:
```json
{
  "p1": { "id", "name" },
  "p2": { "id", "name" },
  "cards": [ {"emoji": "💎", "owner": null|"p1"|"p2"}, ... ],   // 16 cards
  "peekFirst": null|<idx>,           // перша перевернута цього ходу
  "peekTwo":   null|[idx1, idx2],    // після no-match, видно ~3с обом
  "peekUntil": null|<ms-timestamp>,
  "turn": "p1"|"p2",
  "first": "p1"|"p2",
  "round": 2,
  "score": { "p1": 4, "p2": 4 },     // кількість зібраних пар
  "winner": null|"p1"|"p2"|"tie",
  "updatedAt": "ISO"
}
```

Логіка:
- 8 emoji × 2 = 16 карток, Fisher-Yates shuffle при join у пусту кімнату / action `new` / action `reset`
- Emoji: 🧱 ⛏ 💎 🌳 🐔 💧 ⚙️ 🐺 (Minecraft-блоки)
- Match → пара забирається (owner = slot), score++, **той самий хід продовжується**
- No-match → `peekTwo` visible 3 секунди (обом), потім автоматично hide + swap turn (lazy-expire на наступному state read)
- Win: усі 16 карток owned → переможець по сумі пар (8 загалом, 5:3 / 6:2 / 4:4=tie)

## 🚢 Battleship — API контракт

```
GET  /api/battleship?room=<id>&playerId=<id>     → { ok, state }   (server-side mask)
POST /api/battleship { action, playerId, ... }
   action: "join"        {name}            → { ok, state, slot }
   action: "randomFleet"                   → { ok, state, slot }   (server-generated)
   action: "placeFleet"  {ships: [...]}    → { ok, state, slot }   (manual, validation)
   action: "ready"                         → { ok, state, slot }   (треба fleet)
   action: "unready"                       → { ok, state, slot }   (editing mode)
   action: "shoot"       {idx}             → { ok, state, slot, hit, sunk }   idx ∈ 0..35
   action: "rename"      {name}
   action: "next"                          → новий раунд (clear fleets, phase=setup)
   action: "reset"                         → full reset
   action: "leave"
```

State (server-side, **маскується** перед відправкою клієнту):
```json
{
  "p1": {
    "id", "name",
    "ships": [ {"len": 3, "cells": [0,1,2], "hits": [true,false,false]}, ... ],
    "hitsOnMe": [bool × 36],            // мої клітинки по яким стріляли
    "ready": false
  },
  "p2": { ... },
  "shots": {
    "p1": [{"idx": 5, "hit": false}, ...],   // мої постріли по ворогу
    "p2": [...]
  },
  "phase": "setup"|"battle"|"over",
  "turn": "p1"|"p2",
  "first": "p1"|"p2",                  // alternate per round
  "round": 1,
  "score": { "p1": 0, "p2": 0 },       // виграні раунди
  "winner": null|"p1"|"p2",
  "lastShot": null|{ by, idx, hit, sunk },
  "updatedAt": "ISO"
}
```

🔒 **View masking** (важливе security детайль): server **обнуляє** `opponent.ships` перед відправкою клієнту — щоб не leakнути позиції ворожого fleet через DevTools. Видно тільки `hitsOnMe` (де ворог стояв і ваші постріли влучили) + `shots[mySlot]` (де ви стріляли). Завдяки цьому навіть з відкритими DevTools опонент не побачить непідбитих кораблів.

Логіка:
- **Setup phase:** кожен гравець розставляє fleet (4 кораблі: 1×3 + 2×2 + 1×1 = 8 cells на 6×6 grid). Найшвидше — кнопка «🎲 Випадково». Validation: всі straight (H/V), no overlap, in bounds.
- **Battle phase:** обидва `ready=true` → автоматично починається. По черзі стріляють у ворожі cells.
  - **Hit** → той же гравець стріляє ще раз (стандартне battleship rule)
  - **Miss** → swap turn
- **Win:** усі ship cells ворога hit → phase=`over`, winner=current player, score++
- **Naxt раунд** swaps `first` (fairness)

## 🔐 Env (Vercel project settings)

```
UPSTASH_REDIS_REST_URL=https://<your-instance>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<token>
```

Альтернативні імена (теж читаються, для сумісності з Vercel marketplace):

```
KV_REST_API_URL
KV_REST_API_TOKEN
```

## 🚀 Deploy

- **Auto:** push на `main` → GitHub Actions → Vercel auto-deploy (налаштовано з 2026-06-04)
- **Manual:** `vercel deploy --prod --yes --scope oleksiys-projects-1e19468f` з repo root

⚠️ Після manual `vercel deploy --prod` треба **alias rebind** (одноразовий quirk):
```bash
DEP="<deployment-url-від-deploy>"
vercel alias set $DEP kodomandry-games.vercel.app --scope oleksiys-projects-1e19468f
vercel alias set $DEP kodomandry-rps.vercel.app    --scope oleksiys-projects-1e19468f
```
GitHub auto-deploy виконує rebind сам.

## 🧪 Local dev

```bash
npm i -g vercel
vercel dev   # запустить локально + emulator серверлеса
```

Якщо нема Upstash локально — підтягни prod env (`vercel env pull`), або set `UPSTASH_REDIS_REST_URL/TOKEN` руками у `.env.local`.

## 🛡 Deployment Protection

Для нових Vercel проєктів за замовчуванням увімкнено **SSO Deployment Protection** на `*.vercel.app` aliases (`ssoProtection.deploymentType=all_except_custom_domains`). Це блокує публічний доступ до preview/staging URL — для ігор нам не треба. Відключено через API 2026-06-06:

```bash
curl -X PATCH -H "Authorization: Bearer $VTOKEN" \
  -H "Content-Type: application/json" \
  "https://api.vercel.com/v9/projects/$PROJ_ID?teamId=$TEAM_ID" \
  -d '{"ssoProtection":null,"passwordProtection":null}'
```

## 📜 Походження / changelog

- **2026-05-29** — прототип RPS у Andrew/Sales Analytics prototype-lab (Upstash playground)
- **2026-05-30** — перенесено у standalone `kodomandry-rps` repo + Vercel + власний Upstash; Andrew rewrite + папка зняті
- **2026-06-06** — **pivot на multi-game hub:** rename `kodomandry-rps` → `kodomandry-games`, додано landing + **3 нові ігри** (TTT + Memory + Battleship), всі live за один день

Детальний report: [`reports/2026-06-06-multigame-pack.md`](reports/2026-06-06-multigame-pack.md)
