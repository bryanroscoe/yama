// Yama print helper on MakePlayingCards: walks the order through MPC's project editor one page
// at a time (setup, fronts, front text, backs, back text, preview), asking page.js to do each
// page's work, and shows where it is in a small panel. It starts only when you press Fill in,
// stops at MPC's preview, and leaves the confirmation and the cart to you.
(() => {
  const BASE = "https://www.makeplayingcards.com";
  const START = `${BASE}/design/custom-blank-card.html`;
  const PAGES = {
    "/design/custom-blank-card.html": "setup",
    "/products/playingcard/design/dn_playingcards_front_dynamic.aspx": "fronts",
    "/design/dn_texteditor_front.aspx": "frontText",
    "/products/playingcard/design/dn_playingcards_back_dynamic.aspx": "backs",
    "/design/dn_texteditor_back.aspx": "backText",
    "/design/dn_preview_layout.aspx": "preview",
  };
  const STEP_NAMES = { setup: "set up the project", fronts: "the fronts", frontText: "the fronts' text step", backs: "the backs", backText: "the backs' text step", preview: "the preview", done: "done" };
  const here = PAGES[location.pathname] || null;

  let job = null;
  let signedIn = false;

  const get = async () => (await chrome.storage.local.get("job")).job || null;
  const put = async () => chrome.storage.local.set({ job });

  // --- talking to page.js -------------------------------------------------------------------
  let seq = 0;
  const waiting = new Map();
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.yamaMpcRes && waiting.has(m.yamaMpcRes)) {
      const w = waiting.get(m.yamaMpcRes);
      waiting.delete(m.yamaMpcRes);
      m.ok ? w.resolve(m.value) : w.reject(new Error(m.error));
    } else if (m.yamaMpcProgress && typeof m.text === "string") {
      status(m.text);
    }
  });
  function call(cmd, args, ms = 0) {
    const id = `yama-${Date.now()}-${++seq}`;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      window.postMessage({ yamaMpcCmd: id, cmd, args }, location.origin);
      if (ms) {
        setTimeout(() => {
          if (waiting.delete(id)) reject(new Error("timed out"));
        }, ms);
      }
    });
  }
  async function pageReady() {
    for (let i = 0; i < 40; i++) {
      try {
        return await call("look", {}, 500);
      } catch {
        // page.js not listening yet
      }
    }
    throw new Error("The helper couldn't reach MakePlayingCards' page. Reload it.");
  }

  // --- the panel ----------------------------------------------------------------------------
  const host = document.createElement("div");
  host.id = "yama-mpc-helper";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 320px; max-width: calc(100vw - 32px);
        background: #15171a; color: #f2efe8; border: 1px solid #2a2e33; border-radius: 10px; padding: 14px 16px;
        font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.45); }
      h2 { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
      p { margin: 6px 0; color: #a9adb3; }
      .status { color: #f2efe8; }
      .err { color: #f07a62; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      button, a.btn { font: inherit; border-radius: 6px; padding: 6px 12px; cursor: pointer; text-decoration: none; }
      .primary { background: #f2efe8; color: #0b0c0e; border: 1px solid #f2efe8; }
      .quiet { background: #1e2125; color: #f2efe8; border: 1px solid #2a2e33; }
      .min { position: absolute; top: 8px; right: 10px; background: none; border: 0; color: #a9adb3; padding: 2px 6px; }
      ul { margin: 6px 0 0; padding-left: 18px; color: #f07a62; max-height: 120px; overflow: auto; }
    </style>
    <div class="box" role="region" aria-label="Yama print helper">
      <button class="min" title="Hide" aria-label="Hide">&times;</button>
      <h2>Yama print order</h2>
      <p class="what"></p>
      <p class="status" aria-live="polite"></p>
      <ul hidden></ul>
      <div class="row"></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  $(".min").addEventListener("click", () => host.remove());
  const status = (text, err = false) => {
    $(".status").textContent = text;
    $(".status").className = err ? "status err" : "status";
  };
  const failures = (list) => {
    const ul = $("ul");
    ul.hidden = !list.length;
    ul.replaceChildren(...list.map((f) => Object.assign(document.createElement("li"), { textContent: f })));
  };
  function buttons(list) {
    $(".row").replaceChildren(
      ...list.map(([label, fn, primary]) => {
        if (typeof fn === "string") return Object.assign(document.createElement("a"), { className: `btn ${primary ? "primary" : "quiet"}`, href: fn, textContent: label });
        const b = Object.assign(document.createElement("button"), { className: primary ? "primary" : "quiet", textContent: label });
        b.addEventListener("click", fn);
        return b;
      }),
    );
  }
  const describe = () => {
    const o = job.order;
    const dfc = o.backs.reduce((n, b) => n + b.slots.length, 0);
    $(".what").textContent = `${o.quantity} ${o.quantity === 1 ? "card" : "cards"} on ${o.stock}${o.foil ? ", holographic foil" : ""}, in a ${o.bracket}-card project${dfc ? `, ${dfc} double-faced` : ""}.`;
  };

  // --- the steps ----------------------------------------------------------------------------
  /** Record the next step, then take it; if MPC doesn't move, stay on this one. */
  async function go(phase, then) {
    const was = job.phase;
    job.phase = phase;
    await put();
    try {
      await then();
    } catch (e) {
      job.phase = was;
      await put();
      throw e;
    }
  }

  async function stop(text, err = true) {
    job.running = false;
    await put();
    status(text, err);
    offer();
  }

  async function fillFace(face) {
    const o = job.order;
    const plan = face === "front" ? { same: false, images: o.fronts } : backImages(o);
    const images = plan.images.map((i) => ({ ...i, pid: job.pids[i.id] || null }));
    const r = await call("fill", { face, quantity: o.quantity, same: plan.same, images });
    if (r.reloading) {
      status(face === "front" ? "Setting the card count." : "Setting up the backs.");
      return false;
    }
    Object.assign(job.pids, r.pids);
    job.failed = r.failed;
    await put();
    failures(r.failed);
    if (r.failed.length || r.done < r.total) {
      await stop(`${r.done} of ${r.total} ${face === "front" ? "fronts" : "backs"} placed. Fix or retry the ones below.`);
      return false;
    }
    if (signedIn) {
      status("Saving the project to your MakePlayingCards account.");
      const saved = await call("save", { name: o.name }, 45000).catch(() => ({ saved: false }));
      if (!saved.saved) status("Couldn't save the project to your account; carrying on.");
    }
    return true;
  }

  async function step() {
    if (!job || !job.running) return offer();
    try {
      const look = await pageReady();
      signedIn = look.signedIn;
      if (job.phase === "done") return offer();
      // MPC passes through pages of its own between steps (pro_item_process_flow.aspx).
      if (!here && job.phase !== "setup") {
        status("Waiting for MakePlayingCards to open the next step.", false);
        return;
      }
      if (here !== job.phase) {
        if (job.phase === "setup") {
          status("Going to the start of a new project.");
          location.href = START;
          return;
        }
        return stop(`This order is on ${STEP_NAMES[job.phase]}, but this page is another step. Start over to begin a fresh project.`);
      }
      switch (here) {
        case "setup":
          status("Choosing card stock and project size.");
          return go("fronts", () => call("setup", { stock: job.order.stock, bracket: job.order.bracket, foil: job.order.foil }, 30000));
        case "fronts":
          if (await fillFace("front")) return go("frontText", () => call("next", {}, 90000));
          return;
        case "frontText":
          return go("backs", () => call("skipText", {}, 90000));
        case "backs":
          if (await fillFace("back")) return go("backText", () => call("next", {}, 90000));
          return;
        case "backText":
          return go("preview", () => call("skipText", {}, 90000));
        case "preview":
          job.phase = "done";
          job.running = false;
          await put();
          return offer();
      }
    } catch (e) {
      return stop(e.message || String(e));
    }
  }

  function offer() {
    if (!job) return;
    describe();
    failures(job.failed || []);
    const forget = ["Forget this order", async () => {
      await chrome.storage.local.remove("job");
      host.remove();
    }];
    if (job.phase === "done") {
      status("Filled in. Check every card in MakePlayingCards' preview, tick its confirmation and add to cart yourself.", false);
      buttons([forget]);
      return;
    }
    if (job.running) {
      buttons([["Stop after this step", async () => {
        job.running = false;
        await put();
        status("Stopping after this step.", false);
      }]]);
      return;
    }
    const startOver = ["Start over", async () => {
      job.phase = "setup";
      job.running = true;
      job.failed = [];
      await put();
      location.href = START;
    }];
    const resume = [job.phase === "setup" ? "Fill in" : "Continue", async () => {
      job.running = true;
      await put();
      buttons([]);
      step();
    }, true];
    if (job.phase === "setup" && !signedIn) {
      $(".status").textContent ||= "Sign in to MakePlayingCards first so the project is saved to your account, or fill it in as a guest.";
      buttons([["Sign in", `${BASE}/login.aspx`, true], ["Fill in as a guest", resume[1]], forget]);
      return;
    }
    buttons(job.phase === "setup" ? [resume, forget] : [resume, startOver, forget]);
  }

  (async () => {
    job = await get();
    // A finished order shows only on the preview it finished on.
    if (!job || (job.phase === "done" && here !== "preview")) return;
    document.documentElement.appendChild(host);
    try {
      signedIn = (await pageReady()).signedIn;
    } catch (e) {
      status(e.message, true);
    }
    if (job.running) step();
    else offer();
  })();
})();
