(() => {
"use strict";

const AUDIO_EXT = ["mp3","m4a","wav","ogg","oga","flac","aac","opus","webm","wma"];
const isAudioName = (name) => AUDIO_EXT.includes((name.split(".").pop() || "").toLowerCase());
const hasFSAccess = "showDirectoryPicker" in window;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const pathEl = $("path"), crumbsEl = $("crumbs"), listingEl = $("listing"),
      emptyState = $("emptyState"), fileListEl = $("fileList"), rootBtn = $("rootBtn"),
      playerEl = $("player"), trackNameEl = $("trackName"), audio = $("audio"),
      playBtn = $("playBtn"), prevBtn = $("prevBtn"), nextBtn = $("nextBtn"),
      progress = $("progress"), progressFill = $("progressFill"), progressHandle = $("progressHandle"),
      curTimeEl = $("curTime"), durTimeEl = $("durTime"), volume = $("volume"),
      toastEl = $("toast"), folderInputFallback = $("folderInputFallback");

// ---------- state ----------
let dirStack = [];        // [{node, name}], index 0 = root
let currentFiles = [];    // audio-file nodes in the current folder, sorted
let currentIndex = -1;    // index within currentFiles that is loaded
let objectUrl = null;

// ---------- toast ----------
let toastTimer = null;
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastEl.classList.toggle("err", !!isErr);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

// ---------- indexedDB (persist last root handle, fsapi only) ----------
const DB_NAME = "musica-local", STORE = "kv";
function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// ---------- node adapters ----------
// A "node" is either {mode:'fsapi', kind, name, handle} or {mode:'fallback', kind, name, children?, file?}

async function listChildren(node) {
  let entries = [];
  if (node.mode === "fsapi") {
    for await (const [name, handle] of node.handle.entries()) {
      entries.push({ mode: "fsapi", kind: handle.kind, name, handle });
    }
  } else {
    entries = Array.from(node.children.values());
  }
  entries = entries.filter((e) => e.kind === "directory" || isAudioName(e.name));
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return entries;
}

async function getBlobFile(node) {
  return node.mode === "fsapi" ? node.handle.getFile() : node.file;
}

// ---------- fallback tree (browsers without File System Access API) ----------
function buildFallbackTree(fileList) {
  const files = Array.from(fileList).filter((f) => isAudioName(f.name));
  let rootName = "musica";
  const root = { mode: "fallback", kind: "directory", name: rootName, children: new Map() };
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split("/");
    rootName = parts[0] || rootName;
    let cur = root;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast) {
        cur.children.set(part, { mode: "fallback", kind: "file", name: part, file });
      } else {
        if (!cur.children.has(part)) {
          cur.children.set(part, { mode: "fallback", kind: "directory", name: part, children: new Map() });
        }
        cur = cur.children.get(part);
      }
    }
  }
  root.name = rootName;
  return root;
}

// ---------- navigation ----------
async function enterRoot(node) {
  dirStack = [{ node, name: node.name }];
  await refreshView();
}
async function enterDir(node) {
  dirStack.push({ node, name: node.name });
  await refreshView();
}
async function goUp() {
  if (dirStack.length > 1) {
    dirStack.pop();
    await refreshView();
  }
}
async function goToCrumb(index) {
  dirStack = dirStack.slice(0, index + 1);
  await refreshView();
}

function renderCrumbs() {
  crumbsEl.innerHTML = "";
  dirStack.forEach((entry, i) => {
    const btn = document.createElement("button");
    btn.textContent = entry.name;
    btn.addEventListener("click", () => goToCrumb(i));
    crumbsEl.appendChild(btn);
    if (i < dirStack.length - 1) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = " / ";
      crumbsEl.appendChild(sep);
    }
  });
  const shortPath = "~/" + dirStack.map((e) => e.name).join("/");
  pathEl.textContent = shortPath;
}

async function refreshView() {
  renderCrumbs();
  const here = dirStack[dirStack.length - 1].node;
  let children;
  try {
    children = await listChildren(here);
  } catch (err) {
    toast("no se pudo leer la carpeta", true);
    return;
  }

  currentFiles = children.filter((c) => c.kind === "file");

  emptyState.hidden = true;
  fileListEl.hidden = false;
  fileListEl.innerHTML = "";

  if (dirStack.length > 1) {
    const up = document.createElement("li");
    up.className = "row is-dir";
    up.innerHTML = `<span class="kind">d</span><span class="name up">../</span>`;
    up.addEventListener("click", goUp);
    fileListEl.appendChild(up);
  }

  if (children.length === 0) {
    const li = document.createElement("li");
    li.className = "row";
    li.innerHTML = `<span class="kind">#</span><span class="name">(carpeta vacía)</span>`;
    fileListEl.appendChild(li);
    return;
  }

  children.forEach((child) => {
    const li = document.createElement("li");
    const isDir = child.kind === "directory";
    li.className = "row " + (isDir ? "is-dir" : "is-file");
    const kind = isDir ? "d" : "-";
    const suffix = isDir ? "/" : "";
    li.innerHTML = `<span class="kind">${kind}</span><span class="name">${escapeHtml(child.name)}${suffix}</span>`;
    li.addEventListener("click", () => {
      if (isDir) enterDir(child);
      else playFromFolder(child);
    });
    child._li = li;
    fileListEl.appendChild(li);
  });

  markPlayingRow();
}

function markPlayingRow() {
  fileListEl.querySelectorAll(".row.is-playing").forEach((r) => r.classList.remove("is-playing"));
  const cur = currentFiles[currentIndex];
  if (cur && cur._li) {
    cur._li.classList.add("is-playing");
    const nameSpan = cur._li.querySelector(".name");
    if (nameSpan && !nameSpan.querySelector(".row-cursor")) {
      const c = document.createElement("span");
      c.className = "cursor row-cursor";
      c.textContent = " ▮";
      nameSpan.appendChild(c);
    }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ---------- playback ----------
async function playFromFolder(node) {
  const idx = currentFiles.findIndex((f) => f === node);
  await loadAndPlay(idx);
}

async function loadAndPlay(idx) {
  if (idx < 0 || idx >= currentFiles.length) return;
  currentIndex = idx;
  const node = currentFiles[idx];
  let file;
  try {
    file = await getBlobFile(node);
  } catch (err) {
    toast("no se pudo abrir el archivo", true);
    return;
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.src = objectUrl;
  playerEl.hidden = false;
  trackNameEl.textContent = node.name;
  try {
    await audio.play();
  } catch (err) {
    // autoplay might be blocked without a gesture; user tapped, so usually fine
  }
  updatePlayButton();
  markPlayingRow();
  updateMediaSession(node.name);
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx >= currentFiles.length - 1;
}

function updatePlayButton() {
  playBtn.textContent = audio.paused ? "▶" : "⏸";
}

playBtn.addEventListener("click", () => {
  if (!audio.src) return;
  if (audio.paused) audio.play(); else audio.pause();
});
audio.addEventListener("play", updatePlayButton);
audio.addEventListener("pause", updatePlayButton);
audio.addEventListener("ended", () => {
  if (currentIndex < currentFiles.length - 1) loadAndPlay(currentIndex + 1);
});

prevBtn.addEventListener("click", () => loadAndPlay(currentIndex - 1));
nextBtn.addEventListener("click", () => loadAndPlay(currentIndex + 1));

function fmtTime(s) {
  if (!isFinite(s)) return "00:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

audio.addEventListener("timeupdate", () => {
  const dur = audio.duration || 0;
  const pct = dur ? (audio.currentTime / dur) * 100 : 0;
  progressFill.style.width = pct + "%";
  progressHandle.style.left = pct + "%";
  progress.setAttribute("aria-valuenow", Math.round(pct));
  curTimeEl.textContent = fmtTime(audio.currentTime);
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.setPositionState({
        duration: dur || 0,
        position: Math.min(audio.currentTime, dur || 0),
      });
    } catch (e) {}
  }
});
audio.addEventListener("loadedmetadata", () => {
  durTimeEl.textContent = fmtTime(audio.duration);
});

function seekFromClientX(clientX) {
  const rect = progress.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  if (audio.duration) audio.currentTime = pct * audio.duration;
}
progress.addEventListener("pointerdown", (e) => {
  seekFromClientX(e.clientX);
  const move = (ev) => seekFromClientX(ev.clientX);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});
progress.addEventListener("keydown", (e) => {
  if (!audio.duration) return;
  if (e.key === "ArrowRight") audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
  if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
});

volume.addEventListener("input", () => { audio.volume = parseFloat(volume.value); });

function updateMediaSession(name) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: name,
    artist: "musica@local",
  });
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => loadAndPlay(currentIndex - 1));
  navigator.mediaSession.setActionHandler("nexttrack", () => loadAndPlay(currentIndex + 1));
  navigator.mediaSession.setActionHandler("seekto", (details) => {
    if (details.seekTime != null) audio.currentTime = details.seekTime;
  });
}

// ---------- opening a folder ----------
rootBtn.addEventListener("click", openFolder);

async function openFolder() {
  if (hasFSAccess) {
    try {
      const handle = await window.showDirectoryPicker();
      const node = { mode: "fsapi", kind: "directory", name: handle.name, handle };
      await idbSet("root", handle);
      await enterRoot(node);
    } catch (err) {
      if (err && err.name !== "AbortError") toast("no se pudo abrir la carpeta", true);
    }
  } else {
    folderInputFallback.click();
  }
}

folderInputFallback.addEventListener("change", () => {
  if (!folderInputFallback.files.length) return;
  const root = buildFallbackTree(folderInputFallback.files);
  enterRoot(root);
});

// ---------- restore last folder (fsapi only) ----------
async function tryRestore() {
  if (!hasFSAccess) return;
  let handle;
  try {
    handle = await idbGet("root");
  } catch (e) { return; }
  if (!handle) return;

  try {
    let perm = await handle.queryPermission({ mode: "read" });
    if (perm === "granted") {
      const node = { mode: "fsapi", kind: "directory", name: handle.name, handle };
      await enterRoot(node);
    } else {
      rootBtn.textContent = "reconectar ▾";
      rootBtn.addEventListener("click", async function onceReconnect(e) {
        e.stopPropagation();
        const p = await handle.requestPermission({ mode: "read" });
        if (p === "granted") {
          rootBtn.textContent = "carpeta ▾";
          const node = { mode: "fsapi", kind: "directory", name: handle.name, handle };
          await enterRoot(node);
        }
        rootBtn.removeEventListener("click", onceReconnect);
      }, { once: true });
    }
  } catch (e) { /* handle stale, ignore */ }
}

// ---------- service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

tryRestore();
})();
