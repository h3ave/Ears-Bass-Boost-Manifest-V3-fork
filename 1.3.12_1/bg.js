// bg.js (MV3 service worker)
// Owns: persisted filter/gain state, presets, captured-tab bookkeeping, tabCapture,
// fullscreen sync. Delegates the actual Web Audio graph to offscreen.js because
// service workers have no DOM (no AudioContext, no getUserMedia).

const FREQ_DEFAULTS = [20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480];
const Q_DEFAULT = 0.7071;
const NUM_FILTERS = 11;
const OFFSCREEN_URL = "offscreen.html";

function filterType(i) {
  if (i === 0) return "lowshelf";
  if (i === NUM_FILTERS - 1) return "highshelf";
  return "peaking";
}

function defaultFilters() {
  const out = [];
  for (let i = 0; i < NUM_FILTERS; i++) {
    out.push({ frequency: FREQ_DEFAULTS[i], gain: 0, q: Q_DEFAULT, type: filterType(i) });
  }
  return out;
}

function clampGainLinear(v) { return Math.min(10, Math.max(0.00316, v)); }
function clampGainDb(v) { return Math.min(30, Math.max(-30, v)); }
function clampFreq(v) { return Math.min(20000, Math.max(5, v)); }
function clampQ(v) { return Math.min(11, Math.max(0.2, v)); }

// ---------- persistence ----------

async function loadState() {
  const { earsState } = await chrome.storage.local.get("earsState");
  if (earsState && Array.isArray(earsState.filters) && earsState.filters.length === NUM_FILTERS) {
    return earsState;
  }
  return { filters: defaultFilters(), gain: 1 };
}

async function saveState(state) {
  await chrome.storage.local.set({ earsState: state });
}

async function loadPresets() {
  const { earsPresets } = await chrome.storage.sync.get("earsPresets");
  return earsPresets && typeof earsPresets === "object" ? earsPresets : {};
}

async function savePresetsObj(obj) {
  await chrome.storage.sync.set({ earsPresets: obj });
}

async function loadCapturedTabs() {
  const { earsCapturedTabs } = await chrome.storage.local.get("earsCapturedTabs");
  return earsCapturedTabs && typeof earsCapturedTabs === "object" ? earsCapturedTabs : {};
}

async function saveCapturedTabs(obj) {
  await chrome.storage.local.set({ earsCapturedTabs: obj });
}

// ---------- offscreen document + port plumbing ----------

let offscreenPort = null;
let creatingOffscreen = null;
let requestCounter = 0;
const pendingRequests = new Map();

async function ensureOffscreen() {
  let justCreated = false;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"],
        justification: "Web Audio graph (EQ filters, tab-audio capture, spectrum analyser) needs DOM APIs unavailable in the service worker."
      })
      .then(() => { justCreated = true; })
      .catch((err) => {
        // Chrome throws here if a document already exists - that's fine, not an error for us.
        console.log("Ears: offscreen.createDocument() said:", err && err.message);
      });
  }
  await creatingOffscreen;
  creatingOffscreen = null;

  if (!offscreenPort) {
    offscreenPort = chrome.runtime.connect({ name: "ears-offscreen" });
    offscreenPort.onDisconnect.addListener(() => { offscreenPort = null; });
    offscreenPort.onMessage.addListener(handleOffscreenMessage);
  }
  if (justCreated) {
    // Freshly created offscreen documents start with default (zeroed) filters;
    // push the persisted EQ state into it right away.
    const state = await loadState();
    for (let i = 0; i < state.filters.length; i++) {
      const f = state.filters[i];
      offscreenPort.postMessage({ cmd: "setFilter", index: i, frequency: f.frequency, gain: f.gain, q: f.q });
    }
    offscreenPort.postMessage({ cmd: "setGain", gain: state.gain });
  }
  return offscreenPort;
}

function handleOffscreenMessage(msg) {
  if (msg.requestId && pendingRequests.has(msg.requestId)) {
    const resolve = pendingRequests.get(msg.requestId);
    pendingRequests.delete(msg.requestId);
    resolve(msg);
  }
  if (msg.type === "sampleRate") {
    chrome.runtime.sendMessage({ type: "sendSampleRate", Fs: msg.Fs }).catch(() => {});
  }
}

async function sendOffscreen(cmd, extra) {
  const port = await ensureOffscreen();
  port.postMessage(Object.assign({ cmd }, extra));
}

async function requestOffscreen(cmd, extra) {
  const port = await ensureOffscreen();
  const requestId = ++requestCounter;
  return new Promise((resolve) => {
    pendingRequests.set(requestId, resolve);
    port.postMessage(Object.assign({ cmd, requestId }, extra));
  });
}

// Push the full persisted filter/gain state into a (re)created offscreen graph.
async function syncStateToOffscreen() {
  const state = await loadState();
  for (let i = 0; i < state.filters.length; i++) {
    const f = state.filters[i];
    await sendOffscreen("setFilter", { index: i, frequency: f.frequency, gain: f.gain, q: f.q });
  }
  await sendOffscreen("setGain", { gain: state.gain });
}

// ---------- filter / gain mutation ----------

async function modifyFilter(index, frequency, gain, q) {
  const state = await loadState();
  state.filters[index] = {
    frequency: clampFreq(frequency),
    gain: clampGainDb(gain),
    q: clampQ(q),
    type: filterType(index)
  };
  await saveState(state);
  await sendOffscreen("setFilter", { index, frequency: state.filters[index].frequency, gain: state.filters[index].gain, q: state.filters[index].q });
}

async function modifyGain(gain) {
  const state = await loadState();
  state.gain = clampGainLinear(gain);
  await saveState(state);
  await sendOffscreen("setGain", { gain: state.gain });
}

async function resetFilter(index) {
  await modifyFilter(index, FREQ_DEFAULTS[index], 0, Q_DEFAULT);
}

async function resetAllFilters() {
  const state = { filters: defaultFilters(), gain: 1 };
  await saveState(state);
  await syncStateToOffscreen();
}

async function applyPreset(name) {
  let filters;
  if (name === "bassBoost") {
    filters = defaultFilters();
    filters[0] = { frequency: 340, gain: 5, q: Q_DEFAULT, type: "lowshelf" };
  } else {
    const presets = await loadPresets();
    const p = presets[name];
    if (!p) return;
    filters = p.frequencies.map((f, i) => ({
      frequency: f, gain: p.gains[i], q: p.qs[i], type: filterType(i)
    }));
  }
  const state = await loadState();
  state.filters = filters;
  await saveState(state);
  await syncStateToOffscreen();
}

async function savePreset(name) {
  const state = await loadState();
  const presets = await loadPresets();
  presets[name] = {
    frequencies: state.filters.map(f => f.frequency),
    gains: state.filters.map(f => f.gain),
    qs: state.filters.map(f => f.q)
  };
  await savePresetsObj(presets);
}

async function deletePreset(name) {
  const presets = await loadPresets();
  delete presets[name];
  await savePresetsObj(presets);
}

async function importPresets(imported) {
  const presets = await loadPresets();
  for (const name of Object.keys(imported)) {
    presets[name] = imported[name];
  }
  await savePresetsObj(presets);
}

async function exportPresets() {
  const presets = await loadPresets();
  const json = JSON.stringify(presets, null, 2);
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  await chrome.downloads.download({ url: dataUrl, filename: "EarsAudioToolkitPresets.json", saveAs: false });
}

// ---------- tab capture ----------

async function startEqTab() {
  const [tab] = await chrome.tabs.query({ currentWindow: true, active: true });
  if (!tab || (tab.url && tab.url.startsWith("chrome-extension://" + chrome.runtime.id))) return;

  const captured = await loadCapturedTabs();
  if (tab.id in captured) {
    // Already tracked as captured - nothing to do, just make sure the popup UI matches.
    await broadcastFullRefresh();
    return;
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    console.error("Ears: getMediaStreamId failed", err);
    // Chrome only allows one active capturer per tab. If a previous offscreen
    // document died without releasing its stream (e.g. during dev reloads),
    // Chrome still thinks this tab is being captured until it's reloaded.
    await chrome.runtime.sendMessage({
      type: "captureError",
      message: "Couldn't EQ this tab (it may still be marked as captured from an earlier session). Try reloading the tab and clicking EQ Current Tab again."
    }).catch(() => {});
    return;
  }

  captured[tab.id] = { id: tab.id, title: tab.title, favIconUrl: tab.favIconUrl, windowId: tab.windowId };
  await saveCapturedTabs(captured);

  const result = await requestOffscreen("startCapture", { tabId: tab.id, streamId });
  if (!result.ok) {
    delete captured[tab.id];
    await saveCapturedTabs(captured);
  }
  await broadcastFullRefresh();
}

async function disconnectTab(tabRef) {
  const tabId = tabRef.id;
  await sendOffscreen("stopCapture", { tabId });
  const captured = await loadCapturedTabs();
  delete captured[tabId];
  await saveCapturedTabs(captured);
  await broadcastFullRefresh();
}

// ---------- fullscreen sync (captured tab goes fullscreen -> follow with the browser window) ----------

const restoreWindowState = {};

chrome.tabCapture.onStatusChanged.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    const win = await chrome.windows.get(tab.windowId);
    if (info.fullscreen) {
      if (win.state !== "fullscreen") restoreWindowState[win.id] = win.state;
      await chrome.windows.update(win.id, { state: "fullscreen" });
    } else if (win.id in restoreWindowState) {
      await chrome.windows.update(win.id, { state: restoreWindowState[win.id] || "normal" });
      delete restoreWindowState[win.id];
    }
  } catch (e) {
    // tab/window may already be gone; nothing to do
  }

  if (info.status === "stopped" || info.status === "error") {
    const captured = await loadCapturedTabs();
    if (info.tabId in captured) {
      delete captured[info.tabId];
      await saveCapturedTabs(captured);
      await sendOffscreen("stopCapture", { tabId: info.tabId });
      await broadcastFullRefresh();
    }
  }
});

// ---------- messages to popup ----------

async function broadcastFullRefresh() {
  const state = await loadState();
  const captured = await loadCapturedTabs();

  await chrome.runtime.sendMessage({
    type: "sendWorkspaceStatus",
    eqFilters: state.filters,
    streams: Object.values(captured),
    gain: state.gain
  }).catch(() => {});

  const [tab] = await chrome.tabs.query({ currentWindow: true, active: true });
  await chrome.runtime.sendMessage({
    type: "sendCurrentTabStatus",
    streaming: !!(tab && tab.id in captured)
  }).catch(() => {});

  await sendOffscreen("getSampleRate", {});

  const presets = await loadPresets();
  await chrome.runtime.sendMessage({ type: "sendPresets", presets }).catch(() => {});
}

// ---------- popup message handling ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sendResponse);
  return true; // keep the message channel open for async sendResponse
});

async function handle(msg, sendResponse) {
  try {
    switch (msg.type) {
      case "onPopupOpen":
      case "getFullRefresh":
        await broadcastFullRefresh();
        break;
      case "eqTab":
        if (msg.on) await startEqTab();
        else {
          const [tab] = await chrome.tabs.query({ currentWindow: true, active: true });
          if (tab) await disconnectTab({ id: tab.id });
        }
        break;
      case "disconnectTab":
        await disconnectTab(msg.tab);
        break;
      case "modifyFilter":
        await modifyFilter(msg.index, msg.frequency, msg.gain, msg.q);
        break;
    case "modifyGain":
      await modifyGain(msg.gain);
      break;
    case "resetFilter":
      await resetFilter(msg.index);
      break;
    case "resetFilters":
      await resetAllFilters();
      await broadcastFullRefresh();
      break;
    case "preset":
      await applyPreset(msg.preset);
      await broadcastFullRefresh();
      break;
    case "savePreset":
      await savePreset(msg.preset);
      await broadcastFullRefresh();
      break;
    case "deletePreset":
      await deletePreset(msg.preset);
      await broadcastFullRefresh();
      break;
    case "importPresets":
      await importPresets(msg.presets);
      await broadcastFullRefresh();
      break;
    case "exportPresets":
      await exportPresets();
      break;
    case "getFFT": {
      const result = await requestOffscreen("getFFT", {});
      sendResponse({ fft: result.fft || [] });
      return;
    }
    case "gainUpdated":
    case "filterUpdated":
      // analytics hooks in the original build; no-op now.
      break;
    }
  } catch (err) {
    console.error("Ears: error handling message", msg, err);
  }
  sendResponse({});
}

// Make sure the offscreen document (and its persisted state) is ready as early as possible.
chrome.runtime.onStartup.addListener(() => {
  saveCapturedTabs({}); // capture streams never survive a browser restart
  ensureOffscreen().then(syncStateToOffscreen);
});
chrome.runtime.onInstalled.addListener(() => { ensureOffscreen().then(syncStateToOffscreen); });
