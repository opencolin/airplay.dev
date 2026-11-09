# Samsung Wall

A small hub that drives the office Samsung screens (32" Smart Monitor M8s and 98" Crystal UHD TVs)
over DLNA. It shows websites, images and videos on any set of screens, keeps them playing through
sleep and dropped streams, and switches monitors back to their PC input.

Websites are rendered by headless Chrome and streamed to the screens through ffmpeg as one shared
MPEG-TS stream, so every screen showing the same page stays in sync.

## Control it from Claude

Open the landing page (`site/`, deployed on Vercel), copy the prompt into Claude Code, and give
it the wall password when asked. That installs [`skills/samsung-wall/SKILL.md`](skills/samsung-wall/SKILL.md) as the
`samsung-wall` skill, after which you can just ask Claude to put things on the screens.

The hub announces itself over Bonjour as `_samsungwall._tcp`, so the skill finds it by name
whichever machine runs it and whatever its IP is.

## Run the hub

Needs macOS, Node 20+, ffmpeg and Google Chrome.

```bash
npm install
DASHBOARD_PASSWORD=... npm start                      # run in the foreground
DASHBOARD_PASSWORD=... scripts/install-service.sh     # run at login as a launch agent
```

The dashboard is at `http://<hub>:8787`. It needs no password from the hub itself; everywhere
else it asks for `DASHBOARD_PASSWORD`. Screen state, uploads and the Chrome profile live in
`data/`, which is not committed.

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
