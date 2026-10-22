const $ = (s) => document.querySelector(s);

const audio = $("#audio");
chrome.storage.local.get({ audioKeepAlive: true }, (s) => (audio.checked = s.audioKeepAlive));
audio.addEventListener("change", () => chrome.storage.local.set({ audioKeepAlive: audio.checked }).then(render));

const tag = (kind, text) => Object.assign(document.createElement("span"), { className: `tag ${kind}`, textContent: text });

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
      state.append(tag("warn", "Reload this tab to activate"));
    } else {
      state.append(tab.autoDiscardable === false ? tag("ok", "✓ Won't be unloaded") : tag("warn", "Can be unloaded"));
      if (!status.wanted) state.append(tag("", "Audio off"));
      else state.append(status.audio ? tag("ok", "✓ Audio on") : tag("warn", "Click in the tab to start audio"));
    }
    li.append(state);
    list.append(li);
  }
}
render();
