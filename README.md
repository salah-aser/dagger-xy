# Salah Web — AI Story Studio

A browser-hosted Arabic storyboard planning interface deployed with GitHub Pages.

## Live website
https://salah-aser.github.io/dagger-xy/

## What works in the current version
- Arabic RTL responsive UI and slideshow hero.
- Separate story workspaces persisted in the current browser via localStorage.
- Script word-count and estimated narration-time helper.
- Choose a target runtime; scene plan is split into 15-second slots.
- Sequential script segmentation, prompt drafting, Arabic/historical styling rules, and per-story character notes.
- Browser speech synthesis preview (voice availability depends on the visitor's browser/OS).
- Export storyboard prompts as TXT/JSON.

## Important limitations
This is currently a **storyboard and prompt-planning web app**, not an end-to-end generative video service. It does not yet generate cinematic video files, downloadable studio-quality Arabic narration, or real lip-sync output. Those features require a hosted inference backend and model/compute resources. GitHub Pages serves static web files only; it does not run a persistent Python/GPU process.

No API key or paid service is required for the currently implemented planning features. Browser speech synthesis may use voices provided by the operating system/browser and is not guaranteed to be available offline or to sound the same on every device. There is no promise of unlimited, lifetime-free hosted AI inference.

## Deployment
The workflow at `.github/workflows/salah-web-pages.yml` deploys `public/` to GitHub Pages when the site or workflow changes on `main`. The repository must have GitHub Pages configured to use GitHub Actions.
