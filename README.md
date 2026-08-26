# Exam Speedrun

A LiveSplit-style timer for practising exam papers (Full Paper / Topic Drill), extended
with local webcam + screen tracking to flag idle time and time away from the desk, plus
an optional AI check that reads which question is on screen.

## Setup

```bash
cd exam-speedrun
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt         # macOS/Linux

copy .env.example .env                              # Windows
# cp .env.example .env                               # macOS/Linux
```

Open `.env` and set:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at https://console.anthropic.com/settings/keys. This is only needed if you
want the **AI section detection** feature — the timer, splits, PBs, and idle/away
tracking all work without one.

## Run

```bash
.venv\Scripts\python server.py      # Windows
# .venv/bin/python server.py         # macOS/Linux
```

Then open **http://127.0.0.1:5183**. Screen share and webcam permission prompts only
work over `localhost`/`https`, which is why this needs the local server instead of a
plain `.html` file — `getUserMedia`/`getDisplayMedia` are blocked on `file://`.

## How it works

- **Timer / splits / PBs** — same mechanics as before: pick a subject, pick Full Paper
  (split per section) or Topic Drill (split per question), start, split, finish. Runs and
  PBs are stored in `data/runs.json` on disk (not `localStorage` — a JSON file survives
  the app restarting cleanly and doesn't need any DB setup).
- **Enable tracking** — click it to get the browser's native screen-share and webcam
  permission prompts. You can grant either one, both, or neither; tracking works with
  whatever you allow. A dot in the tracking bar goes amber and the status text changes
  when idle/away is detected.
- **Idle detection (screen, local only)** — every ~1.2s the browser diffs the current
  screen frame against the previous one at low resolution. No visible change for longer
  than the configured "idle after" threshold (default 90s) is logged as an idle spell.
  No API calls, no data leaves the browser.
- **Away detection (webcam, local only)** — same diffing approach applied to the webcam
  feed. This is a simple motion-diff heuristic, not face detection — if the frame stays
  essentially static (you've stepped away, or you're being unusually still) for longer
  than the "away after" threshold (default 20s), it's logged as an away spell. Webcam
  frames are never sent anywhere, analyzed or not.
- **AI section detection (optional, needs an API key)** — every "AI check every N sec"
  (default 25s), a downscaled screenshot is sent to the local server, which forwards it
  to Claude asking "which section/question from this run's list is currently visible?"
  If Claude's answer disagrees with the split you're currently tracking, a banner appears
  with **Split** / **Dismiss** — it never auto-splits on its own, since a false positive
  would corrupt your run data. The screenshot is not saved anywhere; it's discarded by
  the server as soon as the response comes back.
- **Per-split breakdown** — after a run finishes, each split row shows any idle/away
  spells and AI flags that happened during it, so you can see *why* a section was slow,
  not just that it was slow.

## Privacy

- Camera and screen access always go through the browser's standard permission prompts —
  nothing is pre-authorized or bypassed.
- The tracking bar shows a visible indicator any time capture is active, with a one-click
  **Stop tracking** button that kills both streams immediately without ending your run.
- Raw webcam video and raw screen video/images are never written to disk. The only things
  persisted are: idle/away timestamps and durations, AI-flag decisions, and your run/split
  times — never the frames themselves.
- The only image data that ever leaves your machine is the small set of downscaled
  screenshots sent for AI section detection (only while that feature is on), and only to
  Anthropic's API via your own server. Webcam frames are 100% local, always.
- Your Anthropic API key lives only in `.env` on your machine and is read server-side; it
  is never sent to or stored in the browser.

## Deploying (Render)

This is a single-user tool by design — deploying it publicly means anyone with the URL
could use it, so set `APP_PASSWORD` before you do (it gates the whole app behind a
browser login prompt; unset locally, it stays open for convenience).

1. Push this repo to GitHub (see steps below if you haven't yet).
2. On https://dashboard.render.com → **New** → **Blueprint**, point it at the repo.
   Render reads `render.yaml` and creates the service automatically.
3. In the service's **Environment** tab, set:
   - `ANTHROPIC_API_KEY` — your key
   - `APP_USERNAME` — whatever login name you want (default `exam`)
   - `APP_PASSWORD` — a real password, not blank
4. Deploy. Render gives you an HTTPS URL like `exam-speedrun.onrender.com` — camera/screen
   permissions work there since it's HTTPS.
5. **Custom domain (optional):** in the service's **Settings → Custom Domains**, add your
   domain and follow Render's instructions to point a CNAME (or A record) at it from your
   DNS provider. Render issues the TLS certificate automatically once DNS resolves.

**Persistence note:** the free plan's disk is ephemeral — `data/runs.json` resets on every
redeploy or restart. To keep run history permanently, upgrade the service to a paid plan,
attach a persistent disk (Render dashboard → Disks), mount it at e.g. `/data`, and set the
`DATA_DIR=/data` env var.

### Pushing to GitHub for the first time

```bash
git remote add origin https://github.com/<your-username>/exam-speedrun.git
git branch -M main
git push -u origin main
```

(Create the empty repo on GitHub first — no README/license/gitignore, since this repo
already has its own.)

## Project layout

```
server.py          FastAPI backend: static file serving, run persistence, Claude relay
static/index.html  Page shell
static/style.css   Design system (dark, JetBrains Mono numerals, Inter UI, per-subject accent)
static/app.js      Timer/splits/PB state, rendering, run persistence
static/tracking.js Screen/webcam capture, local frame diffing, AI section-check calls
data/runs.json     Run history + PBs (created on first save)
```

## Adding a subject

Edit the `SUBJECTS` object at the top of `static/app.js` — add a key with `label`, `code`,
`accent`, `paperDefault` (name + section list), and `drillTopics`.
