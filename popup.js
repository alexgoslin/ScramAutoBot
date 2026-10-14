const $ = (s) => document.querySelector(s);

const audio = $("#audio");
chrome.storage.local.get({ audioKeepAlive: true }, (s) => (audio.checked = s.audioKeepAlive));
audio.addEventListener("change", () => chrome.storage.local.set({ audioKeepAlive: audio.checked }).then(render));

const span = (cls, text) => Object.assign(document.createElement("span"), { className: cls, textContent: text });

async function render() {
  const tabs = await chrome.tabs.query({ url: "https://editor.buildwithscram.com/*" });
  const list = $("#tabs");
  list.replaceChildren();
  $("#none").classList.toggle("hidden", tabs.length > 0);
  for (const tab of tabs) {
    const status = await chrome.tabs.sendMessage(tab.id, { type: "status" }).catch(() => null);
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("div"), { className: "title", textContent: tab.title || tab.url }));
    const state = document.createElement("div");
    state.className = "state";
    if (!status) {
      state.append(span("warn", "Reload this tab to activate"));
    } else {
      state.append(span(tab.autoDiscardable === false ? "ok" : "warn", tab.autoDiscardable === false ? "✓ Won't be unloaded" : "Can be unloaded"), " · ");
      if (!status.wanted) state.append(span("", "Audio keep-alive off"));
      else state.append(span(status.audio ? "ok" : "warn", status.audio ? "✓ Audio keep-alive on" : "Click in the tab once to start audio keep-alive"));
    }
    li.append(state);
    list.append(li);
  }
}
render();
