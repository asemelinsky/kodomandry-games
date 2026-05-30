---
created: 2026-05-30
type: report
labels: [vercel, github, kodomandry, rps, upstash, migration]
related: [Andrew/Sales Analytics and Lead Flow/vercel.json]
---

# RPS міграція з Andrew у власний Кодомандри-repo

## Запит

Олексій 2026-05-30: «RPS чудово, єдине — задеплоїли на Vercel Andrew, а краще на Кодомандри. Створи це як підпроєкт в Кодомандрах, задокументуй, зроби проєкт на GitHub». Уточнення:

1. (a) standalone repo (окрема Vercel-проєкт)
2. GitHub: той самий що для Кодомандри-проєктів (`asemelinsky`), окрема тека
3. Новий Upstash KV (не reuse Andrew-shared)
4. /rps у Andrew зняти **після** smoke-тесту нового URL

## Зроблено

| Крок | Результат |
|---|---|
| Local repo `/root/projects/kodomandry-rps/` | ✅ index.html + api/rps.js + vercel.json + .gitattributes (LF) + README укр |
| GitHub repo `asemelinsky/kodomandry-rps` (public) | ✅ створено через `POST /user/repos`, push з token-injection |
| Vercel project `kodomandry-rps` | ✅ `vercel deploy --prod --yes --scope oleksiys-projects-1e19468f` — production READY |
| Production URL | https://kodomandry-rps.vercel.app (HTML 200) |
| Upstash KV (новий) | ❌ blocker — `vercel integration add upstash/upstash-kv` потребує `xdg-open` (browser-flow), у devbox-контейнері fail |

## Smoke-тест

- `curl -sI https://kodomandry-rps.vercel.app` → HTTP/2 200
- `curl https://kodomandry-rps.vercel.app/api/rps?room=test` → `{"ok":false,"error":"Upstash Redis env vars not set"}` (очікувано, KV не provisioned)

## Що треба від користувача

**Single browser step** (~30 секунд):

1. Відкрити https://vercel.com/oleksiys-projects-1e19468f/kodomandry-rps/stores
2. **Create Database** → **Upstash for Redis** → Continue
3. Назва (рекомендую): `kodomandry-rps-kv`, region: будь-який близький
4. **Connect** до проєкту `kodomandry-rps` (auto-set env у Production+Preview+Development)
5. Vercel auto-redeploy (3-5 хв)

Після того — `https://kodomandry-rps.vercel.app/?room=test` має пройти повний flow (join → choose → score).

## Cleanup Andrew (відкладено)

Після підтвердження що `kodomandry-rps.vercel.app` працює end-to-end:

```bash
# Andrew/Sales Analytics and Lead Flow/vercel.json — видалити рядки
{ "source": "/rps",  "destination": "/prototypes/rps/pages/index.html" },
{ "source": "/rps/", "destination": "/prototypes/rps/pages/index.html" }

# Andrew/Sales Analytics and Lead Flow/prototypes/rps/ — видалити каталог
rm -rf "/root/projects/Andrew/Sales Analytics and Lead Flow/prototypes/rps"
```

Andrew Upstash KV — залишити (інші prototypes use). НЕ disconnect.

## Stack

```
GitHub asemelinsky/kodomandry-rps
       │ git push
       ▼
Vercel team oleksiys-projects-1e19468f
  ├─ prj_FMYgYtQYkU50Zs5Cr78GxbeGpNeq (kodomandry-rps)
  │    ├─ index.html  (static)
  │    └─ api/rps.js  (Node 24 serverless)
  └─ Upstash for Redis (KV) — TBD via marketplace integration
       └─ env: KV_REST_API_URL, KV_REST_API_TOKEN (auto-inject)
```

## Файли

| File | Notes-hub URL |
|---|---|
| `kodomandry-rps/README.md` | (не у vault, без URL) |
| `kodomandry-rps/reports/2026-05-30-kodomandry-rps-migration.md` | (reports не у vault, без URL) |
