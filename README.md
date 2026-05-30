# Кодомандри · Камінь–Ножиці–Папір (мережа, 2 гравці)

Маленька мережева гра для уроків Кодомандрів. Двоє учнів заходять з різних пристроїв на одне URL, грають у RPS у тій самій кімнаті. State синхронізується через Upstash Redis (KV) на Vercel-бекенді. Polling 1.5s (без WebSocket — простіше і досить швидко для класного формату).

## Live

- **Default room:** https://kodomandry-rps.vercel.app/
- **Custom room:** https://kodomandry-rps.vercel.app/?room=`<code>` (наприклад `?room=alex-vs-bob`)

Всі учасники з однаковим `room` грають у одній кімнаті. Перший заходить = `p1`, другий = `p2`, третій+ = observer (read-only).

## Стек

| Шар | Що |
|---|---|
| Frontend | Один HTML файл, vanilla JS, polling 1.5s |
| Backend | Vercel serverless (`api/rps.js`), Node 20 runtime |
| State | Upstash Redis (KV), TTL 24h |
| Hosting | Vercel (free) |

## Файли

```
kodomandry-rps/
├── index.html      UI + JS (polling, render, player-id у localStorage)
├── api/rps.js      Serverless: room state у Upstash KV
├── vercel.json     cleanUrls + trailingSlash off
└── README.md
```

## API контракт

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
  "updatedAt": "2026-05-30T08:00:00.000Z"
}
```

## Логіка

- **Player identity** — UUID у `localStorage` (`rps-player-id`). Refresh не вибиває з кімнати.
- **Slot assignment** — перший заходить = `p1`, другий = `p2`, третій+ = `observer` (read-only).
- **Choice resolution** — як тільки обидва зробили вибір, бекенд нараховує очко (BEATS table) + state на reveal. Фронт показує карти + verdict. Кнопка «Ще раунд» → POST `next`, choices зачищаються, round++.
- **Leave** — звільняє slot, інша людина може зайти. Якщо обидва вийшли — весь state reset.
- **Storage TTL** — 24 год без активності → KV auto-cleanup.

## Env (Vercel project settings)

```
KV_REST_API_URL=https://<your-instance>.upstash.io
KV_REST_API_TOKEN=<token>
```

Альтернативні імена (теж читаються, для сумісності з Upstash CLI):

```
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Створення Upstash KV — через Vercel Marketplace Integration: project → Storage → Create Database → Upstash Redis (KV). Env-vars впишуться автоматично після rebuild.

## Local dev

```bash
npm i -g vercel
vercel dev   # запустить локально + emulator серверлеса
```

Якщо нема Upstash локально — або підтягни prod env (`vercel env pull`), або set `UPSTASH_REDIS_REST_URL` руками у `.env.local`.

## Майбутні фічі (не зроблено)

- WebSocket замість polling (latency 1.5s → миттєво)
- Best-of-N з auto-end
- Історія раундів
- Lobby з списком активних кімнат
- Sound effects + animations
- i18n (зараз тільки укр)

## Походження

Прототип написаний 2026-05-29 у `Andrew/Sales Analytics and Lead Flow/prototypes/rps/` як playground для тестування Upstash-інтеграції на Vercel. Перенесений у Кодомандри 2026-05-30 — окремий repo + Vercel-проєкт, окремий Upstash, щоб не змішувати з робочим Andrew/Re-Bath бекендом. Andrew-копія знесена після smoke-тесту нової URL.
