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

## v0.6 (Jack: only one blur at a time; scrolling back cancels the blur)
- Bug: pictures that arrived while the two scoring slots were busy were skipped and never retried.
  Now any unscored picture retries every frame, up to 4 at once. Tested: 6-picture grid, all 6 blurred.
- Memory of scrolled-past pictures: the tracker also measures overall page scroll (a band down the middle
  of the screen, works between pictures; exact to the pixel over 2,550 px of recorded scrolling). Each
  scored picture is remembered by its position on the page; when it comes back it re-blurs at once and is
  re-checked a second later. Tested: down 600 px and back, all re-blurred.

## v0.7 (Jack: folder of AI pictures as extra-large icons: only ~2 of 8 per row blurred; hover clears the blur)
- Packed pictures (thumbnail grids, galleries) merged into one blob. Now each blob is cut apart wherever a
  clean full-height or full-width strip of background runs through it. Explorer-style test page: old finder
  3 of 7 per row, new finder 7 of 7 (21 of 21).
- Hover highlight (light blue behind a thumbnail) made the picture unrecognizable to re-scans, which then
  dropped it. Now a bigger shape around a known picture counts as that picture, and a blur is only dropped
  if the pixels inside it actually changed. Tested: highlight held on two thumbnails, blurs stayed.

## v0.8 (Jack: many test pictures have plain white or black backgrounds, a blind spot)
- Pictures whose background matches the page (white on white, black on black) only show their subject, an
  odd-shaped blob, which the rectangle-only finder threw out (0 of 21 found). Now big, genuinely colorful
  blobs count as pictures too (text, logos and icons are two-tone, so they don't). Found 17 of 21 on both
  white and black test pages; misses are tall thin product shots at thumbnail size. No stray boxes; the
  feed and folder tests are unchanged.
- Decided against "unnatural plain background" as an AI signal: real product photos, stock and clipart have
  it too.

## v0.9: reading labels and watermarks (offline OCR, Tesseract.js, Apache-2.0)
- Each picture, once it sits still, gets read: top and bottom strips inside it (watermarks) and the area
  around it, stopping at neighboring pictures (name row, caption, strip below: site labels and hashtags).
- Watermark phrases and tool names (short names only as whole words inside the picture); label phrases and
  AI hashtags around it; forgiving of misread letters; ambiguous words (gemini, runway) left out.
- A hit blurs regardless of the model score (watermark counts as 97%, label 90%); the tag shows the reason.
- Test: six posts with dark "real-looking" pictures; the four with "AI info", #aiart, "Imagined with AI" and
  "KLING AI" blurred, the two normal posts left alone. An early version read the neighbor post's watermark
  from the area above a picture; fixed by stopping at neighboring pictures.
- Speed: about 1.2 s per text area on the test machine (about 5 s per picture); runs one picture at a time in
  the background, so it never delays the detector's blur.

## v0.10 (Jack: his AI-made desktop wallpaper got blurred)
- Asks Windows for the wallpaper image (TranscodedWallpaper) and its fit (fill, fit, stretch, center, tile,
  span), draws it the way Windows lays it out, and treats screen pixels that match it as background when
  looking for pictures. The wallpaper never becomes a "picture", however many windows cover it; the same image
  shown elsewhere (in a browser) doesn't line up and is still checked. Re-checks the wallpaper every 2 minutes.
- Tested on a virtual desktop with a bright wallpaper and a browser window over half of it: switch off, the
  wallpaper was blurred; switch on, it wasn't, and both pictures in the browser (one the same image as the
  wallpaper) still were. First attempt failed: it compared whole regions, and windows covering the desktop
  dragged the match below the line; matching pixel by pixel fixed it.
- Tray: "Ignore my desktop wallpaper" (on by default).

## v0.11 (Jack: opening Task Manager over the picture folder left blur boxes blurring patches of Task Manager)
- Cause: the hover-highlight rule ("a bigger shape around a known picture is that picture") also matched a
  window opened on top, so old boxes stayed and blurred the window.
- Now every frame, still pictures are checked as a 32x32 grid of color samples: mostly covered pictures lose
  their blur at once; partly covered ones are blurred only on the cells still showing the picture. A bigger
  shape counts as the picture only if the picture's pixels are unchanged; a box whose outline really changed is
  replaced. When the window closes, blurs come back instantly and grow back to full size (only if the extra
  area is more picture, not a flat highlight or a file name). "Video" (same outline, changing pixels) is only
  judged while still, since scrolling shifts pixels too.
- Test: Explorer-style folder with a dark Task Manager stand-in: blur on the window 61% -> 0.1% while open
  (also after scrolling), fully restored after closing. Hover, grid scrolling, labels, wallpaper, cut-outs and
  feed tests all unchanged.

## v0.12 (Jack: cap CPU around 20%, move load to the graphics card)
- Still screen: a 64x36 copy scaled on the graphics card shows whether anything changed; if not, all the work is
  skipped (a full check still runs every 2 s). The quarter-size tracking copy is also scaled on the graphics card,
  from the same frame as the full-detail copy (taking it from the live video gave mismatched frames and broke the
  scroll measurement: 53 px drift; fixed, exact again).
- CPU limit (tray: 10/20/35%/none, default 20%): the main process sums the app's CPU every 2 s (as Task Manager
  shows it) and moves between 5 levels: frames per second 30/20/15/10/6, re-scans every 150 ms to 1.2 s, text
  reading on / only when the screen is still / off, two views per picture or one. Steps down quickly, up slowly.
- Still pictures are scored twice and then left alone; only videos keep getting re-checked. Pictures are never
  scored while something covers them (a covered score had dragged one picture's average under the line).
  Unscored pictures go before second looks.
- Tests: still screen mostly skipped, governor steps 0->4 at faked 50% and back at 5%; Task Manager (0.0-0.3% on
  the window, all back after), hover, grid scrolling, labels, wallpaper all pass.
- Already on the graphics card when WebGPU works: the AI model, capture, drawing the blur. Text reading has no
  graphics-card version; at higher CPU levels it only runs while the screen is still, or not at all.
