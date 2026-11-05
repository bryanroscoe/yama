// Yama print helper on Yama's own pages: says it's installed, and passes a print order the page
// sends (Print with MakePlayingCards) to the background worker. Only messages from this page
// itself count.
const VERSION = chrome.runtime.getManifest().version;
document.documentElement.dataset.yamaMpc = VERSION;

window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data;
  if (!m || typeof m !== "object" || m.yamaMpc !== 1) return;
  if (m.type === "hello") {
    window.postMessage({ yamaMpcExt: 1, type: "ready", version: VERSION }, location.origin);
    return;
  }
  if (m.type === "order") {
    chrome.runtime.sendMessage({ type: "start", order: m.order }, (res) => {
      const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : res && !res.ok ? res.error : null;
      window.postMessage({ yamaMpcExt: 1, type: error ? "refused" : "started", error }, location.origin);
    });
  }
});

window.postMessage({ yamaMpcExt: 1, type: "ready", version: VERSION }, location.origin);
