# AI Slop

Blurs pictures and videos that look AI-generated, lightly, so you notice them while you scroll.
Everything runs on your own computer: no cloud, and nothing leaves the machine except a one-time
download of the detection model.

Two versions:

| Folder | What it is |
| --- | --- |
| `overlay/` | **AI Slop Overlay**, a Windows app that works over anything on screen (any browser, any app). Watches the screen, finds pictures, blurs likely-AI ones with a "Likely AI · N% · show" chip. On/Off and close in the top-left corner, desktop icon, steps aside completely while games run. See `overlay/HOW-TO-USE.txt` and `overlay/STATUS.md`. |
| `extension/` | **AI Slop Detector**, a Chrome/Edge/Brave extension (built, load it unpacked). Same detector, works inside web pages. See `extension/HOW-TO-INSTALL.txt`. |

## Building the Windows app
`cd overlay && sh build-windows.sh` (needs Node.js, curl, zip). Produces `AI-Slop-Overlay-windows.zip`.

## Credits
- Detection model and the extension's base: [Detectra](https://github.com/ashhart/Detectra) by ashhart, MIT license (`extension/LICENSE`).
- Electron (MIT), ONNX Runtime Web (MIT).

Everything else: © 2026 Jack Hagman. All rights reserved (see `LICENSE`).
