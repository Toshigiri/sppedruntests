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

AI section detection uses a local model via **LM Studio** instead of a paid cloud API —
the timer, splits, PBs, and idle/away tracking all work without it, so this step is
optional:

1. Install [LM Studio](https://lmstudio.ai/).
2. In its model browser, download a vision-capable model — `gemma-3-4b-it` is a good
   default (small, fast, decent at reading on-screen text). For better accuracy on a
   beefier machine, `qwen2.5-vl-7b` reads small text more reliably.
3. Load the model, then go to the **Developer** tab → **Start Server** (default
   `http://localhost:1234`).
4. If you used a different model, update `LM_STUDIO_MODEL` in `.env` to match its exact
   id (check `http://localhost:1234/v1/models` while the server is running).

LM Studio needs to be running with a model loaded whenever you want the AI check —
everything else works fine without it.

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
- **AI section detection (optional, needs LM Studio running locally)** — every "AI check
  every N sec" (default 25s), a downscaled screenshot is sent to your local backend, which
  forwards it to LM Studio asking "which section/question from this run's list is
  currently visible?" If the model's answer disagrees with the split you're currently
  tracking, a banner appears with **Split** / **Dismiss** — it never auto-splits on its
  own, since a false positive would corrupt your run data. The screenshot is not saved
  anywhere; it's discarded as soon as the response comes back. If LM Studio isn't running,
  this just quietly turns itself off (visible in the tracking bar) — nothing else breaks.
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
- AI section detection runs against LM Studio on your own machine — no cloud API, no key,
  no image data ever leaves your computer. Webcam frames are 100% local, always, in every
  mode.

## Deploying (Render)

This is a single-user tool by design — deploying it publicly means anyone with the URL
could use it, so set `APP_PASSWORD` before you do (it gates the whole app behind a
browser login prompt; unset locally, it stays open for convenience).

**AI section detection will not work on the deployed copy** — it calls LM Studio on
whatever machine the backend runs on, and on Render that's Render's container, not your
PC. Timer, splits, PBs, and local idle/away tracking are unaffected; only the AI-flag
banner won't fire remotely. Run locally on this machine (with LM Studio running) if you
want that feature.

1. Push this repo to GitHub (see steps below if you haven't yet).
2. On https://dashboard.render.com → **New** → **Blueprint**, point it at the repo.
   Render reads `render.yaml` and creates the service automatically.
3. In the service's **Environment** tab, set:
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
server.py          FastAPI backend: static file serving, run persistence, LM Studio relay
static/index.html  Page shell
static/style.css   Design system (dark, JetBrains Mono numerals, Inter UI, per-subject accent)
static/app.js      Timer/splits/PB state, rendering, run persistence
static/tracking.js Screen/webcam capture, local frame diffing, AI section-check calls
data/runs.json     Run history + PBs (created on first save)
```

## Adding a subject

Edit the `SUBJECTS` object at the top of `static/app.js` — add a key with `label`, `code`,
`accent`, `paperDefault` (name + section list), and `drillTopics`.
