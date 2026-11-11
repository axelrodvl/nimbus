# Шаг 13 — Провайдер RuTracker

**Зависит от:** 12
**Оценка:** 1.5–2 дня

## Цель

Реализовать `TorrentProvider` для rutracker.org. Официального API поиска нет — нужен вход по логину, поиск по HTML-странице, получение info-hash по топику. Учитываем блокировки (прокси), кодировку cp1251 и капчу.

## Что сделать

### 1. HTTP-клиент

- `reqwest::Client` с cookie store, `User-Agent` обычного браузера, таймаут 20 с, опциональный прокси из `config.rutracker_proxy` (`socks5h://…` или `http://…`; фича `socks` в reqwest уже включена в шаге 03).
- Base URL настраиваемый (`https://rutracker.org/forum/`), для тестов — wiremock.
- Ответы в **cp1251**: декодировать через `encoding_rs::WINDOWS_1251` (не полагаться на `resp.text()`). Параметры запроса кодировать в cp1251 + percent-encoding (кириллица в `nm=`).

### 2. Авторизация

- Если задан `NIMBUS_RUTRACKER_COOKIE` (значение `bb_session=…`) — использовать его, логин не выполнять.
- Иначе `POST login.php` с формой (cp1251-кодированной!): `login_username`, `login_password`, `login=вход`. Успех — в ответе установлена cookie `bb_session`. Если в ответе есть капча (`cap_sid` / `<img src=...captcha...>`) → `ProviderError::Auth("captcha required: set NIMBUS_RUTRACKER_COOKIE")`.
- Сессию держать в памяти; при признаке разлогина (редирект на `login.php` или в HTML нет ссылки на профиль/`logged-in-username`) — один повторный логин, потом ошибка.
- (Шаг 22 перенесёт cookie в таблицу `settings` с вводом из UI — сейчас хватает env.)

### 3. Поиск

- `GET tracker.php?nm=<cp1251-urlenc query>` (можно добавить `&o=10&s=2` — сортировка по сидам, по убыванию).
- Парсинг (`scraper`) таблицы результатов `#tor-tbl tbody tr` (строки `tr.hl-tr`):
  - тема: `a.tLink` (или `a[data-topic_id]`) → `title` (текст), `source_topic_id` (из `data-topic_id` или `viewtopic.php?t=(\d+)`);
  - раздел форума: `a.f` / `td.f-name a` → `category`;
  - размер: `td.tor-size` атрибут `data-ts_text` (байты) — если нет, разобрать текст `1.2 GB`;
  - сиды: `b.seedmed` / `td.seedmed` (может быть отрицательным/пустым — `None`), личи: `td.leechmed`.
- **Селекторы могут меняться** — вынести их в константы в одном модуле, сохранить реальный HTML страницы поиска как фикстуру (если сеть есть) и задокументировать структуру в комментарии.
- Фильтр по музыкальным разделам: в результатах оставлять строки, где `category` соответствует регулярке музыкальных разделов (`(?i)(музык|music|rock|metal|jazz|blues|pop|rap|hip-hop|electronic|classical|классическ|lossless|flac|mp3|ape|дискограф|discograph|саундтрек|soundtrack|альтернатив|alternative|indie|folk|punk|шансон|эстрад)`). Остальное отбрасывать (фильмы, книги, игры). Регулярку держать константой.
- `info_hash`/`magnet` в поиске нет → `None`, заполняются в `resolve`.

### 4. `resolve`

Вариант А (без авторизации, предпочтительный): публичный API `https://api.rutracker.cc/v1/get_tor_topic_data?by=topic_id&val=<id>` → `{ "result": { "<id>": { "info_hash": "...", "seeders": N, "size": N, "topic_title": "..." } } }`. Возможно требует того же прокси.
Вариант Б (fallback): `GET viewtopic.php?t=<id>` → `a.magnet-link[href]` → magnet → `InfoHash::from_magnet`.
К magnet от RuTracker добавлять `PUBLIC_TRACKERS`? — **нет**: у RuTracker свои ретрекеры с passkey в magnet из viewtopic; если hash пришёл из API — собрать magnet через `build_magnet(hash, title, &["http://bt.t-ru.org/ann?magnet", "http://bt2.t-ru.org/ann?magnet", "http://bt3.t-ru.org/ann?magnet", "http://bt4.t-ru.org/ann?magnet"])` + DHT.

### 5. Ошибки и устойчивость

- Сеть/таймаут/DNS/TLS-ошибки, похожие на блокировку → `ProviderError::Blocked` с подсказкой про `NIMBUS_RUTRACKER_PROXY`.
- Лимитер: не чаще 1 запроса в 2 с.
- Регистрация в `ProviderRegistry`: включается, если задан логин+пароль **или** cookie.

## Тесты

- Фикстуры: `search_results.html` (cp1251-байты!), `login_ok.html`, `login_captcha.html`, `viewtopic.html`, `api_topic_data.json`. Если сети нет — собрать HTML вручную по описанной структуре, закодировать в cp1251 (`iconv -f utf-8 -t cp1251`).
- `wiremock`: логин (cookie выставляется), капча → `Auth`, поиск → кандидаты с topic_id/size/seeders, фильтр по разделам отбрасывает немузыкальные, `resolve` через API и через viewtopic, разлогин → повторный логин.
- Кодирование кириллического запроса в cp1251.
- Живой тест `#[ignore]` (нужны креды в env).

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят.
- Живой тест — по возможности; если RuTracker недоступен из окружения, отметь в Журнале (не блок, но обязательно укажи, что провайдер проверен только на фикстурах).

## Вне рамок шага

UI для ввода cookie (шаг 22).
