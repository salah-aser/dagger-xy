from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DATA = Path(os.getenv("SALAHDATA", str(ROOT / "data")))
OUTPUTS = DATA / "outputs"
DB_PATH = DATA / "salah.db"
STATIC = ROOT / "static"
WORKFLOW_PATH = DATA / "workflow_api.json"
COMFY_URL = os.getenv("COMFYUI_URL", "http://comfyui:8188").rstrip("/")
API_TOKEN = os.getenv("API_TOKEN", "").strip()
TTS_PROVIDER = os.getenv("TTS_PROVIDER", "local").lower()
COMFY_TIMEOUT = int(os.getenv("COMFY_TIMEOUT_SECONDS", "1800"))
AUTH = HTTPBearer(auto_error=False)
ACTIVE_TASKS: dict[str, asyncio.Task] = {}
JOB_LOCKS: dict[str, asyncio.Lock] = {}

DATA.mkdir(parents=True, exist_ok=True)
OUTPUTS.mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with get_db() as db:
        db.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            stage TEXT NOT NULL DEFAULT 'queued',
            script TEXT NOT NULL,
            request_json TEXT NOT NULL,
            scenes_json TEXT NOT NULL DEFAULT '[]',
            error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            final_file TEXT NOT NULL DEFAULT ''
        )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS jobs_updated_idx ON jobs(updated_at DESC)")


def row_to_job(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "status": row["status"],
        "progress": row["progress"],
        "stage": row["stage"],
        "script": row["script"],
        "request": json.loads(row["request_json"]),
        "scenes": json.loads(row["scenes_json"]),
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "final_url": f"/api/files/{row['final_file']}" if row["final_file"] else None,
    }


def read_job(job_id: str) -> dict[str, Any]:
    with get_db() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(404, "المشروع غير موجود.")
    return row_to_job(row)


def update_job(job_id: str, **changes: Any) -> None:
    allowed = {"title", "status", "progress", "stage", "scenes_json", "error", "updated_at", "final_file"}
    if any(key not in allowed for key in changes):
        raise ValueError("Unsupported job field")
    changes["updated_at"] = now_iso()
    assignments = ", ".join(f"{key}=?" for key in changes)
    values = [json.dumps(value, ensure_ascii=False) if key == "scenes_json" else value for key, value in changes.items()]
    with get_db() as db:
        db.execute(f"UPDATE jobs SET {assignments} WHERE id=?", (*values, job_id))


def require_auth(credentials: HTTPAuthorizationCredentials | None = Depends(AUTH)) -> None:
    if not API_TOKEN:
        return
    supplied = credentials.credentials if credentials else ""
    if not supplied or not secrets.compare_digest(supplied, API_TOKEN):
        raise HTTPException(401, "مطلوب رمز وصول صحيح لسيرفر Salah Cloud.", headers={"WWW-Authenticate": "Bearer"})


class CreateJob(BaseModel):
    script: str = Field(min_length=20, max_length=30000)
    character_description: str = Field(default="", max_length=2500)
    title: str = Field(default="", max_length=120)
    language: Literal["ar", "ar-EG", "en"] = "ar"
    voice_provider: Literal["local", "edge"] = "local"
    target_minutes: float = Field(default=2, ge=0.25, le=20)
    aspect_ratio: Literal["9:16", "16:9", "1:1"] = "9:16"
    width: int = Field(default=480, ge=320, le=1280)
    height: int = Field(default=854, ge=320, le=1280)
    frames: int = Field(default=81, ge=25, le=241)
    seed: int | None = None
    visual_style: Literal["cinematic", "historical", "horror", "spiritual", "documentary"] = "cinematic"
    religious_face_rule: bool = True
    arab_characters: bool = True


def split_script(script: str, target_minutes: float) -> list[str]:
    """Keep the text in order; prefer sentence boundaries and cap scene size."""
    text = re.sub(r"\s+", " ", script).strip()
    if not text:
        return []
    words = text.split(" ")
    target_scenes = max(1, min(80, round(target_minutes * 4)))
    words_per_scene = max(12, min(34, (len(words) + target_scenes - 1) // target_scenes))
    sentences = re.split(r"(?<=[.!?؟…؛])\s+", text)
    units: list[str] = []
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        # Comma clauses improve breath groups in Arabic without deleting punctuation.
        clauses = re.split(r"(?<=،)\s*", sentence)
        for clause in clauses:
            bits = clause.split()
            while bits:
                chunk = bits[:words_per_scene]
                bits = bits[words_per_scene:]
                units.append(" ".join(chunk))
    scenes: list[str] = []
    buffer: list[str] = []
    count = 0
    for unit in units:
        size = len(unit.split())
        if buffer and (count + size > words_per_scene or len(" ".join(buffer)) + len(unit) > 1200):
            scenes.append(" ".join(buffer).strip())
            buffer, count = [], 0
        buffer.append(unit)
        count += size
    if buffer:
        scenes.append(" ".join(buffer).strip())
    # Protect against empty items and cap job size.
    scenes = [scene for scene in scenes if scene]
    if len(scenes) > 80:
        raise ValueError("النص يحتاج أكثر من 80 مشهدًا. قسّم القصة إلى مشروعين أقصر.")
    return scenes


def make_prompt(scene: str, req: dict[str, Any], index: int, total: int) -> str:
    styles = {
        "cinematic": "photorealistic live-action cinema, physically plausible light, natural skin and cloth textures, deliberate camera movement",
        "historical": "photorealistic historical drama, plausible period props and architecture, natural fabric texture, no modern objects",
        "horror": "serious atmospheric horror cinema, restrained dread, realistic shadows, no text or gore",
        "spiritual": "reverent and dignified spiritual atmosphere, solemn framing, warm natural light, no disrespectful depiction",
        "documentary": "photorealistic documentary cinematography, natural light, grounded camera position",
    }
    rules = [
        styles.get(req.get("visual_style", "cinematic"), styles["cinematic"]),
        "One continuous scene, one shot, one moment; never a collage, triptych, storyboard, contact sheet, split screen, comic panels, or multiple frames in one image.",
        f"Scene {index + 1} of {total}. Portray only this scene and do not depict other scenes.",
        "No captions, letters, subtitles, logos, borders or watermark.",
    ]
    if req.get("arab_characters"):
        rules.append("Characters are Arab; use plausible Arab features and culturally consistent setting when people appear.")
    if req.get("character_description"):
        rules.append("Continuity reference, keep the same described people, apparent ages, facial features, hair, beard and outfits through every scene: " + req["character_description"])
    if req.get("religious_face_rule"):
        rules.append("Respectful religious depiction: if a prophet, messenger, or companion is represented, show a dignified sheikh-like figure with the entire face replaced by pure radiant light without facial features.")
    rules.append("Action for this scene: " + scene)
    return ". ".join(rules)


def workflow_ready() -> bool:
    return WORKFLOW_PATH.exists()


async def comfy_health() -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            resp = await client.get(f"{COMFY_URL}/system_stats")
            resp.raise_for_status()
            data = resp.json()
            devices = data.get("devices", [])
            gpu_info = [
                {"name": d.get("name"), "vram_total": d.get("vram_total"), "vram_free": d.get("vram_free")}
                for d in devices
            ]
            return {"online": True, "gpu": gpu_info}
    except Exception as exc:
        return {"online": False, "error": str(exc)[:200], "gpu": []}


async def object_info() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.get(f"{COMFY_URL}/object_info")
        response.raise_for_status()
        return response.json()


def graph_to_api(graph: dict[str, Any], info: dict[str, Any]) -> dict[str, Any]:
    """Convert a classic ComfyUI UI graph into API prompt format."""
    if isinstance(graph, dict) and graph and all(isinstance(v, dict) and "class_type" in v for v in graph.values()):
        return graph
    nodes = graph.get("nodes")
    links = graph.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise ValueError("ملف سير العمل يجب أن يكون ComfyUI API JSON أو رسم ComfyUI عادي.")
    link_map: dict[int, tuple[str, int]] = {}
    for link in links:
        if isinstance(link, list) and len(link) >= 5:
            link_map[int(link[0])] = (str(link[1]), int(link[2]))
    result: dict[str, Any] = {}
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") not in info:
            continue
        class_type = node["type"]
        schema = info[class_type].get("input", {})
        widgets = list(node.get("widgets_values") or [])
        connected: dict[str, list[Any]] = {}
        for inp in node.get("inputs", []):
            link_id = inp.get("link")
            if link_id is not None and int(link_id) in link_map:
                src, slot = link_map[int(link_id)]
                connected[inp["name"]] = [src, slot]
        api_inputs = dict(connected)
        widget_idx = 0
        schema_names: list[str] = []
        for key in ("required", "optional"):
            values = schema.get(key, {})
            if isinstance(values, dict):
                schema_names.extend(values.keys())
        for name in schema_names:
            if name in connected:
                continue
            # Widget values follow the node's remaining unconnected inputs.
            if widget_idx < len(widgets):
                api_inputs[name] = widgets[widget_idx]
                widget_idx += 1
        properties = node.get("properties") or {}
        title = node.get("title") or properties.get("Node name for S&R") or class_type
        result[str(node["id"])] = {"class_type": class_type, "inputs": api_inputs, "_meta": {"title": str(title)}}
    if not result:
        raise ValueError("لم يتم العثور على عقد ComfyUI قابلة للتنفيذ في سير العمل.")
    return result


async def get_workflow() -> dict[str, Any]:
    if not WORKFLOW_PATH.exists():
        raise RuntimeError("لم يتم إعداد سير عمل ComfyUI بعد. افتح إعداد سير العمل في لوحة Salah Cloud وارفع ملف API JSON من ComfyUI.")
    raw = json.loads(WORKFLOW_PATH.read_text(encoding="utf-8"))
    info = await object_info()
    workflow = graph_to_api(raw, info)
    return workflow


def patch_workflow(base: dict[str, Any], prompt: str, req: dict[str, Any], scene_num: int, job_id: str) -> dict[str, Any]:
    wf = json.loads(json.dumps(base))
    aspect = req.get("aspect_ratio", "9:16")
    width, height = (480, 854) if aspect == "9:16" else ((854, 480) if aspect == "16:9" else (640, 640))
    width = int(req.get("width") or width)
    height = int(req.get("height") or height)
    frames = int(req.get("frames") or 81)
    seed_base = int(req.get("seed") or secrets.randbelow(2**31 - 1))
    for node in wf.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        title = str(node.get("_meta", {}).get("title", "")).lower()
        class_type = str(node.get("class_type", ""))
        if "text" in inputs and ("cliptextencode" in class_type.lower() or "textencode" in class_type.lower()):
            if "negative" not in title:
                inputs["text"] = prompt
        for key in list(inputs.keys()):
            low = key.lower()
            if low in {"seed", "noise_seed"}:
                inputs[key] = seed_base + scene_num
            elif low == "width":
                inputs[key] = width
            elif low == "height":
                inputs[key] = height
            elif low in {"length", "frames", "num_frames"}:
                inputs[key] = frames
            elif low in {"filename_prefix"}:
                inputs[key] = f"salah/{job_id}/scene-{scene_num + 1:03d}"
    return wf


async def queue_comfy(workflow: dict[str, Any]) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(f"{COMFY_URL}/prompt", json={"prompt": workflow, "client_id": "salah-cloud"})
        if response.status_code >= 400:
            raise RuntimeError("ComfyUI رفض سير العمل: " + response.text[:900])
        data = response.json()
        if not data.get("prompt_id"):
            raise RuntimeError("ComfyUI لم يُرجع prompt_id: " + json.dumps(data, ensure_ascii=False)[:500])
        return str(data["prompt_id"])


async def wait_for_comfy(prompt_id: str, timeout: int = COMFY_TIMEOUT) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient(timeout=20) as client:
        while time.monotonic() < deadline:
            response = await client.get(f"{COMFY_URL}/history/{prompt_id}")
            if response.status_code == 200:
                data = response.json()
                if prompt_id in data:
                    return data[prompt_id]
                if data:
                    return next(iter(data.values()))
            await asyncio.sleep(3)
    raise TimeoutError("انتهت مهلة توليد الفيديو. تحقق من ذاكرة GPU وحالة ComfyUI ثم أعد المحاولة.")


def collect_video_ref(history: dict[str, Any]) -> dict[str, str]:
    outputs = history.get("outputs", {})
    for node in outputs.values():
        if not isinstance(node, dict):
            continue
        for key in ("videos", "gifs", "files"):
            for item in node.get(key, []) or []:
                if not isinstance(item, dict):
                    continue
                filename = item.get("filename") or item.get("name")
                if filename and Path(filename).suffix.lower() in {".mp4", ".webm", ".mov", ".mkv"}:
                    return {"filename": filename, "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")}
    raise RuntimeError("انتهى ComfyUI من المعالجة لكنه لم يُرجع ملف فيديو. تأكد أن سير العمل يحتوي على عقدة SaveVideo.")


async def download_comfy_file(ref: dict[str, str], destination: Path) -> None:
    params = {"filename": ref["filename"], "subfolder": ref.get("subfolder", ""), "type": ref.get("type", "output")}
    async with httpx.AsyncClient(timeout=180) as client:
        async with client.stream("GET", f"{COMFY_URL}/view", params=params) as response:
            response.raise_for_status()
            with destination.open("wb") as f:
                async for chunk in response.aiter_bytes(1024 * 1024):
                    f.write(chunk)
    if not destination.exists() or destination.stat().st_size < 1000:
        raise RuntimeError("ملف الفيديو الناتج فارغ أو غير مكتمل.")


async def create_voice(text: str, language: str, provider: str, target: Path) -> None:
    if provider == "edge":
        # Edge TTS is online: the text is sent to Microsoft's service. Use only with explicit user choice.
        try:
            import edge_tts
        except ImportError as exc:
            raise RuntimeError("اختير الصوت السحابي لكن مكتبة edge-tts غير مثبتة.") from exc
        voice = {"ar": "ar-SA-HamedNeural", "ar-EG": "ar-EG-ShakirNeural", "en": "en-US-GuyNeural"}.get(language, "ar-SA-HamedNeural")
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(str(target))
        return
    # Fully local, free voice; quality is intentionally described as basic and can be robotic.
    voice_code = "en" if language == "en" else "ar"
    executable = shutil.which("espeak-ng") or shutil.which("espeak")
    if not executable:
        raise RuntimeError("محرك الصوت المحلي espeak-ng غير مثبت. أعد بناء حاوية engine أو اختر الصوت السحابي من الواجهة.")
    process = await asyncio.create_subprocess_exec(
        executable, "-v", voice_code, "-s", "145", "-w", str(target), text,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await process.communicate()
    if process.returncode != 0 or not target.exists() or target.stat().st_size < 500:
        raise RuntimeError("فشل توليد الصوت المحلي: " + stderr.decode("utf-8", "ignore")[:500])


async def mux_video(raw_video: Path, audio: Path, final_video: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("FFmpeg/FFprobe غير موجودين في حاوية السيرفر.")
    probe = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(audio),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, _ = await probe.communicate()
    try:
        duration = max(1.0, float(out.decode().strip()))
    except Exception:
        duration = 15.0
    # This is voice-over. It does not invent lip-sync. If the generated video is shorter than the voice,
    # it loops visually until the narration ends; a true audio-driven workflow should be installed for lip-sync.
    command = [
        ffmpeg, "-y", "-stream_loop", "-1", "-i", str(raw_video), "-i", str(audio),
        "-t", str(duration), "-map", "0:v:0", "-map", "1:a:0",
        "-vf", "fps=24,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(final_video)
    ]
    process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, stderr = await process.communicate()
    if process.returncode != 0 or not final_video.exists() or final_video.stat().st_size < 1000:
        raise RuntimeError("فشل تركيب الصوت والفيديو: " + stderr.decode("utf-8", "ignore")[-900:])


def save_scenes(job_id: str, scenes: list[dict[str, Any]]) -> None:
    update_job(job_id, scenes_json=scenes)


async def run_job(job_id: str, resume: bool = False) -> None:
    lock = JOB_LOCKS.setdefault(job_id, asyncio.Lock())
    if lock.locked():
        return
    async with lock:
        job = read_job(job_id)
        req = job["request"]
        scenes = job["scenes"]
        outdir = OUTPUTS / job_id
        outdir.mkdir(parents=True, exist_ok=True)
        try:
            health = await comfy_health()
            if not health["online"]:
                raise RuntimeError("سيرفر ComfyUI غير متصل. تأكد أن حاوية GPU تعمل وأن COMFYUI_URL صحيح.")
            base_workflow = await get_workflow()
            update_job(job_id, status="running", stage="preparing", error="")
            total = max(1, len(scenes))
            for index, scene in enumerate(scenes):
                # If a complete MP4 already exists, keep it during retries.
                final_path = outdir / f"scene-{index + 1:03d}.mp4"
                audio_path = outdir / f"scene-{index + 1:03d}.mp3"
                raw_path = outdir / f"scene-{index + 1:03d}-raw.mp4"
                if resume and final_path.exists() and final_path.stat().st_size > 1000:
                    scene["status"] = "completed"
                    scene["video_url"] = f"/api/files/{job_id}/{final_path.name}"
                    continue
                scene["status"] = "voice"
                scene["progress"] = 0
                save_scenes(job_id, scenes)
                update_job(job_id, stage=f"scene-{index + 1}-voice", progress=round(100 * index / total), scenes_json=scenes)
                await create_voice(scene["text"], req["language"], req["voice_provider"], audio_path)
                scene["audio_url"] = f"/api/files/{job_id}/{audio_path.name}"
                scene["status"] = "queued_video"
                save_scenes(job_id, scenes)
                update_job(job_id, stage=f"scene-{index + 1}-video", progress=round(100 * (index + 0.15) / total), scenes_json=scenes)
                prompt = make_prompt(scene["text"], req, index, total)
                workflow = patch_workflow(base_workflow, prompt, req, index, job_id)
                prompt_id = await queue_comfy(workflow)
                scene["comfy_prompt_id"] = prompt_id
                scene["status"] = "rendering_video"
                save_scenes(job_id, scenes)
                update_job(job_id, stage=f"scene-{index + 1}-rendering", progress=round(100 * (index + 0.25) / total), scenes_json=scenes)
                history = await wait_for_comfy(prompt_id)
                ref = collect_video_ref(history)
                await download_comfy_file(ref, raw_path)
                scene["raw_video_url"] = f"/api/files/{job_id}/{raw_path.name}"
                scene["status"] = "muxing_audio"
                save_scenes(job_id, scenes)
                update_job(job_id, stage=f"scene-{index + 1}-muxing", progress=round(100 * (index + 0.85) / total), scenes_json=scenes)
                await mux_video(raw_path, audio_path, final_path)
                scene["status"] = "completed"
                scene["progress"] = 100
                scene["video_url"] = f"/api/files/{job_id}/{final_path.name}"
                save_scenes(job_id, scenes)
                update_job(job_id, stage=f"scene-{index + 1}-done", progress=round(100 * (index + 1) / total), scenes_json=scenes)
            # Concatenate the successful scene files in order.
            clips = [outdir / f"scene-{i + 1:03d}.mp4" for i in range(total) if (outdir / f"scene-{i + 1:03d}.mp4").exists()]
            if clips:
                list_file = outdir / "concat.txt"
                list_file.write_text("".join("file '" + str(path).replace("'", "'\\''") + "'\n" for path in clips), encoding="utf-8")
                final_path = outdir / "Salah-Web-Story.mp4"
                ffmpeg = shutil.which("ffmpeg")
                proc = await asyncio.create_subprocess_exec(
                    ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
                    "-c", "copy", "-movflags", "+faststart", str(final_path),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
                )
                _, err = await proc.communicate()
                if proc.returncode != 0 or not final_path.exists() or final_path.stat().st_size < 1000:
                    raise RuntimeError("اكتملت مقاطع، لكن فشل دمج MP4 النهائي: " + err.decode("utf-8", "ignore")[-500:])
                update_job(job_id, status="completed", stage="completed", progress=100, final_file=f"{job_id}/{final_path.name}", scenes_json=scenes, error="")
            else:
                raise RuntimeError("لم يكتمل أي مشهد.")
        except Exception as exc:
            current = read_job(job_id)
            update_job(job_id, status="partial" if any(s.get("status") == "completed" for s in current["scenes"]) else "failed",
                       stage="failed", error=str(exc)[:1600], scenes_json=current["scenes"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    with get_db() as db:
        rows = db.execute("SELECT id FROM jobs WHERE status='running'").fetchall()
        for row in rows:
            db.execute("UPDATE jobs SET status='partial', stage='server-restarted', error=?, updated_at=? WHERE id=?",
                       ("أعيد تشغيل السيرفر. النتائج المكتملة محفوظة؛ استخدم «استكمال» للمتابعة.", now_iso(), row["id"]))
    yield


app = FastAPI(title="Salah Cloud Engine", version="0.1.0", lifespan=lifespan)
cors_origins = [item.strip() for item in os.getenv("CORS_ORIGINS", "https://salah-aser.github.io,http://localhost:8000,http://127.0.0.1:8000").split(",") if item.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/", response_class=HTMLResponse)
async def home():
    return HTMLResponse((STATIC / "index.html").read_text(encoding="utf-8"))


@app.get("/api/health")
async def health():
    comfy = await comfy_health()
    return {
        "service": "Salah Cloud Engine",
        "api": "online",
        "comfyui": comfy,
        "workflow_configured": workflow_ready(),
        "tts_provider_default": TTS_PROVIDER,
        "gpu_requirement": "Video generation requires an NVIDIA GPU with enough VRAM; this API does not create free GPU capacity."
    }


@app.get("/api/jobs", dependencies=[Depends(require_auth)])
async def list_jobs():
    with get_db() as db:
        rows = db.execute("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 50").fetchall()
    return [row_to_job(row) for row in rows]


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
async def job_status(job_id: str):
    return read_job(job_id)


@app.post("/api/jobs", dependencies=[Depends(require_auth)])
async def create_job(payload: CreateJob):
    try:
        parts = split_script(payload.script, payload.target_minutes)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not parts:
        raise HTTPException(400, "اكتب نص القصة أولًا.")
    job_id = uuid.uuid4().hex[:16]
    title = payload.title.strip() or "قصة " + payload.script.strip().splitlines()[0][:70]
    req = payload.model_dump()
    scenes = [
        {"id": i + 1, "text": part, "status": "queued", "progress": 0, "audio_url": None, "video_url": None, "error": ""}
        for i, part in enumerate(parts)
    ]
    with get_db() as db:
        db.execute("""INSERT INTO jobs(id,title,status,progress,stage,script,request_json,scenes_json,error,created_at,updated_at,final_file)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (job_id, title, "queued", 0, "queued", payload.script, json.dumps(req, ensure_ascii=False),
                    json.dumps(scenes, ensure_ascii=False), "", now_iso(), now_iso(), ""))
    ACTIVE_TASKS[job_id] = asyncio.create_task(run_job(job_id))
    return read_job(job_id)


@app.post("/api/jobs/{job_id}/resume", dependencies=[Depends(require_auth)])
async def resume_job(job_id: str):
    job = read_job(job_id)
    if job["status"] == "running":
        raise HTTPException(409, "المشروع قيد التنفيذ بالفعل.")
    ACTIVE_TASKS[job_id] = asyncio.create_task(run_job(job_id, resume=True))
    update_job(job_id, status="queued", stage="resume", error="")
    return read_job(job_id)


@app.post("/api/workflow", dependencies=[Depends(require_auth)])
async def upload_workflow(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".json"):
        raise HTTPException(400, "ارفع ملف JSON لسير عمل ComfyUI.")
    raw = await file.read(25 * 1024 * 1024 + 1)
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(413, "ملف سير العمل أكبر من 25 ميجابايت.")
    try:
        parsed = json.loads(raw)
    except Exception as exc:
        raise HTTPException(400, "ملف JSON غير صالح.") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(400, "صيغة سير العمل يجب أن تكون كائن JSON.")
    WORKFLOW_PATH.write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "message": "تم حفظ سير العمل على السيرفر.", "workflow_configured": True}


@app.get("/api/workflow/status", dependencies=[Depends(require_auth)])
async def workflow_status():
    if not WORKFLOW_PATH.exists():
        return {"configured": False, "message": "ارفع ملف ComfyUI بصيغة API JSON من إعدادات الموقع."}
    try:
        info = await object_info()
        base = json.loads(WORKFLOW_PATH.read_text(encoding="utf-8"))
        normalized = graph_to_api(base, info)
        return {"configured": True, "nodes": len(normalized), "message": "سير العمل مقروء بواسطة ComfyUI."}
    except Exception as exc:
        return {"configured": False, "message": str(exc)[:800]}


@app.get("/api/files/{job_id}/{filename}", dependencies=[Depends(require_auth)])
async def protected_file(job_id: str, filename: str):
    job_dir = OUTPUTS / job_id
    target = (job_dir / Path(filename).name).resolve()
    if not target.is_relative_to(job_dir.resolve()) or not target.is_file():
        raise HTTPException(404, "الملف غير موجود.")
    return FileResponse(target)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
