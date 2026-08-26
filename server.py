"""
Exam Speedrun — backend.

Thin relay + JSON persistence. Serves the frontend from ./static and
exposes two small API surfaces:
  - /api/runs           run history / PBs, persisted to data/runs.json
  - /api/vision/section  downscaled-screenshot -> "which section is this"
                         via a local LM Studio server (no cloud API, no key —
                         only reachable when this backend and LM Studio are
                         running on the same machine)

Run with: python server.py
"""
import base64
import json
import os
import re
import secrets
import threading
from pathlib import Path

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

load_dotenv()

ROOT = Path(__file__).parent
DATA_DIR = Path(os.environ.get("DATA_DIR") or (ROOT / "data"))
DATA_FILE = DATA_DIR / "runs.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# LM Studio's local server (Developer tab -> Start Server), OpenAI-compatible.
# Only reachable from wherever this backend process itself is running — if
# you deploy this app to a host like Render, AI section detection will fail
# there (LM Studio is on your PC, not the host), while the timer/splits/PB/
# idle-away tracking keep working fine.
LM_STUDIO_BASE_URL = (os.environ.get("LM_STUDIO_BASE_URL") or "http://localhost:1234/v1").rstrip("/")
LM_STUDIO_MODEL = os.environ.get("LM_STUDIO_MODEL", "gemma-3-4b-it").strip()

# Set APP_PASSWORD when deploying anywhere reachable off your own machine —
# it gates the whole app behind HTTP Basic Auth. Left unset for local dev,
# where anyone reaching it already has access to the machine.
APP_USERNAME = os.environ.get("APP_USERNAME", "exam").strip()
APP_PASSWORD = os.environ.get("APP_PASSWORD", "").strip()

app = FastAPI(title="Exam Speedrun")


class BasicAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if not APP_PASSWORD:
            return await call_next(request)
        auth = request.headers.get("authorization", "")
        if auth.startswith("Basic "):
            try:
                user, _, pwd = base64.b64decode(auth[6:]).decode("utf-8").partition(":")
            except Exception:
                user, pwd = "", ""
            if secrets.compare_digest(user, APP_USERNAME) and secrets.compare_digest(pwd, APP_PASSWORD):
                return await call_next(request)
        return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Exam Speedrun"'})


app.add_middleware(BasicAuthMiddleware)

_lock = threading.Lock()


def _load_runs():
    if not DATA_FILE.exists():
        return []
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8")).get("runs", [])
    except (json.JSONDecodeError, OSError):
        return []


def _save_runs(runs):
    DATA_FILE.write_text(json.dumps({"runs": runs}, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- runs API

class Run(BaseModel):
    id: str
    key: str
    subject: str
    mode: str
    label: str
    sections: list
    totalMs: float
    date: str
    isPB: bool = False
    events: list = []


@app.get("/api/runs")
def list_runs():
    with _lock:
        return {"runs": _load_runs()}


@app.post("/api/runs")
def save_run(run: Run):
    with _lock:
        runs = _load_runs()
        runs.insert(0, run.model_dump())
        runs = runs[:500]
        _save_runs(runs)
    return {"ok": True, "run": run}


@app.delete("/api/runs")
def clear_runs():
    with _lock:
        _save_runs([])
    return {"ok": True}


# ------------------------------------------------------------ vision API

DATA_URL_RE = re.compile(r"^data:(image/\w+);base64,(.+)$", re.DOTALL)


class SectionCheckRequest(BaseModel):
    image: str  # data: URL, downscaled screenshot
    subject: str
    labels: list[str]
    currentIndex: int


@app.post("/api/vision/section")
def vision_section_check(req: SectionCheckRequest):
    if not DATA_URL_RE.match(req.image):
        raise HTTPException(status_code=400, detail="image must be a data: URL")
    if not req.labels:
        raise HTTPException(status_code=400, detail="labels list is empty")

    labels_block = "\n".join(f"{i}: {label}" for i, label in enumerate(req.labels))

    try:
        resp = requests.post(
            f"{LM_STUDIO_BASE_URL}/chat/completions",
            json={
                "model": LM_STUDIO_MODEL,
                "max_tokens": 200,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are watching a screenshot of a student working through an exam paper "
                            "or a set of practice questions. You are given a numbered list of the "
                            "sections/questions in their current run. Identify which one is currently "
                            "visible/being worked on. Reply with ONLY a JSON object, no prose, no "
                            'markdown fences: {"index": <int, 0-based index into the list, or -1 if you '
                            'cannot tell>, "confidence": <float 0-1>}'
                        ),
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": req.image}},
                            {
                                "type": "text",
                                "text": (
                                    f"Subject: {req.subject}\n"
                                    f"Sections/questions (0-based index: label):\n{labels_block}\n\n"
                                    f"Currently tracked as index {req.currentIndex}. "
                                    "Which index is actually visible on screen right now?"
                                ),
                            },
                        ],
                    },
                ],
            },
            timeout=30,
        )
        resp.raise_for_status()
    except requests.exceptions.ConnectionError as e:
        raise HTTPException(
            status_code=503,
            detail=f"Couldn't reach LM Studio at {LM_STUDIO_BASE_URL} — make sure it's running with a "
                   "model loaded (Developer tab -> Start Server).",
        ) from e
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=502, detail=f"LM Studio call failed: {e}") from e

    text = resp.json()["choices"][0]["message"]["content"].strip()
    # local models often ignore "no markdown fences" and wrap the JSON in
    # ```json ... ``` anyway — pull out the first {...} blob regardless.
    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    try:
        parsed = json.loads(json_match.group(0) if json_match else text)
        index = int(parsed.get("index", -1))
        confidence = float(parsed.get("confidence", 0))
    except (json.JSONDecodeError, TypeError, ValueError, KeyError, IndexError, AttributeError):
        index, confidence = -1, 0.0

    if index < -1 or index >= len(req.labels):
        index = -1

    return {
        "index": index,
        "label": req.labels[index] if index >= 0 else None,
        "confidence": confidence,
    }
    # Note: the screenshot (`req.image`) is never written to disk — it lives
    # only in this request's memory and is discarded once this handler returns.


# ------------------------------------------------------------- static app

app.mount("/assets", StaticFiles(directory=ROOT / "static"), name="assets")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 5183))
    # DEV_RELOAD=1 for local autoreload; off by default (and always off when
    # deployed, since reload's watcher process isn't something you want in prod)
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=bool(os.environ.get("DEV_RELOAD")))
