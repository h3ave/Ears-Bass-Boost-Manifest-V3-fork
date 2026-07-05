# Ears Audio Toolkit — Manifest V3 fork

*[Русская версия](README.ru.md)*

This is a community fork of **[Ears: Bass Boost, EQ Any Audio!](https://chrome.google.com/webstore/detail/ears-audio-toolkit/nfdfiepdkbnoanddpianalelglmfooik)** by Kevin King, migrated from **Manifest V2** to **Manifest V3** so it keeps working after Chrome/Chromium removes MV2 support.

The migration (manifest, service worker, offscreen document rewrite) was done with the help of [Claude AI](https://claude.ai) (Anthropic).

> This is an unofficial, community-maintained fork. It is not affiliated with or endorsed by the original author. All credit for the original design, DSP, and UI goes to Kevin King.

## What this extension does

Ears lets you live-EQ the audio of any browser tab: boost the bass, tame harsh highs, bring vocals forward, and see a real-time frequency spectrum of what you're listening to. It uses the Web Audio API's biquad filters (shelf + peaking filters) driven by draggable dots on an interactive graph, plus save/load presets and a one-click Bass Boost.

## Installation (unpacked / developer mode)

The fork is not available in the extension store, so it must be installed as a unpacked extension:

> **Already have the original "Ears" extension installed from the Chrome Web Store (or an earlier copy of this fork)?** Remove it first, *then* load this version. Loading a new copy on top of an old one, or just clicking "Reload" after swapping files on disk, can leave the browser running stale code — permissions and background-script changes in particular don't always get picked up that way. A clean install avoids that entirely:
> 1. Go to your extensions page (see below) and **Remove** the old Ears extension completely.
> 2. Then follow the steps below to **Load unpacked** this fork fresh.

1. **Download this repository** — click *Code → Download ZIP* on GitHub, then unzip it.
2. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - (any other Chromium-based browser has an equivalent `*://extensions` page)
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the folder containing `manifest.json`.

### Updating after you change or pull new code

Simply clicking **Reload** on the extension card is not always enough — some browsers (Brave included) don't reliably pick up new `manifest.json` permissions that way. If something seems stuck or a permission-related error shows up in the console:

1. Click **Remove** on the extension card (not just Reload).
2. **Load unpacked** again and re-select the same folder.

### Using it

1. Open the tab whose audio you want to EQ, then click the Ears icon and hit **EQ Current Tab**.
2. Drag the dots on the graph to shape the EQ; shift-drag a dot up/down to widen or narrow that filter's Q.
3. Use the volume slider on the left to adjust overall gain.
4. Save your favorite settings as a named preset, or try the one-click **Bass Boost**.
5. Toggle the **Spectrum Visualizer** to see the frequency content of the audio in real time.

<details>
<summary><strong>Why this fork exists (click to expand)</strong></summary>

Chrome (and most Chromium-based browsers) is phasing out Manifest V2 extensions. The original Ears codebase used a persistent Manifest V2 background page holding a live `AudioContext`, which cannot simply be ported to MV3 — service workers have no DOM, no `AudioContext`, and no `localStorage`. This fork restructures the extension around the required MV3 primitives:

- **`manifest.json`** — `manifest_version: 3`, `action` instead of `browser_action`, a service worker instead of a persistent background page, and an MV3-compliant `content_security_policy`.
- **`bg.js`** (service worker) — owns all persisted state (EQ filter values, gain, presets, active-tab bookkeeping via `chrome.storage`), tab querying, `chrome.tabCapture`, and fullscreen sync. It has no DOM access, so it delegates anything audio-related to the offscreen document.
- **`offscreen.js`** / **`offscreen.html`** — a hidden offscreen document that owns the actual `AudioContext`, the 11-band biquad filter chain, and the spectrum analyser. It only talks to the service worker over a `chrome.runtime.Port`, since offscreen documents can't use `chrome.tabs`, `chrome.storage`, or `chrome.tabCapture` directly.
- **`popup.js`** / **`popup.html`** — mostly unchanged; the popup UI only ever talked to the background via `chrome.runtime.sendMessage`, so it doesn't need to know that the "background" is now split in two.

#### Known differences from the original MV2 build

- Legacy Google Analytics (Universal Analytics, `UA-64913318-2`) tracking has been removed. It was already non-functional — Google shut down Universal Analytics processing in July 2023 — and MV3's extension-page CSP no longer allows loading remotely-hosted scripts anyway.
- Presets are stored as a single object under one `chrome.storage.sync` key instead of one sync key per preset. Simpler, but a very large personal preset collection could bump into the 8&nbsp;KB per-item sync storage limit.
- "Export Presets" now uses `chrome.downloads.download` instead of a DOM `<a download>` click (the service worker has no DOM to create that link).
- The EQ filter chain is always fully wired in series (even at 0 dB gain) instead of being dynamically spliced in/out of the audio graph. This has no audible effect — a 0 dB filter is a no-op — it's a negligible amount of extra CPU.
- Because `AudioContext`/`getUserMedia` now live in an offscreen document (independent lifetime from the service worker), captured-tab bookkeeping is rebuilt from `chrome.storage.local` and cleared on browser startup, since a real audio-capture stream can never survive a full browser restart anyway.

</details>



## Repository layout

```
manifest.json     MV3 manifest
bg.js             Service worker: storage, presets, tabs, tabCapture, fullscreen sync
offscreen.html    Hidden offscreen document (host page)
offscreen.js      Web Audio engine: AudioContext, biquad filters, analyser
popup.html        Popup UI markup
popup.js          Popup UI logic (EQ graph rendering, drag handling, messaging)
popup.css         Popup styling  (carry over from the original repo — not modified)
snap.svg-min.js   Bundled Snap.svg library, used to draw the EQ graph
ears*.png         Toolbar/store icons                (carry over from the original repo — not modified)
```

## Contributing / issues

Since this is a community MV3 migration rather than the original developer's repo, please file issues here for anything MV3-specific (service worker, offscreen document, storage). For the underlying EQ/DSP design and popup UI, credit and original context belong to Kevin King's original extension, linked above.

## License

No license was specified in the original source drop this fork was migrated from. If you're the original author and want a specific license applied (or would like the fork to be removed), please open an issue.