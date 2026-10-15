// Runs in the extension's isolated world on Scram editor pages.
//
// Spoofing visibility (spoof.js) can't stop Chrome from *freezing* a background tab, which halts all
// of its JavaScript; Energy Saver does this, for example. Chrome doesn't freeze or heavily throttle
// tabs that are playing audio, so this plays a tone far too quiet and too low to hear. Chrome only
// lets a page start audio after you've clicked or typed in it, so it starts on your first click.
(() => {
  // Chrome counts a tab as silent below about -72 dBFS; 0.001 is -60 dBFS, at 20 Hz, so inaudible.
  const GAIN = 0.001;
  const FREQUENCY_HZ = 20;

  let ctx = null;
  let wanted = true;

  const start = () => {
    if (!wanted) return;
    // Creating or resuming audio before the page has had a click or key press only gets blocked,
    // with a warning in the console, so wait for one.
    if (!navigator.userActivation?.hasBeenActive) return;
    try {
      if (!ctx) {
        ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = FREQUENCY_HZ;
        gain.gain.value = GAIN;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
      }
      if (ctx.state !== "running") ctx.resume().catch(() => {});
    } catch {
      /* audio unavailable */
    }
  };

  const stop = () => {
    if (ctx) ctx.suspend().catch(() => {});
  };

  const apply = (on) => {
    wanted = on !== false;
    if (wanted) start();
    else stop();
  };

  for (const type of ["pointerdown", "pointerup", "keydown", "click", "touchend"]) window.addEventListener(type, start, true);

  chrome.storage.local.get({ audioKeepAlive: true }, (s) => apply(s.audioKeepAlive));
  chrome.storage.onChanged.addListener((changes) => {
    if ("audioKeepAlive" in changes) apply(changes.audioKeepAlive.newValue);
  });

  // For the popup: is the keep-alive tone actually playing in this tab?
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "status") reply({ audio: ctx?.state === "running", wanted });
  });
})();
