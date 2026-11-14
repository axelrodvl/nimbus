# Инвентаризация `web/` (форк nextjs/next-beats)

Составлено на шаге 02 по состоянию кода «как есть». Все пути — относительно `web/`.
Стек: Next.js `16.4.0-canary.63`, React 19.2.4 + React Compiler, Tailwind v4, Prisma 7 (`prisma-client` generator → `generated/prisma`), pnpm 10.

## 0. Как запустить как есть

- `DATABASE_URL` обязателен для `pnpm dev`/`pnpm build`/сида. **Для локального Postgres без TLS нужен `?sslmode=disable`** — `lib/database-url.ts` иначе принудительно ставит `sslmode=verify-full`, и подключение падает с `TlsConnectionError`.
  Пример `.env.local`: `DATABASE_URL=postgres://nimbus:nimbus@localhost:5432/nextbeats_tmp?sslmode=disable`.
- `pnpm prisma db push` (миграций в репозитории нет, только `schema.prisma`) → `pnpm run prisma.seed` (44 трека, 3 плейлиста, пользователь `e2e`) → `pnpm dev`.
- `pnpm build` проходит, `pnpm lint` и `pnpm exec tsc --noEmit` — без ошибок.
- Авторизация: `proxy.ts` редиректит всё на `/login`, пока нет cookie `beats-user` (значение = `User.id`). Вход — по «email» (создаёт `User` с `name=email`). Для curl: `-H 'Cookie: beats-user=e2e'`.
- `prisma generate` запускается в `postinstall`, `dev` и `build`.
- Скриншоты (`docs/screenshots/`) не снимались — пункт необязательный.

## 1. Маршруты

Группа `app/(app)/` оборачивается `app/(app)/layout.tsx`: `PlayerProvider` → `OptimisticNavigationProvider` → `Sidebar` + `<main>` + `NowPlayingBar` + `MobileTabBar` + `SeedNavLinks`. Корневой `app/layout.tsx`: тема, `BoundaryProvider`, `OfflineIndicator`, `DemoToolbar`, `Toaster`, `@vercel/analytics`, `@vercel/speed-insights`.

| URL | Файл | Что показывает | Данные |
|---|---|---|---|
| `/login` | `app/login/page.tsx` | форма входа, фоновое превью | `getCurrentUser` (`features/user/user-queries.ts`); экшен `signIn` |
| `/` | `app/(app)/page.tsx` | Recently Played, Most Played, плейлисты, жанры | `QuickPlayGrid`→`getRecentlyPlayed`; `MostPlayed`→`getMostPlayed`; `PlaylistBrowse`→`getPlaylists`; `TopGenresGrid`→`getGenres` |
| `/library` | `app/(app)/library/page.tsx` | все треки, плейлисты, жанры | `LibraryGrid`→`getLibrary(page)`; `PlaylistBrowse`; `TopGenresGrid` |
| `/search?q=` | `app/(app)/search/page.tsx` | без `q` — `GenreBrowse`; с `q` — `SearchResults` (треки + плейлисты) | `searchTracks`, `searchPlaylists`, `getGenres` |
| `/track/[id]` | `app/(app)/track/[id]/page.tsx` | `TrackHeader`, `TrackControls`, `RecommendedTracks` | `getTrack`, `getRecommendedTracks`, `getUserFavoriteIds` |
| `/favorites` | `app/(app)/favorites/page.tsx` | `FavoritesFeed`, `Discover`, жанры | `getFavorites`, `getDiscover`, `getGenres` |
| `/playlist` | `app/(app)/playlist/page.tsx` | форма создания + список плейлистов | `PlaylistBrowse`; экшен `createPlaylist` |
| `/playlist/[id]` | `app/(app)/playlist/[id]/page.tsx` | `PlaylistDetail` + «Other Playlists» | `getPlaylist(id)`, `getPlaylists` |
| `/genre/[genre]` | `app/(app)/genre/[genre]/page.tsx` (+ `genre/layout.tsx`) | треки жанра + «Explore Other Genres» | `getTracksByGenre`, `getGenres` |
| `POST /api/play` | `app/api/play/route.ts` | учёт прослушивания `{trackId}` → 204/400/401 | `prisma.track.update(playCount++)`, `userTrackPlay.upsert`, `revalidateTag` |
| `/icon` | `app/icon.tsx` | favicon | — |

Страницы строятся через `PageWrapper` (`components/ui/page-layout.tsx`) и `AnimatedSuspense` (`components/ui/animated-suspense.tsx`); у большинства есть `error.tsx`/`not-found.tsx`.
Проверено с cookie `beats-user=e2e`: `/`, `/library`, `/search?q=a`, `/favorites`, `/playlist`, `/genre/rock` → 200; без cookie `/` → 307 на `/login` (200).

## 2. Слой данных

Единственная точка входа в БД — `lib/db.ts` (`prisma`, `PrismaPg`, `server-only`). Все запросы — серверные функции с `'use cache'` (Cache Components); аргумент `slow` (из `components/demo/demo-slow.ts`) нужен только для демо-задержек `delay()`.

### Запросы

| Файл | Функция | Кэш (`cacheTag` / `cacheLife`) | Возвращает |
|---|---|---|---|
| `features/track/track-queries.ts` | `getLibrary(page=1)` | `library` / hours | `{hasMore, tracks: Track[]}` (страница 100) |
| | `getFavorites()` | `favorites:{userId}` | `Track[]` |
| | `getUserFavoriteIds()` | `favorites:{userId}` | `Set<string>` |
| | `getRecentlyPlayed(limit=8)` | `recently-played:{userId}` / minutes | `Track[]` |
| | `getTrack(id)` | `tracks`, `track-{id}`, `track-{id}:{userId}` | `Track` (или `notFound()`) |
| | `getMostPlayed(limit=8)` | `tracks` | `Track[]` |
| | `getDiscover(limit=8)` | `discover:{userId}` | `Track[]` |
| | `getTracksByGenre(genre)` | `tracks`, `genre-{genre}` | `Track[]` |
| | `getRecommendedTracks(excludeId, limit=5)` | `recommendations:{userId}` | `Track[]` |
| | `searchTracks(query)` | `search` / hours | `Track[]` (до 30, `contains … insensitive`) |
| `features/playlist/playlist-queries.ts` | `getPlaylists()` | `playlists:{userId}` | `PlaylistWithTracks[]` (свои + `userId=null`) |
| | `searchPlaylists(query)` | `playlists:{userId}` | то же |
| | `getPlaylist(id)` | `playlist-{id}` | `PlaylistWithTracks` / `notFound()` |
| | `getPlaylistMenuItems(trackId)` | `playlists:{userId}` | `PlaylistMenuItem[]` |
| `features/genre/genre-queries.ts` | `getGenres()` | `genres` / days | `GenreSummary[]` (groupBy genre) |
| `features/user/user-queries.ts` | `getCurrentUser()` | `'use cache: private'` | `userId` или `''` |
| | `getCurrentUserName()`, `verifyAuth()` | — | `verifyAuth` делает `redirect('/login')` |

### Server Functions (мутации, `'use server'`)

- `features/track/track-actions.ts`: `toggleFavorite(trackId: string) → {ok:true}`; инвалидирует `track-{id}:{userId}`, `favorites:{userId}` (`updateTag`), `discover:*`, `recommendations:*` (`revalidateTag`).
- `features/playlist/playlist-actions.ts`: `createPlaylist(formData)` (использует `moderateText`), `addToPlaylist(playlistId, trackId)`, `removeFromPlaylist(playlistId, trackId)`, `deletePlaylist(playlistId)`; возвращают `{ok:true,…}` или `{ok:false,error}`; сид-плейлисты (`playlist-constants.ts`) read-only.
- `features/user/user-actions.ts`: `signIn(formData)` (cookie `beats-user`, 30 дней), `signOut()`.
- `components/demo/demo-actions.ts` — демо-тулбар.

### Типы (`types/`)

`Track { id, title, artist, album, duration(сек), genre, coverColor, playCount, isFavorite, lastPlayedAt, createdAt }` + `toTrack(row, userData)`; `PlaylistSummary/PlaylistWithTracks/PlaylistMenuItem`; `GenreSummary`. `types/track.ts` импортирует тип из `@/generated/prisma/client`.

## 3. Аудио (заменяется в шаге 19)

**Синтез:** `lib/audio/music-engine.ts` (Web Audio: `getAudioContext`, `resetAudioContext`, `suspendAudio`, `resumeAudio`, `killAudio`, `getSecondsPerBar`, `scheduleBar`), `lib/audio/audio-scheduler.ts` (`createAudioRefs`, `stopAll`, `scheduleTrack`, `resumeTrack`, `getPlaybackBeat`), `lib/audio/genre-configs.ts`, `lib/audio/track-profiles.ts` (параметры по трекам).

**Провайдер:** `providers/player-provider.tsx` (`PlayerProvider`, `usePlayer`), монтируется в `app/(app)/layout.tsx`.

Состояние (`useReducer`): `track: Track|null`, `queue: Track[]`, `queueIndex`, `isPlaying`, `progress` (**0–100, проценты**), `volume` (**0–100**, по умолчанию 75).
API контекста: `play(track, queue?)`, `pause()`, `resume()`, `togglePlayPause()`, `next()`, `previous()`, `setVolume(v)`, плюс `hasQueue` (= `queue.length > 1`). Перемотки (seek) **нет**. `next/previous` зацикливаются по очереди; по окончании последнего трека — `ENDED`.
Побочные эффекты `playAtIndex`: `POST /api/play {trackId}` (keepalive), `scheduleTrack({duration, genre, trackId, onProgress, onEnd})`. `useListeningMilestones(isPlaying)` (`hooks/use-listening-milestones.ts`) показывает toast-«пасхалки» про синтез — удалить.

**Потребители `usePlayer`:** `components/now-playing-bar.tsx` (бар: обложка, название, prev/play/next, прогресс, громкость; мобильная и десктопная вёрстки), `features/track/components/play-button.tsx` (`PlayButton`), `features/track/components/track-interactions.tsx` (`TrackPlayRow`, `TrackIndexCell`, `NowPlayingTrackLink`, `NowPlayingTrackTitle` — подсветка играющего трека). Вне `usePlayer` с синтезом связаны `getPlaybackBeat` (бит для живых обложек, `AlbumArt beatTrackIds`) и `features/user/components/login-music-preview.tsx`.

Для шага 19: контракт `usePlayer` стоит сохранить, заменив внутренности на `<audio>` (`src=/api/tracks/{id}/stream`), `progress` — по `timeupdate`, добавить seek и статус трека (`found/ready`). `Track.duration` в новой модели может быть `null`.

## 4. Ключевые UI-компоненты

| Компонент | Путь | Пропсы | Где используется |
|---|---|---|---|
| `TrackRow`, `TrackList`, `RecommendedTracks`, `TrackListSkeleton` | `features/track/components/track-row.tsx` | `track, index?, showAlbum?, queue?` / `tracks` | favorites, genre, search, track page, playlist |
| `TrackPlayRow`, `FavoriteButton`, `TrackIndexCell`, `NowPlayingTrackLink/Title` | `features/track/components/track-interactions.tsx` | `track, queue`; `trackId, isFavorite` | `TrackRow`, `AlbumCard` |
| `AlbumCard` / `AlbumCardSkeleton` | `features/track/components/album-card.tsx` | `track` | `LibraryGrid`, `MostPlayed`, `Discover` |
| `PlayButton` | `features/track/components/play-button.tsx` | `track, queue?, className?, size?` | карточки, заголовки |
| `QuickPlayGrid`, `MostPlayed`, `LibraryGrid`, `Discover`, `FavoritesFeed`, `TrackHeader`, `TrackControls` | `features/track/components/*` | — (асинхронные RSC, сами ходят в запросы) | страницы |
| `NowPlayingBar` | `components/now-playing-bar.tsx` | — | `(app)/layout.tsx` |
| `Sidebar`, `MobileTabBar` | `components/sidebar.tsx`, `components/mobile-nav.tsx` | — | `(app)/layout.tsx`; пункты: Home, Search, Library, Liked Tracks + список плейлистов |
| `Search` (форма, синхронизация с `?q=`), `SearchResults` | `features/search/components/` | `children` / `query` | `/search` |
| `PlaylistBrowse/Card/List/Detail/TrackList`, `CreatePlaylistForm`, `AddToPlaylistMenu` | `features/playlist/components/` | `excludeId?`, `animateItems?`; `trackId, itemsPromise` | страницы, `TrackRow` |
| `GenreBrowse`, `TopGenresGrid`, `GenreCard`, `GenreTracks` | `features/genre/components/` | — | страницы |
| `AlbumArt` / `AlbumArtCover` | `features/artwork/components/` | `coverColor, coverSeed, label, kind('track'\|'album'\|'playlist'), beatTrackIds, size('sm'\|'md'\|'lg')` | везде |
| UI-кит | `components/ui/*` | `Button`, `NavLink`, `PrefetchLink`, `Skeleton`, `EmptyState`, `ErrorState`, `Collapsible`, `ConfirmDialog`, … | везде |
| Демо | `components/demo/*` | `Boundary`, `DemoToolbar` (визуализация границ кэша, переключатель «slow») | `Boundary` обёрнут вокруг многих клиентских компонентов |

Поиск существует (только по трекам и плейлистам в БД) — в шаге 09 заменяется поиском по MusicBrainz. Избранное = `UserFavorite`, плейлисты = `Playlist`/`PlaylistTrack`.

## 5. Модель данных Prisma → модель Nimbus

Жанры в seed: electronic, hip-hop, indie, lo-fi, pop, synthwave.

| Prisma | Поля | Судьба |
|---|---|---|
| `User` | `id` cuid, `name` unique | Выкинуть в MVP (пользователь один; авторизация — токен, шаг 23). Cookie `beats-user`, `proxy.ts`, `/login` — убрать |
| `Track` | `title, artist, album` (строки), `duration`, `genre`, `coverColor`, `playCount` | Заменяется `Artist`/`Album`/`Track` (шаг 04): `artist`/`album` → связи, `duration` из MB (nullable), `genre` и `coverColor` **выкидываем** (цвет — заглушка по hash), `playCount` — опционально; добавляем `status` (`adding/found/not_found/ready`), `status_reason`, `mbid` |
| `UserFavorite` | `userId, trackId, addedAt` | Остаётся как «лайки», без `userId` |
| `UserTrackPlay` | `lastPlayedAt` | Остаётся как история прослушиваний (Recently Played) |
| `Playlist` / `PlaylistTrack` | `name, description, coverColor, position` | Остаётся 1:1 (без `userId`), `coverColor` убрать |

Тип `Track` для UI (`types/track.ts`) пересобирается из API-типов (`web/lib/api/schema.d.ts`): id станет `number`, появятся `mbid`, `status`.

## 6. Обложки

- Статика: `public/covers/{tracks,genres,playlists}/*.static.webp` в 4 формах (`square 512`, `thumb 80`, `banner 960×288`, `banner-thumb 320×96`); путь строится в `features/artwork/cover-assets.ts` (`coverAssetPath(seed,label,kind,shape)`; для треков — по `seed=trackId`), версия кэша — `generated-cover-version.ts`. Генерация: `pnpm covers:icons` (`scripts/generate-covers.mts`, vgpu + `pngjs`).
- Live: для `size='lg'` `AlbumArtCover` поверх статики динамически подгружает WebGPU-шейдер (`features/artwork/artwork-runtime.ts`, `artwork.wgsl`, `artwork-motif.ts`), реагирующий на «бит» синтеза.
- Подмена на Cover Art Archive: добавить в `AlbumArt` проп `coverUrl?: string`; при наличии рендерить `<img>`/`next/image` (добавить `images.remotePatterns` для `coverartarchive.org` / `archive.org` либо проксировать через бэкенд), а `AlbumArtCover`/`coverColor`-градиент оставить как fallback. Файлы `public/covers/**` и генерация становятся не нужны.

## 7. Что удалить в шаге 08

Файлы и каталоги:
- `prisma/`, `prisma.config.ts`, `generated/prisma`, `lib/db.ts`, `lib/database-url.ts`, `.env.sample` (заменить на `BACKEND_URL`/`NEXT_PUBLIC_BACKEND_URL`).
- `lib/audio/*` (до шага 19 плеер должен продолжать как-то работать — удалять синтез вместе с заменой плеера или оставить заглушку), `hooks/use-listening-milestones.ts`.
- `lib/moderation.ts` (+ вызов в `createPlaylist`).
- `features/artwork/artwork-runtime.ts`, `artwork.wgsl`, `wgsl-env.d.ts`, `scripts/generate-covers.mts`, `public/covers/**`, `generated-cover-version.ts`, правило `*.wgsl` в `next.config.ts` (если убираем vgpu-обложки целиком).
- `components/demo/*` и `delay(…, slow)` во всех запросах, `Boundary`-обёртки (опционально).
- `app/login`, `features/user/*`, `proxy.ts`, `/api/play` (вместо этого — вызов бэкенда).
- `@vercel/analytics`, `@vercel/speed-insights` в `app/layout.tsx`.

Зависимости (`package.json`): `@prisma/client`, `@prisma/adapter-pg`, `@prisma/adapter-better-sqlite3`, `prisma`, `pg`, `@types/pg`, `better-sqlite3`, `dotenv`, `ai`, `@ai-sdk/gateway`, `vgpu`, `@vgpu/wgsl`, `pngjs`, `@types/pngjs`, `@vercel/analytics`, `@vercel/speed-insights`; скрипты `prisma.*`, `covers:icons`, `postinstall`, `prisma generate` в `dev`/`build`; блок `pnpm.onlyBuiltDependencies`. Оставить: `server-only`, `zod`, `sonner`, `lucide-react`, `next-themes`, `clsx`, `tailwind-merge`, `geist`, `@ariakit/react`.

Тесты `tests/*.spec.ts` (Playwright) рассчитаны на сид и пользователя `e2e` — переписываются под новый API (шаг 23).

## 8. Риски

- `next@16.4.0-canary.63` и `@next/playwright` — canary: версии закреплены точно, при обновлении возможны поломки. `AGENTS.md` предупреждает, что API отличаются от привычных, — перед правками читать `node_modules/next/dist/docs/`.
- `cacheComponents: true`, `partialPrefetching`, `typedRoutes`, `experimental.useOffline/inlineCss/agentFeedback`: динамические данные вне `Suspense` или `cookies()` внутри `'use cache'` ломают prerender. При переходе на fetch к бэкенду: `'use cache'` + `cacheTag` для общих данных, динамику — внутри `Suspense`.
- React Compiler (`reactCompiler: true`): `PlayerProvider` создаёт функции на каждый рендер и опирается на refs; при переписывании на `<audio>` следить за эффектами и мемоизацией.
- `next dev` сам создаёт/восстанавливает `web/AGENTS.md` и `web/CLAUDE.md` (включён `experimental.agentFeedback`) — файлы коммитятся как есть.
- pnpm не запускает build-скрипты `prisma`, `esbuild`, `webgpu`, `unrs-resolver` без `pnpm approve-builds` (предупреждение при install); сборка при этом работает.
- Сборка и dev требуют `DATABASE_URL` (импорт `lib/db.ts`) — уйдёт вместе с Prisma в шаге 08.
- Порты: фронт — 3000, бэкенд — 8080. На этой машине 8080 уже занят чужим контейнером (`alfa-equip-backend`), 5432 — чужим Postgres: учесть в шаге 03 (`NIMBUS_BIND`).
