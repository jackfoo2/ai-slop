// AI Slop Overlay — main process: the see-through window, screen capture permission, tray menu,
// settings, the one-time model download, and a log file.
const { app, BrowserWindow, screen, desktopCapturer, session, Tray, Menu, ipcMain, globalShortcut, nativeImage, shell } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto');

const MODEL = {
  url: 'https://huggingface.co/Vontra/detectra-v1/resolve/d8709d3c39aa69ab862748badce0d4a06e90bf4c/model.onnx',
  sha256: '1414b9aafaa01a644ed706224973f09b53a1388282104409862df9893b1b962b',
};
const DEFAULTS = { paused: false, strength: 'light', sensitivity: 'balanced', video: true, gameGuard: true, showScores: false, readText: true, ignoreWallpaper: true, cpuLimit: 20 };
let settings = { ...DEFAULTS }, win = null, tray = null, gameReason = null, gameClearSince = 0, gameWatcher = null;
let status = { model: 'starting', engine: null, flagged: 0, tracked: 0, fps: 0, error: null };

// ---- log file (send it over if something goes wrong)
const logFile = () => path.join(app.getPath('userData'), 'overlay-log.txt');
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try { fs.mkdirSync(path.dirname(logFile()), { recursive: true }); fs.appendFileSync(logFile(), line); } catch { /* ignore */ }
  if (process.env.SLOP_DEBUG) process.stdout.write(line);
}

// ---- settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...DEFAULTS }; } }
function saveSettings() { try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { log('settings save failed', String(e)); } }
function setSetting(k, v) { settings[k] = v; saveSettings(); if (win && !win.isDestroyed()) win.webContents.send('settings', settings); buildMenu(); if (k === 'gameGuard') applyGameMode(); }

// ---- the detection model: downloaded once, checked, kept
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function modelBytes() {
  if (process.env.SLOP_MODEL) return fs.readFileSync(process.env.SLOP_MODEL); // test builds only
  const file = path.join(app.getPath('userData'), 'models', 'detectra-v3.onnx');
  if (fs.existsSync(file)) { const b = fs.readFileSync(file); if (sha(b) === MODEL.sha256) return b; log('cached model failed its check; downloading again'); }
  setStatus({ model: 'downloading 0%' });
  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 43684258;
  const chunks = []; let got = 0, lastPct = -1;
  for await (const c of res.body) { chunks.push(Buffer.from(c)); got += c.length; const pct = Math.floor((100 * got) / total); if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; setStatus({ model: `downloading ${pct}%` }); } }
  const b = Buffer.concat(chunks);
  if (sha(b) !== MODEL.sha256) throw new Error('downloaded model failed its checksum');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, b);
  log('model downloaded and verified', b.length);
  return b;
}
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
ipcMain.handle('model', async () => { try { return toAB(await modelBytes()); } catch (e) { log('model error', String(e)); setStatus({ model: 'error', error: String(e.message || e) }); throw e; } });
ipcMain.handle('wasm', () => toAB(fs.readFileSync(path.join(__dirname, 'vendor', 'ort', 'ort-wasm-simd-threaded.jsep.wasm'))));
ipcMain.handle('settings', () => settings);
// ---- CPU budget: measure the whole app's CPU (as Task Manager shows it) and step quality down or up
let budgetLevel = 0, cpuAvg = 0, lastLevelChange = 0;
ipcMain.handle('budget', () => budgetLevel);
setInterval(() => {
  let total;
  if (process.env.SLOP_FAKE_CPU_FILE) { try { total = Number(fs.readFileSync(process.env.SLOP_FAKE_CPU_FILE, 'utf8')); } catch { total = 0; } } // tests only
  else { const m = app.getAppMetrics(); total = m.reduce((a, p) => a + ((p.cpu && p.cpu.percentCPUUsage) || 0), 0) / require('os').cpus().length; }
  cpuAvg = cpuAvg ? cpuAvg * 0.6 + total * 0.4 : total;
  const limit = settings.cpuLimit, now = Date.now(); let next = budgetLevel;
  if (limit && cpuAvg > limit && budgetLevel < 4 && now - lastLevelChange > 3000) next++;            // over: step down quickly
  else if ((!limit || cpuAvg < limit * 0.6) && budgetLevel > 0 && now - lastLevelChange > 8000) next--; // lots of room: step back up slowly
  if (next !== budgetLevel) {
    budgetLevel = next; lastLevelChange = now;
    if (win && !win.isDestroyed()) win.webContents.send('budget', budgetLevel);
    log('cpu', { cpu: +cpuAvg.toFixed(1), limit, level: budgetLevel, cores: require('os').cpus().length });
  }
  const shown = Math.round(cpuAvg); if (shown !== status.cpu) { status.cpu = shown; buildMenu(); }
}, 2000);
// the desktop wallpaper: the image Windows is showing, and how it's fitted to the screen
ipcMain.handle('wallpaper', () => {
  try {
    let file = process.env.SLOP_WALLPAPER || '', style = process.env.SLOP_WALLPAPER_STYLE || '10', tile = '0';
    if (!file && process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      const ps = "$k = Get-ItemProperty 'HKCU:\\Control Panel\\Desktop'; $t = Join-Path $env:APPDATA 'Microsoft\\Windows\\Themes\\TranscodedWallpaper'; [Console]::Out.WriteLine((@{ path = [string]$k.WallPaper; style = [string]$k.WallpaperStyle; tile = [string]$k.TileWallpaper; t = $(if (Test-Path $t) { $t } else { '' }) } | ConvertTo-Json -Compress))";
      const o = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }).toString().trim());
      file = o.t || o.path; style = o.style || '10'; tile = o.tile || '0';
    }
    if (!file || !fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    return { bytes: toAB(fs.readFileSync(file)), style: String(style), tile: String(tile), stamp: `${file}:${st.mtimeMs}:${style}:${tile}` };
  } catch (e) { log('wallpaper check failed', String(e?.message || e)); return null; }
});
ipcMain.handle('display', () => { const d = screen.getPrimaryDisplay(); return { width: d.bounds.width, height: d.bounds.height, scale: d.scaleFactor }; });
ipcMain.on('clickable', (_e, on) => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true }); });
ipcMain.on('status', (_e, s) => setStatus(s));
ipcMain.on('set-paused', (_e, v) => setSetting('paused', !!v));
ipcMain.on('quit', () => quitFully());
/** Fully stop: no tray icon, no shortcut key, no window, no background processes left behind. */
function quitFully() {
  log('quitting');
  try { if (gameWatcher) { gameWatcher.kill(); gameWatcher = null; } } catch { /* already gone */ }
  try { globalShortcut.unregisterAll(); } catch { /* already gone */ }
  try { if (tray) { tray.destroy(); tray = null; } } catch { /* already gone */ }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  app.exit(0);
}
ipcMain.on('log', (_e, ...a) => log('[overlay]', ...a));

function setStatus(s) {
  const before = JSON.stringify(status); Object.assign(status, s);
  if (JSON.stringify(status) !== before) { if (s.model || s.engine || s.error) log('status', status); if (tray) { tray.setToolTip(tooltip()); buildMenu(); } }
}
const tooltip = () => `AI Slop Overlay — ${gameReason ? 'off while a game runs' : settings.paused ? 'paused' : status.model === 'ready' ? `${status.flagged} blurred on screen` : status.model}`;

// ---- tray menu
function buildMenu() {
  if (!tray) return;
  const radio = (key, opts) => opts.map(([v, label]) => ({ label, type: 'radio', checked: settings[key] === v, click: () => setSetting(key, v) }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'AI Slop Overlay', enabled: false },
    ...(gameReason ? [{ label: `Off while a game runs: ${gameReason}`, enabled: false }] : []),
    { label: status.model === 'ready' ? `Ready (${status.engine === 'webgpu' ? 'graphics card' : 'processor'}) · ${status.flagged} blurred on screen` : `Model: ${status.model}`, enabled: false },
    { type: 'separator' },
    { label: 'Pause  (Ctrl+Alt+B)', type: 'checkbox', checked: settings.paused, click: () => setSetting('paused', !settings.paused) },
    { label: 'Blur strength', submenu: radio('strength', [['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']]) },
    { label: 'Sensitivity', submenu: radio('sensitivity', [['sensitive', 'Sensitive (flags at 50%)'], ['balanced', 'Balanced (65%)'], ['strict', 'Strict (80%)']]) },
    { label: 'Check videos', type: 'checkbox', checked: settings.video, click: () => setSetting('video', !settings.video) },
    { label: `CPU limit${status.cpu != null ? ` (now ${status.cpu}%)` : ''}`, submenu: [[10, '10%'], [20, '20%'], [35, '35%'], [0, 'No limit']].map(([v, l]) => ({ label: l, type: 'radio', checked: settings.cpuLimit === v, click: () => setSetting('cpuLimit', v) })) },
    { label: 'Turn off during games', type: 'checkbox', checked: settings.gameGuard, click: () => setSetting('gameGuard', !settings.gameGuard) },
    { label: 'Ignore my desktop wallpaper', type: 'checkbox', checked: settings.ignoreWallpaper, click: () => setSetting('ignoreWallpaper', !settings.ignoreWallpaper) },
    { label: 'Read labels and watermarks', type: 'checkbox', checked: settings.readText, click: () => setSetting('readText', !settings.readText) },
    { label: 'Show scores on every picture', type: 'checkbox', checked: settings.showScores, click: () => setSetting('showScores', !settings.showScores) },
    { type: 'separator' },
    { label: 'Open log folder', click: () => shell.openPath(app.getPath('userData')) },
    { label: 'Quit', click: () => quitFully() },
  ]));
}

// ---- the see-through window over the screen
function createOverlay() {
  if (win && !win.isDestroyed()) return;
  const d = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, hasShadow: false, alwaysOnTop: true,
    backgroundColor: '#00000000', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through to whatever is underneath
  win.setContentProtection(true);                    // keep the overlay out of screen captures, including our own
  win.loadFile('overlay.html');
  win.once('ready-to-show', () => { if (!process.env.SLOP_HIDDEN) win.showInactive(); });
  win.webContents.on('render-process-gone', (_e, det) => log('overlay crashed', det));
}
setInterval(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver'); }, 5000);

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (!app.requestSingleInstanceLock()) app.quit();
app.whenReady().then(() => {
  loadSettings();
  log('starting', { version: app.getVersion(), electron: process.versions.electron, os: process.platform, release: require('os').release() });
  // the overlay asks for the screen; hand it the primary display without a picker
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const d = screen.getPrimaryDisplay();
      cb({ video: sources.find((s) => s.display_id === String(d.id)) || sources[0] });
    }).catch((e) => { log('capture source error', String(e)); cb({}); });
  });
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip(tooltip()); buildMenu();
  globalShortcut.register('Control+Alt+B', () => setSetting('paused', !settings.paused));
  createOverlay();
  makeDesktopShortcut();
  startGameWatch();
});

/** Put an "AI Slop Overlay" shortcut on the desktop the first time, and keep it pointing at this copy. */
function makeDesktopShortcut() {
  if (process.platform !== 'win32') return;
  try {
    const lnk = path.join(app.getPath('desktop'), 'AI Slop Overlay.lnk');
    const opts = { target: process.execPath, cwd: path.dirname(process.execPath), description: 'AI Slop Overlay: blurs likely-AI pictures', icon: process.execPath, iconIndex: 0 };
    if (fs.existsSync(lnk)) {
      let target = '';
      try { target = shell.readShortcutLink(lnk).target; } catch { /* unreadable: replace it */ }
      if (target.toLowerCase() !== process.execPath.toLowerCase()) { shell.writeShortcutLink(lnk, 'replace', opts); log('desktop shortcut updated'); }
    } else if (!settings.shortcutMade) {
      shell.writeShortcutLink(lnk, 'create', opts); log('desktop shortcut created');
    }
    if (!settings.shortcutMade) { settings.shortcutMade = true; saveSettings(); } // if you delete it, it stays deleted
  } catch (e) { log('desktop shortcut failed', String(e)); }
}

// opening it again while it's running: just switch it back on
app.on('second-instance', () => { if (settings.paused) setSetting('paused', false); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());

// ---------------------------------------------------------------- games ----
// Anti-cheat software can treat screen capture plus a window on top of the game as suspicious, so
// while a game is running the overlay steps aside completely: no capture, no window. Only the tray
// icon stays. It comes back 10 s after the game is gone.
const ANTI_CHEAT = ['EasyAntiCheat', 'EasyAntiCheat_EOS', 'BEService', 'BEService_x64', 'vgc', 'FACEIT', 'FACEITService',
  'EAAntiCheat.GameServiceLauncher', 'GameMon', 'GameMon64', 'PnkBstrA', 'PnkBstrB', 'SGuard64', 'SGuardSvc64', 'xigncode'];
const AC_NAMES = { easyanticheat: 'Easy Anti-Cheat', easyanticheat_eos: 'Easy Anti-Cheat', beservice: 'BattlEye', beservice_x64: 'BattlEye', vgc: 'Riot Vanguard',
  faceit: 'FACEIT', faceitservice: 'FACEIT', 'eaanticheat.gameservicelauncher': 'EA Anti-Cheat', gamemon: 'GameGuard', gamemon64: 'GameGuard',
  pnkbstra: 'PunkBuster', pnkbstrb: 'PunkBuster', sguard64: 'Tencent ACE', sguardsvc64: 'Tencent ACE', xigncode: 'XIGNCODE' };
const NOT_GAMES = /^(chrome|msedge|firefox|brave|opera|vivaldi|iexplore|vlc|mpc-hc|mpc-hc64|mpv|potplayer|potplayermini|potplayermini64|wmplayer|video\.ui|applicationframehost|explorer|ai slop overlay|electron)$/i;
const GAME_DIRS = /\\(steamapps\\common|epic games|riot games|ea games|origin games|ubisoft game launcher\\games|gog galaxy\\games|xboxgames|rockstar games|roblox\\versions)\\/i;

/** Why the current state counts as "a game is running", or null. o is one reading from the watcher. */
function gameCheck(o) {
  const ac = Array.isArray(o.ac) ? o.ac : o.ac ? [o.ac] : [];
  if (ac.length) return `${AC_NAMES[String(ac[0]).toLowerCase()] || ac[0]} is running`;
  const fg = String(o.fg || '');
  if (o.path && GAME_DIRS.test(String(o.path))) return `${fg}.exe is a game`;
  if (o.quns === 3) return `${fg || 'something'} is running full-screen 3D`;
  if (o.quns === 2 && fg && !NOT_GAMES.test(fg)) return `${fg}.exe is full screen`;
  return null;
}

function onGameReading(o) {
  const why = gameCheck(o), now = Date.now();
  if (why) { gameClearSince = 0; if (gameReason !== why) { const was = gameReason; gameReason = why; if (!was) log('game detected:', why); applyGameMode(); buildMenu(); } return; }
  if (!gameReason) return;
  if (!gameClearSince) gameClearSince = now;
  if (now - gameClearSince >= 10000) { log('game gone, coming back on'); gameReason = null; gameClearSince = 0; applyGameMode(); buildMenu(); }
}

/** Off during games: remove the window entirely (that also ends screen capture). Back on after. */
function applyGameMode() {
  const off = settings.gameGuard && gameReason;
  if (off) { if (win && !win.isDestroyed()) { win.destroy(); win = null; log('overlay removed while a game runs'); } }
  else if (!win || win.isDestroyed()) { createOverlay(); }
  if (tray) tray.setToolTip(tooltip());
}

/** A small helper that reports, every 2 s: the app in front, Windows' full-screen state, and any running anti-cheat. */
function startGameWatch() {
  const { spawn } = require('child_process');
  let cmd, args;
  if (process.env.SLOP_GAME_CMD) { cmd = '/bin/sh'; args = ['-c', process.env.SLOP_GAME_CMD]; } // tests only
  else if (process.platform === 'win32') {
    const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class SlopW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
}
"@
$ac = @(${ANTI_CHEAT.map((n) => `'${n}'`).join(',')})
while ($true) {
  $o = @{ fg = ''; path = ''; quns = -1; ac = @() }
  try { $h = [SlopW]::GetForegroundWindow(); $fpid = 0; [void][SlopW]::GetWindowThreadProcessId($h, [ref]$fpid); $p = Get-Process -Id $fpid -ErrorAction Stop; $o.fg = $p.ProcessName; try { $o.path = $p.Path } catch {} } catch {}
  try { $s = 0; [void][SlopW]::SHQueryUserNotificationState([ref]$s); $o.quns = $s } catch {}
  $o.ac = @(Get-Process -Name $ac -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName } | Select-Object -Unique)
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  Start-Sleep -Milliseconds 2000
}`;
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')];
  } else return; // only Windows has the games we're worried about
  gameWatcher = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', first = true;
  gameWatcher.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const o = JSON.parse(line); if (first) { first = false; log('game check working', o); } onGameReading(o); } catch { /* partial line */ }
    }
  });
  gameWatcher.stderr.on('data', (d) => log('game check error', d.toString().slice(0, 500)));
  gameWatcher.on('exit', (code) => { log('game check stopped', code); gameWatcher = null; setTimeout(startGameWatch, 10000); });
}
module.exports.__gameCheck = gameCheck; // for tests
