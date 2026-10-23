from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DATA = Path(os.getenv("SALAHDATA", str(ROOT / "data")))
OUTPUTS = DATA / "outputs"
DB_PATH = DATA / "salah.db"
CUSTOM_WORKFLOW_PATH = DATA / "workflow_api.json"
DEFAULT_WORKFLOW_PATH = ROOT / "workflows" / "wan22_t2v_blueprint.json"
STATIC = ROOT / "static"
COMFY_URL = os.getenv("COMFYUI_URL", "http://comfyui:8188").rstrip("/")
API_TOKEN = os.getenv("API_TOKEN", "").strip()
COMFY_TIMEOUT = int(os.getenv("COMFY_TIMEOUT_SECONDS", "1800"))
AUTH = HTTPBearer(auto_error=False)
JOB_LOCKS: dict[str, asyncio.Lock] = {}
ACTIVE_TASKS: dict[str, asyncio.Task] = {}

DATA.mkdir(parents=True, exist_ok=True)
OUTPUTS.mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init_db() -> None:
    with get_db() as db:
        db.execute(
            """
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
            """
        )
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
    if row is None:
        raise HTTPException(404, "المشروع غير موجود.")
    return row_to_job(row)


def update_job(job_id: str, **changes: Any) -> None:
    allowed = {"title", "status", "progress", "stage", "scenes_json", "error", "updated_at", "final_file"}
    if any(key not in allowed for key in changes):
        raise ValueError("Unsupported job field")
    changes["updated_at"] = now_iso()
    assignments = ", ".join(f"{key}=?" for key in changes)
    values = [
        json.dumps(value, ensure_ascii=False) if key == "scenes_json" else value
        for key, value in changes.items()
    ]
    with get_db() as db:
        db.execute(f"UPDATE jobs SET {assignments} WHERE id=?", (*values, job_id))


def require_auth(credentials: HTTPAuthorizationCredentials | None = Depends(AUTH)) -> None:
    if not API_TOKEN:
        return
    supplied = credentials.credentials if credentials else ""
    if not supplied or not secrets.compare_digest(supplied, API_TOKEN):
        raise HTTPException(401, "مطلوب رمز دخول صحيح لسيرفر Salah Cloud.", headers={"WWW-Authenticate": "Bearer"})


class CreateJob(BaseModel):
    script: str = Field(min_length=20, max_length=30000)
    character_description: str = Field(default="", max_length=2500)
    title: str = Field(default="", max_length=120)
    language: Literal["ar", "ar-EG", "en"] = "ar"
    voice_provider: Literal["local", "edge"] = "local"
    target_minutes: float = Field(default=2, ge=0.25, le=20)
    aspect_ratio: Literal["9:16", "16:9", "1:1"] = "9:16"
    width: int = Field(default=480, ge=320, le=1280)
    height: int = Field(default=848, ge=320, le=1280)
    frames: int = Field(default=81, ge=25, le=241)
    seed: int | None = None
    visual_style: Literal["cinematic", "historical", "horror", "spiritual", "documentary"] = "cinematic"
    religious_face_rule: bool = True
    arab_characters: bool = True


def split_script(script: str, target_minutes: float) -> list[str]:
    """Split a complete story in order into voice-friendly scene chunks."""
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
        for clause in re.split(r"(?<=،)\s*", sentence):
            remaining = clause.split()
            while remaining:
                chunk = remaining[:words_per_scene]
                remaining = remaining[words_per_scene:]
                units.append(" ".join(chunk))
    scenes: list[str] = []
    buffer: list[str] = []
    word_count = 0
    for unit in units:
        size = len(unit.split())
        proposed_chars = len(" ".join(buffer)) + len(unit)
        if buffer and (word_count + size > words_per_scene or proposed_chars > 1200):
            scenes.append(" ".join(buffer).strip())
            buffer, word_count = [], 0
        buffer.append(unit)
        word_count += size
    if buffer:
        scenes.append(" ".join(buffer).strip())
    scenes = [scene for scene in scenes if scene]
    if len(scenes) > 80:
        raise ValueError("القصة تحتاج أكثر من 80 مشهدًا في مشروع واحد. قسّمها إلى مشروعين أقصر.")
    return scenes


def make_prompt(scene: str, req: dict[str, Any], index: int, total: int) -> str:
    styles = {
        "cinematic": "Photorealistic live-action cinema, plausible lighting, natural skin and cloth textures, deliberate camera movement",
        "historical": "Photorealistic historical drama, period-accurate architecture and props, woven cloth texture, no modern objects",
        "horror": "Serious atmospheric horror cinema, restrained dread, realistic shadows, no text or graphic gore",
        "spiritual": "Reverent and dignified spiritual atmosphere, solemn framing, warm natural light, respectful composition",
        "documentary": "Photorealistic documentary cinematography, natural light and grounded camera position",
    }
    rules = [
        styles.get(req.get("visual_style", "cinematic"), styles["cinematic"]),
        "One continuous scene, one shot, one moment. Never a collage, triptych, storyboard, contact sheet, split screen, comic panels or multiple frames in one image.",
        f"Scene {index + 1} of {total}. Portray only this scene and do not depict other scenes.",
        "No captions, letters, subtitles, logos, borders or watermarks.",
    ]
    if req.get("arab_characters"):
        rules.append("Use Arab characters, plausible Arab features and culturally consistent surroundings when people appear.")
    if req.get("character_description"):
        rules.append("Character continuity reference; keep the described identity, apparent age, skin tone, face, beard, hair and clothing consistent: " + req["character_description"])
    if req.get("religious_face_rule"):
        rules.append("Respectful Islamic depiction: if a prophet, messenger, or companion is represented, show a dignified sheikh-like figure whose entire face is pure radiant light without facial features.")
    rules.append("Scene action: " + scene)
    return ". ".join(rules)


def workflow_ready() -> bool:
    return CUSTOM_WORKFLOW_PATH.exists() or DEFAULT_WORKFLOW_PATH.exists()


async def comfy_health() -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            response = await client.get(f"{COMFY_URL}/system_stats")
            response.raise_for_status()
            data = response.json()
        devices = data.get("devices", [])
        return {
            "online": True,
            "gpu": [
                {"name": d.get("name"), "vram_total": d.get("vram_total"), "vram_free": d.get("vram_free")}
                for d in devices
            ],
        }
    except Exception as exc:
        return {"online": False, "error": str(exc)[:200], "gpu": []}


async def object_info() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.get(f"{COMFY_URL}/object_info")
        response.raise_for_status()
        return response.json()


def graph_to_api(
    graph: dict[str, Any],
    info: dict[str, Any],
    external_values: dict[str, Any] | None = None,
    external_link_ids: dict[int, str] | None = None,
) -> dict[str, Any]:
    """Convert API JSON, classic ComfyUI graphs, or an embedded ComfyUI blueprint."""
    if isinstance(graph, dict) and graph and all(
        isinstance(value, dict) and "class_type" in value for value in graph.values()
    ):
        return json.loads(json.dumps(graph))

    nodes = graph.get("nodes")
    links = graph.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise ValueError("ملف سير العمل يجب أن يكون ComfyUI API JSON أو رسم ComfyUI عادي.")

    # ComfyUI blueprints keep the usable node graph inside definitions.subgraphs.
    subgraphs = (graph.get("definitions") or {}).get("subgraphs") or []
    subgraph_by_id = {
        str(item.get("id")): item for item in subgraphs
        if isinstance(item, dict) and item.get("id") is not None
    }
    for outer_node in nodes:
        if not isinstance(outer_node, dict):
            continue
        subgraph = subgraph_by_id.get(str(outer_node.get("type")))
        if subgraph:
            outer_widgets = list(outer_node.get("widgets_values") or [])
            values: dict[str, Any] = {}
            external_links: dict[int, str] = {}
            for index, external_input in enumerate(subgraph.get("inputs") or []):
                name = str(external_input.get("name") or "")
                if name and index < len(outer_widgets):
                    values[name] = outer_widgets[index]
                for link_id in external_input.get("linkIds") or []:
                    external_links[int(link_id)] = name
            return graph_to_api(subgraph, info, values, external_links)

    external_values = external_values or {}
    external_link_ids = external_link_ids or {}
    link_map: dict[int, tuple[str, int]] = {}
    for link in links:
        if isinstance(link, dict):
            try:
                link_map[int(link["id"])] = (str(link["origin_id"]), int(link["origin_slot"]))
            except (KeyError, TypeError, ValueError):
                continue
        elif isinstance(link, list) and len(link) >= 5:
            link_map[int(link[0])] = (str(link[1]), int(link[2]))

    result: dict[str, Any] = {}
    ui_seed_controls = {"fixed", "randomize", "increment", "decrement"}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("type") or "")
        if class_type not in info:
            continue

        api_inputs: dict[str, Any] = {}
        connected: set[str] = set()
        input_slots = node.get("inputs") or []
        for inp in input_slots:
            name = str(inp.get("name") or "")
            link_id = inp.get("link")
            if not name or link_id is None:
                continue
            try:
                link_id = int(link_id)
            except (TypeError, ValueError):
                continue
            if link_id in external_link_ids:
                external_name = external_link_ids[link_id]
                if external_name in external_values:
                    api_inputs[name] = external_values[external_name]
                    connected.add(name)
            elif link_id in link_map:
                source_id, source_slot = link_map[link_id]
                api_inputs[name] = [source_id, source_slot]
                connected.add(name)

        # Only assign widgets that are actual widget slots, never optional ports such as audio.
        widgets = list(node.get("widgets_values") or [])
        widget_index = 0
        previous_name = ""
        for inp in input_slots:
            if not isinstance(inp.get("widget"), dict):
                continue
            name = str(inp.get("name") or "")
            if not name:
                continue
            if previous_name in {"seed", "noise_seed"} and widget_index < len(widgets):
                if str(widgets[widget_index]).lower() in ui_seed_controls:
                    widget_index += 1
            if widget_index >= len(widgets):
                break
            value = widgets[widget_index]
            widget_index += 1
            previous_name = name
            if name not in connected:
                api_inputs[name] = value

        properties = node.get("properties") or {}
        title = node.get("title") or properties.get("Node name for S&R") or class_type
        result[str(node["id"])] = {
            "class_type": class_type,
            "inputs": api_inputs,
            "_meta": {"title": str(title)},
        }

    if not result:
        raise ValueError("لم يتم العثور على عقد ComfyUI قابلة للتنفيذ في سير العمل.")
    return result


def ensure_video_saver(workflow: dict[str, Any]) -> dict[str, Any]:
    """Append a SaveVideo node to Comfy workflows which only return a VIDEO output."""
    if any(node.get("class_type") in {"SaveVideo", "VHS_VideoCombine"} for node in workflow.values() if isinstance(node, dict)):
        return workflow
    create_nodes = [
        (str(node_id), node)
        for node_id, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") == "CreateVideo"
    ]
    if not create_nodes:
        raise ValueError("سير عمل الفيديو يحتاج إلى عقدة CreateVideo أو SaveVideo.")
    node_id, _ = create_nodes[-1]
    numeric_ids = [int(key) for key in workflow if str(key).isdigit()]
    saver_id = str(max(numeric_ids, default=0) + 1)
    workflow[saver_id] = {
        "class_type": "SaveVideo",
        "inputs": {
            "video": [node_id, 0],
            "filename_prefix": "salah/output",
            "format": "auto",
            "codec": "auto",
        },
        "_meta": {"title": "Salah Cloud Save Video"},
    }
    return workflow


async def get_workflow() -> dict[str, Any]:
    # A custom workflow overrides the bundled official Wan 2.2 blueprint.
    source = CUSTOM_WORKFLOW_PATH if CUSTOM_WORKFLOW_PATH.exists() else DEFAULT_WORKFLOW_PATH
    if not source.exists():
        raise RuntimeError("قالب Wan 2.2 الافتراضي غير موجود، ولم يتم رفع قالب بديل.")
    raw = json.loads(source.read_text(encoding="utf-8"))
    info = await object_info()
    return ensure_video_saver(graph_to_api(raw, info))


def patch_workflow(base: dict[str, Any], prompt: str, req: dict[str, Any], scene_num: int, job_id: str) -> dict[str, Any]:
    workflow = json.loads(json.dumps(base))
    aspect = req.get("aspect_ratio", "9:16")
    width, height = (480, 848) if aspect == "9:16" else ((848, 480) if aspect == "16:9" else (640, 640))
    width = max(320, min(1280, int(req.get("width") or width)))
    height = max(320, min(1280, int(req.get("height") or height)))
    width = max(320, (width // 16) * 16)
    height = max(320, (height // 16) * 16)
    frames = max(25, min(241, int(req.get("frames") or 81)))
    seed_base = int(req.get("seed") or secrets.randbelow(2**31 - 1))
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        title = str(node.get("_meta", {}).get("title", "")).lower()
        class_type = str(node.get("class_type", ""))
        if "text" in inputs and ("cliptextencode" in class_type.lower() or "textencode" in class_type.lower()):
            if "negative" not in title:
                inputs["text"] = prompt
        for key in list(inputs):
            low = key.lower()
            if low in {"seed", "noise_seed"}:
                inputs[key] = seed_base
            elif low == "width":
                inputs[key] = width
            elif low == "height":
                inputs[key] = height
            elif low in {"length", "frames", "num_frames"}:
                inputs[key] = frames
            elif low == "filename_prefix":
                inputs[key] = f"salah/{job_id}/scene-{scene_num + 1:03d}"
    return workflow


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
    for node in (history.get("outputs") or {}).values():
        if not isinstance(node, dict):
            continue
        for key in ("videos", "gifs", "files"):
            for item in node.get(key, []) or []:
                if not isinstance(item, dict):
                    continue
                filename = item.get("filename") or item.get("name")
                if filename and Path(filename).suffix.lower() in {".mp4", ".webm", ".mov", ".mkv"}:
                    return {"filename": filename, "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")}
    raise RuntimeError("انتهى ComfyUI من المعالجة لكنه لم يرجع ملف فيديو. تحقق من عقدة SaveVideo.")


async def download_comfy_file(ref: dict[str, str], destination: Path) -> None:
    params = {"filename": ref["filename"], "subfolder": ref.get("subfolder", ""), "type": ref.get("type", "output")}
    async with httpx.AsyncClient(timeout=180) as client:
        async with client.stream("GET", f"{COMFY_URL}/view", params=params) as response:
            response.raise_for_status()
            with destination.open("wb") as output:
                async for chunk in response.aiter_bytes(1024 * 1024):
                    output.write(chunk)
    if not destination.exists() or destination.stat().st_size < 1000:
        raise RuntimeError("ملف الفيديو الناتج فارغ أو غير مكتمل.")


async def create_voice(text: str, language: str, provider: str, target: Path) -> None:
    if provider == "edge":
        try:
            import edge_tts
        except ImportError as exc:
            raise RuntimeError("اختير الصوت السحابي لكن مكتبة edge-tts غير مثبتة.") from exc
        voice = {"ar": "ar-SA-HamedNeural", "ar-EG": "ar-EG-ShakirNeural", "en": "en-US-GuyNeural"}.get(language, "ar-SA-HamedNeural")
        await edge_tts.Communicate(text, voice).save(str(target))
        return
    executable = shutil.which("espeak-ng") or shutil.which("espeak")
    if not executable:
        raise RuntimeError("محرك الصوت المحلي espeak-ng غير مثبت.")
    voice = "en" if language == "en" else "ar"
    process = await asyncio.create_subprocess_exec(
        executable, "-v", voice, "-s", "145", "-w", str(target), text,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
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
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    output, _ = await probe.communicate()
    try:
        duration = max(1.0, float(output.decode().strip()))
    except Exception:
        duration = 15.0
    command = [
        ffmpeg, "-y", "-stream_loop", "-1", "-i", str(raw_video), "-i", str(audio),
        "-t", str(duration), "-map", "0:v:0", "-map", "1:a:0",
        "-vf", "fps=24,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(final_video),
    ]
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
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
                raise RuntimeError("سيرفر ComfyUI غير متصل. تأكد أن حاوية GPU تعمل.")
            base_workflow = await get_workflow()
            update_job(job_id, status="running", stage="preparing", error="")
            total = max(1, len(scenes))
            for index, scene in enumerate(scenes):
                final_path = outdir / f"scene-{index + 1:03d}.mp4"
                extension = "mp3" if req["voice_provider"] == "edge" else "wav"
                audio_path = outdir / f"scene-{index + 1:03d}.{extension}"
                raw_path = outdir / f"scene-{index + 1:03d}-raw.mp4"
                if final_path.exists() and final_path.stat().st_size > 1000:
                    scene["status"] = "completed"
                    scene["progress"] = 100
                    scene["video_url"] = f"/api/files/{job_id}/{final_path.name}"
                    continue

                if not (resume and audio_path.exists() and audio_path.stat().st_size > 500):
                    scene["status"] = "voice"
                    scene["progress"] = 0
                    save_scenes(job_id, scenes)
                    update_job(job_id, stage=f"scene-{index + 1}-voice", progress=round(100 * index / total), scenes_json=scenes)
                    await create_voice(scene["text"], req["language"], req["voice_provider"], audio_path)
                scene["audio_url"] = f"/api/files/{job_id}/{audio_path.name}"
                scene["status"] = "video"
                save_scenes(job_id, scenes)

                if not (resume and raw_path.exists() and raw_path.stat().st_size > 1000):
                    prompt = make_prompt(scene["text"], req, index, total)
                    workflow = patch_workflow(base_workflow, prompt, req, index, job_id)
                    prompt_id = await queue_comfy(workflow)
                    scene["comfy_prompt_id"] = prompt_id
                    scene["status"] = "rendering_video"
                    update_job(job_id, stage=f"scene-{index + 1}-rendering", progress=round(100 * (index + 0.25) / total), scenes_json=scenes)
                    history = await wait_for_comfy(prompt_id)
                    ref = collect_video_ref(history)
                    await download_comfy_file(ref, raw_path)
                scene["raw_video_url"] = f"/api/files/{job_id}/{raw_path.name}"
                scene["status"] = "muxing_audio"
                update_job(job_id, stage=f"scene-{index + 1}-muxing", progress=round(100 * (index + 0.85) / total), scenes_json=scenes)
                await mux_video(raw_path, audio_path, final_path)
                scene["status"] = "completed"
                scene["progress"] = 100
                scene["video_url"] = f"/api/files/{job_id}/{final_path.name}"
                save_scenes(job_id, scenes)
                update_job(job_id, stage=f"scene-{index + 1}-done", progress=round(100 * (index + 1) / total), scenes_json=scenes)

            clips = [outdir / f"scene-{i + 1:03d}.mp4" for i in range(total) if (outdir / f"scene-{i + 1:03d}.mp4").exists()]
            if not clips:
                raise RuntimeError("لم يكتمل أي مشهد.")
            concat = outdir / "concat.txt"
            concat.write_text("".join("file '" + str(path) + "'\n" for path in clips), encoding="utf-8")
            final = outdir / "Salah-Web-Story.mp4"
            ffmpeg = shutil.which("ffmpeg")
            process = await asyncio.create_subprocess_exec(
                ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
                "-c", "copy", "-movflags", "+faststart", str(final),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await process.communicate()
            if process.returncode != 0 or not final.exists() or final.stat().st_size < 1000:
                raise RuntimeError("اكتملت مقاطع، لكن فشل دمج MP4 النهائي: " + stderr.decode("utf-8", "ignore")[-500:])
            update_job(job_id, status="completed", stage="completed", progress=100,
                       final_file=f"{job_id}/{final.name}", scenes_json=scenes, error="")
        except Exception as exc:
            current = read_job(job_id)
            completed = any(scene.get("status") == "completed" for scene in current["scenes"])
            update_job(job_id, status="partial" if completed else "failed",
                       stage="failed", error=str(exc)[:1600], scenes_json=current["scenes"])
        finally:
            ACTIVE_TASKS.pop(job_id, None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    with get_db() as db:
        rows = db.execute("SELECT id FROM jobs WHERE status='running'").fetchall()
        for row in rows:
            db.execute(
                "UPDATE jobs SET status='partial', stage='server-restarted', error=?, updated_at=? WHERE id=?",
                ("أعيد تشغيل السيرفر. النتائج المكتملة محفوظة؛ استخدم «استكمال» للمتابعة.", now_iso(), row["id"]),
            )
    yield


app = FastAPI(title="Salah Cloud Engine", version="0.1.0", lifespan=lifespan)
cors_origins = [
    item.strip()
    for item in os.getenv("CORS_ORIGINS", "https://salah-aser.github.io,http://localhost:8000,http://127.0.0.1:8000").split(",")
    if item.strip()
]
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
        "workflow_source": "custom" if CUSTOM_WORKFLOW_PATH.exists() else "bundled_wan22" if DEFAULT_WORKFLOW_PATH.exists() else "missing",
        "gpu_requirement": "Video generation requires a compatible NVIDIA GPU; this API does not create free GPU capacity.",
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
    if req.get("seed") is None:
        req["seed"] = secrets.randbelow(2**31 - 1)
    scenes = [
        {"id": i + 1, "text": part, "status": "queued", "progress": 0, "audio_url": None, "video_url": None, "error": ""}
        for i, part in enumerate(parts)
    ]
    with get_db() as db:
        db.execute(
            """INSERT INTO jobs(id,title,status,progress,stage,script,request_json,scenes_json,error,created_at,updated_at,final_file)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (job_id, title, "queued", 0, "queued", payload.script,
             json.dumps(req, ensure_ascii=False), json.dumps(scenes, ensure_ascii=False),
             "", now_iso(), now_iso(), ""),
        )
    ACTIVE_TASKS[job_id] = asyncio.create_task(run_job(job_id))
    return read_job(job_id)


@app.post("/api/jobs/{job_id}/resume", dependencies=[Depends(require_auth)])
async def resume_job(job_id: str):
    job = read_job(job_id)
    if job["status"] == "running":
        raise HTTPException(409, "المشروع قيد التنفيذ بالفعل.")
    update_job(job_id, status="queued", stage="resume", error="")
    ACTIVE_TASKS[job_id] = asyncio.create_task(run_job(job_id, resume=True))
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
    CUSTOM_WORKFLOW_PATH.write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "message": "تم حفظ سير العمل على السيرفر.", "workflow_configured": True}


@app.get("/api/workflow/status", dependencies=[Depends(require_auth)])
async def workflow_status():
    source = CUSTOM_WORKFLOW_PATH if CUSTOM_WORKFLOW_PATH.exists() else DEFAULT_WORKFLOW_PATH
    source_name = "uploaded custom workflow" if CUSTOM_WORKFLOW_PATH.exists() else "bundled official Wan 2.2 blueprint"
    if not source.exists():
        return {"configured": False, "message": "لم يُعثر على القالب الافتراضي ولم يتم رفع قالب بديل."}
    try:
        info = await object_info()
        base = json.loads(source.read_text(encoding="utf-8"))
        normalized = ensure_video_saver(graph_to_api(base, info))
        return {"configured": True, "source": source_name, "nodes": len(normalized), "message": "تم تحميل سير العمل إلى صيغة ComfyUI API."}
    except Exception as exc:
        return {"configured": False, "source": source_name, "message": str(exc)[:800]}


@app.get("/api/files/{job_id}/{filename}", dependencies=[Depends(require_auth)])
async def protected_file(job_id: str, filename: str):
    if not re.fullmatch(r"[a-f0-9]{16}", job_id):
        raise HTTPException(404, "الملف غير موجود.")
    job_dir = (OUTPUTS / job_id).resolve()
    target = (job_dir / Path(filename).name).resolve()
    if not target.is_relative_to(job_dir) or not target.is_file():
        raise HTTPException(404, "الملف غير موجود.")
    return FileResponse(target)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
