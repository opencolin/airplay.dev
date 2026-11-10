---
name: airplay-dev
description: Control the Smart TVs and monitors on the local network with airplay.dev — show a website, image or video on one screen or many, clear them, switch monitors back to their PC input, or check what each screen is showing. Use whenever the user asks to put something on the TVs, the 98-inch screens, the monitors, the wall, the conference room screen, or asks what is on them.
---

# airplay.dev

The airplay.dev hub is a small server that runs on the user's own machine. It finds the Smart
TVs and monitors on the local network and drives them over DLNA. You control it with `curl` at
`http://localhost:8787`. No password is needed from the machine the hub runs on.

Today the hub only finds and drives Samsung Smart TVs and Smart Monitors. If the user's screens
are another brand, say so up front rather than installing.

## Setup

Check whether the hub is already running:

```bash
curl -s -o /dev/null -m 3 -w '%{http_code}\n' http://localhost:8787/api/state
```

`200` means it is: skip to the next section. Otherwise install it. This needs macOS, and the
machine must be on the same network as the screens.

1. Check what's there:

   ```bash
   node -v; command -v ffmpeg git; ls -d "/Applications/Google Chrome.app"
   ```

   The hub needs Node 20+, ffmpeg, git and Google Chrome. If any are missing, tell the user
   which, and ask before installing them (`brew install node ffmpeg`; Chrome from google.com/chrome).

2. Get the code and install the hub so it starts at login and stays running:

   ```bash
   git clone https://github.com/opencolin/airplay.dev ~/airplay.dev
   cd ~/airplay.dev && npm install && scripts/install-service.sh
   ```

   If `~/airplay.dev` already exists, `git -C ~/airplay.dev pull` instead of cloning.

3. Wait a few seconds, then find the screens. The scan takes up to a minute:

   ```bash
   curl -s -X POST -m 120 http://localhost:8787/api/scan
   ```

   macOS may ask the user to allow `node` to find devices on the local network; they must allow
   it. If no screens come back, check the screens are on and on the same network, and read
   `~/airplay.dev/data/hub.log`.

4. Tell the user which screens were found, by label.

To restart the hub: `launchctl kickstart -k gui/$(id -u)/club.samsungwall.hub`.

## See the screens and the library

```bash
curl -s "http://localhost:8787/api/state"
```

Returns JSON with:

- `monitors[]`: `id`, `label` (the name people use, e.g. `98" Crystal UHD`, `Conference Room`),
  `ip`, `model`, `status` (`playing`, `asleep`, `sending`, `error`, `checking`…), `error`,
  and `content` (what it should be showing).
- `library[]`: things that can be shown — `id`, `name`, `type` (`url`, `image`, `video`), `src`.
- `groups[]`: saved sets of screens — `id`, `name`, `ids`.

Match what the user says to screens by `label` and `model`. Models starting `UN98` are the
98-inch TVs; `LS32FM8` are the 32-inch M8 monitors. If you can't tell which screens they mean,
list the labels and ask.

## Show something

If the user asks to put something on the screens without saying what, ask them two things
(in one question if your client supports multiple choice):

1. **What to show:** a website (ask for the URL), an image (PNG, JPEG, GIF or WebP), a video
   (MP4), or something already in the library (list the library names).
2. **Where:** which screens or group, from the labels in `/api/state`.

For an image or video, ask for the file path or for them to attach it. Then follow the steps below.

Content must be in the library first. To show a website, add it (if it isn't there already) and
take its `id` from the returned `library`:

```bash
curl -s -X POST "http://localhost:8787/api/library" \
  -H 'content-type: application/json' -d '{"src":"https://example.com/"}'
```

To add an image or video file (PNG, JPEG, GIF, WebP or MP4, up to 500 MB):

```bash
curl -s -X POST "http://localhost:8787/api/upload" \
  -H 'content-type: image/png' -H 'x-file-name: Poster' --data-binary @poster.png
```

Then send it to the screens by id. All the listed screens start together:

```bash
curl -s -X POST "http://localhost:8787/api/show" \
  -H 'content-type: application/json' \
  -d '{"ids":["<screen id>","<screen id>"],"assetId":"<library id>"}'
```

To start them one after another instead, add `"mode":"sequence","delaySeconds":5`.

The hub wakes sleeping screens and sends the content once. It does not push it back: if someone
switches the screen to another input or turns it off, the hub lets go and the screen shows as
`idle` again. Websites take a few seconds to start. After sending, wait ~10 seconds, check
`/api/state`, and tell the user which screens are `playing` and quote any `error` in full.

## Other actions

All take `{"ids":[...]}`:

| Action | Endpoint | What it does |
| --- | --- | --- |
| Clear | `POST /api/clear` | Stops what the hub is showing; monitors go back to their PC input |
| Switch to PC | `POST /api/pc` | Monitors only: switch to the PC (USB-C) input |
| Identify | `POST /api/identify` | Shows each screen's name on it for a few seconds |
| Find screens | `POST /api/scan` (no body) | Rescans the network and wakes sleepers; takes up to a minute |

Groups: `POST /api/groups` with `{"name":"…","ids":[…]}` saves one; `POST /api/groups/delete`
with `{"id":"…"}` removes it.

## Be considerate

These screens are shared and visible to the whole office. Before replacing something that is
already `playing` on a screen the user did not name, or before clearing screens, say what is on
them now and confirm. Don't delete library items or rename screens unless asked.
