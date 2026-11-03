// ScramAutoBuild's own Chrome window. Autopilot opens every tab it works in (exploration, sites
// to research, Scram) in this window, so it never takes over the window you're using. Inside it,
// its tab is the one on screen: pages aren't slowed down and Scram's AI keeps running — as long as
// the window isn't minimised. Off (Settings → Autopilot) = tabs in your current window, as before.

import * as store from "./storage.js";

const KEY = "workWindowId";

async function useOwnWindow() {
  return (await store.getSettings()).workInOwnWindow !== false;
}

async function existingWindow() {
  const { [KEY]: id } = await chrome.storage.local.get(KEY);
  if (id == null) return null;
  try {
    const w = await chrome.windows.get(id);
    return w.type === "normal" ? w : null;
  } catch {
    return null;
  }
}

// Opens a tab for Autopilot to work in and returns it. In its own window it's the active tab of
// that window (which doesn't touch your window); otherwise it's opened like before.
export async function openWorkTab(url) {
  if (!(await useOwnWindow())) return chrome.tabs.create({ url, active: true });
  const w = await existingWindow();
  if (w) {
    // Reuse a leftover blank tab in its window instead of piling up empty tabs.
    const tabs = await chrome.tabs.query({ windowId: w.id });
    const blank = tabs.find((t) => (t.url || t.pendingUrl || "") === "about:blank");
    if (blank) return chrome.tabs.update(blank.id, { url, active: true });
    return chrome.tabs.create({ windowId: w.id, url, active: true });
  }
  const created = await chrome.windows.create({ url, focused: false, type: "normal", state: "normal", width: 1440, height: 900 });
  await chrome.storage.local.set({ [KEY]: created.id });
  // A minimised window counts as hidden (Scram would pause its AI): un-minimise it if needed.
  if (created.state === "minimized") await chrome.windows.update(created.id, { state: "normal" }).catch(() => {});
  return created.tabs?.[0] || (await chrome.tabs.query({ windowId: created.id }))[0];
}

// Bring one of Autopilot's tabs to the front for you (e.g. to log in), window and all.
export async function showWorkTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const w = await chrome.windows.get(tab.windowId);
  if (w.state === "minimized") await chrome.windows.update(w.id, { state: "normal" });
  return tab;
}

export async function workWindowId() {
  return (await existingWindow())?.id ?? null;
}

// Done with a tab: close it, unless it's the last one in ScramAutoBuild's window (closing it would
// close the window) — then it's blanked and reused next time.
export async function closeWorkTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const others = (await chrome.tabs.query({ windowId: tab.windowId })).filter((t) => t.id !== tabId);
    if (others.length || tab.windowId !== (await workWindowId())) await chrome.tabs.remove(tabId);
    else await chrome.tabs.update(tabId, { url: "about:blank" });
  } catch {
    /* already closed */
  }
}
