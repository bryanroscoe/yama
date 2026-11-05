// Yama print helper: what a print order from Yama must look like before the extension acts on
// it (packages/core/src/plan/mpc.ts makes it). Loaded by the background worker, and by
// order.test.mjs under Node.
const MPC_BRACKETS = [18, 36, 55, 72, 90, 108, 126, 144, 162, 180, 198, 216, 234, 396, 504, 612];
const MPC_STOCKS = ["(S27) Smooth", "(S30) Standard Smooth", "(S33) Superior Smooth", "(M31) Linen", "(P10) Plastic"];
const DRIVE_ID = /^[A-Za-z0-9_-]{20,80}$/;

/** The order if it's well formed, else throws saying what's wrong. Only known fields are kept. */
function checkOrder(o) {
  const fail = (why) => {
    throw new Error(`This print order can't be used: ${why}.`);
  };
  if (!o || typeof o !== "object" || o.v !== 1) fail("it isn't a Yama print order (version 1)");
  if (!MPC_STOCKS.includes(o.stock)) fail("unknown card stock");
  if (typeof o.foil !== "boolean") fail("foil isn't yes or no");
  if (o.foil && o.stock === "(P10) Plastic") fail("MakePlayingCards doesn't print foil on plastic");
  const q = o.quantity;
  if (!Number.isInteger(q) || q < 1 || q > 612) fail("the card count isn't 1 to 612");
  if (!MPC_BRACKETS.includes(o.bracket) || o.bracket < q || MPC_BRACKETS.some((b) => b >= q && b < o.bracket)) fail("the project size doesn't fit the card count");
  if (typeof o.cardback !== "string" || !DRIVE_ID.test(o.cardback)) fail("no card back");
  const name = typeof o.name === "string" ? o.name.slice(0, 60) : "Yama prints";
  const face = (list, what, everySlot) => {
    if (!Array.isArray(list) || list.length > q) fail(`the ${what} list is wrong`);
    const seen = new Set();
    const out = list.map((c) => {
      if (!c || typeof c.id !== "string" || !DRIVE_ID.test(c.id)) fail(`a ${what} image isn't an MPC Autofill image`);
      if (typeof c.name !== "string" || !c.name || c.name.length > 200) fail(`a ${what} image has no name`);
      if (!Array.isArray(c.slots) || !c.slots.length) fail(`a ${what} image has no slots`);
      for (const s of c.slots) {
        if (!Number.isInteger(s) || s < 0 || s >= q) fail(`a ${what} slot is outside the project`);
        if (seen.has(s)) fail(`two ${what} images share a slot`);
        seen.add(s);
      }
      return { id: c.id, name: c.name.replace(/[\\/:*?"<>|]/g, ""), slots: [...c.slots] };
    });
    if (everySlot && seen.size !== q) fail(`not every card has a ${what}`);
    return out;
  };
  return { v: 1, name, stock: o.stock, foil: o.foil, quantity: q, bracket: o.bracket, fronts: face(o.fronts, "front", true), backs: face(o.backs ?? [], "back", false), cardback: o.cardback };
}

/** The backs to place: each double-faced back on its slot, the common card back on the rest. */
function backImages(order) {
  const taken = new Set(order.backs.flatMap((b) => b.slots));
  const rest = [];
  for (let s = 0; s < order.quantity; s++) if (!taken.has(s)) rest.push(s);
  const common = rest.length ? [{ id: order.cardback, name: "Card back.png", slots: rest }] : [];
  return { same: order.backs.length === 0, images: [...common, ...order.backs] };
}

/** MPC's editor steps, in order, by the page each one is on. */
const STEPS = ["setup", "fronts", "frontText", "backs", "backText", "preview"];
const STEP_PAGES = {
  "/design/custom-blank-card.html": "setup",
  "/products/playingcard/design/dn_playingcards_front_dynamic.aspx": "fronts",
  "/design/dn_texteditor_front.aspx": "frontText",
  "/products/playingcard/design/dn_playingcards_back_dynamic.aspx": "backs",
  "/design/dn_texteditor_back.aspx": "backText",
  "/design/dn_preview_layout.aspx": "preview",
};

/**
 * What to do on page `here` (a step, or null for any other MPC page) when the order is at
 * `phase`: carry on with the step, catch up when MPC moved on after the helper stopped waiting,
 * begin again on a fresh project page, wait (MPC passes through pages of its own), or stop.
 */
function reconcile(phase, here) {
  if (phase === "done") return { act: "done", phase };
  if (!here) return phase === "setup" ? { act: "start", phase } : { act: "wait", phase };
  if (here === phase) return { act: "step", phase };
  if (STEPS.indexOf(here) === STEPS.indexOf(phase) + 1) return { act: "step", phase: here };
  if (here === "setup") return { act: "step", phase: "setup" };
  return { act: "mismatch", phase };
}

/** A run carries on by itself across MPC's page loads only while it's recent: a tab closed mid-run doesn't restart days later. */
const RUN_FRESH_MS = 3 * 60 * 1000;
function stillRunning(job, now) {
  return !!job && job.running === true && typeof job.active === "number" && now - job.active < RUN_FRESH_MS;
}

if (typeof module !== "undefined") module.exports = { checkOrder, backImages, reconcile, stillRunning, STEPS, STEP_PAGES, MPC_BRACKETS };
