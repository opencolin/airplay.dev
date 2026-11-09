# Samsung Wall

A small hub that drives the office Samsung screens (32" Smart Monitor M8s and 98" Crystal UHD TVs)
over DLNA. It shows websites, images and videos on any set of screens, keeps them playing through
sleep and dropped streams, and switches monitors back to their PC input.

Websites are rendered by headless Chrome and streamed to the screens through ffmpeg as one shared
MPEG-TS stream, so every screen showing the same page stays in sync.

## Set it up with Claude

Open the landing page (`site/`, deployed on Vercel) and paste its prompt into Claude Code on a
Mac that is on the same network as the screens. Claude installs
[`site/skill.md`](site/skill.md) (served at `/skill.md`), which has it clone this repo,
start the hub, scan for screens, and then control them at `http://localhost:8787`.

## Run the hub by hand

Needs macOS, Node 20+, ffmpeg and Google Chrome.

```bash
npm install
npm start                      # run in the foreground
scripts/install-service.sh     # run at login as a launch agent
```

The dashboard is at `http://localhost:8787` and needs no password on the hub machine. Set
`DASHBOARD_PASSWORD` before either command to also open it from other devices. Screen state,
uploads and the Chrome profile live in `data/`, which is not committed.

## Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /` | password | Dashboard |
| `GET /start` | none | Same landing page as `site/` |
| `GET /api/state` | password | Screens, library, groups |
| `POST /api/show` | password | `{ids, assetId, mode?, delaySeconds?}` |
| `POST /api/clear`, `/api/pc`, `/api/identify` | password | `{ids}` |
| `POST /api/scan` | password | Rediscover screens and wake sleepers |
| `POST /api/library`, `/api/upload` | password | Add a URL or a file |

## Notes from testing the screens

- Sleeping screens wake with Wake-on-LAN to their Wi-Fi MAC, usually in about 3 seconds but
  sometimes over 15, and fall asleep again about a minute after nothing is playing.
- Monitors switch to their PC (USB-C) input with remote key `KEY_PCMODE` over
  `wss://<ip>:8002` (`samsung.remote.control`). MDC on port 1515 did not work.
