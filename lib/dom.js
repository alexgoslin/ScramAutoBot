// Service-worker side of content/agent-dom.js.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Call window.__sabDom[method](...args) in the tab, injecting the helper if needed.
export async function dom(tabId, method, ...args) {
  const run = async () => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m, a) => (window.__sabDom ? window.__sabDom[m](...a) : "__sab_missing__"),
      args: [method, args],
    });
    return res?.result;
  };
  let result = await run();
  if (result === "__sab_missing__") {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/agent-dom.js"] });
    result = await run();
  }
  return result;
}

export function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => id === tabId && info.status === "complete" && finish();
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && setTimeout(() => chrome.tabs.get(tabId).then((t2) => t2.status === "complete" && finish()), 300)).catch(finish);
  });
}

export async function navigate(tabId, url, settleMs = 2000) {
  await chrome.tabs.update(tabId, { url });
  await sleep(300);
  await waitForLoad(tabId);
  await sleep(settleMs); // let SPAs render
}

// Screenshot of the tab's visible area, downscaled to keep image tokens reasonable.
export async function screenshot(tabId, maxWidth = 1280) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await sleep(250);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bmp.width);
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch {
    return dataUrl.split(",")[1];
  }
}
