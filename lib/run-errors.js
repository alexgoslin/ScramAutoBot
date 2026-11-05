// The last 20 errors and warnings of the current run, WITH the raw data that failed (e.g. the
// supervisor's actual reply that wasn't valid JSON, and the parse error). Ask Autopilot gets this
// verbatim, so it can explain what went wrong. Stored under its own key ("runErrors") so the run
// loop's saves never overwrite it.

const KEY = "runErrors";
const MAX = 20;
const RAW = 2000; // characters kept from the start and from the end of a failing input

// "first 2,000 … last 2,000" of a long text.
export function headTail(text, n = RAW) {
  text = String(text ?? "");
  return text.length <= n * 2 ? text : `${text.slice(0, n)}\n… [${(text.length - n * 2).toLocaleString()} characters omitted] …\n${text.slice(-n)}`;
}

let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn);
  chain = next.catch(() => {});
  return next;
}

// entry: { message, kind?: "error"|"warning", what?, raw?, parseError?, next? }
export function recordRunError(entry) {
  return serial(async () => {
    const { autopilot: a, [KEY]: cur } = await chrome.storage.local.get(["autopilot", KEY]);
    if (!a?.startedAt) return;
    const items = cur?.startedAt === a.startedAt ? cur.items || [] : [];
    const last = items[items.length - 1];
    const message = String(entry.message || "").slice(0, 2000);
    // The same failure reported twice in a row (e.g. by the caller and then by the run loop):
    // merge into one entry, keeping the raw detail and adding what happened next.
    if (last && last.message === message && Date.now() - last.t < 120000) {
      for (const k of ["what", "parseError", "attempts"]) if (entry[k] != null && last[k] == null) last[k] = entry[k];
      if (entry.raw != null && last.raw == null) last.raw = headTail(entry.raw);
      if (entry.firstRaw != null && last.firstRaw == null) last.firstRaw = headTail(entry.firstRaw);
      if (entry.next) last.next = last.next && last.next !== entry.next ? `${last.next} → ${entry.next}` : entry.next;
    } else {
      items.push({
        t: Date.now(),
        kind: entry.kind || "error",
        phase: a.phase,
        step: a.build?.totalSteps ? (a.build.step || 0) + 1 : null,
        round: a.build?.totalSteps ? a.build.rounds || 0 : null,
        ...entry,
        message,
        ...(entry.raw != null ? { raw: headTail(entry.raw) } : {}),
        ...(entry.firstRaw != null ? { firstRaw: headTail(entry.firstRaw) } : {}),
      });
    }
    await chrome.storage.local.set({ [KEY]: { startedAt: a.startedAt, items: items.slice(-MAX) } });
  });
}

export async function getRunErrors(startedAt) {
  const { [KEY]: cur } = await chrome.storage.local.get(KEY);
  return cur?.startedAt === startedAt ? cur.items || [] : [];
}
