---
name: samsung-wall
description: Control the office Samsung TVs and monitors (the Samsung Wall) — show a website, image or video on one screen or many, clear them, switch monitors back to their PC input, or check what each screen is showing. Use whenever the user asks to put something on the TVs, the 98-inch screens, the monitors, the wall, the conference room screen, or asks what is on them.
---

# Samsung Wall

The Samsung Wall hub is a small server on the office network that drives the Samsung screens
over DLNA. You control it through its HTTP API with `curl`. You must be on the office network.

Hub address: `{{HUB_URL}}`

## Setup (once)

The hub needs the wall password. Look for it in `~/.samsung-wall`:

```bash
cat ~/.samsung-wall 2>/dev/null
```

If the file is missing, ask the user for the wall password (they get it from whoever runs the
hub; never guess it), then save it without echoing it back:

```bash
umask 077; printf 'HUB=%s\nPW=%s\n' '{{HUB_URL}}' '<password>' > ~/.samsung-wall
```

Every command below starts by loading that file:

```bash
. ~/.samsung-wall
```

A `401` means the password is wrong: ask again and rewrite the file. If the hub does not answer,
the user is probably off the office network, or the hub address changed — ask them to open the
hub's `/start` page again and copy the new prompt.

## See the screens and the library

```bash
. ~/.samsung-wall; curl -s -u ":$PW" "$HUB/api/state"
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
. ~/.samsung-wall; curl -s -u ":$PW" -X POST "$HUB/api/library" \
  -H 'content-type: application/json' -d '{"src":"https://example.com/"}'
```

To add an image or video file (PNG, JPEG, GIF, WebP or MP4, up to 500 MB):

```bash
. ~/.samsung-wall; curl -s -u ":$PW" -X POST "$HUB/api/upload" \
  -H 'content-type: image/png' -H 'x-file-name: Poster' --data-binary @poster.png
```

Then send it to the screens by id. All the listed screens start together:

```bash
. ~/.samsung-wall; curl -s -u ":$PW" -X POST "$HUB/api/show" \
  -H 'content-type: application/json' \
  -d '{"ids":["<screen id>","<screen id>"],"assetId":"<library id>"}'
```

To start them one after another instead, add `"mode":"sequence","delaySeconds":5`.

The hub wakes sleeping screens and keeps re-sending the content if a screen drops it, so you only
need to send once. Websites take a few seconds to start. After sending, wait ~10 seconds, check
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
