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
let gradioModulePromise = null;
const SESSION_STORAGE_KEY = "salah-web-story-history-v2";
const ACTIVE_SESSION_KEY = "salah-web-active-story-v2";
let storySessions = [];
let activeSessionId = null;
let runScenes = [];
const sceneCardNodes = new Map();
let finalObjectURL = null;

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
    args = [scene.narration, "arz", "clone", "", await gradioFile(wav), voiceProfile.transcript || "", steps, 2.5, speed, true];
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
  const result = await client.predict("/predict", [await gradioFile(imageUrl), await gradioFile(audioUrl), quality]);
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


/* One story = one independent workspace, including its own character description and settings. */
function activeStorySession() {
  return storySessions.find(function(s) { return s.id === activeSessionId; }) || null;
}
function readStorySettings() {
  return {
    durationMinutes: $("durationMinutes").value || "2",
    aspectRatio: $("aspectRatio").value || "9:16",
    videoQuality: $("videoQuality").value || "480P",
    stylePreset: $("stylePreset").value || "cinematic",
    voiceSpeed: $("voiceSpeed").value || "0.92",
    voiceSteps: $("voiceSteps").value || "32",
    arabicCharacters: $("arabicCharacters").checked,
    historicClothing: $("historicClothing").checked,
    religiousFaces: $("religiousFaces").checked
  };
}
function applyStorySettings(settings) {
  settings = settings || {};
  ["durationMinutes","aspectRatio","videoQuality","stylePreset","voiceSpeed","voiceSteps"].forEach(function(id) {
    if (settings[id] !== undefined && $(id)) $(id).value = settings[id];
  });
  ["arabicCharacters","historicClothing","religiousFaces"].forEach(function(id) {
    if (settings[id] !== undefined && $(id)) $(id).checked = !!settings[id];
  });
  updateEstimate();
}
function sessionTitleFromScript(script) {
  const line = String(script || "").split(/\r?\n/).map(function(x) { return x.trim(); }).find(Boolean) || "";
  if (!line) return "قصة جديدة";
  return line.length > 34 ? line.slice(0, 34) + "…" : line;
}
function persistSessions() {
  try {
    storySessions.sort(function(a,b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    storySessions = storySessions.slice(0, 25);
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(storySessions));
    if (activeSessionId) localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  } catch (err) {
    try {
      storySessions.sort(function(a,b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      storySessions = storySessions.slice(0, 8);
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(storySessions));
      if (activeSessionId) localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
    } catch (_) {}
  }
}
function saveCurrentStoryToHistory(render) {
  const s = activeStorySession();
  if (!s) return;
  const oldTitle = s.title;
  s.script = $("storyScript").value || "";
  s.characterDescription = $("characterDescription").value || "";
  s.settings = readStorySettings();
  s.title = sessionTitleFromScript(s.script);
  s.updatedAt = Date.now();
  if (!s.status) s.status = s.script.trim() ? "draft" : "new";
  persistSessions();
  if (render || oldTitle !== s.title) renderStoryHistory();
}
function statusName(status) {
  return ({
    new: "قصة جديدة",
    draft: "مسودة",
    running: "قيد التنفيذ",
    partial: "نتائج جزئية",
    completed: "مكتملة",
    failed: "توقفت"
  })[status] || "مسودة";
}
function renderStoryHistory() {
  const root = $("storyHistory");
  if (!root) return;
  root.replaceChildren();
  if (!storySessions.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "قصصك الجديدة والقديمة ستظهر هنا.";
    root.appendChild(empty);
    return;
  }
  storySessions.slice().sort(function(a,b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).forEach(function(s) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "story-history-item" + (s.id === activeSessionId ? " active" : "");
    button.disabled = isBusy;
    button.setAttribute("aria-current", s.id === activeSessionId ? "page" : "false");
    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = s.title || "قصة جديدة";
    const meta = document.createElement("span");
    meta.className = "history-meta";
    const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString("ar-EG", { month: "short", day: "numeric" }) : "";
    const pct = Number(s.progress || 0);
    meta.textContent = statusName(s.status) + (s.status === "running" || s.status === "partial" ? " · " + pct + "%" : "") + (date ? " · " + date : "");
    button.append(title, meta);
    button.addEventListener("click", function() { switchStorySession(s.id); });
    root.appendChild(button);
  });
}
function createStorySession(copySettings) {
  const session = {
    id: "story-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8),
    title: "قصة جديدة",
    script: "",
    characterDescription: "",
    settings: copySettings || {
      durationMinutes: "2", aspectRatio: "9:16", videoQuality: "480P",
      stylePreset: "cinematic", voiceSpeed: "0.92", voiceSteps: "32",
      arabicCharacters: true, historicClothing: true, religiousFaces: true
    },
    status: "new", progress: 0, currentScene: 0, currentStage: "",
    sceneSegments: [], clips: [], lastTitle: "", lastDetail: "",
    createdAt: Date.now(), updatedAt: Date.now()
  };
  storySessions.unshift(session);
  activeSessionId = session.id;
  persistSessions();
  return session;
}
function clearStoryResultView() {
  $("clipResults").replaceChildren();
  if (finalObjectURL) { URL.revokeObjectURL(finalObjectURL); finalObjectURL = null; }
  $("finalArea").classList.add("hidden");
  $("finalVideo").pause();
  $("finalVideo").removeAttribute("src");
  $("finalVideo").load();
  $("finalVideo").classList.add("hidden");
  $("downloadFinalVideo").removeAttribute("href");
  $("downloadFinalVideo").classList.add("hidden");
  $("finalFileInfo").textContent = "";
  sceneCardNodes.clear();
  clips.length = 0;
  runScenes = [];
}
function newStorySession() {
  if (isBusy) return;
  saveCurrentStoryToHistory(false);
  const settings = readStorySettings();
  const session = createStorySession(settings);
  $("storyScript").value = "";
  $("characterDescription").value = "";
  applyStorySettings(session.settings);
  clearStoryResultView();
  $("statusBox").classList.add("hidden");
  renderStoryHistory();
  $("storyScript").focus();
  setProgress(0, 100, "قصّة جديدة — لم يبدأ الإنتاج");
}
function applyStorySessionToPage(session) {
  $("storyScript").value = session.script || "";
  $("characterDescription").value = session.characterDescription || "";
  applyStorySettings(session.settings);
  clearStoryResultView();
  const savedClips = Array.isArray(session.clips) ? session.clips : [];
  savedClips.slice().sort(function(a,b) { return a.id - b.id; }).forEach(function(c) {
    clips.push(c);
    drawSceneCard(c);
  });
  if (session.progress) setProgress(session.progress, 100, "آخر تقدم محفوظ: " + session.progress + "%");
  if (session.lastTitle && session.lastDetail) {
    $("statusBox").classList.remove("hidden");
    $("statusTitle").textContent = session.lastTitle;
    $("statusDetail").textContent = session.lastDetail + (session.status === "partial" ? "\nهذه نتائج محفوظة من جلسة سابقة؛ قد تنتهي صلاحية روابط بعض النماذج." : "");
    $("statusTitle").classList.toggle("error", session.status === "failed" || session.status === "partial");
    $("statusTitle").classList.toggle("success", session.status === "completed");
  } else {
    $("statusBox").classList.add("hidden");
  }
  dbGet("final-video:" + session.id).then(function(blob) {
    if (activeSessionId === session.id && blob instanceof Blob && blob.size) showFinalVideo(blob, session.id);
  }).catch(function() {});
}
function switchStorySession(id) {
  if (isBusy || id === activeSessionId) return;
  saveCurrentStoryToHistory(false);
  const session = storySessions.find(function(s) { return s.id === id; });
  if (!session) return;
  activeSessionId = id;
  if (session.status === "running") {
    session.status = "partial";
    session.lastTitle = "توقفت الجلسة السابقة أثناء الإنتاج";
    session.lastDetail = "تم حفظ النص والشخصيات والمراحل والنتائج التي اكتملت. لا يمكن للمتصفح إبقاء طلب نموذج خارجي قيد التشغيل بعد إغلاق الصفحة؛ أعد إنشاء الفيديو لهذه القصة لمتابعة الإنتاج.";
    session.updatedAt = Date.now();
  }
  persistSessions();
  applyStorySessionToPage(session);
  renderStoryHistory();
}
function setStatusV2(title, detail, kind) {
  $("statusBox").classList.remove("hidden");
  $("statusTitle").textContent = title;
  $("statusDetail").textContent = detail || "";
  $("statusTitle").classList.toggle("error", kind === "error");
  $("statusTitle").classList.toggle("success", kind === "success");
  const s = activeStorySession();
  if (s) {
    s.lastTitle = title;
    s.lastDetail = detail || "";
    if (kind === "error") s.status = (s.clips || []).some(function(c) { return !!c.videoUrl; }) ? "partial" : "failed";
    else if (kind === "success" && /جاهز|اكتمل|اكتملت/i.test(title)) s.status = "completed";
    s.updatedAt = Date.now();
    persistSessions();
  }
  renderStoryHistory();
}
function setProgressV2(value, max, label) {
  const denominator = Math.max(1, Number(max) || 1);
  const v = Math.max(0, Math.min(Number(value) || 0, denominator));
  $("progressBar").max = denominator;
  $("progressBar").value = v;
  $("progressLabel").textContent = label || "";
  const s = activeStorySession();
  if (s && denominator === 100) {
    s.progress = Math.round(v);
    s.updatedAt = Date.now();
    persistSessions();
  }
}
function setBusyV2(value) {
  isBusy = value;
  if ($("generateFullVideo")) $("generateFullVideo").disabled = value;
  if ($("saveVoiceSample")) $("saveVoiceSample").disabled = value;
  if ($("newStoryButton")) $("newStoryButton").disabled = value;
  if ($("generateFullVideo")) $("generateFullVideo").textContent = value ? "جاري تنفيذ الفيديو كاملًا…" : "أنشئ الفيديو كاملًا";
  renderStoryHistory();
}
function renderClipLinks(container, url, label) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url; a.target = "_blank"; a.rel = "noopener";
  a.textContent = label; container.appendChild(a);
}
function drawSceneCard(clip) {
  if (sceneCardNodes.size === 0 && $("clipResults")) $("clipResults").replaceChildren();
  let card = sceneCardNodes.get(clip.id);
  if (!card) {
    card = document.createElement("article");
    card.className = "clip-card";
    card.id = "scene-output-" + clip.id;
    sceneCardNodes.set(clip.id, card);
    const ahead = Array.from($("clipResults").children).find(function(el) {
      const otherId = Number((el.id || "").replace("scene-output-",""));
      return otherId > clip.id;
    });
    if (ahead) $("clipResults").insertBefore(card, ahead); else $("clipResults").appendChild(card);
  }
  card.replaceChildren();
  const title = document.createElement("h3");
  title.textContent = "المشهد " + clip.id + " · " + (clip.statusText || (clip.videoUrl ? "اكتمل الفيديو" : "قيد التجهيز"));
  card.appendChild(title);
  if (clip.narration) {
    const text = document.createElement("p");
    text.className = "clip-narration";
    text.textContent = clip.narration;
    card.appendChild(text);
  }
  if (clip.videoUrl) {
    const player = document.createElement("video");
    player.controls = true; player.playsInline = true; player.preload = "metadata"; player.src = clip.videoUrl;
    card.appendChild(player);
    const links = document.createElement("div"); links.className = "clip-links";
    renderClipLinks(links, clip.videoUrl, "فتح / تنزيل المقطع");
    card.appendChild(links);
  } else if (clip.imageUrl) {
    const img = document.createElement("img");
    img.src = clip.imageUrl; img.alt = "صورة المشهد " + clip.id;
    img.className = "clip-image";
    card.appendChild(img);
  }
  if (clip.audioUrl) {
    const alabel = document.createElement("p");
    alabel.className = "clip-subheading";
    alabel.textContent = clip.videoUrl ? "الصوت المركّب مع الفيديو:" : "الصوت اكتمل — الفيديو قيد التجهيز:";
    const audio = document.createElement("audio");
    audio.controls = true; audio.preload = "none"; audio.src = clip.audioUrl; audio.className = "clip-audio";
    card.append(alabel, audio);
    const links = document.createElement("div"); links.className = "clip-links";
    renderClipLinks(links, clip.audioUrl, "فتح / تنزيل الصوت");
    if (clip.imageUrl) renderClipLinks(links, clip.imageUrl, "فتح الصورة");
    if (links.childNodes.length) card.appendChild(links);
  }
  if (clip.errorText) {
    const error = document.createElement("p");
    error.className = "clip-error";
    error.textContent = clip.errorText;
    card.appendChild(error);
  }
}
function upsertSceneClip(scene, patch) {
  let clip = clips.find(function(c) { return c.id === scene.id; });
  if (!clip) {
    clip = { id: scene.id, narration: scene.narration || scene.story || "", audioUrl: null, imageUrl: null, videoUrl: null, statusText: "في انتظار البدء" };
    clips.push(clip);
  }
  Object.assign(clip, patch || {});
  drawSceneCard(clip);
  const s = activeStorySession();
  if (s) {
    s.clips = clips.map(function(c) {
      return { id:c.id, narration:c.narration, audioUrl:c.audioUrl || null, imageUrl:c.imageUrl || null,
        videoUrl:c.videoUrl || null, statusText:c.statusText || "", errorText:c.errorText || null };
    });
    s.updatedAt = Date.now();
    persistSessions();
  }
  return clip;
}
function updateStageProgress(scene, stageIndex, state, detail, payload) {
  const labels = ["الصوت", "الصورة", "الفيديو"];
  const label = labels[stageIndex];
  const total = Math.max(1, runScenes.length * 3);
  const thisSceneCompleted = stageIndex + (state === "done" ? 1 : 0);
  const completedStages = (scene.id - 1) * 3 + thisSceneCompleted;
  const overall = Math.floor(90 * completedStages / total);
  const local = Math.round(100 * thisSceneCompleted / 3);
  const isWorking = state === "working";
  const text = isWorking ? "جاري توليد " + label + "…" : "اكتمل " + label + " ✓";
  const clipText = payload && payload.statusText ? payload.statusText : (isWorking ? "قيد التنفيذ: " + label : (stageIndex === 2 ? "الفيديو جاهز للتنزيل" : "اكتمل " + label + " — الانتقال تلقائيًا للمرحلة التالية"));
  upsertSceneClip(scene, Object.assign({statusText:clipText,scenePercent:local,errorText:null}, payload || {}));
  setProgress(overall, 100, "إجمالي القصة: " + overall + "% · المشهد " + scene.id + "/" + runScenes.length + ": " + local + "% · مراحل مكتملة " + completedStages + "/" + total);
  const serviceNote = "المؤشر يحسب مراحل التوليد المكتملة فعليًا؛ خدمة النموذج لا تكشف نسبة داخلية أثناء الانتظار.\n";
  setStatus("المشهد " + scene.id + " من " + runScenes.length + " — " + text,
    (detail || "") + "\nتقدم هذا المشهد: " + local + "% · تقدم القصة: " + overall + "%\n" + serviceNote);
  const s = activeStorySession();
  if (s) {
    s.status = "running";
    s.progress = overall;
    s.currentScene = scene.id;
    s.currentStage = label + (isWorking ? " (قيد التنفيذ)" : " (اكتمل)");
    s.sceneSegments = runScenes.map(function(x) { return {id:x.id,narration:x.narration,story:x.story,start:x.start,end:x.end}; });
    persistSessions();
  }
}
function withModelTimeout(promise, ms, stageName) {
  let timer;
  const timeout = new Promise(function(_, reject) {
    timer = setTimeout(function() {
      reject(new Error("تجاوزت مرحلة " + stageName + " الحد الانتظاري " + Math.round(ms/1000) + " ثانية من دون رد. تم إيقاف الانتظار في الواجهة بدل تركها عالقة؛ قد تكون خدمة النموذج مزدحمة أو معلّقة."));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(function() { clearTimeout(timer); });
}
async function synthesizeVoiceV2(scene, speed, steps) {
  const client = await withModelTimeout(getVoiceClient(), 90000, "الاتصال بخدمة الصوت");
  let args;
  if (voiceProfile && voiceProfile.blob) {
    const wav = new File([voiceProfile.blob], "salah-voice-reference.wav", { type: "audio/wav" });
    args = [scene.narration, "arz", "clone", "", await gradioFile(wav), voiceProfile.transcript || "", steps, 2.5, speed, true];
  } else {
    args = [scene.narration, "arz", "preset", "Ahmed", null, "", steps, 2.5, speed, true];
  }
  const result = await withModelTimeout(client.predict("/synthesize", args), 180000, "توليد الصوت");
  const audioUrl = findUrl(result && result.data && result.data[0], VOICE_SPACE);
  if (!audioUrl) throw new Error("عاد نموذج الصوت من دون رابط ملف صوتي يمكن تشغيله.");
  return audioUrl;
}
async function generateImageV2(scene, aspect) {
  const client = await withModelTimeout(getImageClient(), 90000, "الاتصال بخدمة الصور");
  const size = imageSize(aspect);
  const result = await withModelTimeout(client.predict("/generate_image", [scene.visual, size.height, size.width, 9, 42 + scene.id, true]), 240000, "توليد الصورة");
  const imageUrl = findUrl(result && result.data && result.data[0], IMAGE_SPACE);
  if (!imageUrl) throw new Error("عاد نموذج الصور من دون صورة قابلة للاستخدام. تحقق من أن واجهة خدمة الصور العامة متاحة.");
  return imageUrl;
}
async function generateVideoV2(scene, imageUrl, audioUrl, quality) {
  const client = await withModelTimeout(getVideoClient(), 90000, "الاتصال بخدمة الفيديو");
  const result = await withModelTimeout(client.predict("/predict", [await gradioFile(imageUrl), await gradioFile(audioUrl), quality]), 300000, "توليد الفيديو");
  const videoUrl = findUrl(result && result.data, VIDEO_SPACE);
  if (!videoUrl) throw new Error("لم يُرجع نموذج الفيديو رابط فيديو. قد تكون خدمته غير متاحة أو تغيّر مخطط واجهته.");
  return videoUrl;
}
function showFinalVideoV2(blob, sessionId) {
  if (finalObjectURL) URL.revokeObjectURL(finalObjectURL);
  finalObjectURL = URL.createObjectURL(blob);
  $("finalVideo").src = finalObjectURL;
  $("finalVideo").classList.remove("hidden");
  const link = $("downloadFinalVideo");
  link.href = finalObjectURL;
  link.download = "Salah-Web-Full-Video.mp4";
  link.classList.remove("hidden");
  $("finalFileInfo").textContent = "ملف MP4 واحد · الحجم " + (blob.size / 1048576).toFixed(1) + " ميجابايت. اضغط تنزيل للاحتفاظ به.";
  $("finalArea").classList.remove("hidden");
}
async function mergeClipsV2(clipsToMerge, aspect, quality) {
  setStatus("اكتملت مشاهد القصة — تجهيز الدمج النهائي", "تم إنشاء المقاطع الفردية. الآن يجري تنزيلها وتركيب الصوت وتوحيد مقاس الفيديو داخل المتصفح.");
  setProgress(90,100,"المشاهد: 100% · تجهيز ملف واحد: 0%");
  const ffmpeg = await loadFFmpeg();
  const dims = aspect === "16:9"
    ? (quality === "720P" ? [1280,720] : [854,480])
    : aspect === "1:1"
      ? (quality === "720P" ? [720,720] : [480,480])
      : (quality === "720P" ? [720,1280] : [480,854]);
  const lines = [];
  for (let i = 0; i < clipsToMerge.length; i++) {
    const c = clipsToMerge[i];
    setStatus("تجهيز الملف النهائي — مقطع " + (i + 1) + "/" + clipsToMerge.length, "جارٍ تنزيل فيديو المشهد وصوته وتوحيد الترميز. إذا منع مزود النموذج التنزيل، سيظل المقطع الفردي ظاهرًا بالأعلى.");
    setProgress(90 + Math.floor(8 * i / Math.max(1, clipsToMerge.length)),100,"تجهيز الفيديو الكامل: " + Math.floor(100 * i / Math.max(1,clipsToMerge.length)) + "%");
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
    lines.push("file '" + out + "'");
    setProgress(90 + Math.floor(8 * (i+1) / Math.max(1, clipsToMerge.length)),100,"تجهيز الفيديو الكامل: " + Math.floor(100 * (i+1) / clipsToMerge.length) + "%");
  }
  await ffmpeg.writeFile("concat_list.txt", new TextEncoder().encode(lines.join("\n") + "\n"));
  setStatus("الدمج الأخير — جمع المقاطع بترتيب القصة", "المقاطع جاهزة. جارٍ إخراج ملف MP4 واحد.");
  setProgress(99,100,"آخر خطوة: إخراج ملف MP4 واحد");
  await ffmpeg.exec(["-f","concat","-safe","0","-i","concat_list.txt","-c","copy","-movflags","+faststart","Salah-Web-Full.mp4"]);
  const output = await ffmpeg.readFile("Salah-Web-Full.mp4");
  const blob = new Blob([output], {type:"video/mp4"});
  if (!blob.size) throw new Error("أنشأ الدمج ملفًا فارغًا.");
  return blob;
}
async function runFullWorkflowV2() {
  if (isBusy) return;
  const story = $("storyScript").value.trim();
  if (!story) { setStatus("اكتب السكريبت أولًا","اكتب القصة كاملة في المربع المخصص."); return; }
  if (story.length < 20) { setStatus("السكريبت قصير جدًا","أضف بعض التفاصيل حتى يمكن إنشاء مشاهد مناسبة."); return; }
  if (story.length > 30000) { setStatus("السكريبت أطول من الحد الحالي","الحد الأقصى 30 ألف حرف في القصة الواحدة."); return; }
  if (!activeStorySession()) createStorySession(readStorySettings());
  saveCurrentStoryToHistory(false);
  const session = activeStorySession();
  if (!session) return;
  setBusy(true);
  clearStoryResultView();
  session.status = "running";
  session.progress = 0;
  session.currentScene = 0;
  session.currentStage = "تهيئة القصة";
  session.lastTitle = "بدأ إنشاء الفيديو";
  session.lastDetail = "يقسم الموقع النص ثم يولّد صوت كل مشهد وصورته وفيديوه، ويعرض النتيجة فور اكتمالها.";
  session.clips = [];
  const desired = Number($("durationMinutes").value || 2);
  const scenes = buildScenePlan(story, desired);
  runScenes = scenes;
  session.sceneSegments = scenes.map(function(x) { return {id:x.id,narration:x.narration,story:x.story,start:x.start,end:x.end}; });
  session.updatedAt = Date.now();
  persistSessions();
  renderStoryHistory();
  setProgress(0,100,"0% · 0/" + (scenes.length * 3) + " مراحل توليد مكتملة");
  setStatus("بدأ الإنتاج التلقائي","تم تقسيم القصة إلى " + scenes.length + " مشهدًا. سينشأ كل مشهد بالترتيب: صوت ← صورة ← فيديو، وسيظهر فور اكتماله. لا توجد خطوة يدوية بين المراحل.");
  let processingScene = null;
  let processingStage = 0;
  try {
    const aspect = $("aspectRatio").value;
    const quality = $("videoQuality").value;
    const speed = Number($("voiceSpeed").value || 0.92);
    const steps = Number($("voiceSteps").value || 32);
    const targetSeconds = Math.round(desired * 60);
    const textSeconds = Math.round(story.split(/\s+/).filter(Boolean).length / 130 * 60);
    if (Math.abs(textSeconds-targetSeconds) > targetSeconds*0.3) {
      setStatus("تنبيه: مدة الكلام تختلف عن المدة المختارة",
        "النص يحتوي كلامًا يكافئ نحو " + (textSeconds/60).toFixed(1) + " دقيقة، بينما المدة المستهدفة " + desired + " دقيقة. سيحافظ الموقع على النص كاملًا؛ لا يمكن ضمان مدة نهائية مطابقة دون حذف النص أو تمديده.");
    }
    for (const scene of scenes) {
      processingScene = scene;
      updateStageProgress(scene,0,"working","الخطوة 1/3 من هذا المشهد: توليد الصوت. قد تنتظر قليلًا حسب دور النموذج.");
      processingStage = 0;
      const audioUrl = await withModelTimeout(synthesizeVoice(scene,speed,steps), 210000, "مرحلة الصوت للمشهد " + scene.id);
      updateStageProgress(scene,0,"done","اكتمل الصوت؛ سيبدأ توليد صورة هذا المشهد تلقائيًا.",{audioUrl:audioUrl,statusText:"اكتمل الصوت — جاري توليد الصورة"});
      processingStage = 1;
      updateStageProgress(scene,1,"working","الخطوة 2/3: إنشاء صورة سينمائية من جزء القصة ووصف الشخصيات.");
      const imageUrl = await withModelTimeout(generateImage(scene,aspect), 270000, "مرحلة الصورة للمشهد " + scene.id);
      updateStageProgress(scene,1,"done","اكتملت الصورة؛ سيبدأ تحريكها باستخدام الصوت الناتج.",{audioUrl:audioUrl,imageUrl:imageUrl,statusText:"اكتمل الصوت والصورة — جاري توليد الفيديو"});
      processingStage = 2;
      updateStageProgress(scene,2,"working","الخطوة 3/3: تحريك الصورة مع الصوت. مدة الخدمة تتغير حسب الضغط والجودة.");
      const videoUrl = await withModelTimeout(generateVideo(scene,imageUrl,audioUrl,quality), 330000, "مرحلة الفيديو للمشهد " + scene.id);
      const result = upsertSceneClip(scene,{audioUrl:audioUrl,imageUrl:imageUrl,videoUrl:videoUrl,statusText:"الفيديو جاهز للتنزيل",errorText:null,scenePercent:100});
      updateStageProgress(scene,2,"done","اكتمل هذا المشهد وأصبح متاحًا الآن؛ جارٍ الانتقال للمشهد التالي.",{audioUrl:audioUrl,imageUrl:imageUrl,videoUrl:videoUrl,statusText:"اكتمل الفيديو — جاهز"});
      const sNow = activeStorySession();
      if (sNow) {
        sNow.completedScenes = clips.filter(function(c) { return !!c.videoUrl; }).length;
        sNow.status = "running";
        persistSessions();
      }
      // Deliberately save and render a completed scene before requesting the next scene.
      drawSceneCard(result);
    }
    setStatus("اكتملت جميع المشاهد — بدء تجميع الفيديو","تم إنشاء " + clips.length + " مقطعًا منفصلًا. جارٍ جمعها في ملف MP4 واحد وتركيب الصوت.");
    const finalBlob = await mergeClips(clips,aspect,quality);
    try { await dbSet("final-video:" + session.id, finalBlob); } catch (_) {}
    showFinalVideo(finalBlob,session.id);
    setProgress(100,100,"100% · اكتملت جميع المشاهد والدمج النهائي");
    setStatus("الفيديو الكامل جاهز ✓","اكتملت القصة في ملف MP4 واحد مع الصوت. يمكنك تنزيله الآن من قسم النتيجة النهائية.","success");
    session.status = "completed";
    session.progress = 100;
    session.completedAt = Date.now();
    session.lastTitle = "الفيديو الكامل جاهز ✓";
    session.lastDetail = "اكتملت جميع المشاهد ودمجها في ملف MP4 واحد.";
    persistSessions();
  } catch (err) {
    const detail = errorText(err);
    if (processingScene) {
      const clip = upsertSceneClip(processingScene,{
        statusText:"توقف عند مرحلة " + ["الصوت","الصورة","الفيديو"][processingStage],
        errorText:detail
      });
    }
    const s = activeStorySession();
    if (s) {
      s.status = clips.some(function(c) { return !!c.videoUrl; }) ? "partial" : "failed";
      s.progress = Number($("progressBar").value || s.progress || 0);
      s.lastTitle = s.status === "partial" ? "توقف الإنتاج — توجد مشاهد جاهزة" : "تعذر إكمال أول مشهد";
      s.lastDetail = "اكتمل " + clips.filter(function(c) { return !!c.videoUrl; }).length + " من " + scenes.length + " مشاهد فيديو. السبب: " + detail + "\nالمقاطع المكتملة محفوظة في نتائج القصة ويمكن فتحها من سجل القصص.";
      persistSessions();
    }
    setStatus("توقف الإنتاج عند المشهد " + (processingScene ? processingScene.id : "?"),
      "المرحلة: " + (["الصوت","الصورة","الفيديو"][processingStage] || "التحضير") + "\n" +
      "نجح حتى الآن " + clips.filter(function(c) { return !!c.videoUrl; }).length + " من " + scenes.length + " مشاهد. لم تختفِ النتائج السابقة. \nالسبب: " + detail,"error");
  } finally {
    setBusy(false);
    renderStoryHistory();
    saveCurrentStoryToHistory(false);
  }
}
async function initV2() {
  try {
    voiceProfile = await dbGet(VOICE_KEY);
    $("voiceSampleStatus").textContent = voiceProfile && voiceProfile.blob
      ? "عينة صوت محفوظة بالفعل في هذا المتصفح؛ سيستخدمها الموقع تلقائيًا."
      : "لا توجد عينة محفوظة؛ سيستخدم الموقع صوتًا عربيًا جاهزًا تلقائيًا.";
  } catch (_) {
    $("voiceSampleStatus").textContent = "سيُستخدم صوت عربي جاهز؛ التخزين المحلي غير متاح حاليًا.";
  }
  try { storySessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "[]"); } catch (_) { storySessions = []; }
  if (!Array.isArray(storySessions)) storySessions = [];
  storySessions = storySessions.filter(function(s) { return s && s.id; });
  storySessions.forEach(function(s) {
    if (s.status === "running") {
      s.status = "partial";
      s.lastTitle = "توقفت جلسة الإنتاج عند إغلاق الصفحة";
      s.lastDetail = "حُفظ النص ووصف الشخصيات والنتائج المكتملة. الطلبات الخارجية المعلقة لا تستمر تلقائيًا بعد مغادرة الصفحة.";
    }
  });
  let savedId = "";
  try { savedId = localStorage.getItem(ACTIVE_SESSION_KEY) || ""; } catch (_) {}
  if (!storySessions.length) createStorySession(readStorySettings());
  else if (storySessions.some(function(s) { return s.id === savedId; })) activeSessionId = savedId;
  else activeSessionId = storySessions.slice().sort(function(a,b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0].id;
  const active = activeStorySession();
  if (active) applyStorySessionToPage(active);
  renderStoryHistory();

  $("newStoryButton").addEventListener("click",newStorySession);
  $("storyScript").addEventListener("input",function() {
    updateEstimate();
    const s = activeStorySession();
    const prior = s ? s.title : "";
    saveCurrentStoryToHistory(false);
    if (s && prior !== s.title) renderStoryHistory();
  });
  $("characterDescription").addEventListener("input",function(){ saveCurrentStoryToHistory(false); });
  ["durationMinutes","aspectRatio","videoQuality","stylePreset","voiceSpeed","voiceSteps","arabicCharacters","historicClothing","religiousFaces"].forEach(function(id) {
    $(id).addEventListener("change",function(){ saveCurrentStoryToHistory(true); });
  });
  $("saveVoiceSample").addEventListener("click",saveVoiceReference);
  $("generateFullVideo").addEventListener("click",runFullWorkflow);
  if (active && active.lastTitle) {
    // Existing saved runs and their partial outputs remain visible when revisiting a story.
  } else {
    setProgress(0,100,"اختر قصة قديمة من السجل أو أنشئ قصة جديدة.");
  }
  updateEstimate();
  setBusy(false);
}


async function loadGradioClientModule() {
  if (!gradioModulePromise) {
    gradioModulePromise = import("https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js");
  }
  return await gradioModulePromise;
}
async function gradioFile(fileOrUrl) {
  const library = await loadGradioClientModule();
  return library.handle_file(fileOrUrl);
}
function getVoiceClientV2() {
  if (!voiceClientPromise) voiceClientPromise = loadGradioClientModule().then(function(lib) { return lib.Client.connect(ORIGIN[VOICE_SPACE]); });
  return voiceClientPromise;
}
function getImageClientV2() {
  if (!imageClientPromise) imageClientPromise = loadGradioClientModule().then(function(lib) { return lib.Client.connect(ORIGIN[IMAGE_SPACE]); });
  return imageClientPromise;
}
function getVideoClientV2() {
  if (!videoClientPromise) videoClientPromise = loadGradioClientModule().then(function(lib) { return lib.Client.connect(ORIGIN[VIDEO_SPACE]); });
  return videoClientPromise;
}

/* Activate the revised implementations only after every helper is defined. */
getVoiceClient = getVoiceClientV2;
getImageClient = getImageClientV2;
getVideoClient = getVideoClientV2;
setStatus = setStatusV2;
setProgress = setProgressV2;
setBusy = setBusyV2;
synthesizeVoice = synthesizeVoiceV2;
generateImage = generateImageV2;
generateVideo = generateVideoV2;
showFinalVideo = showFinalVideoV2;
mergeClips = mergeClipsV2;
runFullWorkflow = runFullWorkflowV2;
init = initV2;


/* Quota-aware connection and narration chunks aligned to natural Arabic punctuation. */
const HF_TOKEN_KEY_V3 = "salah-web-hf-access-token-v1";
function getHFTokenOptionsV3() {
  // Do not send personal HF tokens to third-party public Spaces.
  return {};
}
function getVoiceClientV3() {
  if (!voiceClientPromise) voiceClientPromise = loadGradioClientModule().then(function(lib) {
    return lib.Client.connect(ORIGIN[VOICE_SPACE]);
  });
  return voiceClientPromise;
}
function getImageClientV3() {
  if (!imageClientPromise) imageClientPromise = loadGradioClientModule().then(function(lib) {
    return lib.Client.connect(ORIGIN[IMAGE_SPACE]);
  });
  return imageClientPromise;
}
function getVideoClientV3() {
  if (!videoClientPromise) videoClientPromise = loadGradioClientModule().then(function(lib) {
    return lib.Client.connect(ORIGIN[VIDEO_SPACE]);
  });
  return videoClientPromise;
}
function errorTextV3(err) {
  const raw = String((err && err.message) || err || "خطأ غير معروف");
  if (/ZeroGPU.*(runs limit|quota|exceeded)|exceeded your ZeroGPU runs limit/i.test(raw)) {
    return "حصة Hugging Face المجانية وصلت للحد. افتح إعداد «تسجيل Hugging Face» وأضف Access Token بصلاحية القراءة، ثم أعد المحاولة. إذا استخدمت توكن بالفعل فقد تكون الحصة اليومية لحسابك استُنفدت أيضًا ويجب انتظار إعادة ضبطها. التفاصيل: " + raw.slice(0, 380);
  }
  if (/quota|rate limit|429/i.test(raw)) {
    return "خدمة النموذج وصلت لحد الاستخدام. أضف توكن Hugging Face إن لم يكن محفوظًا، أو انتظر تجدد الحصة. التوكن لا يلغي كل الحدود المجانية. التفاصيل: " + raw.slice(0, 380);
  }
  if (/Space metadata could not be loaded/i.test(raw)) {
    return "لم يمكن قراءة واجهة النموذج. تحقق من اتصال الإنترنت، أو من أن خدمة Hugging Face ما زالت متاحة. لن يستمر الموقع في الانتظار بلا نهاية. التفاصيل: " + raw.slice(0, 380);
  }
  return raw.slice(0, 900);
}
function wordCountV3(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}
function splitAtPunctuationV3(text, marks) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (marks.indexOf(text[i]) !== -1) {
      const part = text.slice(start, i + 1).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out;
}
function makeNarrationUnitsV3(text, maxWords) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const sentences = splitAtPunctuationV3(normalized, ".!?؟…؛");
  const units = [];
  sentences.forEach(function(sentence) {
    const clauses = splitAtPunctuationV3(sentence, "،,:");
    clauses.forEach(function(clause) {
      const words = clause.split(/\s+/).filter(Boolean);
      if (words.length <= maxWords) {
        if (clause) units.push(clause);
        return;
      }
      // Split only exceptionally long clauses, preserving every word and all ending punctuation.
      for (let i = 0; i < words.length; i += maxWords) {
        units.push(words.slice(i, i + maxWords).join(" "));
      }
    });
  });
  return units.filter(Boolean);
}
function splitLongestUnitV3(units) {
  let best = -1;
  let bestCount = 5;
  for (let i = 0; i < units.length; i++) {
    const n = wordCountV3(units[i]);
    if (n > bestCount) { best = i; bestCount = n; }
  }
  if (best < 0) return false;
  const words = units[best].split(/\s+/);
  const middle = Math.ceil(words.length / 2);
  const left = words.slice(0, middle).join(" ").replace(/[.!?؟…؛،,:]+$/u, "");
  const right = words.slice(middle).join(" ");
  if (!left || !right) return false;
  units.splice(best, 1, left + "،", right);
  return true;
}
function buildScenePlanV3(text, desiredMinutes) {
  const wordTotal = wordCountV3(text);
  const wantedByDuration = Math.max(1, Math.round(Number(desiredMinutes || 2) * 4));
  const maxByWords = Math.max(1, Math.ceil(wordTotal / 25));
  // Don't create many empty/tiny narration segments just because the requested runtime is long.
  const count = Math.min(60, Math.ceil(wordTotal / 5), Math.max(wantedByDuration, maxByWords));
  const units = makeNarrationUnitsV3(text, 25);
  while (units.length < count && splitLongestUnitV3(units)) {}
  const targetCount = Math.min(count, Math.max(1, units.length));
  const groups = [];
  let cursor = 0;
  let remainingWords = wordTotal;
  for (let i = 0; i < targetCount; i++) {
    const groupsLeft = targetCount - i;
    const targetWords = remainingWords / groupsLeft;
    const group = [];
    let groupWords = 0;
    const unitsLeft = units.length - cursor;
    const takeAtLeast = Math.max(1, unitsLeft - (groupsLeft - 1));
    while (cursor < units.length && (group.length < takeAtLeast || (groupWords < targetWords && units.length - cursor > groupsLeft - 1))) {
      const unit = units[cursor++];
      group.push(unit);
      groupWords += wordCountV3(unit);
      if (groupWords >= targetWords && group.length >= takeAtLeast) break;
    }
    groups.push(group.join(" ").replace(/\s+/g, " ").trim());
    remainingWords -= groupWords;
  }
  while (cursor < units.length) groups[groups.length - 1] += " " + units[cursor++];
  return groups.filter(Boolean).map(function(part, i, all) {
    return {
      id: i + 1, narration: part, story: part,
      visual: makeVisualPrompt(part, i, all.length),
      start: i * 15, end: (i + 1) * 15
    };
  });
}
function saveHFTokenV3() {
  const field = $("hfTokenInput");
  const val = String(field.value || "").trim();
  const status = $("hfTokenStatus");
  try {
    if (val) {
      if (!/^hf_[A-Za-z0-9]+$/.test(val)) {
        status.textContent = "شكل التوكن غير صحيح؛ يفترض أن يبدأ بـ hf_. لم يتم حفظ شيء.";
        return;
      }
      localStorage.setItem(HF_TOKEN_KEY_V3, val);
      field.value = "";
      status.textContent = "تم حفظ التوكن على هذا الجهاز. لن يُرفع إلى GitHub؛ سيُستخدم عند الاتصال بخدمات Hugging Face فقط.";
      voiceClientPromise = null; imageClientPromise = null; videoClientPromise = null;
      setStatus("تم حفظ إعداد الاتصال", "أعد المحاولة الآن. المصادقة قد تزيد الحصة المتاحة، لكن لا تزيل الحدود اليومية بالكامل.", "success");
    } else {
      const existing = localStorage.getItem(HF_TOKEN_KEY_V3);
      status.textContent = existing
        ? "يوجد توكن محفوظ بالفعل على هذا الجهاز. اكتب توكن جديدًا ثم احفظ لاستبداله، أو اضغط «مسح التوكن»."
        : "لم يتم إدخال توكن؛ سيجرب الموقع الحصة المتاحة دون مصادقة.";
    }
  } catch (e) {
    status.textContent = "تعذر حفظ التوكن محليًا في هذا المتصفح. " + String(e.message || e);
  }
}
function clearHFTokenV3() {
  try { localStorage.removeItem(HF_TOKEN_KEY_V3); } catch (_) {}
  if ($("hfTokenInput")) $("hfTokenInput").value = "";
  $("hfTokenStatus").textContent = "تم مسح التوكن المحفوظ من هذا الجهاز.";
  voiceClientPromise = null; imageClientPromise = null; videoClientPromise = null;
  setStatus("تم مسح التوكن", "سيرجع الموقع لاستخدام الحصة غير المسجلة عند الاتصال بخدمات النماذج.");
}
async function initV3() {
  try {
    voiceProfile = await dbGet(VOICE_KEY);
    $("voiceSampleStatus").textContent = voiceProfile && voiceProfile.blob
      ? "عينة صوت محفوظة بالفعل في هذا المتصفح؛ سيستخدمها الموقع تلقائيًا."
      : "لا توجد عينة محفوظة؛ سيستخدم الموقع صوتًا عربيًا جاهزًا تلقائيًا.";
  } catch (_) {
    $("voiceSampleStatus").textContent = "سيستخدم الموقع صوتًا عربيًا جاهزًا؛ التخزين المحلي غير متاح حاليًا.";
  }
  try {
    const tok = localStorage.getItem(HF_TOKEN_KEY_V3) || "";
    $("hfTokenStatus").textContent = tok
      ? "يوجد توكن محفوظ بالفعل على هذا الجهاز. اترك الحقل فارغًا للإبقاء عليه."
      : "لم يتم حفظ توكن لهذا المتصفح؛ عند نفاد الحصة قد تحتاج إلى واحد.";
  } catch (_) {
    $("hfTokenStatus").textContent = "تعذر الوصول للتخزين المحلي.";
  }
  try { storySessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "[]"); } catch (_) { storySessions = []; }
  if (!Array.isArray(storySessions)) storySessions = [];
  storySessions = storySessions.filter(function(s) { return s && s.id; });
  storySessions.forEach(function(s) {
    if (s.status === "running") {
      s.status = "partial";
      s.lastTitle = "توقفت جلسة الإنتاج عند إغلاق الصفحة";
      s.lastDetail = "حُفظ النص ووصف الشخصيات والنتائج المكتملة. الطلبات الخارجية المعلقة لا تستمر تلقائيًا بعد مغادرة الصفحة.";
    }
  });
  let savedId = "";
  try { savedId = localStorage.getItem(ACTIVE_SESSION_KEY) || ""; } catch (_) {}
  if (!storySessions.length) createStorySession(readStorySettings());
  else if (storySessions.some(function(s) { return s.id === savedId; })) activeSessionId = savedId;
  else activeSessionId = storySessions.slice().sort(function(a,b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0].id;
  const active = activeStorySession();
  if (active) applyStorySessionToPage(active);
  renderStoryHistory();

  $("newStoryButton").addEventListener("click",newStorySession);
  $("storyScript").addEventListener("input",function() {
    updateEstimate();
    const s = activeStorySession();
    const prior = s ? s.title : "";
    saveCurrentStoryToHistory(false);
    if (s && prior !== s.title) renderStoryHistory();
  });
  $("characterDescription").addEventListener("input",function(){ saveCurrentStoryToHistory(false); });
  ["durationMinutes","aspectRatio","videoQuality","stylePreset","voiceSpeed","voiceSteps","arabicCharacters","historicClothing","religiousFaces"].forEach(function(id) {
    $(id).addEventListener("change",function(){ saveCurrentStoryToHistory(true); });
  });
  $("saveVoiceSample").addEventListener("click",saveVoiceReference);
  $("saveHFToken").addEventListener("click",saveHFTokenV3);
  if ($("clearHFToken")) $("clearHFToken").addEventListener("click",clearHFTokenV3);
  $("generateFullVideo").addEventListener("click",runFullWorkflow);
  if (active && active.lastTitle) {
    // Restore saved story state and completed clip links.
  } else {
    setProgress(0,100,"اختر قصة قديمة من السجل أو أنشئ قصة جديدة.");
  }
  updateEstimate();
  setBusy(false);
}


async function testHFConnectionV4() {
  const button = $("testHFConnection");
  if (button) button.disabled = true;
  $("hfTokenStatus").textContent = "جارٍ الاتصال بواجهة نموذج الصوت باستخدام إعداد التوكن المحفوظ…";
  try {
    const token = localStorage.getItem(HF_TOKEN_KEY_V3) || "";
    if (!/^hf_[A-Za-z0-9]+$/.test(token)) {
      throw new Error("لا يوجد توكن محفوظ بهذا المتصفح. أنشئ توكن Read جديدًا، والصقه في الحقل، ثم اضغط «حفظ التوكن» أولًا.");
    }
    voiceClientPromise = null;
    await withModelTimeout(getVoiceClientV3(), 45000, "الاتصال بواجهة نموذج الصوت");
    $("hfTokenStatus").textContent = "نجح الاتصال بواجهة نموذج الصوت. هذا يثبت أن البيانات الوصفية أمكن تحميلها، لكنه لا يضمن توفر حصة التوليد؛ جرّب مشهدًا قصيرًا.";
    setStatus("نجح اختبار الاتصال", "اتصل الموقع بواجهة نموذج الصوت. الآن جرّب توليد مشهد قصير. إذا ظهرت رسالة ZeroGPU limit فهذا يعني أن حصة التوليد ما زالت محدودة.", "success");
  } catch (err) {
    voiceClientPromise = null;
    const detail = errorTextV3(err);
    $("hfTokenStatus").textContent = "تعذر الاتصال: " + detail;
    setStatus("فشل اختبار اتصال Hugging Face", detail, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

/* Last-mile overrides used by the published page. */
getVoiceClient = getVoiceClientV3;
getImageClient = getImageClientV3;
getVideoClient = getVideoClientV3;
errorText = errorTextV3;
buildScenePlan = buildScenePlanV3;
init = initV3;
const previousInitV3 = init;
init = async function() {
  await previousInitV3();
  if ($("testHFConnection")) $("testHFConnection").addEventListener("click", testHFConnectionV4);
};
init = initV5;
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
