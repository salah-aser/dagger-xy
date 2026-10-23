import { Client, handle_file } from "https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";

const DB_NAME = "salah-web-local-media-v1";
const STORE = "assets";
const VOICE_KEY = "voice-profile";
const VOICE_SPACE = "mohammedaly22/VoiceTut-TTS";
const IMAGE_SPACE = "mrfakename/Z-Image-Turbo";
const VIDEO_SPACE = "Wan-AI/Wan2.2-S2V";
const SPACE_ORIGINS = {
  [VOICE_SPACE]: "https://mohammedaly22-voicetut-tts.hf.space",
  [IMAGE_SPACE]: "https://mrfakename-z-image-turbo.hf.space",
  [VIDEO_SPACE]: "https://wan-ai-wan2-2-s2v.hf.space"
};
let referenceProfile = null;
let uploadedCharacterImage = null;
let busy = false;
let voiceClientPromise = null;
let imageClientPromise = null;
let videoClientPromise = null;

function $(id) { return document.getElementById(id); }
function openDb() {
  return new Promise(function(resolve, reject) {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = function() {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = function() { resolve(request.result); };
    request.onerror = function() { reject(request.error || new Error("تعذر فتح التخزين المحلي.")); };
  });
}
async function dbSet(key, value) {
  const db = await openDb();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = function() { db.close(); resolve(true); };
    tx.onerror = function() { db.close(); reject(tx.error); };
    tx.onabort = function() { db.close(); reject(tx.error); };
  });
}
async function dbGet(key) {
  const db = await openDb();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = function() { const value = request.result || null; db.close(); resolve(value); };
    request.onerror = function() { db.close(); reject(request.error); };
  });
}
function storyId() { return window.SalahWeb && window.SalahWeb.getStoryId ? window.SalahWeb.getStoryId() : "default"; }
function showStatus(title, detail, kind) {
  $("productionStatus").classList.remove("hidden");
  $("productionStatusTitle").textContent = title;
  $("productionStatusText").textContent = detail || "";
  $("productionStatusTitle").classList.toggle("statusError", kind === "error");
  $("productionStatusTitle").classList.toggle("statusSuccess", kind === "success");
}
function setBusy(value) {
  busy = value;
  ["prepareVoice","testReferenceVoice","generateOneScene","generateAllScenes","saveCharacterImage"].forEach(function(id) {
    if ($(id)) $(id).disabled = value;
  });
}
function readableError(error) {
  const raw = String((error && error.message) || error || "Unknown error");
  if (/quota|zerogpu|gpu.*time|rate limit|429/i.test(raw)) return "الحصة المجانية أو قدرة النموذج غير متاحة الآن. انتظر تجدد الحصة أو جرّب لاحقًا. التفاصيل: " + raw.slice(0, 400);
  if (/fetch|network|connect|websocket|503|502|504/i.test(raw)) return "تعذر الوصول إلى مساحة النموذج أو أنها متوقفة/مزدحمة. جرّب لاحقًا. التفاصيل: " + raw.slice(0, 400);
  if (/permission|unauthorized|401|403|token/i.test(raw)) return "النموذج رفض الطلب أو يطلب إذنًا من حساب Hugging Face. التفاصيل: " + raw.slice(0, 400);
  return raw.slice(0, 900);
}
function requireConsent() {
  if (!$("externalUploadConsent").checked) throw new Error("فعّل مربع الموافقة. أثناء الإنتاج سترسل عينة الصوت المقتطعة والنص والصورة إلى مزودي النماذج الخارجيين.");
}
function requireReference() {
  if (!referenceProfile || !referenceProfile.blob) throw new Error("ارفع ملف صوتك، حدّد مقطعًا واضحًا، واضغط «قص العينة وحفظ بصمة الصوت» أولًا.");
}
function absUrl(url, space) {
  if (typeof url !== "string" || !url.trim()) return null;
  const value = url.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return SPACE_ORIGINS[space] + value;
  return null;
}
function findFileUrl(value, space, depth) {
  depth = depth || 0;
  if (depth > 7 || value == null) return null;
  if (typeof value === "string") return absUrl(value, space);
  if (Array.isArray(value)) {
    for (const item of value) { const found = findFileUrl(item, space, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["url","video_url","audio_url","image_url"]) {
      const found = absUrl(value[key], space);
      if (found) return found;
    }
    for (const key of ["data","path","file","files","output","result","images","video","audio"]) {
      const found = findFileUrl(value[key], space, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
function currentStory() {
  return window.SalahWeb && window.SalahWeb.getStory ? window.SalahWeb.getStory() : {};
}
function combinedCharacterDescription() {
  const story = currentStory();
  return [story.characters || "", $("productionCharacterDescription").value.trim()].filter(Boolean).join("; ");
}
function makeVisualPrompt(basePrompt) {
  const story = currentStory();
  const character = combinedCharacterDescription();
  const items = [
    basePrompt.trim(),
    "Photorealistic cinematic frame, natural skin texture, believable anatomy, physically realistic lighting, coherent space, detailed fabric and environment.",
    story.arabic ? "Culturally authentic Arab characters and location; correct regional identity and details, not a generic fantasy culture." : "",
    story.historic ? "When the narrative is set in the past, use period-appropriate Arab clothing and architecture, natural fabrics, no modern accessories." : "",
    story.religious ? "Respectful religious depiction. If a prophet, messenger, or companion is represented, the whole face must be pure radiant light with no facial features whatsoever." : "",
    character ? "CHARACTER IDENTITY LOCK: " + character + ". Preserve the same apparent age, skin tone, face shape, facial hair, build and clothes." : "",
    "Aspect ratio " + ($("productionAspect").value || story.ratio || "9:16") + ". No captions, watermarks, logos or on-screen text."
  ];
  return items.filter(Boolean).join("\n\n");
}
function encodeWav(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  const channel = audioBuffer.getChannelData(0);
  const buffer = new ArrayBuffer(44 + channel.length * 2);
  const view = new DataView(buffer);
  const text = function(offset, value) { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + channel.length * 2, true);
  text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, channel.length * 2, true);
  let offset = 44;
  for (let i = 0; i < channel.length; i++, offset += 2) {
    const sample = Math.max(-1, Math.min(1, channel[i]));
    view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
async function cropReferenceAudio(file, startSeconds, requestedSeconds) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !window.OfflineAudioContext) throw new Error("المتصفح لا يدعم قص الصوت محليًا. جرّب Chrome أو Edge.");
  const decoder = new AudioContextClass();
  try {
    const decoded = await decoder.decodeAudioData((await file.arrayBuffer()).slice(0));
    const start = Math.max(0, Math.min(Number(startSeconds) || 0, decoded.duration - 0.25));
    const duration = Math.max(5, Math.min(Number(requestedSeconds) || 12, 15, decoded.duration - start));
    if (duration < 5) throw new Error("الملف أقصر من خمس ثوانٍ.");
    const rate = 24000;
    const frames = Math.max(1, Math.floor(duration * rate));
    const offline = new OfflineAudioContext(1, frames, rate);
    const source = offline.createBufferSource();
    source.buffer = decoded; source.connect(offline.destination); source.start(0, start, duration);
    const rendered = await offline.startRendering();
    return { blob: encodeWav(rendered), duration: rendered.duration, sourceDuration: decoded.duration, start: start };
  } finally { try { await decoder.close(); } catch (_) {} }
}
function wireAudioReference() {
  $("voiceReferenceFile").addEventListener("change", function() {
    const file = $("voiceReferenceFile").files && $("voiceReferenceFile").files[0];
    $("voiceFileMeta").textContent = file ? file.name + " · " + (file.size / 1048576).toFixed(2) + " MB" : "لم يتم اختيار ملف.";
  });
  $("prepareVoice").addEventListener("click", async function() {
    if (busy) return;
    const file = $("voiceReferenceFile").files && $("voiceReferenceFile").files[0];
    if (!file) { showStatus("اختر ملف الصوت", "ارفع ملف WAV أو MP3 الذي يحتوي على صوتك."); return; }
    try {
      setBusy(true); showStatus("جارٍ قص العينة داخل متصفحك…", "لن يُرفع الصوت الكامل في هذه الخطوة.");
      const crop = await cropReferenceAudio(file, $("voiceStartSeconds").value, $("voiceClipSeconds").value);
      referenceProfile = {
        blob: crop.blob, name: file.name, duration: crop.duration, start: crop.start,
        sourceDuration: crop.sourceDuration, transcript: $("voiceReferenceTranscript").value.trim(), savedAt: Date.now()
      };
      await dbSet(VOICE_KEY, referenceProfile);
      $("voicePreview").src = URL.createObjectURL(referenceProfile.blob);
      $("voicePreview").classList.remove("hidden");
      $("voiceProfileStatus").textContent = "محفوظة محليًا · " + crop.duration.toFixed(1) + " ث · بداية القص " + crop.start.toFixed(1) + " ث";
      showStatus("تم حفظ بصمة الصوت محليًا", "العينة " + crop.duration.toFixed(1) + " ثانية / 24kHz. لم تُرسل لأي خدمة بعد.", "success");
    } catch (error) { showStatus("فشل تجهيز العينة", readableError(error), "error"); }
    finally { setBusy(false); }
  });
}
function imageKey() { return "character-image:" + storyId(); }
async function refreshCharacterImageState() {
  try {
    const record = await dbGet(imageKey());
    uploadedCharacterImage = record && record.blob ? record.blob : null;
    $("characterImageStatus").textContent = record ? "محفوظة لهذه القصة · " + (record.name || "صورة شخصية") : "لا توجد صورة مرجعية محفوظة.";
  } catch (_) { uploadedCharacterImage = null; $("characterImageStatus").textContent = "التخزين المحلي غير متاح."; }
}
function wireCharacterImage() {
  $("saveCharacterImage").addEventListener("click", async function() {
    if (busy) return;
    const file = $("speakerImageFile").files && $("speakerImageFile").files[0];
    if (!file) { showStatus("اختر صورة الشخصية", "اختر صورة JPG أو PNG أو WebP أولًا."); return; }
    if (!file.type.startsWith("image/")) { showStatus("ملف غير صالح", "الملف المختار ليس صورة.", "error"); return; }
    try {
      setBusy(true);
      await dbSet(imageKey(), { blob: file, name: file.name, type: file.type, savedAt: Date.now() });
      uploadedCharacterImage = file;
      $("characterImageStatus").textContent = "محفوظة لهذه القصة · " + file.name;
      showStatus("تم حفظ صورة الشخصية محليًا", "ستستخدم الصورة إذا اخترت تثبيت الإطار. لم تُرفع للإنترنت بعد.", "success");
    } catch (error) { showStatus("تعذّر حفظ الصورة", readableError(error), "error"); }
    finally { setBusy(false); }
  });
  $("speakerImageFile").addEventListener("change", function() {
    const file = $("speakerImageFile").files && $("speakerImageFile").files[0];
    if (file) $("characterImageStatus").textContent = "صورة مختارة: " + file.name + " (اضغط حفظ الشخصية لتخزينها)";
  });
}
function refreshSceneOptions() {
  const select = $("productionSceneSelect");
  if (!select) return;
  const previous = select.value;
  const scenes = window.SalahWeb && window.SalahWeb.getScenes ? window.SalahWeb.getScenes() : [];
  select.innerHTML = "";
  const quick = document.createElement("option"); quick.value = "-1"; quick.textContent = "مشهد سريع من وصفك"; select.appendChild(quick);
  scenes.forEach(function(scene, index) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = "المشهد " + String(index + 1).padStart(2, "0") + " — " + Math.round(scene.start) + " إلى " + Math.round(scene.end) + " ثانية";
    select.appendChild(option);
  });
  if (previous !== "-1" && Number(previous) < scenes.length) select.value = previous;
}
function populateSceneFields() {
  const index = Number($("productionSceneSelect").value);
  const scene = (window.SalahWeb && window.SalahWeb.getScenes ? window.SalahWeb.getScenes() : [])[index];
  if (!scene || index < 0) return;
  $("productionNarration").value = scene.narration || scene.story || "";
  $("productionVisualPrompt").value = scene.prompt || scene.story || "";
  $("productionCharacterDescription").value = currentStory().characters || "";
  $("productionAspect").value = currentStory().ratio || "9:16";
}
function productionInputs(overrideScene) {
  const story = currentStory();
  let selected = overrideScene || null;
  if (!selected) {
    const index = Number($("productionSceneSelect").value);
    if (index >= 0) selected = (window.SalahWeb && window.SalahWeb.getScenes ? window.SalahWeb.getScenes() : [])[index] || null;
  }
  const narration = String(selected ? (selected.narration || selected.story || "") : $("productionNarration").value).trim();
  const visual = String(selected ? (selected.prompt || selected.story || "") : $("productionVisualPrompt").value).trim();
  if (!narration) throw new Error("اكتب الكلام الذي تريد أن تنطقه الشخصية أو اختر مشهدًا من خطة القصة.");
  if (!visual) throw new Error("اكتب وصفًا بصريًا للمشهد أو اختر مشهدًا من خطة القصة.");
  if (narration.length > 2800) throw new Error("قسّم الكلام إلى مقاطع أقصر من 2800 حرفًا لكل مشهد.");
  return {
    scene: selected, narration: narration, visual: makeVisualPrompt(visual),
    aspect: $("productionAspect").value || story.ratio || "9:16",
    resolution: $("s2vResolution").value || "480P",
    speed: Number($("productionVoiceSpeed").value || "0.92"),
    steps: Number($("productionVoiceSteps").value || "32"),
    referenceText: (referenceProfile && referenceProfile.transcript) || $("voiceReferenceTranscript").value.trim()
  };
}
function imageDimensions(aspect) {
  if (aspect === "16:9") return { height: 768, width: 1344 };
  if (aspect === "1:1") return { height: 1024, width: 1024 };
  return { height: 1344, width: 768 };
}
function getVoiceClient() { if (!voiceClientPromise) voiceClientPromise = Client.connect(VOICE_SPACE); return voiceClientPromise; }
function getImageClient() { if (!imageClientPromise) imageClientPromise = Client.connect(IMAGE_SPACE); return imageClientPromise; }
function getVideoClient() { if (!videoClientPromise) videoClientPromise = Client.connect(VIDEO_SPACE); return videoClientPromise; }
async function synthesizeVoice(inputs) {
  requireReference(); requireConsent();
  showStatus("١/٣ — جاري توليد الصوت من النص…", "VoiceTut-TTS: صوت عربي مصري مستنسخ من العينة المرجعية. قد يتأخر الدور المجاني.");
  const client = await getVoiceClient();
  const file = new File([referenceProfile.blob], "salah-voice-reference.wav", { type: "audio/wav" });
  const result = await client.predict("/synthesize", [
    inputs.narration, "arz", "clone", "", handle_file(file), inputs.referenceText || "",
    inputs.steps, 2.5, inputs.speed, true
  ]);
  const audioUrl = findFileUrl(result && result.data && result.data[0], VOICE_SPACE);
  if (!audioUrl) throw new Error("لم أتمكن من استخراج ملف WAV من رد نموذج الصوت: " + JSON.stringify(result && result.data || result).slice(0, 450));
  return { url: audioUrl, metrics: result && result.data && result.data[1] };
}
async function generateStill(inputs) {
  requireConsent();
  showStatus("٢/٣ — جاري إنشاء صورة المشهد…", "إرسال الوصف إلى Z-Image-Turbo لإنشاء صورة سينمائية.");
  const client = await getImageClient();
  const size = imageDimensions(inputs.aspect);
  const prompt = inputs.visual + "\n\nCreate one unique photorealistic cinematic still frame, matching this scene's story beat and location.";
  const result = await client.predict("/generate_image", [prompt, size.height, size.width, 9, 42, true]);
  const imageUrl = findFileUrl(result && result.data && result.data[0], IMAGE_SPACE);
  if (!imageUrl) throw new Error("لم أستطع استخراج رابط صورة المشهد. رد Z-Image: " + JSON.stringify(result && result.data || result).slice(0, 450));
  return { url: imageUrl, reused: false };
}
function resultCard(tag, label, href) {
  const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.className = "mediaLink"; a.textContent = label; tag.appendChild(a);
}
function showAudioFallback(inputs, audioUrl, errorText) {
  const empty = $("productionResults").querySelector(".empty"); if (empty) empty.remove();
  const card = document.createElement("article"); card.className = "mediaCard";
  const h = document.createElement("h4"); h.textContent = "تم توليد الصوت، لكن الفيديو لم يكتمل";
  const p = document.createElement("p"); p.textContent = errorText;
  const audio = document.createElement("audio"); audio.controls = true; audio.src = audioUrl;
  card.append(h, p, audio); resultCard(card, "فتح / تنزيل الصوت ↗", audioUrl); $("productionResults").prepend(card);
}
function showVideoResult(inputs, audioUrl, videoUrl, imageUrl) {
  const empty = $("productionResults").querySelector(".empty"); if (empty) empty.remove();
  const card = document.createElement("article"); card.className = "mediaCard";
  const h = document.createElement("h4");
  h.textContent = "✓ " + (inputs.scene ? ("المشهد " + (inputs.scene.id || "")) : "مشهد سريع") + " — فيديو ناتج من النموذج";
  const p = document.createElement("p"); p.textContent = "استمع للصوت وراجع الفيديو. الروابط العامة قد تكون مؤقتة؛ نزّل الفيديو فور ظهوره.";
  const video = document.createElement("video"); video.controls = true; video.playsInline = true; video.src = videoUrl;
  const audioLabel = document.createElement("p"); audioLabel.textContent = "ملف الصوت الذي استُخدم لمزامنة حركة الفم:";
  const audio = document.createElement("audio"); audio.controls = true; audio.src = audioUrl;
  card.append(h, p, video, audioLabel, audio);
  resultCard(card, "فتح / تنزيل الفيديو ↗", videoUrl);
  resultCard(card, "فتح ملف الصوت ↗", audioUrl);
  if (imageUrl) resultCard(card, "فتح صورة المشهد ↗", imageUrl);
  $("productionResults").prepend(card);
}
async function createVideoForInputs(inputs) {
  let audio = null;
  try {
    audio = await synthesizeVoice(inputs);
    const referenceImageRecord = $("reuseCharacterImage") && $("reuseCharacterImage").checked ? uploadedCharacterImage : null;
    let image;
    if (referenceImageRecord) {
      showStatus("٢/٣ — استخدام إطار الشخصية الثابت…", "لأن الإطار نفسه سيعاد استخدامه، قد تبقى الخلفية ثابتة بين المشاهد. أوقف خيار التثبيت إذا أردت خلفية جديدة لكل مشهد.");
      image = { blob: referenceImageRecord, url: null };
    } else {
      image = await generateStill(inputs);
    }
    showStatus("٣/٣ — توليد الفيديو ومزامنة الشفاه…", "إرسال صورة المشهد والصوت الناتج إلى Wan 2.2 S2V. قد تستغرق المهمة عدة دقائق.");
    const client = await getVideoClient();
    const imageInput = image.blob
      ? handle_file(new File([image.blob], "salah-character-reference.png", { type: image.blob.type || "image/png" }))
      : handle_file(image.url);
    const videoResult = await client.predict("/predict", [imageInput, handle_file(audio.url), inputs.resolution]);
    const videoUrl = findFileUrl(videoResult && videoResult.data, VIDEO_SPACE);
    if (!videoUrl) throw new Error("عاد نموذج الفيديو دون رابط فيديو قابل للتشغيل. الرد: " + JSON.stringify(videoResult && videoResult.data || videoResult).slice(0, 500));
    showVideoResult(inputs, audio.url, videoUrl, image.url);
    showStatus("اكتمل توليد الفيديو", "أنشأ النموذج فيديو من صورة وصوت. المدة الفعلية تتبع طول الصوت الناتج وليست مضمونة أن تكون 15.00 ثانية بالضبط.", "success");
    return true;
  } catch (error) {
    if (audio && audio.url) showAudioFallback(inputs, audio.url, readableError(error));
    throw error;
  }
}
async function runSingleVideo() {
  if (busy) return;
  try {
    requireConsent(); requireReference();
    const inputs = productionInputs(null);
    setBusy(true);
    await createVideoForInputs(inputs);
  } catch (error) { showStatus("لم يكتمل التوليد", readableError(error), "error"); }
  finally { setBusy(false); }
}
async function runVoiceTest() {
  if (busy) return;
  try {
    requireConsent(); requireReference();
    const inputs = productionInputs(null);
    setBusy(true);
    const audio = await synthesizeVoice(inputs);
    const empty = $("productionResults").querySelector(".empty"); if (empty) empty.remove();
    const card = document.createElement("article"); card.className = "mediaCard";
    const h = document.createElement("h4"); h.textContent = "اختبار الصوت الناتج — VoiceTut-TTS";
    const p = document.createElement("p"); p.textContent = "استمع للنتيجة قبل إنفاق حصة إضافية على توليد الفيديو.";
    const player = document.createElement("audio"); player.controls = true; player.src = audio.url;
    card.append(h, p, player); resultCard(card, "فتح / تنزيل ملف الصوت ↗", audio.url); $("productionResults").prepend(card);
    showStatus("توليد الصوت اكتمل", "راجع النطق ومطابقة نبرة المرجع قبل بدء توليد الفيديو.", "success");
  } catch (error) { showStatus("فشل اختبار الصوت", readableError(error), "error"); }
  finally { setBusy(false); }
}
async function runAllScenes() {
  if (busy) return;
  const scenes = window.SalahWeb && window.SalahWeb.getScenes ? window.SalahWeb.getScenes() : [];
  if (!scenes.length) { showStatus("لا توجد مشاهد", "أنشئ خطة المشاهد من السكريبت أولًا."); return; }
  if (!confirm("سيتم إرسال كل مشهد إلى نماذج خارجية لإنتاج الصوت والصورة والفيديو. قد تنتهي الحصة المجانية قبل اكتمال القصة. هل تريد المتابعة؟")) return;
  try {
    requireConsent(); requireReference();
    setBusy(true);
    let completed = 0;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      $("productionSceneSelect").value = String(i);
      $("productionNarration").value = scene.narration || scene.story || "";
      $("productionVisualPrompt").value = scene.prompt || scene.story || "";
      const inputs = productionInputs(scene);
      showStatus("إنتاج المشهد " + (i + 1) + " / " + scenes.length, "تُعالج المشاهد بالتتابع لتجنّب إرسال دفعة كبيرة في وقت واحد.");
      try { await createVideoForInputs(inputs); completed++; }
      catch (error) {
        showStatus("توقفت الدفعة عند المشهد " + (i + 1), "اكتمل " + completed + " من " + scenes.length + " مشاهد. السبب: " + readableError(error), "error");
        return;
      }
    }
    showStatus("اكتملت الدفعة", "تم إنشاء " + completed + " مقطعًا منفصلًا. نزّلها ثم ادمجها عند الحاجة.", "success");
  } catch (error) { showStatus("تعذر بدء الدفعة", readableError(error), "error"); }
  finally { setBusy(false); }
}
async function refreshSavedMedia() {
  try {
    referenceProfile = await dbGet(VOICE_KEY);
    if (referenceProfile && referenceProfile.blob) {
      $("voiceProfileStatus").textContent = "محفوظة محليًا · " + Number(referenceProfile.duration).toFixed(1) + " ث";
      $("voicePreview").src = URL.createObjectURL(referenceProfile.blob);
      $("voicePreview").classList.remove("hidden");
    }
  } catch (_) {}
  try {
    const saved = await dbGet(imageKey());
    uploadedCharacterImage = saved && saved.blob ? saved.blob : null;
    $("characterImageStatus").textContent = saved ? "محفوظة لهذه القصة · " + (saved.name || "صورة شخصية") : "لا توجد صورة مرجعية محفوظة.";
  } catch (_) {}
}
function setup() {
  wireAudioReference(); wireCharacterImage();
  $("productionSceneSelect").addEventListener("change", populateSceneFields);
  $("testReferenceVoice").addEventListener("click", runVoiceTest);
  $("generateOneScene").addEventListener("click", runSingleVideo);
  $("generateAllScenes").addEventListener("click", runAllScenes);
  refreshSceneOptions();
  const sceneRoot = $("scenes");
  if (sceneRoot && "MutationObserver" in window) new MutationObserver(refreshSceneOptions).observe(sceneRoot, { childList: true, subtree: true });
  if ($("storyList") && "MutationObserver" in window) new MutationObserver(refreshSavedMedia).observe($("storyList"), { childList: true });
}
async function init() {
  setup();
  await refreshSavedMedia();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
