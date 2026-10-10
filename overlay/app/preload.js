// The overlay page's only way to talk to the main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('slop', {
  model: () => ipcRenderer.invoke('model'),
  wasm: () => ipcRenderer.invoke('wasm'),
  settings: () => ipcRenderer.invoke('settings'),
  wallpaper: () => ipcRenderer.invoke('wallpaper'),
  budget: () => ipcRenderer.invoke('budget'),
  onBudget: (cb) => ipcRenderer.on('budget', (_e, lv) => cb(lv)),
  display: () => ipcRenderer.invoke('display'),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  clickable: (on) => ipcRenderer.send('clickable', on),
  status: (s) => ipcRenderer.send('status', s),
  log: (...a) => ipcRenderer.send('log', ...a),
  setPaused: (v) => ipcRenderer.send('set-paused', v),
  quit: () => ipcRenderer.send('quit'),
});
