(() => {
  // extension/src/popup.js
  var $ = (id) => document.getElementById(id);
  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  function renderStatus(s) {
    if (!s) return;
    $("engine").textContent = s.engine === "webgpu" ? "\u26A1 WebGPU" : s.engine === "wasm" ? "\u{1F9EE} WASM" : "\u2026";
    $("model").textContent = s.model || "\u2026";
    $("speed").textContent = s.avgMs ? `${s.avgMs} ms/image` : "\u2013";
    const st = $("status");
    const bar = $("bar");
    if (s.status === "ready") {
      st.textContent = "ready";
      st.className = "v ok";
      bar.style.display = "none";
    } else if (s.status === "downloading") {
      st.textContent = `downloading model ${Math.round((s.progress || 0) * 100)}%`;
      st.className = "v warn";
      bar.style.display = "block";
      $("fill").style.width = `${Math.round((s.progress || 0) * 100)}%`;
    } else if (s.status === "error") {
      st.textContent = s.error || "error";
      st.className = "v bad";
    } else {
      st.textContent = s.status;
      st.className = "v warn";
    }
  }
  async function refreshStats() {
    const tab = await activeTab();
    if (!tab?.id) return;
    try {
      const s = await chrome.tabs.sendMessage(tab.id, { type: "page-stats" });
      if (s?.ok) {
        $("s-total").textContent = s.total;
        $("s-ai").textContent = s.ai;
        $("s-real").textContent = s.real;
        $("s-unsure").textContent = s.unsure;
      }
    } catch {
    }
  }
  async function refreshSiteToggle() {
    const tab = await activeTab();
    const host = tab?.url ? new URL(tab.url).hostname : "";
    const { siteDisabled = {} } = await chrome.storage.local.get("siteDisabled");
    $("toggle-site").textContent = siteDisabled[host] ? `Enable on ${host}` : `Disable on this site`;
    return host;
  }
  $("rescan").onclick = async () => {
    const tab = await activeTab();
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "rescan" }).catch(() => {
    });
    setTimeout(refreshStats, 800);
  };
  $("toggle-site").onclick = async () => {
    const host = await refreshSiteToggle();
    const { siteDisabled = {} } = await chrome.storage.local.get("siteDisabled");
    siteDisabled[host] = !siteDisabled[host];
    if (!siteDisabled[host]) delete siteDisabled[host];
    await chrome.storage.local.set({ siteDisabled });
    const tab = await activeTab();
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "set-enabled", enabled: !siteDisabled[host] }).catch(() => {
    });
    refreshSiteToggle();
  };
  $("open-lab").onclick = () => chrome.runtime.sendMessage({ target: "bg", type: "open-lab" });
  var DEFAULTS = { blurAI: true, strength: "light", sensitivity: "balanced", badges: "flagged", video: true };
  var THR_NOTE = { sensitive: "flags at 50%", balanced: "flags at 65%", strict: "flags at 80%" };
  async function loadPrefs() {
    const { prefs = {}, blurAI } = await chrome.storage.local.get(["prefs", "blurAI"]);
    const p = { ...DEFAULTS, ...prefs };
    if (typeof blurAI === "boolean" && prefs.blurAI === void 0) p.blurAI = blurAI;
    return p;
  }
  function renderPrefs(p) {
    $("p-blur").checked = p.blurAI;
    $("p-video").checked = p.video;
    document.querySelectorAll(".seg").forEach((seg) => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(p[seg.dataset.pref] === b.dataset.v))));
    $("thr-note").textContent = THR_NOTE[p.sensitivity] || "";
  }
  async function savePrefs(change) {
    const p = { ...await loadPrefs(), ...change };
    await chrome.storage.local.set({ prefs: p, blurAI: p.blurAI });
    renderPrefs(p);
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.id != null) chrome.tabs.sendMessage(t.id, { type: "set-prefs", prefs: p }).catch(() => {
    });
    setTimeout(refreshStats, 300);
  }
  $("p-blur").onchange = (e) => savePrefs({ blurAI: e.target.checked });
  $("p-video").onchange = (e) => savePrefs({ video: e.target.checked });
  document.querySelectorAll(".seg").forEach((seg) => seg.querySelectorAll("button").forEach((b) => {
    b.onclick = () => savePrefs({ [seg.dataset.pref]: b.dataset.v });
  }));
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === "broadcast" && msg.type === "engine-status") renderStatus(msg);
  });
  (async function init() {
    refreshSiteToggle();
    renderPrefs(await loadPrefs());
    refreshStats();
    const s = await chrome.runtime.sendMessage({ target: "bg", type: "engine-status" }).catch(() => null);
    renderStatus(s);
    if (!s || s.status === "boot" || s.status === "error") {
      chrome.runtime.sendMessage({ target: "bg", type: "ensure-model" }).then(renderStatus).catch(() => {
      });
    }
    setInterval(refreshStats, 2e3);
  })();
})();
