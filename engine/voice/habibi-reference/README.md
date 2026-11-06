# Private Habibi voice reference

Copy these two user-owned files into this folder on your local machine:

- `voice_reference.wav` — the short reference recording (about 11 seconds).
- `voice_reference.txt` — the exact transcript that matches that recording.

These files are ignored by Git and must not be committed. The API mounts this directory read-only into the local Salah Cloud container and sends the audio to the Habibi Gradio endpoint at `/basic_tts`.

The Habibi host must be running locally with `--host 0.0.0.0 --port 7860`. Do not enable Gradio's public `--share` option.
