// offscreen.js
// Offscreen documents may ONLY use chrome.runtime (no chrome.tabs/storage/tabCapture/windows).
// So this file is a pure Web Audio engine: it owns the AudioContext + filter chain
// and talks to the service worker (bg.js) exclusively through a long-lived Port.

var FREQ_DEFAULTS = [20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480];
var Q_DEFAULT = 0.7071;
var NUM_FILTERS = 11;

var ctx = null;
var preGain = null;   // sum of all captured tab sources
var masterGain = null; // overall volume knob
var analyser = null;
var filters = [];      // BiquadFilterNode[]
var sources = {};      // tabId -> { stream, sourceNode }
var port = null;

function clampGainLinear(v) { return Math.min(10, Math.max(0.00316, v)); }
function clampGainDb(v) { return Math.min(30, Math.max(-30, v)); }
function clampFreq(v) { return Math.min(20000, Math.max(5, v)); }
function clampQ(v) { return Math.min(11, Math.max(0.2, v)); }

function ensureContext() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: "playback" });
  ctx.suspend();

  preGain = ctx.createGain();
  preGain.gain.value = 1;

  masterGain = ctx.createGain();
  masterGain.gain.value = 1;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.5;

  filters = [];
  for (var i = 0; i < NUM_FILTERS; i++) {
    var f = ctx.createBiquadFilter();
    if (i === 0) f.type = "lowshelf";
    else if (i === NUM_FILTERS - 1) f.type = "highshelf";
    else f.type = "peaking";
    f.frequency.value = FREQ_DEFAULTS[i];
    f.gain.value = 0;
    f.Q.value = Q_DEFAULT;
    filters.push(f);
  }

  // Wire preGain -> filter0 -> filter1 -> ... -> filterN -> masterGain -> destination + analyser
  // (Simplification vs. the old MV2 code: filters always stay chained in series, even at 0 gain,
  // instead of being dynamically spliced in/out of the graph. A 0-gain filter is a numerical
  // no-op, so audibly this is identical; it just costs a negligible amount of extra CPU.)
  var node = preGain;
  for (var i = 0; i < filters.length; i++) {
    node.connect(filters[i]);
    node = filters[i];
  }
  node.connect(masterGain);
  masterGain.connect(ctx.destination);
  masterGain.connect(analyser);
}

function setFilter(index, frequency, gain, q) {
  ensureContext();
  var f = filters[index];
  if (!f) return;
  f.frequency.value = clampFreq(frequency);
  f.gain.value = clampGainDb(gain);
  f.Q.value = clampQ(q);
}

function setGain(gain) {
  ensureContext();
  masterGain.gain.value = clampGainLinear(gain);
}

function anyActiveSources() {
  return Object.keys(sources).length > 0;
}

function startCapture(tabId, streamId) {
  ensureContext();
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  }).then(function (stream) {
    var sourceNode = ctx.createMediaStreamSource(stream);
    sourceNode.connect(preGain);
    sources[tabId] = { stream: stream, sourceNode: sourceNode };
    if (ctx.state === "suspended") ctx.resume();
    return true;
  });
}

function stopCapture(tabId) {
  var entry = sources[tabId];
  if (!entry) return;
  try { entry.sourceNode.disconnect(); } catch (e) {}
  try { entry.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  delete sources[tabId];
  if (!anyActiveSources() && ctx) ctx.suspend();
}

function stopAllCapture() {
  Object.keys(sources).forEach(function (tabId) { stopCapture(tabId); });
}

function getFFT() {
  if (!analyser || !anyActiveSources()) return [];
  var data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);
  return Array.from(data);
}

function handleMessage(msg) {
  switch (msg.cmd) {
    case "init":
      ensureContext();
      port.postMessage({ type: "ready", sampleRate: ctx.sampleRate });
      break;
    case "setFilter":
      setFilter(msg.index, msg.frequency, msg.gain, msg.q);
      break;
    case "setGain":
      setGain(msg.gain);
      break;
    case "startCapture":
      startCapture(msg.tabId, msg.streamId).then(function (ok) {
        port.postMessage({ type: "captureStarted", requestId: msg.requestId, tabId: msg.tabId, ok: ok });
      }).catch(function (err) {
        console.error("Ears offscreen: getUserMedia failed", err);
        port.postMessage({ type: "captureStarted", requestId: msg.requestId, tabId: msg.tabId, ok: false, error: String(err) });
      });
      break;
    case "stopCapture":
      stopCapture(msg.tabId);
      port.postMessage({ type: "captureStopped", tabId: msg.tabId });
      break;
    case "stopAllCapture":
      stopAllCapture();
      port.postMessage({ type: "captureStopped", tabId: null });
      break;
    case "getFFT":
      port.postMessage({ type: "fft", requestId: msg.requestId, fft: getFFT() });
      break;
    case "getSampleRate":
      ensureContext();
      port.postMessage({ type: "sampleRate", Fs: ctx.sampleRate });
      break;
  }
}

chrome.runtime.onConnect.addListener(function (p) {
  if (p.name !== "ears-offscreen") return;
  port = p;
  ensureContext();
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(function () { port = null; });
});
