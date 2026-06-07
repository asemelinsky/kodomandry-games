---
created: 2026-06-06
type: report
labels: [kodomandry, games, vercel, multi-game, pivot, multiplayer, upstash]
related: [README.md, reports/2026-05-30-kodomandry-rps-migration.md]
---

# Multi-game hub pivot — kodomandry-rps → kodomandry-games

## Запит

Олексій 2026-06-06: «можемо зробити ще гру "Морський бій" на 2 гравців і головний екран входу в ці 2 гри?» → після обговорення розширили до **pack з 4 ігор**: RPS + Хрестики-Нулики + Memory + Морський Бій.

Уточнення:
1. Архітектура **(a)** — rename existing `kodomandry-rps` → `kodomandry-games` + monorepo (а не окремий repo чи 3 окремі проєкти)
2. Battleship **спрощений** — 6×6 grid, 4 кораблі (1×3 + 2×2 + 1×1 = 8 cells), а не стандартні 10×10 з 10 кораблями
3. Landing — **4 кнопки** без placeholder'ів для майбутніх ігор

## Що зроблено

| Стадія | Що | Час |
|---|---|---|
| 1 | Rename repo + landing + RPS у `/rps/` subdir | ~1 год |
| 2 | Tic-Tac-Toe (api/tictactoe.js + UI) | ~1 год |
| 3 | Memory з Minecraft-блоками (api/memory.js + UI) | ~1.5 год |
| 4 | Battleship (api/battleship.js + UI з view-masking) | ~2 год |
| 5 | README rewrite + цей report | ~30 хв |

**Total:** ~6 год активної роботи за один день.

### Stage 1 — Rename + Landing

- **GitHub:** `asemelinsky/kodomandry-rps` → `asemelinsky/kodomandry-games` (API PATCH `/repos/...`). GitHub auto-redirect зі старого URL.
- **Vercel:** rename project на `kodomandry-games` (API PATCH `/v9/projects/...`). Alias `kodomandry-rps.vercel.app` залишається на тому ж проєкті.
- **Local:** `/root/projects/kodomandry-rps/` → `/root/projects/kodomandry-games/` (mv).
- **Structure:** RPS уніс у `/rps/` subdir, створив skeleton-теки `tic-tac-toe/`, `memory/`, `battleship/`, `shared/`.
- **Landing `index.html`:** 4 картки у grid 2×2 (responsive 1col на mobile). Стиль RPS (Syne+DM Mono+Instrument Sans, темна тема, accent `#f0a500`). Емодзі + назва + опис.
- **`vercel.json` rewrites:** `/rps` → `/rps/index.html` (потім додавали по черзі для кожної гри).

### Stage 2 — Tic-Tac-Toe

**API (api/tictactoe.js):**
- Actions: `join`, `move {idx}`, `rename`, `next`, `reset`, `leave`
- 8 win-lines (3 rows + 3 cols + 2 diags) перевіряються після кожного move
- Чергування `first` (хто починає) per round для fairness
- Server-side validations: own turn, cell empty, no winner, both players present

**UI (tic-tac-toe/index.html):**
- 3×3 grid, X=синій (--p1, `#5b8dee`), O=зелений (--p2, `#3dd9b3`)
- Highlight win-line з accent кольором (`win-cell` class)
- Status bar з 4 станами: waiting, your-turn, win, lose
- Кнопки: `Ще раунд` (показується тільки після win/tie), `Reset all`, `Покинути`
- Polling 1.5s + optimistic POST

### Stage 3 — Memory (з Minecraft-блоками)

**API (api/memory.js):**
- 8 emoji-tiles × 2 = 16 cards: `🧱 ⛏ 💎 🌳 🐔 💧 ⚙️ 🐺`
- Fisher-Yates shuffle при пустій кімнаті / `new` / `reset`
- **2-phase flip** через server state:
  - `peekFirst: idx` — перша картка цього ходу (visible тільки своєму гравцю на client, але server тримає)
  - `peekTwo: [i1, i2]` + `peekUntil: <ms>` — після no-match, видно обом 3 секунди
  - **lazy-expire** на наступному state read (GET): якщо `Date.now() >= peekUntil` → clear peek + swap turn + persist
- Match → owner=slot, score++, той самий хід продовжується
- Win = усі 16 owned → переможець по сумі пар (4:4 = tie)

**UI (memory/index.html):**
- 4×4 grid, face-down карти з "?" overlay
- Owned: підкреслений колір за player (синій/зелений)
- Peek: жовтий pulse animation 0.8s
- Polling 1.3s (трохи швидше за TTT через peek timer)
- Кнопки: `Нова гра` (після win), `Скинути рахунок`, `Покинути`

### Stage 4 — Battleship (спрощений)

**API (api/battleship.js) — найскладніший:**
- 6×6 board (36 cells), fleet: 1×3 + 2×2 + 1×1 = 8 cells (4 ships)
- 3 phases: `setup` → `battle` → `over`
- Actions: `join`, `randomFleet`, `placeFleet {ships}`, `ready`, `unready`, `shoot {idx}`, `rename`, `next`, `reset`, `leave`
- **Fleet validation** (`validateFleet`):
  - Lengths sorted match [3,2,2,1]
  - Cells in bounds (0..35)
  - No overlap між ships
  - Кожен ship straight (horizontal або vertical contiguous)
- **Random placement** (`randomFleet`): до 200 attempts × 100 per ship — практично завжди вдається
- **Hit logic:**
  - Hit → той же гравець стріляє знову (continue)
  - Miss → swap turn
  - Sunk → ship.hits усі true → flag у `lastShot.sunk`
- **Win check:** усі ships ворога fully hit → phase=`over`, winner=current, score++
- **Alternating `first`** per next round для fairness

**🔒 Security feature — View masking:**

Battleship унікальний тим, що server повинен **приховувати** fleet positions опонента (інакше через DevTools можна побачити де його кораблі). Реалізовано:

```javascript
function viewFor(state, playerId) {
  const out = JSON.parse(JSON.stringify(state));
  const isP1 = out.p1?.id === playerId;
  const isP2 = out.p2?.id === playerId;
  if (isP1) { if (out.p2) out.p2.ships = null; }
  else if (isP2) { if (out.p1) out.p1.ships = null; }
  else {
    // observer — hide both
    if (out.p1) out.p1.ships = null;
    if (out.p2) out.p2.ships = null;
  }
  return out;
}
```

Кожен GET/POST повертає state через `viewFor(state, playerId)`. Player бачить свій fleet + ворожі `hitsOnMe` (де його стояли і ваш постріл влучив) + `shots[mySlot]` (свої постріли). Ворожих фактичних positions не видно навіть з DevTools.

**Smoke-test (2026-06-06 20:55 UTC):**
- Alice randomFleet → 4 ships генеровано: `[{len:3, cells:[15,16,17]}, {len:2, cells:[0,1]}, {len:2, cells:[25,31]}, {len:1, cells:[7]}]` ✅
- Alice ready + Bob randomFleet + Bob ready → phase=`battle`, turn=`p1` автоматично ✅
- Alice shoot idx=5 → result `{hit:false, sunk:false}`, turn swap → `p2` ✅
- View masking: response має `state.p2.ships === null` (для Alice) ✅

**UI (battleship/index.html) — найскладніший:**
- 2 boards: top = opponent (clickable cells, crosshair cursor), bottom = my (read-only з ships visible)
- Setup-phase UI: тільки my board видно, кнопка `🎲 Випадково`, потім `✅ Готово`
- Battle-phase UI: обидва boards видно
- Cell states (CSS classes):
  - `ship` — мій ship cell (сірий)
  - `ship-hit` — мій ship cell hit (червоний)
  - `ship-sunk` — мій ship у sunk-ship (темно-червоний)
  - `miss` — промах (точка `·`)
  - `shot-hit` — мій постріл влучив (💥 emoji)
  - `shootable` — clickable cell (мій хід, opp board)
- Status bar з 8+ станами: setup waiting, you-place, opp-place, battle your-turn, hit-continue, opp-shoot etc.
- Polling 1.5s + optimistic POST

## Технічні нюанси

### Vercel SSO Deployment Protection

Нові Vercel-проєкти за замовчуванням мають `ssoProtection.deploymentType=all_except_custom_domains`, що блокує всі `*.vercel.app` aliases preview-протекцією. Гра 401 на `kodomandry-games.vercel.app/` при першому deploy. Відключено через API PATCH:

```bash
curl -X PATCH -H "Authorization: Bearer $VTOKEN" \
  -H "Content-Type: application/json" \
  "https://api.vercel.com/v9/projects/$PROJ_ID?teamId=$TEAM_ID" \
  -d '{"ssoProtection":null,"passwordProtection":null}'
```

Pattern для майбутніх проєктів — disable одразу після першого deploy.

### Manual alias rebind після `vercel deploy --prod`

Помітив повторюваний quirk: коли deploy робиться через CLI (`vercel deploy --prod`), новий deployment **НЕ** автоматично receivit production aliases (`kodomandry-games.vercel.app`, `kodomandry-rps.vercel.app`). Кожен раз треба:

```bash
DEP="<deployment-url>"
vercel alias set $DEP kodomandry-games.vercel.app --scope <team>
vercel alias set $DEP kodomandry-rps.vercel.app --scope <team>
```

GitHub auto-deploy (з push на `main`) виконує rebind автоматично через CI integration. Тож для production-changes краще йти через GitHub push (auto-deploy + auto-alias).

### State design pattern (спільний для всіх 4 ігор)

Кожна гра дотримується одного pattern для State у KV:

```
{
  p1: { id, name, ...game-specific },
  p2: { id, name, ...game-specific },
  round: number,
  score: { p1, p2, [tie] },
  winner: null|'p1'|'p2'|'tie',
  updatedAt: ISO,
  // game-specific: board / cards / ships / phase / turn / peek / shots / etc.
}
```

Спільне:
- `playerId` у `localStorage` per game (`rps-player-id`, `ttt-player-id`, ...)
- TTL 24h на KV key
- Polling 1.3-1.5s
- Optimistic POST + server validation
- Observer mode для 3+ глядачів

## Метрики

- **Code:** ~3000 lines (4 × ~250 server + ~600 UI)
- **Commits:** 5 (rename, TTT, Memory, Battleship, docs)
- **Deploys:** 4 production deploys через CLI
- **GitHub repo renames:** 1 (rps → games)
- **Vercel project renames:** 1
- **SSO Protection disables:** 1 (через API PATCH)
- **Manual alias rebinds:** 4 (один на deploy)
- **Smoke tests:** 12 (3 per гру: page 200 + API basic + flow test)

## Що НЕ зроблено (backlog)

- 📱 **Phone testing** — Олексій ще не перевіряв на телефонах. Можливі issues: 
  - Battleship cells на iPhone SE (6×6 grid + дрібні cells) можуть бути дуже маленькі
  - Memory peek 3 сек може здаватись повільним для дітей
  - Battleship setup-phase без manual placement (тільки random) — можливо діти захочуть розставляти самі
- 🔊 **Sound effects** — splash на shoot, ding на match, fanfare на win
- 👤 **Avatar emoji** при join (вибір з 6-8 emoji) для персоналізації
- 🏆 **Cross-room leaderboard** через KV — топ гравці за тиждень
- ✏️ **Manual ship placement** для Battleship (drag/click + rotate) — для дітей які хочуть стратегії
- 🌐 **EN locale** — поки тільки UA

## Файли

| File | Notes-hub URL |
|---|---|
| `kodomandry-games/README.md` | (не у vault, без URL) |
| `kodomandry-games/reports/2026-06-06-multigame-pack.md` | (reports не у vault, без URL) |
