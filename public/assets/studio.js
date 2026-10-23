import { Client, handle_file } from "https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";

const SPACE = {
  fusha: "oddadmix/Nabra-82M-Demo",
  egyptian: "mohammedaly22/VoiceTut-TTS",
  english: "mohammedaly22/VoiceTut-TTS",
  image: "mrfakename/Z-Image-Turbo",
  video: "Wan-AI/Wan2.2-S2V"
};
const ORIGIN = {
  fusha: "https://oddadmix-nabra-82m-demo.hf.space",
  egyptian: "https://mohammedaly22-voicetut-tts.hf.space",
  english: "https://mohammedaly22-voicetut-tts.hf.space",
  image: "https://mrfakename-z-image-turbo.hf.space",
  video: "https://wan-ai-wan2-2-s2v.hf.space"
};
const STORE_KEY = "salah-studio-projects-v1";
const ACTIVE_KEY = "salah-studio-active-project-v1";
const $ = function(id) { return document.getElementById(id); };
let projects = [];
let activeId = null;
let busy = false;
let voiceClientCache = {};
let imageClient = null;
let videoClient = null;
let ffmpeg = null;
let finalObjectUrl = null;
let activeClips = [];
let activeScenes = [];
const cardByScene = new Map();

function makeId() {
  return "story-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}
function defaultSettings() {
  return {
    language: "fusha",
    aspect: "9:16",
    resolution: "480P",
    style: "cinematic",
    duration: "2",
    speed: "1",
    characters: "",
    arabic: true,
    periodClothes: true,
    religiousRule: true
  };
}
function activeProject() {
  return projects.find(function(p) { return p.id === activeId; }) || null;
}
function settingsFromPage() {
  return {
    language: $("language").value,
    aspect: $("aspect").value,
    resolution: $("resolution").value,
    style: $("style").value,
    duration: $("duration").value || "2",
    speed: $("speed").value || "1",
    characters: $("characters").value || "",
    arabic: $("arabic").checked,
    periodClothes: $("periodClothes").checked,
    religiousRule: $("religiousRule").checked
  };
}
function applySettings(s) {
  s = s || defaultSettings();
  ["language","aspect","resolution","style","duration","speed"].forEach(function(id) {
    if (s[id] !== undefined && $(id)) $(id).value = s[id];
  });
  $("characters").value = s.characters || "";
  $("arabic").checked = s.arabic !== false;
  $("periodClothes").checked = s.periodClothes !== false;
  $("religiousRule").checked = s.religiousRule !== false;
  updateScenePreview();
}
function pageTitle(script) {
  const line = String(script || "").split(/\r?\n/).map(function(s) { return s.trim(); }).find(Boolean) || "";
  if (!line) return "قصة جديدة";
  return line.length > 36 ? line.slice(0, 36) + "…" : line;
}
function saveProjects() {
  try {
    projects.sort(function(a,b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if (projects.length > 30) projects = projects.slice(0, 30);
    localStorage.setItem(STORE_KEY, JSON.stringify(projects));
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  } catch (_) {}
}
function saveCurrentProject() {
  const p = activeProject();
  if (!p) return;
  p.script = $("script").value || "";
  p.title = pageTitle(p.script);
  p.characterDescription = $("characters").value || "";
  p.settings = settingsFromPage();
  p.updatedAt = Date.now();
  saveProjects();
  renderHistory();
}
function createProject() {
  return {
    id: makeId(),
    title: "قصة جديدة",
    script: "",
    characterDescription: "",
    settings: defaultSettings(),
    status: "draft",
    progress: 0,
    stage: "",
    sceneCount: 0,
    currentScene: 0,
    clips: [],
    segments: [],
    finalUrl: "",
    statusTitle: "",
    statusDetail: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}
function statusLabel(status) {
  return {
    draft: "مسودة",
    running: "قيد التنفيذ",
    partial: "نتائج جزئية",
    failed: "توقّف",
    completed: "مكتمل"
  }[status] || "مسودة";
}
function renderHistory() {
  const root = $("history");
  if (!root) return;
  root.replaceChildren();
  if (!projects.length) {
    const e = document.createElement("p");
    e.className = "empty-history";
    e.textContent = "ابدأ قصة جديدة، وستظهر مشاريعك هنا.";
    root.appendChild(e);
    return;
  }
  projects.slice().sort(function(a,b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).forEach(function(p) {
    const b = document.createElement("button");
    b.className = "history-item" + (p.id === activeId ? " active" : "");
    b.type = "button";
    b.disabled = busy;
    const t = document.createElement("strong");
    t.textContent = p.title || "قصة جديدة";
    const m = document.createElement("span");
    m.textContent = statusLabel(p.status) + (p.status === "running" || p.status === "partial" ? " · " + (p.progress || 0) + "%" : "");
    b.append(t,m);
    b.addEventListener("click", function() { switchProject(p.id); });
    root.appendChild(b);
  });
}
function status(title, detail, kind) {
  $("statusBox").classList.remove("hidden");
  $("statusTitle").textContent = title;
  $("statusDetail").textContent = detail || "";
  $("statusTitle").classList.toggle("bad", kind === "error");
  $("statusTitle").classList.toggle("good", kind === "success");
  const p = activeProject();
  if (p) {
    p.statusTitle = title;
    p.statusDetail = detail || "";
    if (kind === "error") p.status = p.clips.some(function(c) { return !!c.videoUrl; }) ? "partial" : "failed";
    if (kind === "success") p.status = "completed";
    p.updatedAt = Date.now();
    saveProjects();
    renderHistory();
  }
}
function setProgress(percent, label) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  $("progress").value = value;
  $("progressLabel").textContent = Math.round(value) + "% — " + (label || "");
  const p = activeProject();
  if (p) {
    p.progress = Math.round(value);
    p.updatedAt = Date.now();
    saveProjects();
  }
}
function setBusy(value) {
  busy = value;
  $("createVideo").disabled = value;
  $("newProject").disabled = value;
  $("createVideo").textContent = value ? "جاري الإنتاج…" : "أنشئ الفيديو الكامل";
  renderHistory();
}
function clearResults() {
  $("results").replaceChildren();
  $("finalArea").classList.add("hidden");
  $("finalVideo").pause();
  $("finalVideo").removeAttribute("src");
  $("finalVideo").load();
  $("finalVideo").classList.add("hidden");
  $("downloadFinal").classList.add("hidden");
  if (finalObjectUrl) URL.revokeObjectURL(finalObjectUrl);
  finalObjectUrl = null;
  activeClips = [];
  activeScenes = [];
  cardByScene.clear();
}
function switchProject(id) {
  if (busy || id === activeId) return;
  saveCurrentProject();
  const p = projects.find(function(x) { return x.id === id; });
  if (!p) return;
  activeId = id;
  if (p.status === "running") {
    p.status = "partial";
    p.statusTitle = "توقف الإنتاج السابق";
    p.statusDetail = "تم حفظ النص والنتائج المكتملة. طلبات النماذج المعلقة لا تواصل العمل بعد إغلاق الصفحة.";
  }
  $("script").value = p.script || "";
  applySettings(p.settings || defaultSettings());
  clearResults();
  (p.clips || []).forEach(function(c) {
    activeClips.push(c);
    drawClip(c);
  });
  if (p.statusTitle) {
    $("statusBox").classList.remove("hidden");
    $("statusTitle").textContent = p.statusTitle;
    $("statusDetail").textContent = p.statusDetail || "";
    $("statusTitle").classList.toggle("bad", p.status === "failed" || p.status === "partial");
    $("statusTitle").classList.toggle("good", p.status === "completed");
  } else {
    $("statusBox").classList.add("hidden");
  }
  setProgress(p.progress || 0, p.status === "draft" ? "جاهز لبدء التوليد" : "آخر حالة محفوظة");
  if (p.finalUrl) {
    $("finalVideo").src = p.finalUrl;
    $("finalVideo").classList.remove("hidden");
    $("downloadFinal").href = p.finalUrl;
    $("downloadFinal").classList.remove("hidden");
    $("finalArea").classList.remove("hidden");
  }
  saveProjects();
  renderHistory();
  updateScenePreview();
}
function newProject() {
  if (busy) return;
  saveCurrentProject();
  const p = createProject();
  projects.unshift(p);
  activeId = p.id;
  $("script").value = "";
  applySettings(p.settings);
  clearResults();
  $("statusBox").classList.add("hidden");
  setProgress(0, "قصة جديدة");
  saveProjects();
  renderHistory();
  $("script").focus();
}
function findAssetUrl(value, space, depth) {
  depth = depth || 0;
  if (value == null || depth > 10) return null;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("/")) return ORIGIN[space] + value;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i=0;i<value.length;i++) {
      const v = findAssetUrl(value[i], space, depth+1);
      if (v) return v;
    }
    return null;
  }
  if (typeof value === "object") {
    const keys = ["url","video_url","audio_url","image_url","path"];
    for (let i=0;i<keys.length;i++) {
      const v = findAssetUrl(value[keys[i]], space, depth+1);
      if (v) return v;
    }
    const nested = ["data","files","file","output","result","audio","video","image","images"];
    for (let i=0;i<nested.length;i++) {
      const v = findAssetUrl(value[nested[i]], space, depth+1);
      if (v) return v;
    }
  }
  return null;
}
function clientForVoice(language) {
  if (!voiceClientCache[language]) {
    const space = language === "fusha" ? SPACE.fusha : SPACE[language];
    const origin = language === "fusha" ? ORIGIN.fusha : ORIGIN[language];
    voiceClientCache[language] = Client.connect(origin).catch(function(err) {
      voiceClientCache[language] = null;
      throw err;
    });
  }
  return voiceClientCache[language];
}
function clientForImage() {
  if (!imageClient) imageClient = Client.connect(ORIGIN.image).catch(function(err) { imageClient=null; throw err; });
  return imageClient;
}
function clientForVideo() {
  if (!videoClient) videoClient = Client.connect(ORIGIN.video).catch(function(err) { videoClient=null; throw err; });
  return videoClient;
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise(function(_, reject) {
      timer = setTimeout(function() {
        reject(new Error("تجاوزت مرحلة " + label + " المهلة المحددة. قد تكون الخدمة مزدحمة أو غير متاحة."));
      }, ms);
    })
  ]).finally(function() { clearTimeout(timer); });
}
function describeError(err) {
  const raw = String((err && err.message) || err || "خطأ غير معروف");
  if (/ZeroGPU.*limit|exceeded your ZeroGPU runs limit|429|rate limit|quota/i.test(raw)) {
    return "الحصة المجانية لخدمة الذكاء الاصطناعي وصلت لحدها. انتظر تجدد الحصة أو جرّب لاحقًا؛ تسجيل الدخول لا يضمن إزالة حد ZeroGPU. التفاصيل: " + raw.slice(0,400);
  }
  if (/Space metadata could not be loaded/i.test(raw)) {
    return "لم تُحمّل واجهة النموذج. الخدمة العامة قد تكون نائمة أو متوقفة، أو تغيّر عنوانها. التفاصيل: " + raw.slice(0,400);
  }
  if (/DashScope|API key|Authorization|401|403/i.test(raw)) {
    return "خدمة الفيديو الخلفية رفضت الطلب أو استنفدت حصتها. هذه النسخة من خدمة Wan تعتمد على DashScope خارج Hugging Face؛ توكن Hugging Face لا يرفع حدها. التفاصيل: " + raw.slice(0,400);
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
    return "تعذر الاتصال بالخدمة. تحقق من الإنترنت أو من حالة النموذج. التفاصيل: " + raw.slice(0,400);
  }
  return raw.slice(0,700);
}
function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}
function sentenceUnits(text, maxWords) {
  const normalized = String(text || "").replace(/\s+/g," ").trim();
  if (!normalized) return [];
  const sentences = normalized.split(/(?<=[.!?؟…؛])\s+/).filter(Boolean);
  const units = [];
  sentences.forEach(function(sentence) {
    const clauses = sentence.split(/(?<=،)\s*/).filter(Boolean);
    clauses.forEach(function(clause) {
      let current = [];
      const words = clause.split(/\s+/).filter(Boolean);
      words.forEach(function(w) {
        current.push(w);
        if (current.length >= maxWords) {
          units.push(current.join(" "));
          current = [];
        }
      });
      if (current.length) units.push(current.join(" "));
    });
  });
  return units;
}
function splitUnitsIntoScenes(text, maxWords) {
  const units = sentenceUnits(text, maxWords || 23);
  const scenes = [];
  let buffer = [];
  let count = 0;
  units.forEach(function(unit) {
    const n = wordCount(unit);
    if (buffer.length && (count + n > (maxWords || 23) || buffer.join(" ").length + unit.length > 1400)) {
      scenes.push(buffer.join(" ").trim());
      buffer = [];
      count = 0;
    }
    buffer.push(unit);
    count += n;
  });
  if (buffer.length) scenes.push(buffer.join(" ").trim());
  return scenes;
}
function visualPrompt(part, index, total, language) {
  const styleMap = {
    cinematic: "photorealistic live-action cinema, natural human skin texture, physically plausible lighting, shallow depth of field",
    historical: "photorealistic historical drama, authentic period architecture, woven cloth texture, no modern objects",
    horror: "serious atmospheric horror film, realistic shadows, restrained dread, cinematic low-key lighting",
    spiritual: "reverent Islamic atmosphere, dignified and solemn framing, subtle warm light, respectful composition",
    documentary: "photorealistic documentary cinematography, natural light, believable camera placement"
  };
  const s = activeProject().settings || defaultSettings();
  const rules = [];
  rules.push("SINGLE FRAME ONLY. One continuous photograph-like cinematic shot, one location, one moment in time.");
  rules.push("Do not make a collage, triptych, storyboard, comic, diptych, contact sheet, split-screen, multiple panels, grid, sequence of frames, repeated characters, image strips, borders or picture-in-picture.");
  rules.push("One main visual event, one camera angle, full frame composed for vertical " + s.aspect + " video. No text, no subtitles, no watermark, no labels.");
  if (s.arabic) rules.push("All human characters are Arab; natural Arab facial features and culturally accurate environment.");
  if (s.periodClothes) rules.push("If the story is historical, use authentic period Arab clothing and props, no modern objects.");
  if (s.religiousRule) rules.push("If a prophet, messenger, or companion is depicted, respectfully show a dignified sheikh-like figure whose entire face is pure radiant light with no facial features.");
  if (s.characters) rules.push("Character continuity description — keep the identity, apparent age, skin tone, face, hair, beard and clothing consistent across every scene: " + s.characters);
  rules.push("Visual style: " + (styleMap[s.style] || styleMap.cinematic) + ".");
  rules.push("Story beat to portray in this single frame: " + part);
  rules.push("This is scene " + (index+1) + " of " + total + ". Do not show the other scenes; do not create a sequence or montage.");
  return rules.join(" ");
}
function planTextSegments(text) {
  const s = activeProject() ? (activeProject().settings || defaultSettings()) : defaultSettings();
  const words = wordCount(text);
  const targetScenes = Math.max(1, Math.round(Number(s.duration || 2) * 4));
  // Approximate 15-second scenes while preserving the whole script.
  // Longer scripts may need more scenes than the target duration can reasonably fit.
  const wordsPerScene = Math.max(8, Math.min(38, Math.ceil(words / targetScenes)));
  return splitUnitsIntoScenes(text, wordsPerScene);
}
function buildScenePlan(text) {
  const pieces = planTextSegments(text);
  if (pieces.length > 120) throw new Error("القصة طويلة جدًا لإنشاء 120 مشهدًا أو أقل في عملية واحدة. قسّم القصة إلى مشروعين أقصر.");
  const s = activeProject().settings || defaultSettings();
  return pieces.map(function(part, i) {
    return {
      id:i+1,
      narration:part,
      visual:visualPrompt(part,i,pieces.length,s.language),
      stage:"لم يبدأ",
      audioUrl:null,
      imageUrl:null,
      videoUrl:null,
      error:null
    };
  });
}
function updateScenePreview() {
  const root = $("scenePreview");
  if (!root) return;
  const text = $("script").value.trim();
  if (!text) {
    root.textContent = "اكتب القصة لتظهر معاينة عدد المشاهد. سيُقسّم النص تلقائيًا قبل بدء الإنتاج.";
    return;
  }
  const pieces = planTextSegments(text);
  const count = pieces.length;
  const longest = pieces.reduce(function(max,p) { return Math.max(max,p.length); }, 0);
  const actualMin = Math.round(wordCount(text) / 145 * 10) / 10;
  const desiredMin = Number($("duration").value || 2);
  root.textContent = "معاينة تلقائية: " + count + " مشهدًا · أطول مقطع " + longest + " حرفًا · المدة التقريبية للكلام " + actualMin + " دقيقة مقابل هدف " + desiredMin + " دقيقة. سيُحفظ النص بترتيبه دون حذف. قد تختلف مدة الفيديو الفعلية حسب النطق والزمن الذي تنتجه خدمة الفيديو.";
}
function renderLink(root, url, label) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = label;
  root.appendChild(a);
}
function drawClip(clip) {
  let card = cardByScene.get(clip.id);
  if (!card) {
    card = document.createElement("article");
    card.className = "result-card";
    card.id = "scene-" + clip.id;
    cardByScene.set(clip.id,card);
    const next = Array.from($("results").children).find(function(el) {
      return Number((el.id || "").replace("scene-","")) > clip.id;
    });
    if (next) $("results").insertBefore(card,next); else $("results").appendChild(card);
  }
  card.replaceChildren();
  const h = document.createElement("h3");
  h.textContent = "المشهد " + clip.id + " — " + (clip.stage || "قيد الإنتاج");
  card.appendChild(h);
  const script = document.createElement("p");
  script.className = "scene-script";
  script.textContent = (clip.narration || "").length > 300 ? clip.narration.slice(0,300) + "…" : (clip.narration || "");
  script.title = clip.narration || "";
  card.appendChild(script);
  if (clip.imageUrl) {
    const img = document.createElement("img");
    img.className = "scene-image";
    img.src = clip.imageUrl;
    img.alt = "إطار المشهد " + clip.id;
    card.appendChild(img);
  }
  if (clip.audioUrl) {
    const audioLabel = document.createElement("div");
    audioLabel.className = "asset-label";
    audioLabel.textContent = "الصوت";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = clip.audioUrl;
    card.append(audioLabel,audio);
  }
  if (clip.videoUrl) {
    const videoLabel = document.createElement("div");
    videoLabel.className = "asset-label";
    videoLabel.textContent = "الفيديو";
    const video = document.createElement("video");
    video.controls = true; video.playsInline = true; video.preload = "metadata"; video.src = clip.videoUrl;
    const links = document.createElement("div"); links.className = "result-links";
    renderLink(links,clip.videoUrl,"فتح / تنزيل الفيديو");
    renderLink(links,clip.audioUrl,"فتح الصوت");
    card.append(videoLabel,video,links);
  }
  if (clip.error) {
    const err = document.createElement("p");
    err.className = "scene-error";
    err.textContent = clip.error;
    card.appendChild(err);
  }
}
function updateClip(scene, patch) {
  let c = activeClips.find(function(x) { return x.id === scene.id; });
  if (!c) {
    c = { id:scene.id, narration:scene.narration, stage:"في الانتظار", audioUrl:null, imageUrl:null, videoUrl:null, error:null };
    activeClips.push(c);
  }
  Object.assign(c,patch || {});
  drawClip(c);
  const p = activeProject();
  if (p) {
    p.clips = activeClips.map(function(x) { return {
      id:x.id,narration:x.narration,stage:x.stage,audioUrl:x.audioUrl||null,imageUrl:x.imageUrl||null,
      videoUrl:x.videoUrl||null,error:x.error||null
    };});
    saveProjects();
  }
}
async function createNarration(scene, language, speed) {
  status("المشهد " + scene.id + " — جاري توليد الصوت", language === "fusha"
    ? "صوت عربي فصيح عبر Nabra، النموذج المخصص للفصحى."
    : language === "egyptian" ? "صوت باللهجة المصرية عبر VoiceTut-TTS." : "صوت إنجليزي عبر VoiceTut-TTS.");
  let client, result, url;
  if (language === "fusha") {
    client = await withTimeout(clientForVoice("fusha"),45000,"الاتصال بنموذج الفصحى");
    result = await withTimeout(client.predict("/synthesize",[scene.narration,Number(speed||1)]),180000,"توليد الصوت بالفصحى");
    url = findAssetUrl(result && result.data && result.data[0],"fusha");
  } else {
    const lang = language === "english" ? "en" : "arz";
    client = await withTimeout(clientForVoice(language),45000,"الاتصال بنموذج الصوت");
    result = await withTimeout(client.predict("/synthesize",[scene.narration,lang,"preset","Ahmed",null,"",32,2.0,Number(speed||1),true]),180000,"توليد الصوت");
    url = findAssetUrl(result && result.data && result.data[0],language);
  }
  if (!url) throw new Error("خدمة الصوت لم تُرجع ملفًا صوتيًا قابلًا للتشغيل.");
  return url;
}
async function createHordeStill(scene, dimensions) {
  const base = "https://aihorde.net/api/v2";
  status("المشهد " + scene.id + " — بديل الصور المجتمعي المجاني",
    "حصة مولد الصور الأساسي غير متاحة؛ أُرسل طلب صورة واحدة إلى AI Horde. الطلب المجهول قد يُشارك علنًا وقد يحتاج وقت انتظار طويلًا.");
  const submit = await fetch(base + "/generate/async", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": "0000000000",
      "Client-Agent": "SalahWeb:1.0:github.com/salah-aser/dagger-xy"
    },
    body: JSON.stringify({
      prompt: scene.visual + "### collage, triptych, diptych, storyboard, comic panels, split screen, multiple frames, image grid, repeated people, text, watermark, logos",
      params: {
        n: 1,
        width: dimensions.w,
        height: dimensions.h,
        steps: 20,
        cfg_scale: 7,
        sampler_name: "k_euler_a"
      },
      nsfw: false,
      censor_nsfw: true,
      r2: true,
      shared: false
    })
  });
  if (!submit.ok) {
    let detail = "";
    try { detail = (await submit.json()).message || ""; } catch (_) {}
    throw new Error("بديل AI Horde رفض الطلب (HTTP " + submit.status + "). " + detail);
  }
  const accepted = await submit.json();
  if (!accepted.id) throw new Error("بديل الصور لم يُرجع رقم طلب.");
  const jobId = accepted.id;
  const deadline = Date.now() + 8 * 60 * 1000;
  let lastQueue = "";
  while (Date.now() < deadline) {
    await new Promise(function(resolve) { setTimeout(resolve, 5000); });
    const check = await fetch(base + "/generate/check/" + encodeURIComponent(jobId), {
      headers: {"Client-Agent":"SalahWeb:1.0:github.com/salah-aser/dagger-xy"}
    });
    if (!check.ok) throw new Error("تعذر متابعة طلب AI Horde (HTTP " + check.status + ").");
    const progress = await check.json();
    const queue = progress.queue_position;
    if (queue !== undefined && String(queue) !== lastQueue) {
      lastQueue = String(queue);
      status("المشهد " + scene.id + " — انتظار صورة مجانية",
        "بديل المجتمع: " + (progress.waiting !== undefined ? progress.waiting + " طلبًا في الانتظار" : "الطلب في قائمة الانتظار") +
        (queue !== undefined ? " · موقعك التقريبي في الصف " + queue : "") +
        ". يظل وقت الانتظار حسب توفر أجهزة المتطوعين.");
    }
    if (progress.faulted) throw new Error("تعطل طلب AI Horde. جرّب لاحقًا أو عطّل البديل المجتمعي.");
    if (progress.done) {
      const resultResponse = await fetch(base + "/generate/status/" + encodeURIComponent(jobId), {
        headers: {"Client-Agent":"SalahWeb:1.0:github.com/salah-aser/dagger-xy"}
      });
      if (!resultResponse.ok) throw new Error("تعذر استلام نتيجة AI Horde (HTTP " + resultResponse.status + ").");
      const result = await resultResponse.json();
      const item = result.generations && result.generations[0];
      const url = item && (item.img || item.url);
      if (!url || typeof url !== "string") throw new Error("اكتمل طلب AI Horde من دون رابط صورة.");
      return url;
    }
  }
  throw new Error("بديل الصور ظل في الانتظار أكثر من 8 دقائق. لم يُعاد إرسال الطلب تلقائيًا حتى لا نصنع طلبات مكررة.");
}
async function createStill(scene, index, total) {
  status("المشهد " + scene.id + " — جاري توليد صورة واحدة", "سيُرسل وصف المشهد مع تعليمات صريحة تمنع الكولاج واللوحات المتعددة.");
  const params = $("aspect").value === "16:9" ? {h:768,w:1344}
    : $("aspect").value === "1:1" ? {h:512,w:512} : {h:512,w:768};
  const seed = 1000 + scene.id * 37;
  try {
    const client = await withTimeout(clientForImage(),45000,"الاتصال بنموذج الصور");
    const result = await withTimeout(client.predict("/generate_image",[scene.visual,params.h,params.w,9,seed,true]),240000,"توليد الصورة");
    const url = findAssetUrl(result && result.data && result.data[0],"image");
    if (!url) throw new Error("نموذج الصور لم يُرجع صورة صالحة.");
    return url;
  } catch (err) {
    const raw = String((err && err.message) || err || "");
    if (!/ZeroGPU|runs limit|quota|exceeded|429|rate limit|Space metadata could not be loaded/i.test(raw)) throw err;
    if (!$("communityImageFallback") || !$("communityImageFallback").checked) {
      throw new Error("حصة مولد الصور المجاني انتهت. لو كانت قصتك عامة وغير سرية، فعّل خيار «السماح ببديل الصور المجتمعي المجاني» ثم أعد المحاولة. لم يُرسل النص إلى بديل عام. التفاصيل: " + raw.slice(0,250));
    }
    return await createHordeStill(scene, params);
  }
}
async function createMotion(scene,imageUrl,audioUrl) {
  status("المشهد " + scene.id + " — تحريك الصورة وربطها بالصوت", "خدمة Wan2.2-S2V تحرك صورة مرجعية بناءً على الصوت. زمن الخدمة وحدودها خارج سيطرة الموقع.");
  const client = await withTimeout(clientForVideo(),45000,"الاتصال بخدمة الفيديو");
  const result = await withTimeout(client.predict("/predict",[await handle_file(imageUrl),await handle_file(audioUrl),$("resolution").value]),360000,"توليد الفيديو");
  const url = findAssetUrl(result && result.data,"video");
  if (!url) throw new Error("خدمة الفيديو لم تُرجع ملف فيديو قابلًا للتشغيل.");
  return url;
}
function updatePhaseProgress(scene, stageIndex, state, detail, patch) {
  const labels = ["الصوت","الصورة","الفيديو"];
  const total = Math.max(1, activeScenes.length * 3);
  const doneThis = stageIndex + (state === "done" ? 1 : 0);
  const done = (scene.id-1)*3 + doneThis;
  const pct = Math.floor(90*done/total);
  const thisPct = Math.round(100*doneThis/3);
  const stage = labels[stageIndex];
  updateClip(scene,Object.assign({stage:state === "working" ? "جاري " + stage : "اكتمل " + stage, error:null},patch||{}));
  setProgress(pct,"المشهد " + scene.id + "/" + activeScenes.length + " · " + thisPct + "% · مراحل مكتملة " + done + "/" + total);
  status("المشهد " + scene.id + " من " + activeScenes.length + " — " +
    (state === "working" ? "جاري " + stage + "…" : "اكتمل " + stage),
    detail + "\nتقدم المشهد: " + thisPct + "% · تقدم القصة: " + pct + "%\nالنسبة محسوبة من المراحل المنجزة؛ النموذج لا يرسل نسبة داخلية دقيقة أثناء الانتظار.");
  const p = activeProject();
  if (p) {
    p.status = "running"; p.currentScene = scene.id; p.stage = stage; p.sceneCount = activeScenes.length;
    p.segments = activeScenes.map(function(x) { return {id:x.id,narration:x.narration};});
    p.updatedAt = Date.now(); saveProjects();
  }
}
async function loadFfmpeg() {
  if (ffmpeg) return ffmpeg;
  const mod = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js");
  const util = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js");
  ffmpeg = new mod.FFmpeg();
  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
  await ffmpeg.load({
    coreURL: await util.toBlobURL(base + "/ffmpeg-core.js","text/javascript"),
    wasmURL: await util.toBlobURL(base + "/ffmpeg-core.wasm","application/wasm")
  });
  return ffmpeg;
}
async function downloadBlob(url,label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("تعذّر تنزيل " + label + " (HTTP " + r.status + ").");
  return await r.blob();
}
async function mergeFinal(clips) {
  status("المشاهد اكتملت — جاري دمج الفيديو النهائي","يُجهّز الموقع ملف MP4 واحد. إن منع مزود الخدمة تنزيل المقاطع، ستظل المقاطع الفردية متاحة.");
  const engine = await loadFfmpeg();
  const ratio = $("aspect").value;
  const quality = $("resolution").value;
  const dims = ratio === "16:9" ? (quality === "720P" ? [1280,720] : [854,480])
    : ratio === "1:1" ? (quality === "720P" ? [720,720] : [480,480])
    : (quality === "720P" ? [720,1280] : [480,854]);
  const list = [];
  for (let i=0;i<clips.length;i++) {
    const c = clips[i];
    setProgress(90+Math.floor(8*i/clips.length),"دمج المقطع " + (i+1) + "/" + clips.length);
    status("تجهيز الملف النهائي — " + (i+1) + "/" + clips.length,"تحميل الفيديو والصوت وتوحيد القياس والترميز.");
    const vb = await downloadBlob(c.videoUrl,"الفيديو");
    const ab = await downloadBlob(c.audioUrl,"الصوت");
    const iv = "v"+i+".mp4", ia = "a"+i+".wav", ov = "s"+i+".mp4";
    await engine.writeFile(iv,new Uint8Array(await vb.arrayBuffer()));
    await engine.writeFile(ia,new Uint8Array(await ab.arrayBuffer()));
    const w=dims[0],h=dims[1];
    const filter="[0:v]fps=24,scale="+w+":"+h+":force_original_aspect_ratio=decrease,pad="+w+":"+h+":(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,tpad=stop_mode=clone:stop_duration=30[v]";
    await engine.exec(["-i",iv,"-i",ia,"-filter_complex",filter,"-map","[v]","-map","1:a:0","-c:v","libx264","-preset","ultrafast","-crf","27","-pix_fmt","yuv420p","-c:a","aac","-b:a","128k","-shortest","-movflags","+faststart",ov]);
    await engine.deleteFile(iv); await engine.deleteFile(ia);
    list.push("file '"+ov+"'");
  }
  await engine.writeFile("list.txt",new TextEncoder().encode(list.join("\n")+"\n"));
  await engine.exec(["-f","concat","-safe","0","-i","list.txt","-c","copy","-movflags","+faststart","Salah-Web-Story.mp4"]);
  const bytes=await engine.readFile("Salah-Web-Story.mp4");
  const blob=new Blob([bytes],{type:"video/mp4"});
  if (!blob.size) throw new Error("ملف الدمج النهائي فارغ.");
  return blob;
}
function showFinal(blob) {
  if (finalObjectUrl) URL.revokeObjectURL(finalObjectUrl);
  finalObjectUrl=URL.createObjectURL(blob);
  $("finalVideo").src=finalObjectUrl;
  $("finalVideo").classList.remove("hidden");
  $("downloadFinal").href=finalObjectUrl;
  $("downloadFinal").download="Salah-Web-Story.mp4";
  $("downloadFinal").classList.remove("hidden");
  $("finalArea").classList.remove("hidden");
  $("finalInfo").textContent="ملف MP4 واحد · الحجم " + (blob.size/1048576).toFixed(1) + " ميجابايت.";
}
async function createFullVideo() {
  if (busy) return;
  const script = $("script").value.trim();
  if (script.length < 20) { status("اكتب القصة أولًا","أدخل السكريبت أو القصة كاملة قبل إنشاء الفيديو.","error"); return; }
  if (script.length > 30000) { status("النص طويل جدًا","الحد الحالي 30 ألف حرف لكل مشروع لتجنب طلبات ضخمة تفشل منتصف الإنتاج.","error"); return; }
  if (!activeProject()) { const p=createProject(); projects.unshift(p); activeId=p.id; }
  saveCurrentProject();
  const p=activeProject();
  setBusy(true);
  clearResults();
  p.status="running";p.progress=0;p.clips=[];p.finalUrl="";p.statusTitle="بدأ الإنتاج";
  p.statusDetail="يقسم السكريبت تلقائيًا ثم يولد الصوت والصورة والفيديو لكل مشهد.";
  const scenes=buildScenePlan(script);
  activeScenes=scenes;
  p.sceneCount=scenes.length;
  p.segments=scenes.map(function(s){return {id:s.id,narration:s.narration};});
  saveProjects();renderHistory();
  if (!scenes.length) { setBusy(false);status("لم يتم العثور على مشاهد","أدخل نصًا يحتوي على كلام.");return; }
  setProgress(0,"تقسيم القصة إلى " + scenes.length + " مشهدًا");
  status("بدأ إنشاء الفيديو","عدد المشاهد: " + scenes.length + ". الخطوات لكل مشهد: صوت ← صورة واحدة ← فيديو. ستظهر النتائج فور اكتمال كل مرحلة.");
  let current=null,phase=0;
  try {
    for (const scene of scenes) {
      current=scene; phase=0;
      updatePhaseProgress(scene,0,"working","توليد صوت المشهد.");
      const audioUrl=await createNarration(scene,p.settings.language,p.settings.speed);
      scene.audioUrl=audioUrl;
      updatePhaseProgress(scene,0,"done","اكتمل الصوت؛ جارٍ إنشاء الصورة.",{audioUrl:audioUrl,stage:"اكتمل الصوت"});
      phase=1;
      updatePhaseProgress(scene,1,"working","إنشاء إطار واحد فقط لهذا المشهد. لا يتم طلب لوحة مشاهد.");
      const imageUrl=await createStill(scene,scene.id-1,scenes.length);
      scene.imageUrl=imageUrl;
      updatePhaseProgress(scene,1,"done","اكتملت صورة المشهد؛ جارٍ تحريكها مع الصوت.",{audioUrl:audioUrl,imageUrl:imageUrl,stage:"اكتمل الصوت والصورة"});
      phase=2;
      updatePhaseProgress(scene,2,"working","تحريك الصورة ومزامنة حركة الرأس والفم مع الصوت.");
      const videoUrl=await createMotion(scene,imageUrl,audioUrl);
      scene.videoUrl=videoUrl;scene.stage="اكتمل الفيديو";
      const c=updateClip(scene,{audioUrl:audioUrl,imageUrl:imageUrl,videoUrl:videoUrl,stage:"جاهز للتنزيل",error:null});
      updatePhaseProgress(scene,2,"done","اكتمل هذا المشهد وهو متاح الآن قبل بدء المشهد التالي.",{audioUrl:audioUrl,imageUrl:imageUrl,videoUrl:videoUrl,stage:"اكتمل الفيديو"});
      drawClip(c);
    }
    setProgress(90,"اكتملت جميع المشاهد · تجهيز ملف MP4");
    const finalBlob=await mergeFinal(activeClips);
    showFinal(finalBlob);
    setProgress(100,"اكتمل الفيديو النهائي");
    p.status="completed";p.progress=100;p.statusTitle="الفيديو الكامل جاهز";p.statusDetail="اكتملت المشاهد وتم دمجها في ملف واحد.";p.completedAt=Date.now();saveProjects();
    status("الفيديو الكامل جاهز ✓","تم دمج " + scenes.length + " مشهدًا في ملف MP4 واحد. يمكنك تنزيله الآن.","success");
  } catch (e) {
    const message=describeError(e);
    if (current) {
      current.error=message;current.stage="توقف عند " + ["الصوت","الصورة","الفيديو"][phase];
      updateClip(current,{stage:current.stage,error:message,audioUrl:current.audioUrl,imageUrl:current.imageUrl,videoUrl:current.videoUrl});
    }
    const done=activeClips.filter(function(c){return !!c.videoUrl;}).length;
    p.status=done ? "partial" : "failed";
    p.statusTitle="توقف الإنتاج عند المشهد " + (current ? current.id : "?");
    p.statusDetail="اكتمل " + done + " من " + scenes.length + " مشاهد فيديو. السبب: " + message;
    saveProjects();
    status(p.statusTitle,p.statusDetail,"error");
  } finally {
    setBusy(false);
    saveCurrentProject();
    renderHistory();
  }
}
function init() {
  try { projects=JSON.parse(localStorage.getItem(STORE_KEY)||"[]"); } catch (_) { projects=[]; }
  if (!Array.isArray(projects)) projects=[];
  projects=projects.filter(function(p){return p&&p.id;});
  projects.forEach(function(p){if(p.status==="running"){p.status="partial";p.statusTitle="توقف الإنتاج سابقًا";p.statusDetail="تم حفظ نتائج المشاهد التي اكتملت قبل مغادرة الصفحة."; }});
  let saved="";
  try { saved=localStorage.getItem(ACTIVE_KEY)||""; } catch (_) {}
  if (!projects.length) { const p=createProject();projects=[p];activeId=p.id; }
  else activeId=projects.some(function(p){return p.id===saved;}) ? saved : projects[0].id;
  const active=activeProject();
  $("script").value=active.script||"";
  applySettings(active.settings||defaultSettings());
  (active.clips||[]).forEach(function(c){activeClips.push(c);drawClip(c);});
  if(active.statusTitle){$("statusBox").classList.remove("hidden");$("statusTitle").textContent=active.statusTitle;$("statusDetail").textContent=active.statusDetail||"";}
  saveProjects();renderHistory();
  $("newProject").addEventListener("click",newProject);
  $("createVideo").addEventListener("click",createFullVideo);
  $("script").addEventListener("input",function(){updateScenePreview();saveCurrentProject();});
  $("characters").addEventListener("input",saveCurrentProject);
  ["language","aspect","resolution","style","duration","speed","arabic","periodClothes","religiousRule","communityImageFallback"].forEach(function(id){
    $(id).addEventListener("change",function(){saveCurrentProject();updateScenePreview();});
  });
  updateScenePreview();
  setProgress(active.progress||0,active.statusTitle||"جاهز");
  setBusy(false);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",init,{once:true});
else init();
