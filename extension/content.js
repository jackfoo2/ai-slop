(() => {
  // extension/src/content.js
  var MIN_NATURAL = 64;
  var MIN_DISPLAY = 40;
  var MIN_SCAN = 100;
  var REAL_THRESHOLD = 0.35;
  var THRESH = { sensitive: 0.5, balanced: 0.65, strict: 0.8 };
  var BLUR_RANGE = { light: [3, 9], medium: [6, 16], strong: [10, 24] };
  var prefs = { blurAI: true, strength: "light", sensitivity: "balanced", badges: "flagged", video: true };
  var thr = () => THRESH[prefs.sensitivity] ?? 0.65;
  function blurPx(p) {
    const t = thr(), [lo, hi] = BLUR_RANGE[prefs.strength] || BLUR_RANGE.light;
    const k = Math.min(1, Math.max(0, (p - t) / (1 - t)));
    return Math.round(lo + (hi - lo) * k);
  }
  var tracked = /* @__PURE__ */ new Map();
  var recId = 0;
  var byUrl = /* @__PURE__ */ new Map();
  var overlayRoot = null;
  var enabled = true;
  var rafPending = false;
  function ensureOverlay() {
    if (overlayRoot) return overlayRoot;
    const host = document.createElement("detectra-overlay");
    host.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;";
    overlayRoot = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = BADGE_CSS;
    overlayRoot.appendChild(style);
    document.documentElement.appendChild(host);
    return overlayRoot;
  }
  function makeBadge(rec) {
    const root = ensureOverlay();
    const el = document.createElement("div");
    el.className = "badge scanning";
    el.innerHTML = `<span class="dot"></span><span class="txt">scanning</span>`;
    el.addEventListener("mouseenter", () => showPanel(rec));
    el.addEventListener("mouseleave", () => hidePanel());
    root.appendChild(el);
    return el;
  }
  function labelFor(p) {
    if (p >= thr()) return ["ai", `AI ${Math.round(p * 100)}%`];
    if (p <= REAL_THRESHOLD) return ["real", `Real ${Math.round((1 - p) * 100)}%`];
    return ["unsure", `Unsure ${Math.round(p * 100)}%`];
  }
  function ensureBadge(rec) {
    if (!rec.badge) rec.badge = makeBadge(rec);
    return rec.badge;
  }
  function dropBadge(rec) {
    rec.badge?.remove();
    rec.badge = null;
  }
  function paintBadge(rec) {
    if (rec.status === "done") {
      const flagged = rec.result.p >= thr();
      const chipShowing = flagged && prefs.blurAI && !rec.revealed && !rec.isBg;
      if (prefs.badges === "all" || flagged && !chipShowing) {
        const el = ensureBadge(rec);
        const [cls, txt] = labelFor(rec.result.p);
        el.className = `badge ${cls}`;
        el.querySelector(".txt").textContent = txt;
      } else dropBadge(rec);
      applyBlur(rec);
    } else if (rec.status === "error") {
      if (prefs.badges === "all") {
        const el = ensureBadge(rec);
        el.className = "badge err";
        el.querySelector(".txt").textContent = "\u2013";
        el.title = rec.error || "analysis failed";
      } else dropBadge(rec);
    } else if (prefs.badges === "all") ensureBadge(rec);
    else dropBadge(rec);
    rec.img.setAttribute("data-slop-badge", rec.badge ? "1" : "0");
    position(rec);
  }
  function applyBlur(rec) {
    if (rec.isBg) return;
    const p = rec.result ? rec.result.p : 0;
    const shouldBlur = prefs.blurAI && !rec.revealed && rec.result && p >= thr();
    if (shouldBlur) {
      if (!rec.blurred) {
        rec.prevFilter = rec.img.style.filter || "";
        rec.blurred = true;
      }
      const px = blurPx(p);
      rec.img.style.setProperty("filter", `blur(${px}px) saturate(.85)`, "important");
      rec.img.setAttribute("data-slop-blur", String(px));
      if (!rec.reveal) {
        const chip = document.createElement("div");
        chip.className = "reveal";
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          rec.revealed = true;
          hidePanel();
          paintBadge(rec);
        });
        chip.addEventListener("mouseenter", () => showPanel(rec));
        chip.addEventListener("mouseleave", () => hidePanel());
        ensureOverlay().appendChild(chip);
        rec.reveal = chip;
      }
      rec.reveal.textContent = `Likely AI \xB7 ${Math.round(p * 100)}% \xB7 show`;
      rec.img.setAttribute("data-slop-chip", "1");
      positionReveal(rec);
    } else if (rec.blurred) {
      rec.img.style.setProperty("filter", rec.prevFilter);
      if (!rec.prevFilter) rec.img.style.removeProperty("filter");
      rec.blurred = false;
      rec.reveal?.remove();
      rec.reveal = null;
      rec.img.removeAttribute("data-slop-blur");
      rec.img.removeAttribute("data-slop-chip");
    }
  }
  function positionReveal(rec) {
    if (!rec.reveal) return;
    const r = rec.img.getBoundingClientRect();
    const visible = r.width >= MIN_DISPLAY && r.bottom > 0 && r.top < innerHeight && rec.img.isConnected;
    rec.reveal.style.display = visible ? "flex" : "none";
    if (!visible) return;
    rec.reveal.style.transform = `translate(${r.left + scrollX + 8}px, ${r.top + scrollY + 8}px)`;
  }
  function position(rec) {
    const r = rec.img.getBoundingClientRect();
    const el = rec.badge;
    if (!el) return;
    const visible = enabled && r.width >= MIN_DISPLAY && r.height >= MIN_DISPLAY && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && rec.img.isConnected;
    el.style.display = visible ? "flex" : "none";
    if (!visible) return;
    el.style.transform = `translate(${r.right + scrollX - el.offsetWidth - 6}px, ${r.top + scrollY + 6}px)`;
  }
  function repositionAll() {
    rafPending = false;
    for (const rec of tracked.values()) {
      position(rec);
      positionReveal(rec);
    }
  }
  function scheduleReposition() {
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(repositionAll);
    }
  }
  var panelEl = null;
  var heatEl = null;
  async function showHeatmap(rec) {
    if (rec.isVideo || rec.heat === "pending") return;
    if (!rec.heat) {
      rec.heat = "pending";
      try {
        const payload = rec.url.startsWith("blob:") ? {} : { url: rec.url };
        if (!payload.url) return;
        const res = await chrome.runtime.sendMessage({ target: "bg", type: "explain", ...payload });
        rec.heat = res?.ok ? res : null;
      } catch {
        rec.heat = null;
      }
    }
    if (!rec.heat || rec.heat === "pending" || !panelEl || panelEl.dataset.for !== String(rec.id)) return;
    const r = rec.img.getBoundingClientRect();
    heatEl = document.createElement("div");
    heatEl.className = "heat";
    heatEl.style.transform = `translate(${r.left + scrollX}px, ${r.top + scrollY}px)`;
    heatEl.style.width = `${r.width}px`;
    heatEl.style.height = `${r.height}px`;
    const n = rec.heat.n;
    heatEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    for (const p of rec.heat.grid) {
      const cell = document.createElement("div");
      const alpha = Math.abs(p - 0.5) * 0.7;
      cell.style.background = p >= 0.5 ? `rgba(244,63,94,${alpha})` : `rgba(52,211,153,${alpha})`;
      heatEl.appendChild(cell);
    }
    ensureOverlay().appendChild(heatEl);
  }
  function showPanel(rec) {
    if (!rec.result) return;
    const root = ensureOverlay();
    hidePanel();
    const { p, pRaw, signals = [], engine, ms, model, cached } = rec.result;
    panelEl = document.createElement("div");
    panelEl.className = "panel";
    const rows = signals.map(
      (s) => `<div class="sig ${s.kind}"><span class="k">${s.kind === "ai" ? "\u26A0" : s.kind === "real" ? "\u2713" : "\u2139"}</span><div><b>${esc(s.label)}</b><small>${esc(s.detail || "")}</small></div></div>`
    ).join("");
    panelEl.innerHTML = `
    <div class="ph"><b>Detectra forensics</b><span>${esc(model || "")}</span></div>
    <div class="meter"><div class="fill" style="width:${Math.round(p * 100)}%"></div></div>
    <div class="pr"><span>AI likelihood</span><b>${(p * 100).toFixed(1)}%</b></div>
    <div class="pr sub"><span>neural net (uncalibrated)</span><span>${(pRaw * 100).toFixed(1)}%</span></div>
    ${rows || '<div class="sig info"><span class="k">\u2139</span><div><b>No provenance metadata</b><small>verdict from pixel analysis alone</small></div></div>'}
    <div class="pf">${engine === "webgpu" ? "\u26A1 WebGPU" : "\u{1F9EE} WASM"} \xB7 ${cached ? "cached" : `${ms}ms`} \xB7 on-device</div>`;
    panelEl.dataset.for = String(rec.id);
    root.appendChild(panelEl);
    showHeatmap(rec);
    const r = rec.img.getBoundingClientRect();
    const x = Math.min(r.right + scrollX - 280, scrollX + innerWidth - 296);
    panelEl.style.transform = `translate(${Math.max(scrollX + 8, x)}px, ${r.top + scrollY + 34}px)`;
  }
  function hidePanel() {
    panelEl?.remove();
    panelEl = null;
    heatEl?.remove();
    heatEl = null;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }
  async function analyzeRecord(rec) {
    rec.status = "analyzing";
    const url = rec.url;
    try {
      let payload;
      if (url.startsWith("blob:")) {
        const blob = await (await fetch(url)).blob();
        if (blob.size > 20 * 1024 * 1024) throw new Error("image too large");
        payload = { dataUrl: await blobToDataUrl(blob) };
      } else {
        payload = { url };
      }
      const res = byUrl.get(url) ?? await chrome.runtime.sendMessage({ target: "bg", type: "analyze", ...payload });
      if (!res?.ok) throw new Error(res?.error || "no response");
      byUrl.set(url, res);
      rec.result = res;
      rec.status = "done";
      rec.img.setAttribute("data-detectra-score", res.p.toFixed(4));
      rec.img.setAttribute("data-detectra-verdict", res.p >= thr() ? "ai" : "real");
      if (typeof res.logit === "number") rec.img.setAttribute("data-detectra-logit", res.logit.toFixed(4));
    } catch (e) {
      rec.status = "error";
      rec.error = String(e?.message || e);
      rec.img.setAttribute("data-detectra-error", rec.error);
    }
    paintBadge(rec);
  }
  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }
  function consider(img) {
    if (tracked.has(img)) return;
    const start = () => {
      if (tracked.has(img)) return;
      if (img.naturalWidth < MIN_NATURAL || img.naturalHeight < MIN_NATURAL) return;
      const shown = img.getBoundingClientRect();
      if (shown.width < MIN_SCAN || shown.height < MIN_SCAN) return;
      const url = img.currentSrc || img.src;
      if (!url || url.startsWith("chrome")) return;
      const rec = { img, url, id: ++recId, status: "pending", result: null, badge: null, heat: null };
      tracked.set(img, rec);
      if (prefs.badges === "all") rec.badge = makeBadge(rec);
      position(rec);
      const cached = byUrl.get(url);
      if (cached) {
        rec.result = cached;
        rec.status = "done";
        paintBadge(rec);
      } else {
        analyzeRecord(rec);
      }
    };
    if (img.complete && img.naturalWidth > 0) start();
    else img.addEventListener("load", start, { once: true });
  }
  function* allImages(root = document) {
    const walker = root.querySelectorAll ? root.querySelectorAll("*") : [];
    if (root === document) yield* document.images;
    for (const el of walker) {
      if (el.shadowRoot) {
        for (const img of el.shadowRoot.querySelectorAll("img")) yield img;
        yield* allImages(el.shadowRoot);
      }
    }
  }
  var bgChecked = /* @__PURE__ */ new WeakSet();
  function scanBackgrounds() {
    const els = document.querySelectorAll("body *");
    const cap = Math.min(els.length, 5e3);
    for (let i = 0; i < cap; i++) {
      const el = els[i];
      if (bgChecked.has(el) || tracked.has(el) || el instanceof HTMLImageElement) continue;
      bgChecked.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg !== "none" ? bg.match(/url\(["']?(https?:[^"')]+|data:image[^"')]+)["']?\)/) : null;
      if (!m) continue;
      const rec = { img: el, url: m[1], id: ++recId, status: "pending", result: null, badge: null, heat: null, isBg: true };
      tracked.set(el, rec);
      if (prefs.badges === "all") rec.badge = makeBadge(rec);
      position(rec);
      const cached = byUrl.get(rec.url);
      if (cached) {
        rec.result = cached;
        rec.status = "done";
        paintBadge(rec);
      } else {
        analyzeRecord(rec);
      }
    }
  }
  function sweep() {
    if (!enabled) return;
    for (const img of allImages()) consider(img);
    if (prefs.video) for (const v of allVideos()) considerVideo(v);
    scanBackgrounds();
  }
  var VIDEO_EVERY_MS = 1500;
  var VIDEO_SLOW_MS = 6e3;
  var VIDEO_MIN_W = 120;
  var VIDEO_MIN_H = 80;
  var isTop = window === window.top;
  var videoBusy = 0;
  function* allVideos(root = document) {
    if (root === document) yield* document.querySelectorAll("video");
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) {
        yield* el.shadowRoot.querySelectorAll("video");
        yield* allVideos(el.shadowRoot);
      }
    }
  }
  function videoKey(v) {
    return v.currentSrc || v.src || (v.srcObject ? `stream:${recId}` : "");
  }
  function considerVideo(v) {
    let rec = tracked.get(v);
    const key = videoKey(v);
    if (rec && !rec.url.startsWith("stream:") && rec.url !== key) {
      detach(v);
      rec = null;
    }
    if (rec || !key) return;
    rec = { img: v, url: key, id: ++recId, status: "pending", result: null, badge: null, heat: null, isVideo: true, frames: [], checks: 0, busy: false, nextAt: 0, flagged: false };
    tracked.set(v, rec);
    if (prefs.badges === "all") rec.badge = makeBadge(rec);
    position(rec);
  }
  function visibleRect(v) {
    const r = v.getBoundingClientRect();
    if (r.width < VIDEO_MIN_W || r.height < VIDEO_MIN_H) return null;
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - x, h = Math.min(innerHeight, r.bottom) - y;
    if (w <= 0 || h <= 0 || h / r.height < 0.4) return null;
    return { x, y, w, h };
  }
  function grabFrame(v) {
    const k = Math.min(1, 480 / Math.min(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(32, Math.round(v.videoWidth * k));
    c.height = Math.max(32, Math.round(v.videoHeight * k));
    try {
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.92);
    } catch {
      return null;
    }
  }
  async function sampleVideo(rec) {
    const v = rec.img;
    if (rec.busy || rec.flagged || performance.now() < rec.nextAt || videoBusy >= 2) return;
    if (!v.isConnected || v.readyState < 2 || !v.videoWidth) return;
    const rect = visibleRect(v);
    if (!rect) return;
    rec.busy = true;
    videoBusy++;
    try {
      const frame = grabFrame(v);
      let res;
      if (frame) res = await chrome.runtime.sendMessage({ target: "bg", type: "analyze", dataUrl: frame });
      else if (isTop) res = await chrome.runtime.sendMessage({ target: "bg", type: "analyze-region", rect, dpr: devicePixelRatio, vw: innerWidth });
      else throw new Error("video from another site inside a frame");
      if (!res?.ok) throw new Error(res?.error || "no response");
      rec.frames.push(res.p);
      if (rec.frames.length > 3) rec.frames.shift();
      const avg = rec.frames.reduce((a, b) => a + b, 0) / rec.frames.length;
      rec.checks++;
      rec.result = { ...res, p: avg, signals: [...res.signals || [], { kind: "info", label: "Video", detail: `average of the last ${rec.frames.length} frame${rec.frames.length > 1 ? "s" : ""} (${rec.checks} checked)` }] };
      rec.status = "done";
      v.setAttribute("data-slop-score", avg.toFixed(4));
      v.setAttribute("data-slop-frames", String(rec.checks));
      v.setAttribute("data-slop-path", frame ? "frame" : "screen");
      if (rec.frames.length >= 2 && avg >= thr()) rec.flagged = true;
      rec.nextAt = performance.now() + (rec.checks >= 6 ? VIDEO_SLOW_MS : VIDEO_EVERY_MS);
      paintBadge(rec);
    } catch (e) {
      rec.nextAt = performance.now() + 5e3;
      v.setAttribute("data-slop-error", String(e?.message || e));
    } finally {
      rec.busy = false;
      videoBusy--;
    }
  }
  function videoTick() {
    if (!enabled || !prefs.video || document.hidden) return;
    for (const rec of tracked.values()) if (rec.isVideo) sampleVideo(rec);
  }
  function detach(img) {
    const rec = tracked.get(img);
    if (rec) {
      rec.badge?.remove();
      rec.reveal?.remove();
      if (rec.blurred) {
        rec.img.style.setProperty("filter", rec.prevFilter || "");
        if (!rec.prevFilter) rec.img.style.removeProperty("filter");
      }
      tracked.delete(img);
    }
  }
  var sweepTimer = null;
  var scheduleSweep = () => {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, 250);
  };
  var mo = new MutationObserver((muts) => {
    let dirty = false;
    for (const m of muts) {
      if (m.type === "attributes" && m.target instanceof HTMLVideoElement) {
        const rec = tracked.get(m.target);
        if (rec && !rec.url.startsWith("stream:") && videoKey(m.target) !== rec.url) detach(m.target);
        dirty = true;
      } else if (m.type === "attributes" && m.target instanceof HTMLImageElement) {
        const rec = tracked.get(m.target);
        if (rec && (m.target.currentSrc || m.target.src) !== rec.url) {
          detach(m.target);
        }
        dirty = true;
      } else if (m.addedNodes.length || m.removedNodes.length) {
        for (const n of m.removedNodes) {
          if (n instanceof HTMLImageElement || n instanceof HTMLVideoElement) detach(n);
          else if (n.querySelectorAll) n.querySelectorAll("img,video").forEach(detach);
        }
        dirty = true;
      }
    }
    if (dirty) {
      scheduleSweep();
      scheduleReposition();
    }
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "analyze-src" && msg.srcUrl) {
      for (const img of document.images) {
        if ((img.currentSrc || img.src) === msg.srcUrl) consider(img);
      }
      sendResponse({ ok: true });
    } else if (msg?.type === "page-stats") {
      let ai = 0, real = 0, unsure = 0, pending = 0;
      for (const rec of tracked.values()) {
        if (rec.status !== "done") {
          pending++;
          continue;
        }
        const p = rec.result.p;
        if (p >= thr()) ai++;
        else if (p <= REAL_THRESHOLD) real++;
        else unsure++;
      }
      sendResponse({ ok: true, total: tracked.size, ai, real, unsure, pending });
    } else if (msg?.type === "rescan") {
      for (const img of [...tracked.keys()]) detach(img);
      byUrl.clear();
      sweep();
      sendResponse({ ok: true });
    } else if (msg?.type === "set-enabled") {
      enabled = msg.enabled;
      if (!enabled) for (const img of [...tracked.keys()]) detach(img);
      else sweep();
      sendResponse({ ok: true });
    } else if (msg?.type === "set-blur") {
      prefs.blurAI = msg.blurAI;
      for (const rec of tracked.values()) applyBlur(rec);
      scheduleReposition();
      sendResponse({ ok: true });
    } else if (msg?.type === "set-prefs") {
      const wasVideo = prefs.video;
      Object.assign(prefs, msg.prefs || {});
      for (const rec of tracked.values()) {
        if (rec.isVideo && !prefs.video) {
          detach(rec.img);
          continue;
        }
        if (rec.isVideo && rec.result) rec.flagged = rec.frames.length >= 2 && rec.result.p >= thr();
        paintBadge(rec);
      }
      if (prefs.video && !wasVideo) sweep();
      scheduleReposition();
      sendResponse({ ok: true });
    }
    return false;
  });
  async function init() {
    const { siteDisabled = {}, blurAI: storedBlur, prefs: storedPrefs } = await chrome.storage.local.get(["siteDisabled", "blurAI", "prefs"]);
    if (storedPrefs) Object.assign(prefs, storedPrefs);
    if (typeof storedBlur === "boolean") prefs.blurAI = storedBlur;
    if (siteDisabled[location.hostname]) enabled = false;
    if (!enabled) return;
    sweep();
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"]
    });
    addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
    addEventListener("resize", scheduleReposition, { passive: true });
    setInterval(scheduleReposition, 1500);
    setInterval(scheduleSweep, 4e3);
    setInterval(videoTick, 400);
  }
  init();
  var BADGE_CSS = `
:host { all: initial; }
.badge {
  position: absolute; top: 0; left: 0; display: flex; align-items: center; gap: 5px;
  padding: 3px 9px 3px 7px; border-radius: 999px; cursor: default; user-select: none;
  font: 600 11.5px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif;
  color: #fff; background: rgba(20,22,28,.82); backdrop-filter: blur(6px);
  box-shadow: 0 1px 4px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.14);
  transition: background .25s ease; pointer-events: auto; white-space: nowrap;
}
.badge .dot { width: 7px; height: 7px; border-radius: 50%; background: #9aa4b2; }
.badge.scanning .dot { background: #7dd3fc; animation: pulse 1s ease-in-out infinite; }
.badge.ai { background: linear-gradient(135deg, rgba(190,24,60,.92), rgba(136,19,55,.92)); }
.badge.ai .dot { background: #fda4af; }
.badge.real { background: linear-gradient(135deg, rgba(5,102,54,.9), rgba(6,78,59,.9)); }
.badge.real .dot { background: #6ee7b7; }
.badge.unsure { background: linear-gradient(135deg, rgba(146,101,7,.92), rgba(120,73,10,.92)); }
.badge.unsure .dot { background: #fcd34d; }
.badge.err { opacity: .5; }
@keyframes pulse { 50% { opacity: .25; transform: scale(.7); } }
.panel {
  position: absolute; top: 0; left: 0; width: 280px; padding: 12px 14px;
  border-radius: 14px; background: rgba(17,19,24,.96); color: #e5e9f0;
  font: 12px/1.45 -apple-system, system-ui, "Segoe UI", sans-serif;
  box-shadow: 0 12px 40px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.1);
  pointer-events: none; z-index: 1;
}
.panel .ph { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.panel .ph b { font-size: 12.5px; }
.panel .ph span { color: #8b93a3; font-size: 10.5px; }
.panel .meter { height: 6px; border-radius: 4px; background: #2a2f3a; overflow: hidden; margin: 2px 0 6px; }
.panel .fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg,#34d399,#fbbf24 55%,#fb7185); }
.panel .pr { display: flex; justify-content: space-between; margin: 2px 0; }
.panel .pr.sub { color: #8b93a3; font-size: 11px; }
.panel .sig { display: flex; gap: 8px; margin-top: 8px; }
.panel .sig .k { flex: 0 0 auto; }
.panel .sig.ai .k { color: #fb7185; }
.panel .sig.real .k { color: #34d399; }
.panel .sig.info .k { color: #7dd3fc; }
.panel .sig small { display: block; color: #8b93a3; }
.panel .pf { margin-top: 10px; padding-top: 8px; border-top: 1px solid #262b35; color: #8b93a3; font-size: 10.5px; }
.heat {
  position: absolute; top: 0; left: 0; display: grid; pointer-events: none;
  border-radius: 4px; overflow: hidden; mix-blend-mode: normal;
}
.reveal {
  position: absolute; top: 0; left: 0;
  display: flex; align-items: center; padding: 4px 10px; border-radius: 999px;
  font: 600 11.5px/1.3 -apple-system, system-ui, "Segoe UI", sans-serif;
  border-left: 3px solid #fb7185;
  color: #fff; background: rgba(20,22,28,.88); backdrop-filter: blur(4px);
  box-shadow: 0 2px 10px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.16);
  cursor: pointer; pointer-events: auto; user-select: none; white-space: nowrap;
}
.reveal:hover { background: rgba(30,33,42,.95); }
`;
})();
