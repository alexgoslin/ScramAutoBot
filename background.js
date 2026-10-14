// Stops Chrome's Memory Saver from discarding (unloading) Scram editor tabs while they're in the
// background. A discarded tab is reloaded from scratch when you go back to it, killing whatever
// was running in it.
const SCRAM_EDITOR = /^https:\/\/editor\.buildwithscram\.com\//i;

const protect = (tab) => {
  if (tab?.id == null || !SCRAM_EDITOR.test(tab.url || tab.pendingUrl || "")) return;
  if (tab.autoDiscardable === false) return;
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
};

const protectAll = () => chrome.tabs.query({ url: "https://editor.buildwithscram.com/*" }, (tabs) => tabs.forEach(protect));

chrome.runtime.onInstalled.addListener(protectAll);
chrome.runtime.onStartup.addListener(protectAll);
chrome.tabs.onCreated.addListener(protect);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.url || change.status === "loading" || "autoDiscardable" in change) protect(tab);
});
// A tab that Chrome swaps in (prerender, back/forward) gets a new id.
chrome.tabs.onReplaced.addListener((addedId) => chrome.tabs.get(addedId).then(protect).catch(() => {}));
