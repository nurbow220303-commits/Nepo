# Ветки

Личное приложение для веток Threads: свайп-колода, план, напоминания push на iPhone.

- `public/` — само приложение (PWA): `index.html`, `sw.js`, манифест, иконки, `seed.json` со стартовыми ветками.
- `src/worker.js` — сервер на Cloudflare Workers: хранит ветки и подписки в Durable Object, в нужное время шлёт push.
- `src/push.js` — отправка Web Push (VAPID + шифрование aes128gcm) без внешних библиотек.
- `index.src.html` + `style.css` → `public/index.html` собирается командой `python3 build.py`.

## Развёртывание (Cloudflare, один раз)

1. Cloudflare → Workers & Pages → Create → Import a repository → репозиторий `Nepo`.
2. Project name: `vetki`. В Advanced settings → Root directory (Path): `vetki`.
3. Build command — пусто. Deploy command — `npx wrangler deploy` (по умолчанию).
4. Deploy. Адрес будет вида `https://vetki.<ваш-поддомен>.workers.dev`.

Дальше каждый push в `main` с изменениями в `vetki/` обновляет приложение сам.

## iPhone

1. Открыть адрес в Safari → «Поделиться» → «На экран „Домой“».
2. Открыть «Ветки» с иконки, придумать PIN.
3. Колокольчик сверху → «Включить уведомления» → «Разрешить».
