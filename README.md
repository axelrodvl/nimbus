# Nimbus

A self-hosted web music player: metadata from [MusicBrainz](https://musicbrainz.org), music streamed straight from torrents.

- **Frontend:** Next.js (`web/`, a fork of [next-beats](https://github.com/nextjs/next-beats))
- **Backend:** Rust — axum, sqlx, librqbit (`backend/`)
- **Database:** PostgreSQL

> **Disclaimer.** This is a research / experimental project. Legally, it can only be used to listen to music that is
> in the public domain (or that you otherwise have the explicit right to download and share). Nimbus does not host or
> provide any content and does not verify the legal status of what you stream.

> **Legal notice.** Downloading and sharing copyrighted content may be illegal in your country. This project is
> intended for personal use with content you have the rights to. You are solely responsible for how you use it.

## Features

- Search artists, albums and tracks via MusicBrainz (⌘K / Ctrl+K); cover art from the Cover Art Archive.
- Library: add an album or a whole discography — Nimbus finds releases on its own (TPB, Torznab/Jackett/Prowlarr,
  RuTracker), checks their contents and matches files to tracks.
- Streaming playback directly from the torrent (HTTP Range, seeking); ffmpeg transcoding for CUE images and APE/WV/DSD.
- Live track statuses over WebSocket: searching → playable → downloaded.
- Manual source selection, custom magnet links, search retry.
- Pinning: download an album or track to the server on demand (queue, concurrency limit, pause); pinned files are
  never evicted from the cache, so they count against — and may exceed — the cache limit. Optional auto-download
  of everything added to the library.
- Settings in the UI, cache size limit with eviction, next-track prefetch, optional seeding.
- Simple single-user token authentication.
- UI in 14 languages (English, Русский, Español, Français, Deutsch, 中文, Português, Italiano, 日本語, 한국어,
  Українська, Polski, Türkçe, हिन्दी); chosen by browser language by default.

## Quick start (Linux / macOS)

Requirements: [Docker](https://docs.docker.com/get-docker/) with the Compose v2 plugin (on macOS: Docker Desktop;
on Linux: Docker Engine, and your user in the `docker` group). Nothing else is needed: Rust, Node and pnpm are only
used inside the build containers, never on your machine.

```sh
git clone https://github.com/axelrodvl/nimbus.git nimbus
cd nimbus
./scripts/build.sh   # build all images (inside containers)
./scripts/start.sh   # start the stack
```

Then open **http://localhost:8000**.

### Scripts

| Script | What it does |
|---|---|
| `./scripts/build.sh` | Builds the `nimbus-backend` and `nimbus-web` images (the Rust and Next.js builds run inside Docker) and pre-pulls Postgres and Caddy. The first build takes several minutes; later builds reuse the BuildKit cache (cargo registry/`target`, pnpm store, Next cache). Arguments go to `docker compose build`, e.g. `--no-cache` or a service name: `./scripts/build.sh web`. |
| `./scripts/start.sh` | Starts the stack (Postgres, backend, web, Caddy) from the built images and waits until every service is healthy. Builds nothing; if the images are missing it asks you to run `build.sh`. |
| `./scripts/stop.sh` | Stops and removes the containers. Images, the database and `./data` are kept. `--purge` also deletes the database volume. |

`build.sh` and `start.sh` create `.env` from `.env.example` if it does not exist yet. Shortcuts if you have
[just](https://github.com/casey/just): `just build`, `just start`, `just stop`, `just up` (build + start).

To update: `git pull && ./scripts/build.sh && ./scripts/start.sh` (`start.sh` recreates only the containers whose
images changed).

- Logs: `docker compose logs -f` (or `just logs`)
- Data (torrents, cache) lives in `./data`; the database lives in the `nimbus_pgdata` Docker volume.
- Port `6881` (TCP/UDP) is published for incoming BitTorrent connections. It is set by `NIMBUS_TORRENT_PORT`
  (default `6881`; docker compose publishes whatever port it is set to; a busy port falls back to a random one).

Before the first run you may want to edit `.env`:

| Variable | Purpose |
|---|---|
| `NIMBUS_API_TOKEN` | Enables authentication (strongly recommended if exposed beyond localhost) |
| `NIMBUS_MB_USER_AGENT` | Your contact, e.g. `Nimbus/0.1 ( you@example.org )` — see [MusicBrainz](#musicbrainz-and-user-agent) |
| `NIMBUS_PORT` | Public port (default `8000`) |
| `NIMBUS_CACHE_LIMIT_GB` | Torrent cache limit (default `50`) |

Changes to `.env` take effect after `./scripts/start.sh`; no rebuild is needed.

## Run from prebuilt images (no build)

Each [GitHub Release](https://github.com/axelrodvl/nimbus/releases) ships a ready-to-run bundle that pulls
multi-arch (amd64/arm64) images from GHCR (`ghcr.io/axelrodvl/nimbus-backend`, `nimbus-web`):

```sh
unzip nimbus-vX.Y.Z.zip && cd nimbus
cp .env.example .env
docker compose up -d
```

To publish a release: `git tag vX.Y.Z && git push --tags` (workflow `.github/workflows/release.yml`). After the first
publish, make the two packages public in the repository's *Packages* settings so anyone can pull them.

## Windows (via WSL 2)

Nimbus is run on Windows inside **WSL 2** (Windows Subsystem for Linux) using Docker. Requires Windows 10 (22H2) or
Windows 11.

### 1. Enable virtualization in BIOS/UEFI

WSL 2 runs a lightweight virtual machine, so hardware virtualization must be on. Check first: open **Task Manager →
Performance → CPU** and look for *Virtualization: Enabled*. If it says *Disabled*:

1. Reboot and enter BIOS/UEFI (usually `Del`, `F2`, `F10` or `Esc` right after power-on).
2. Enable **Intel VT-x / Intel Virtualization Technology** (Intel) or **SVM Mode / AMD-V** (AMD). It is often under
   *Advanced → CPU Configuration*.
3. Save and reboot.

### 2. Install WSL 2 and Ubuntu

Open **PowerShell as Administrator**:

```powershell
wsl --install -d Ubuntu
```

Reboot when asked, then launch "Ubuntu" from the Start menu and create a Linux username and password.
Verify it is version 2: `wsl -l -v` (if not: `wsl --set-version Ubuntu 2`).
If the command fails, make sure the *Virtual Machine Platform* and *Windows Subsystem for Linux* features are enabled
(`optionalfeatures.exe`), then reboot.

### 3. Install Docker

Pick one:

- **Docker Desktop (easiest):** install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/),
  then in *Settings → General* enable **Use the WSL 2 based engine** and in *Settings → Resources → WSL integration*
  enable your Ubuntu distro. (Review Docker Desktop's licensing terms for commercial use.)
- **Docker Engine inside Ubuntu (no Desktop):** in the Ubuntu terminal follow
  [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/), then
  `sudo usermod -aG docker $USER`, restart the terminal, and `sudo service docker start`
  (or enable systemd in WSL: add `[boot]` / `systemd=true` to `/etc/wsl.conf` and run `wsl --shutdown`).

### 4. Run Nimbus

**Inside the Ubuntu terminal** (not PowerShell), and keep the project in the Linux filesystem (`~`), not under
`/mnt/c` — it is much faster:

```sh
cd ~
git clone https://github.com/axelrodvl/nimbus.git nimbus
cd nimbus
./scripts/build.sh
./scripts/start.sh
```

Open **http://localhost:8000** in your Windows browser — WSL forwards localhost automatically.

Troubleshooting:

- `Cannot connect to the Docker daemon` — start Docker Desktop, or `sudo service docker start` in Ubuntu.
- `WslRegisterDistribution failed ... 0x80370102` — virtualization is disabled in BIOS (step 1).
- `bash\r: No such file` / `^M` errors — scripts got CRLF line endings; run
  `git config --global core.autocrlf input` and re-clone inside WSL.
- Out of memory during the build — raise the limit in `%UserProfile%\.wslconfig` (`[wsl2]` / `memory=8GB`), then
  `wsl --shutdown`.

## Authentication

If `NIMBUS_API_TOKEN` is set, every `/api/*` route except `/api/health` requires the token: an
`Authorization: Bearer <token>` header or the `nimbus_token` cookie (set by `POST /api/auth/login` and the `/login`
page; needed for `<audio>` and WebSocket). The web server reads the same token from the environment.
**If you expose Nimbus to the internet, always set a token and put a TLS-terminating reverse proxy in front of Caddy.**
Without a token everything is open; the backend warns at startup if it listens on anything other than `127.0.0.1`.

## Development without Docker

Only needed to work on the code with hot reload; to just build and run Nimbus use the [scripts](#scripts) above.
Requirements: Rust (stable), Node 22+ with pnpm (legacy `web/`), [bun](https://bun.sh) (new `client/`), [just](https://github.com/casey/just), Docker (for PostgreSQL), ffmpeg.

```sh
cp .env.example .env
just db-up
just backend   # http://localhost:8080/api/health
just web       # http://localhost:3000 (legacy Next.js client)
just client    # http://localhost:5173 (new Vite client, proxies /api to :8080; work in progress)
```

If ports 5432/8080 are taken, change `POSTGRES_PORT`, `DATABASE_URL`, `NIMBUS_BIND`, `BACKEND_URL` and
`NEXT_PUBLIC_BACKEND_URL` in `.env`. With separate origins (dev) the login cookie is set on `localhost` regardless of
port, and CORS is opened for `NIMBUS_CORS_ORIGIN`.

Commands: `just test` (backend tests), `just check` (fmt + clippy + lint + typecheck), `just e2e` (full compose stack
with fake external services; needs Docker), `just web-gen-api` / `just client-gen-api` (regenerate API types from OpenAPI).
New client: `just client-test`, `just client-cov`, `just client-build`, `just client-e2e` (see `client/README.md`).
Backend coverage: `just cov` (needs `cargo install cargo-llvm-cov --locked` and `rustup component add llvm-tools-preview`;
runs the tests and fails below `backend/coverage-threshold.txt`, which may only go up); `just backend-cov-html` builds an
HTML report. Current baseline: `docs/coverage.md`.
JSON logs: `NIMBUS_LOG_FORMAT=json`. Health: `GET /api/health` (DB, engine, job queue).

## MusicBrainz and User-Agent

Set `NIMBUS_MB_USER_AGENT` to your own contact (e.g. `Nimbus/0.1 ( you@example.org )`). With the default placeholder
MusicBrainz often replies `503 throttled`, slowing down search and discography import. Imports are not lost: they are
retried with growing delays (up to 8 attempts), and the status is shown on the artist page.

The public server allows about **1 request per second per IP**; Nimbus keeps to that (short bursts of 3 requests for
interactive search, rate halved automatically after a `503`/`429`), fetches a discography in batches of ~25 releases with
tracklists, and serves expired cache entries if MusicBrainz is unavailable. Don't raise the limits for `musicbrainz.org`:
it risks an IP/User-Agent ban.

### Your own MusicBrainz mirror

With a self-hosted mirror ([musicbrainz-docker](https://github.com/metabrainz/musicbrainz-docker)) the limit is gone and
the import runs in parallel. Set the `musicbrainz` section via `PUT /api/settings` (UI comes later):

```json
{"musicbrainz": {"base_url": "http://mb.lan:5000/ws/2/"}}
```

For a non-`musicbrainz.org` address with the other fields left at their defaults Nimbus uses `rate_per_sec = 0`
(unlimited) and `max_concurrent = 8`. To tune it, set the fields explicitly: `rate_per_sec` (0 or 0.1–100), `burst`
(1–20), `max_concurrent` (1–32). Changes apply immediately, without a restart. `NIMBUS_MB_USER_AGENT` is still used.

## Torrent providers

Configured in `.env` or in the UI (*Settings → Sources*, each has a "Test" button).

- **TPB** (apibay) — enabled by default (`NIMBUS_TPB_ENABLED`).
- **Jackett / Prowlarr (Torznab)** — `NIMBUS_TORZNAB_URL` (e.g.
  `http://jackett:9117/api/v2.0/indexers/all/results/torznab`) and `NIMBUS_TORZNAB_API_KEY`.
- **RuTracker** — `NIMBUS_RUTRACKER_USERNAME` / `NIMBUS_RUTRACKER_PASSWORD`. If a captcha is required, log in with a
  browser and pass the whole cookie in `NIMBUS_RUTRACKER_COOKIE`. If the site is blocked, use
  `NIMBUS_RUTRACKER_PROXY` (e.g. `socks5://host:1080`).

## VPN for BitTorrent

You can route the torrent engine through a VPN container such as [gluetun](https://github.com/qdm12/gluetun): start
`gluetun` and uncomment `network_mode: "service:gluetun"` for the `backend` service in `docker-compose.yml` (move
`ports`/`depends_on` to `gluetun`; Caddy then proxies to `gluetun:8080`). Off by default.

## Limitations

- Cold start of a track takes 5–30 seconds (peer discovery and metadata fetch).
- Torrents can be dead (no seeds): the track gets a "not found" status with a reason; pick another source manually.
- Metadata comes from public MusicBrainz (1 request/s), so the first search can be slow.
- ffmpeg is required (the Docker image includes it; override the path with `NIMBUS_FFMPEG`). Transcoded streams
  (CUE, APE/WV/DSD) do not support Range seeking — a seek issues a new request.

## Translations

Dictionaries live in `web/lib/i18n/messages/<lang>.ts`; `en.ts` is the key source and the others are typed against it.
To add a language: add a dictionary file, an entry in `lib/i18n/config.ts` and a loader in `lib/i18n/messages.ts`.
The language is stored in the `nimbus_locale` cookie.

## Documentation

- [docs/architecture.md](docs/architecture.md) — diagram, pipeline, statuses.
- [docs/api.md](docs/api.md) — REST (OpenAPI) and WebSocket events.
- [PLAN.md](PLAN.md) — development plan and log.

## License

[MIT](LICENSE). The frontend in `web/` is derived from [next-beats](https://github.com/nextjs/next-beats)
(© Vercel, Inc., MIT); its notice is preserved in [LICENSE](LICENSE) and `web/LICENSE`.
The license covers the code only, not the content you stream — see the disclaimer above.
