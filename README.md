# AI Slop

**Notice AI-generated pictures and videos while you scroll.** AI Slop lightly blurs images that look AI-made and
labels them ("Likely AI · 87% · show"), so they stand out in your feed instead of passing as real. One click shows the
picture clearly. Everything runs on your own computer: no account, no cloud, and nothing you look at ever leaves the
machine.

It's a nudge, not a wall: the blur is deliberately light (you can still make out the picture), and you decide.

## Two versions

| | What it is | Works on |
| --- | --- | --- |
| [`overlay/`](overlay) | **AI Slop Overlay** (v0.20): a Windows app that works over *anything* on screen: any browser, Discord, image viewers, File Explorer thumbnails. | Windows 10 (2004+) / 11, 64-bit |
| [`extension/`](extension) | **AI Slop Detector** (v0.2): a browser extension that works inside web pages. | Chrome, Edge, Brave (loaded unpacked) |

Both use the same detector.

## What it does

- **Finds pictures and videos on screen** (the overlay reads the screen itself, so it works anywhere), keeps the blur
  glued to them while you scroll, and re-checks videos every few seconds.
- **Scores each one** with an AI-image detection model and blurs the likely-AI ones. Sensitivity is adjustable
  (Sensitive 50%, Balanced 65%, Strict 80%).
- **Reads labels and watermarks** in and around a picture ("Imagined with AI", "KLING AI", "Sora", "AI info",
  #aiart, #midjourney...): a match blurs it whatever the detector thought, and the tag says why.
- **Splits collages** (a grid of pictures made into one) and checks each panel.
- **Learns from you:** every tag has **+** (right) and **−** (wrong); your call sticks to that picture. You can also
  type a sentence ("anything like this is AI", "stop blurring in Discord", "too many false alarms") and it acts on it,
  with Undo. Common wordings are understood instantly; anything else goes to a small language model that runs on your
  PC (downloaded once, then offline).
- **Stays out of the way:** turns itself off completely while a game runs (anti-cheat detected, a game-store app in
  front, or a full-screen non-browser app) and comes back after; leaves your own desktop wallpaper alone; keeps its
  CPU use under a limit you choose (20% by default) and does almost nothing while the screen is still.
- **Controls:** On / Off and ⚙ settings in the top-left corner, Ctrl+Alt+B, a tray menu, and an X on every blur.

## Privacy

- The pictures on your screen are checked **on your computer only**. Nothing is uploaded or sent anywhere.
- The only downloads: the detection model (once, about 44 MB, a pinned version checked against a fixed SHA-256 hash)
  and, only if you use the type-a-sentence feature, the small language model (once, about 480 MB: Qwen2.5-0.5B-Instruct,
  the onnx-community conversion on Hugging Face).
- Your ratings and notes are saved on your PC (tray > "Open ratings folder"), nowhere else.
- The overlay is kept out of screenshots on purpose, so it never ends up in what you share.

## Good to know

- **It's a strong guess, not proof.** Some AI pictures get through and some real ones get flagged. It's best at
  photo-style AI images; illustrated or cartoon AI art scores lower, and real photos that were only AI-edited usually
  pass.
- The overlay works on the main monitor for now.
- It's an early, personal project: Windows may warn that the app is from an unknown publisher (it isn't code-signed
  yet): "More info" > "Run anyway".

## Getting it

- **Windows app:** build it (below) or use a release zip, unzip it somewhere it can stay (e.g. Documents), and run
  `AI Slop Overlay.exe`. Full instructions: [`overlay/HOW-TO-USE.txt`](overlay/HOW-TO-USE.txt). What changed in each
  version: [`overlay/STATUS.md`](overlay/STATUS.md).
- **Browser extension:** `chrome://extensions` > Developer mode > Load unpacked > the `extension` folder. Full
  instructions: [`extension/HOW-TO-INSTALL.txt`](extension/HOW-TO-INSTALL.txt).

### Building the Windows app

```
cd overlay && sh build-windows.sh
```

Needs Node.js, curl and zip. Produces `AI-Slop-Overlay-windows.zip` (Electron, win32-x64).

## How it works (short version)

The overlay captures the screen several times a second, finds picture-shaped regions from the pixels (big, varied,
non-background rectangles), tracks them as the page scrolls, and sends each one to a detection model running in its own
thread (graphics card through WebGPU when available, otherwise the processor). Likely-AI pictures get a light blur and
a tag drawn in a click-through, see-through window on top. A text reader (OCR) looks for AI labels and watermarks
around each picture. Code: `overlay/src/` (core.js finds and tracks pictures, overlay.js draws, engine.js runs the
model, ocr.js reads labels, feedback.js handles your ratings and sentences).

## Credits

- Detection model (Detectra v3) and the extension's base: [Detectra](https://github.com/ashhart/Detectra) by ashhart,
  MIT license (`extension/LICENSE`).
- Electron, ONNX Runtime Web: MIT licenses. Tesseract.js (the label and watermark reader) and Transformers.js:
  Apache-2.0. Qwen2.5-0.5B-Instruct (optional, downloaded at runtime): Apache-2.0.

## License

**MIT** (see [`LICENSE`](LICENSE)): free to use, change, share or build on, including commercially. This is a side
project with no plans to market or sell it, so anyone who wants to pick it up and carry it further is welcome to.
The third-party parts keep their own licenses (listed in `LICENSE`).
