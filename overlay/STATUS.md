# AI Slop Overlay: status (v0.2)

A Windows app that watches the screen, finds pictures and videos, runs the same AI-image
detector as the AI Slop Detector extension (Detectra v3, MIT), and draws a light blur with a
"Likely AI · N% · show" chip over likely-AI ones. Your own program: no browser, no store.

## Built
- `src/core.js`: finds pictures from pixels (big, varied, non-background rectangles) and keeps boxes
  glued to them while scrolling (measures each feed column's scroll from the page around the
  pictures, coarse then pixel-exact, several guesses so look-alike feed layouts can't fool it).
- `src/overlay.js`: per frame capture, track, find (every 300 ms, snapping boxes to exact edges),
  score in a worker thread (re-checks every 2.5 s, so videos are covered), blur, chips.
- `src/engine.js` + `src/engine-worker.js`: model runner on its own thread (graphics card via WebGPU,
  processor fallback), same preprocessing and calibration as Detectra.
- `app/main.js`: see-through, click-through, always-on-top window kept out of screen captures; tray
  menu (pause, strength, sensitivity, videos, log folder, quit); Ctrl+Alt+B; settings file; model
  download (pinned, SHA-256 checked); log file (overlay-log.txt in the app's data folder).
- Windows build: `ai-slop-overlay-windows-v0.1.zip` (Electron 44.6.0, win32-x64).

## Tested here
- Vision core on a realistic fake feed captured while scrolling: 93% of pictures found, nothing
  flagged that wasn't a picture; boxes about 1 px off during smooth scrolling; about 10 ms per
  full-screen search and 8 ms per frame of tracking.
- Whole app on a Linux virtual display with a stand-in model: captures the screen, finds the
  pictures, scores them in the worker, marks them for blur; boxes within 2 to 4 px of the pictures.

## Not tested yet (needs Jack's PC)
- Anything Windows-only: see-through click-through window, hiding the overlay from capture, high-DPI.
- The real model's accuracy, and graphics-card speed.
- Real frame rate: the Linux virtual display only delivered about 1 capture a second, so smooth
  tracking at full speed has only been proven on recorded frames, not live.

## Next
1. Jack runs v0.1 and sends overlay-log.txt plus a screenshot of what he sees.
2. Fix whatever Windows turns up; tune blur lag during fast scrolling.
3. Later: multiple monitors, start with Windows, a real icon, code signing.

## v0.2 (after Jack's first run on Windows: "works, but slow to switch on and blurs linger")
- Looks for pictures every 150 ms (was 300) and processes a lighter copy of big screens (at most 1280 px
  wide); still scores pictures from the full-quality capture.
- Blurs drop as soon as tracking is unsure, and any picture two re-scans in a row can't find is removed.
- Picture edges: a row counts as picture only if under 25% background (fixes captions getting included).
- Top-left control bar: On/Off and close. Pushes harder for the graphics card (WebGPU) on startup.
- Logs a speed line every 10 s (frame rate, time per step, engine) for diagnosing on Jack's PC.
- Open question for Jack: what "full screen" should do (all monitors?).

## v0.3
- Desktop shortcut made on first run (Windows); kept pointing at the program if the folder moves;
  not recreated if deleted. Program file has its own icon and name (written with resedit).
- X and tray Quit fully stop the program (tested: no processes left). Opening it again while it's
  running switches it back on.

## v0.4
- Off during games (tray: "Turn off during games", on by default): a PowerShell helper reports every 2 s the
  foreground app, Windows' full-screen state, and running anti-cheat processes. Game = anti-cheat running,
  or foreground app from a game library folder, or full-screen 3D, or a non-browser full-screen app.
  While a game runs, the overlay window is destroyed (screen capture stops); it returns 10 s after.
  Tested on Linux with a scripted feed; the PowerShell helper itself is untested (no Windows here);
  its errors go to the log ("game check error").

## v0.5 (Jack: jumpy while scrolling, misses obvious AI images, wants an X on the blur)
- Drawing runs on its own loop at the screen's refresh rate (backup timer if that stalls), projecting
  each box forward by its speed and the capture's age, with a little extra cover while moving.
- Re-scans only move boxes for real differences (>2 px); pictures partly covered by a sticky bar or the
  screen edge keep their size and get clipped instead of shrinking and growing back.
- A blur survives one uncertain tracking frame (projected forward) instead of flickering off.
- Scores each picture twice (middle crop as trained, plus the whole picture) and keeps the higher.
- X button on every blur; tray "Show scores on every picture" for diagnosing misses.
- Known weak spot: the model is trained mostly on photo-style AI; illustrated/cartoon AI art scores lower.
