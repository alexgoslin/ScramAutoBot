// "Web-first" mode (CONTROL_CENTER_WEB_FIRST_ADDENDUM.md): when the extension is connected to the
// Control Center and Dev mode is off, every question, confirmation, resume and retry happens on
// the website. Dev mode (the side-panel switch) keeps the side panel as before.

// Connected to the Control Center and not in Dev mode.
export async function isWebMode() {
  const { bridge, uiDevMode } = await chrome.storage.local.get(["bridge", "uiDevMode"]);
  return uiDevMode !== true && !!(bridge?.enabled && bridge.token && bridge.computerId) && bridge.status !== "error";
}

// The run's messages mention the side panel ("in the Category tab", "press Resume"…). What the
// Control Center shows, and notifications in web mode, say where it's done instead. Keeps the
// words the app keys on ("log in", "Paused by you").
export function forWeb(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(/press “I'm logged in — explore it” in the (Category tab|side panel)/g, "press “I'm logged in” on the Control Center")
    .replace(/press “I'm logged in — explore it”/g, "press “I'm logged in” on the Control Center")
    .replace(/\(or Skip this site\)/g, "(or skip this site there)")
    .replace(/(Open it )?from the Autopilot card in the side panel/gi, (m, open) => (open ? "Open it on the Control Center" : "on the Control Center"))
    .replace(/\s*\(or use the recommended answers\)/gi, "")
    .replace(/in the (Category tab|side panel|Autopilot card|Files tab)/gi, "on the Control Center")
    .replace(/message me in the log below/gi, "message me in the run's chat on the Control Center")
    .replace(/Ask me anything about the run below/gi, "Ask me anything about the run in its chat on the Control Center")
    .replace(/See the Autopilot log/gi, "See the run's log on the Control Center")
    .replace(/Clear and start again/g, "Clear this run on the Control Center and start again")
    .replace(/\bpress Resume\b(?! on the Control Center)/g, "press Resume on the Control Center")
    .replace(/\bpress Resume on the Control Center there\b/g, "press Resume on the Control Center");
}
