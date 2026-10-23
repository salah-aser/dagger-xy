import { Client, handle_file } from "https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";

const DB_NAME = "salah-web-local-media-v1";
const STORE = "assets";
const VOICE_KEY = "voice-profile";
const VOICE_SPACE = "mohammedaly22/VoiceTut-TTS";
const IMAGE_SPACE = "mrfakename/Z-Image-Turbo";
const VIDEO_SPACE = "Wan-AI/Wan2.2-S2V";
const ORIGIN = {
  [VOICE_SPACE]: "https://mohammedaly22-voicetut-tts.hf.space",
  [IMAGE_SPACE]: "https://mrfakename-z-image-turbo.hf.space",
  [VIDEO_SPACE]: "https://wan-ai-wan2-2-s2v.hf.space"
};
const $ = (id) => document.getElementById(id);
let voiceProfile = null;
let isBusy = false;
let voiceClientPromise = null;
let imageClientPromise = null;
let videoClientPromise = null;
let ffmpegInstance = null;
const clips = [];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("تعذّر فتح التخزين المحلي."));
  });
}
async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => { const value = req.result || null; db.close(); resolve(value); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
function setStatus(title, detail, kind) {
  $("statusBox").classList.remove("hidden");
  $("statusTitle").textContent = title;
  $("statusDetail").textContent = detail || "";
  $("statusTitle").classList.toggle("error", kind === "error");
  $("statusTitle").classList.toggle("success", kind === "success");
}
function setProgress(value, max, label) {
  $("progressBar").max = Math.max(1, max || 1);
  $("progressBar").value = Math.min(value, $("progressBar").max);
  $("progressLabel").textContent = label || "";
}
function setBusy(value) {
  isBusy = value;
  $("generateFullVideo").disabled = value;
  $("saveVoiceSample").disabled = value;
  $("generateFullVideo").textContent = value ? "جاري تنفيذ الفيديو كاملًا…" : "أنشئ الفيديو كاملًا";
}
function errorText(err) {
  const raw = String((err && err.message) || err || "خطأ غير معروف");
  if (/quota|zerogpu|gpu.*time|rate limit|429/i.test(raw))
    return "الحصة المجانية للنموذج ممتلئة أو محدودة حاليًا. جرّب لاحقًا. التفاصيل: " + raw.slice(0, 450);
  if (/fetch|network|connect|websocket|503|502|504|space.*sleep/i.test(raw))
    return "خدمة التوليد لا تستجيب حاليًا أو مزدحمة. جرّب لاحقًا. التفاصيل: " + raw.slice(0, 450);
  if (/401|403|unauthorized|permission|dashscope|api.key|api_key/i.test(raw))
    return "خدمة الفيديو رفضت الطلب أو تحتاج إعدادًا غير متاح في الخدمة العامة. التفاصيل: " + raw.slice(0, 550);
  return raw.slice(0, 900);
}
function toAbsoluteUrl(value, space) {
  if (typeof value !== "string" || !value.trim()) return null;
  const u = value.trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return ORIGIN[space] + u;
  return null;
}
function findUrl(value, space, depth) {
  depth = depth || 0;
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") return toAbsoluteUrl(value, space);
  if (Array.isArray(value)) {
    for (const item of value) { const found = findUrl(item, space, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["url", "video_url", "audio_url", "image_url"]) {
      const found = toAbsoluteUrl(value[key], space);
      if (found) return found;
    }
    for (const key of ["data", "path", "file", "files", "output", "result", "images", "video", "audio"]) {
      const found = findUrl(value[key], space, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
function getVoiceClient() {
  if (!voiceClientPromise) voiceClientPromise = Client.connect(VOICE_SPACE);
  return voiceClientPromise;
}
function getImageClient() {
  if (!imageClientPromise) imageClientPromise = Client.connect(IMAGE_SPACE);
  return imageClientPromise;
}
function getVideoClient() {
  if (!videoClientPromise) videoClientPromise = Client.connect(VIDEO_SPACE);
  return videoClientPromise;
}
function splitWords(text, count) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const actualCount = Math.max(1, Math.min(count, words.length));
  const groups = [];
  for (let i = 0; i < actualCount; i++) {
    const start = Math.floor(i * words.length / actualCount);
    const end = Math.floor((i + 1) * words.length / actualCount);
    groups.push(words.slice(start, end).join(" "));
  }
  return groups.filter(Boolean);
}
function buildScenePlan(text, desiredMinutes) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const wanted = Math.max(1, Math.round(Number(desiredMinutes) * 4));
  // Keep each voice request short enough for a roughly 15-second clip and never omit script words.
  const byLength = Math.max(1, Math.ceil(wordCount / 34));
  const byShortText = Math.max(1, Math.ceil(wordCount / 8));
  const count = Math.min(60, Math.max(byLength, Math.min(wanted, byShortText)));
  const parts = splitWords(text, count);
  return parts.map((part, i) => ({
    id: i + 1,
    narration: part,
    story: part,
    visual: makeVisualPrompt(part, i, parts.length),
    start: i * 15,
    end: (i + 1) * 15
  }));
}
function makeVisualPrompt(part, index, total) {
  const styleValue = $("stylePreset").value;
  const styles = {
    cinematic: "ultra-photorealistic serious cinematic drama, film-quality composition, natural skin texture, realistic lighting, expressive but restrained performances",
    historical: "ultra-photorealistic historical drama, authentic historical architecture and natural woven fabrics, grounded period details, no modern objects",
    horror: "serious atmospheric horror, realistic shadow and texture, unsettling but believable environment, cinematic low-key lighting",
    spiritual: "reverent Islamic atmosphere, solemn cinematic composition, subtle warm light, dignified and respectful imagery",
    documentary: "photorealistic documentary cinematography, natural light, believable environment, observational camera language",
    realistic: "hyper-realistic live-action film still, plausible anatomy, physically accurate light and materials"
  };
  const charDesc = $("characterDescription").value.trim();
  const rules = [];
  if ($("arabicCharacters").checked) rules.push("All people are Arab; use culturally accurate Arab features, architecture and environment.");
  if ($("historicClothing").checked) rules.push("For historical scenes, use era-appropriate traditional Arab clothing and avoid modern objects.");
  if ($("religiousFaces").checked) rules.push("If a prophet, messenger, or companion is depicted, respectfully show a dignified sheikh-like figure whose entire face is pure radiant light with absolutely no facial features.");
  if (charDesc) rules.push("CONTINUITY: keep the same character identities, apparent ages, facial structure, skin tones, hair, facial hair and clothing across all scenes. Character description: " + charDesc);
  return "Create one unique, ultra-photorealistic cinematic frame for scene " + (index + 1) + " of " + total + ". Visual style: " + (styles[styleValue] || styles.cinematic) + ". Story moment, illustrate this exact beat and do not add unrelated events: " + part + ". " + rules.join(" ") + " Continue the visual action of the same story; consistent geography and lighting. Realistic anatomy and natural motion potential. No captions, no subtitles, no logos, and no written text.";
}
function updateEstimate() {
  const words = $("storyScript").value.trim().split(/\s+/).filter(Boolean).length;
  const duration = Number($("durationMinutes").value || 2);
  const estimate = words / 130;
  const wantedClips = Math.max(1, Math.round(duration * 4));
  const expectedClips = Math.max(1, Math.ceil(words / 34));
  $("estimateText").textContent = words
    ? "عدد الكلمات: " + words + " · مدة التعليق الصوتي التقريبية: " + estimate.toFixed(1) + " دقيقة · المدة المستهدفة: " + duration.toFixed(2).replace(/\.?0+$/, "") + " دقيقة · المتوقع: نحو " + Math.max(expectedClips, Math.min(wantedClips, Math.ceil(words / 8))) + " مشهدًا. المدة النهائية تتأثر بسرعة الصوت وزمن كل نموذج."
    : "اكتب السكريبت هنا. سيُقسّم تلقائيًا إلى مشاهد متتابعة قريبة من 15 ثانية حسب طول النص.";
}
function imageSize(aspect) {
  if (aspect === "16:9") return { height: 768, width: 1344 };
  if (aspect === "1:1") return { height: 1024, width: 1024 };
  return { height: 1344, width: 768 };
}
async function synthesizeVoice(scene, speed, steps) {
  setStatus("المشهد " + scene.id + ": توليد التعليق الصوتي…", voiceProfile ? "سيُستخدم ملف الصوت المرجعي المحفوظ في هذا المتصفح." : "سيُستخدم صوت عربي جاهز من نموذج VoiceTut-TTS.");
  const client = await getVoiceClient();
  let args;
  if (voiceProfile && voiceProfile.blob) {
    const wav = new File([voiceProfile.blob], "salah-voice-reference.wav", { type: "audio/wav" });
    args = [scene.narration, "arz", "clone", "", handle_file(wav), voiceProfile.transcript || "", steps, 2.5, speed, true];
  } else {
    args = [scene.narration, "arz", "preset", "Ahmed", null, "", steps, 2.5, speed, true];
  }
  const result = await client.predict("/synthesize", args);
  const audioUrl = findUrl(result && result.data && result.data[0], VOICE_SPACE);
  if (!audioUrl) throw new Error("عاد نموذج الصوت من دون رابط ملف صوتي يمكن تشغيله.");
  return audioUrl;
}
async function generateImage(scene, aspect) {
  setStatus("المشهد " + scene.id + ": تصميم الصورة السينمائية…", "يُنشئ الموقع الصورة من جزء القصة ووصف الشخصيات والإعدادات.");
  const client = await getImageClient();
  const size = imageSize(aspect);
  const result = await client.predict("/generate_image", [scene.visual, size.height, size.width, 9, 42 + scene.id, true]);
  const imageUrl = findUrl(result && result.data && result.data[0], IMAGE_SPACE);
  if (!imageUrl) throw new Error("عاد نموذج الصور من دون صورة قابلة للاستخدام.");
  return imageUrl;
}
async function generateVideo(scene, imageUrl, audioUrl, quality) {
  setStatus("المشهد " + scene.id + ": تحويل الصورة إلى فيديو مع الصوت…", "يُرسل إطار المشهد والصوت إلى نموذج Wan 2.2 S2V.");
  const client = await getVideoClient();
  const result = await client.predict("/predict", [handle_file(imageUrl), handle_file(audioUrl), quality]);
  const videoUrl = findUrl(result && result.data, VIDEO_SPACE);
  if (!videoUrl) throw new Error("لم يُرجع نموذج الفيديو رابط فيديو. قد تكون خدمته غير متاحة.");
  return videoUrl;
}
function addSceneResult(clip) {
  const card = document.createElement("article");
  card.className = "clip-card";
  const title = document.createElement("h3");
  title.textContent = "المشهد " + clip.id + " — جاهز";
  const player = document.createElement("video");
  player.controls = true; player.playsInline = true; player.src = clip.videoUrl;
  const links = document.createElement("div"); links.className = "clip-links";
  const videoLink = document.createElement("a");
  videoLink.href = clip.videoUrl; videoLink.target = "_blank"; videoLink.rel = "noopener";
  videoLink.textContent = "فتح المقطع";
  const audioLink = document.createElement("a");
  audioLink.href = clip.audioUrl; audioLink.target = "_blank"; audioLink.rel = "noopener";
  audioLink.textContent = "ملف الصوت";
  links.append(videoLink, audioLink);
  card.append(title, player, links);
  $("clipResults").appendChild(card);
}
async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  setStatus("تم إنشاء المشاهد: جارٍ تجهيز ملف الفيديو الكامل…", "يتم الآن دمج المقاطع وتركيب الصوت في ملف واحد داخل المتصفح.");
  const module = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js");
  const util = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js");
  const ffmpeg = new module.FFmpeg();
  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
  const coreURL = await util.toBlobURL(base + "/ffmpeg-core.js", "text/javascript");
  const wasmURL = await util.toBlobURL(base + "/ffmpeg-core.wasm", "application/wasm");
  await ffmpeg.load({ coreURL, wasmURL });
  ffmpegInstance = ffmpeg;
  return ffmpeg;
}
async function fetchBlob(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("تعذر تنزيل " + label + " من خدمة النموذج (HTTP " + response.status + ").");
  return await response.blob();
}
async function mergeClips(clipsToMerge, aspect, quality) {
  const ffmpeg = await loadFFmpeg();
  const dims = aspect === "16:9"
    ? (quality === "720P" ? [1280, 720] : [854, 480])
    : aspect === "1:1"
      ? (quality === "720P" ? [720, 720] : [480, 480])
      : (quality === "720P" ? [720, 1280] : [480, 854]);
  const listLines = [];
  for (let i = 0; i < clipsToMerge.length; i++) {
    const c = clipsToMerge[i];
    setStatus("دمج الفيديو النهائي: " + (i + 1) + " من " + clipsToMerge.length, "تحميل المقطع والصوت ثم توحيد المقاس والإطارات وتركيب الصوت.");
    const videoBlob = await fetchBlob(c.videoUrl, "الفيديو");
    const audioBlob = await fetchBlob(c.audioUrl, "الصوت");
    const inV = "input_video_" + i + ".mp4";
    const inA = "input_audio_" + i + ".wav";
    const out = "scene_" + i + ".mp4";
    await ffmpeg.writeFile(inV, new Uint8Array(await videoBlob.arrayBuffer()));
    await ffmpeg.writeFile(inA, new Uint8Array(await audioBlob.arrayBuffer()));
    const w = dims[0], h = dims[1];
    const filter = "[0:v:0]fps=24,scale=" + w + ":" + h + ":force_original_aspect_ratio=decrease,pad=" + w + ":" + h + ":(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,tpad=stop_mode=clone:stop_duration=30[v]";
    await ffmpeg.exec([
      "-i", inV, "-i", inA, "-filter_complex", filter, "-map", "[v]", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out
    ]);
    await ffmpeg.deleteFile(inV);
    await ffmpeg.deleteFile(inA);
    listLines.push("file '" + out + "'");
  }
  await ffmpeg.writeFile("concat_list.txt", new TextEncoder().encode(listLines.join("\n") + "\n"));
  setStatus("جارٍ إخراج ملف واحد…", "يجمع المقاطع بترتيب القصة.");
  await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", "concat_list.txt", "-c", "copy", "-movflags", "+faststart", "Salah-Web-Full.mp4"]);
  const output = await ffmpeg.readFile("Salah-Web-Full.mp4");
  const blob = new Blob([output], { type: "video/mp4" });
  if (!blob.size) throw new Error("أنشأ الدمج ملفًا فارغًا.");
  return blob;
}
function showFinalVideo(blob) {
  const url = URL.createObjectURL(blob);
  $("finalVideo").src = url;
  $("finalVideo").classList.remove("hidden");
  const link = $("downloadFinalVideo");
  link.href = url;
  link.download = "Salah-Web-Full-Video.mp4";
  link.classList.remove("hidden");
  $("finalFileInfo").textContent = "تم تجهيز ملف MP4 واحد · الحجم " + (blob.size / 1048576).toFixed(1) + " ميجابايت. اضغط تنزيل واحفظه على جهازك.";
  $("finalArea").classList.remove("hidden");
}
async function runFullWorkflow() {
  if (isBusy) return;
  const story = $("storyScript").value.trim();
  if (!story) { setStatus("اكتب السكريبت أولًا", "ضع القصة كاملة في المربع الرئيسي."); return; }
  if (story.length < 20) { setStatus("السكريبت قصير جدًا", "أضف تفاصيل أكثر حتى يمكن إنشاء مشاهد متعددة."); return; }
  if (story.length > 30000) { setStatus("السكريبت طويل جدًا", "الحد الحالي 30 ألف حرف في الدفعة الواحدة."); return; }
  if (story.length > 3000 * 60) { setStatus("السكريبت أطول من الحد", "قسّم القصة إلى مشروعين أقصر."); return; }
  setBusy(true);
  $("clipResults").innerHTML = "";
  $("finalArea").classList.add("hidden");
  $("finalVideo").classList.add("hidden");
  $("downloadFinalVideo").classList.add("hidden");
  clips.length = 0;
  try {
    const desired = Number($("durationMinutes").value || 2);
    const scenes = buildScenePlan(story, desired);
    const aspect = $("aspectRatio").value;
    const quality = $("videoQuality").value;
    const speed = Number($("voiceSpeed").value || 0.92);
    const steps = Number($("voiceSteps").value || 32);
    const targetSeconds = Math.round(desired * 60);
    const actualEstimatedSeconds = Math.round(story.trim().split(/\s+/).filter(Boolean).length / 130 * 60);
    setProgress(0, scenes.length + 1, "0 / " + scenes.length + " مشاهد");
    setStatus("بدأ الإنتاج التلقائي", "سيُعالج " + scenes.length + " مشهدًا بالتتابع؛ لا تحتاج إلى نسخ برومبتات أو تجهيز صوت أو دمج يدوي.");
    if (Math.abs(actualEstimatedSeconds - targetSeconds) > targetSeconds * 0.3) {
      setStatus("بدأ الإنتاج التلقائي — تنبيه مدة", "السكريبت يعادل تقريبًا " + (actualEstimatedSeconds / 60).toFixed(1) + " دقيقة من الكلام، بينما اخترت " + desired + " دقيقة. سيُحافظ الموقع على النص كاملًا وقد تختلف مدة الملف النهائي عن المطلوب.");
    }
    for (const scene of scenes) {
      setStatus("المشهد " + scene.id + " من " + scenes.length, "الخطوة 1/3: توليد الصوت من جزء القصة.");
      const audioUrl = await synthesizeVoice(scene, speed, steps);
      const imageUrl = await generateImage(scene, aspect);
      const videoUrl = await generateVideo(scene, imageUrl, audioUrl, quality);
      const clip = { id: scene.id, narration: scene.narration, audioUrl, imageUrl, videoUrl };
      clips.push(clip);
      addSceneResult(clip);
      setProgress(clips.length, scenes.length + 1, clips.length + " / " + scenes.length + " مشاهد جاهزة");
    }
    setStatus("اكتملت المشاهد", "جاري جمع " + clips.length + " مقطعًا في فيديو واحد مع تركيب الصوت.");
    const finalBlob = await mergeClips(clips, aspect, quality);
    showFinalVideo(finalBlob);
    setProgress(scenes.length + 1, scenes.length + 1, "اكتمل الفيديو الكامل");
    setStatus("الفيديو الكامل جاهز", "تم توليد المشاهد وجمعها في ملف MP4 واحد. نزّل الملف للاحتفاظ به.", "success");
  } catch (err) {
    const detail = errorText(err);
    setStatus("توقف التوليد قبل اكتمال الفيديو", clips.length
      ? "نجح " + clips.length + " مشهدًا. قد تظل روابط المقاطع متاحة أدناه. السبب: " + detail
      : "لم ينجح توليد أول مشهد. السبب: " + detail, "error");
  } finally {
    setBusy(false);
  }
}
function writeWav(buffer) {
  const input = buffer.getChannelData(0);
  const bytes = new ArrayBuffer(44 + input.length * 2);
  const view = new DataView(bytes);
  function writeString(offset, text) { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); }
  writeString(0, "RIFF"); view.setUint32(4, 36 + input.length * 2, true);
  writeString(8, "WAVE"); writeString(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(36, "data"); view.setUint32(40, input.length * 2, true);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}
async function cropAudio(file, start, seconds) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !window.OfflineAudioContext) throw new Error("هذا المتصفح لا يدعم قص الصوت محليًا.");
  const ctx = new AudioContextClass();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    if (start < 0 || start >= decoded.duration) throw new Error("بداية القص خارج مدة الملف.");
    const actual = Math.min(seconds, decoded.duration - start);
    if (actual < 5) throw new Error("اختر مقطعًا صوتيًا واضحًا لا يقل عن 5 ثوانٍ.");
    const frames = Math.round(actual * 24000);
    const offline = new OfflineAudioContext(1, frames, 24000);
    const src = offline.createBufferSource();
    src.buffer = decoded; src.connect(offline.destination); src.start(0, start, actual);
    const rendered = await offline.startRendering();
    return { blob: writeWav(rendered), duration: rendered.duration };
  } finally { if (ctx.close) await ctx.close().catch(() => {}); }
}
async function saveVoiceReference() {
  if (isBusy) return;
  const file = $("voiceReferenceFile").files && $("voiceReferenceFile").files[0];
  if (!file) { $("voiceSampleStatus").textContent = "اختَر ملف WAV أو MP3 أولًا."; return; }
  try {
    $("saveVoiceSample").disabled = true;
    $("voiceSampleStatus").textContent = "جارٍ قص العينة داخل المتصفح…";
    const profile = await cropAudio(file, Number($("voiceStart").value || 0), Number($("voiceClipDuration").value || 12));
    voiceProfile = {
      blob: profile.blob, duration: profile.duration, name: file.name,
      transcript: $("voiceTranscript").value.trim(), savedAt: Date.now()
    };
    await dbSet(VOICE_KEY, voiceProfile);
    $("voiceSampleStatus").textContent = "اتحفظت عينة صوتك محليًا (" + profile.duration.toFixed(1) + " ثانية). هتُستخدم تلقائيًا في المشاهد القادمة.";
  } catch (e) {
    $("voiceSampleStatus").textContent = "تعذر حفظ العينة: " + errorText(e);
  } finally { $("saveVoiceSample").disabled = false; }
}
async function init() {
  try {
    voiceProfile = await dbGet(VOICE_KEY);
    if (voiceProfile && voiceProfile.blob) {
      $("voiceSampleStatus").textContent = "عينة صوت محفوظة بالفعل في هذا المتصفح؛ سيستخدمها الموقع تلقائيًا.";
    } else {
      $("voiceSampleStatus").textContent = "لا توجد عينة محفوظة؛ سيستخدم الموقع صوتًا عربيًا جاهزًا تلقائيًا.";
    }
  } catch (_) {
    $("voiceSampleStatus").textContent = "سيُستخدم صوت عربي جاهز؛ التخزين المحلي غير متاح حاليًا.";
  }
  $("storyScript").addEventListener("input", updateEstimate);
  $("durationMinutes").addEventListener("input", updateEstimate);
  $("saveVoiceSample").addEventListener("click", saveVoiceReference);
  $("generateFullVideo").addEventListener("click", runFullWorkflow);
  updateEstimate();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
