// Yama print helper: the background worker. It takes an order from a Yama tab (yama.js), checks
// it, keeps it as the one job, and opens MakePlayingCards on the page where a project starts.
importScripts("order.js");

const START = "https://www.makeplayingcards.com/design/custom-blank-card.html";

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "start") {
    (async () => {
      try {
        const order = checkOrder(msg.order);
        const job = { id: crypto.randomUUID(), order, phase: "setup", running: false, active: null, pids: {}, failed: [], modeAnswers: 0, from: sender.origin || null, at: new Date().toISOString() };
        await chrome.storage.local.set({ job });
        await chrome.tabs.create({ url: START });
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  return false;
});
