# Scram Keep Alive (Chrome extension)

Keeps Scram editor tabs (`https://editor.buildwithscram.com/...`) running at full speed when you switch to another tab or window.

## What it does

- **Always visible and focused:** `spoof.js` runs before Scram's own scripts and makes `document.hidden` always `false`, `document.visibilityState` always `"visible"` and `document.hasFocus()` always `true`. Scram never receives `visibilitychange`, `freeze`, or window `blur` events.
- **Animation frames and timers keep running:** Chrome stops `requestAnimationFrame` in hidden tabs. It also slows `setTimeout`/`setInterval` to once a second, and to once a minute after 5 minutes. While the tab is really hidden, these are driven from a Web Worker's clock instead, which Chrome doesn't throttle.
- **Never unloaded:** `background.js` turns off Chrome's tab discarding (Memory Saver) for Scram editor tabs.
- **Never frozen:** `keepalive.js` plays an inaudible tone, because Chrome doesn't freeze tabs that are playing audio. It starts after your first click in the tab, and you can turn it off in the popup.

## Install

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this `KeepScramAlive` folder. Reload any Scram tabs that were already open.

For extra safety, also add `editor.buildwithscram.com` under **chrome://settings/performance → Always keep these sites active**.
