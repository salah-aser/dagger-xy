# Salah Web — AI Story Studio

Live site: https://salah-aser.github.io/dagger-xy/

Salah Web is a browser-hosted Arabic story planner with an experimental, opt-in connection to public Hugging Face inference demos.

## Story planning
- Arabic RTL interface with cinematic slideshow design.
- Each story gets its own title, script, character descriptions, and scene plan, stored in the current browser.
- Analyze word count and estimated narration time; split a script in order into 15-second storyboard cards.
- Build visual prompts with optional character and Arab/historical/religious setting guidelines.
- Export storyboard and prompts as TXT or JSON.

## Experimental voice and video generation
In the "توليد الصوت والفيديو فعليًا" section:
1. Choose your original WAV/MP3 voice clip.
2. Crop an 8–15 second reference sample in the browser and save it locally.
3. Enter the words to speak and the visual prompt (or select a scene from the storyboard).
4. Check the external processing consent box and test voice first.
5. Start one scene, or run the scene queue sequentially.

The browser sends only the cropped voice reference clip to the VoiceTut-TTS Hugging Face Space for Arabic/Egyptian-Arabic voice cloning. A prompt-to-image demo creates scene imagery when required, and the Wan2.2-S2V public demo is called with the image plus synthesized audio to generate a speech-driven video clip. The current implementation uses these public spaces:
- mohammedaly22/VoiceTut-TTS
- mrfakename/Z-Image-Turbo
- Wan-AI/Wan2.2-S2V

## Important limitations
- These are public third-party inference demos. They may be sleeping, queued, changed, restricted, or unavailable. Their GPU quotas are limited; usage is not guaranteed to be unlimited or free forever.
- Browser audio cloning is experimental; output can differ from the reference voice and pronunciation quality needs to be judged using the “test voice” button before producing videos.
- VoiceTut-TTS is tuned primarily for Egyptian Arabic (language code arz), not a dedicated Modern Standard Arabic narration model. Formal Arabic may sound Egyptian or differ from the original reading style.
- Wan2.2-S2V produces output length based largely on the generated speech audio, so exactly 15.00 seconds is not guaranteed. Each storyboard slot is 15 seconds, but narration text must fit the target runtime.
- A saved character image can be reused as the exact video frame. This preserves the face/frame better but also keeps its background fixed. Generating fresh scene images gives changing locations but does not guarantee identical character identity.
- Generated result URLs may be temporary: download completed video and audio outputs promptly.
- GitHub Pages hosts only the static frontend. The app does not run its own GPU server, and your ASUS GTX 1050 is not used for cloud inference.
- The reference audio and character images are stored in IndexedDB in the browser and are not committed to this public GitHub repository. They are sent to external inference providers only after the page's consent checkbox is selected and a generation request is started.

## Deploy
GitHub Actions publishes public/ using .github/workflows/salah-web-pages.yml.
