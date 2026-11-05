// Yama print helper: the part that runs in MakePlayingCards' own page (the "MAIN" world), where
// its editor's functions live. It does only what mpc.js asks, one command at a time, and answers
// with window.postMessage. It never ticks MPC's copyright confirmation or adds to the cart.
//
// MPC has no API. These are the page functions its editor uses, the same ones MPC Autofill's
// desktop tool calls (github.com/chilli-axe/mpc-autofill, desktop-tool/src/driver.py); Yama's
// code is its own (ARCHITECTURE.md, "Printing with MakePlayingCards").
(() => {
  if (window.__yamaMpcPage) return;
  window.__yamaMpcPage = true;

  const IMAGE_SERVICE = "https://cdn.mpcautofill.com/images/google_drive/full/";
  /** Plenty for MPC's 300 dpi print, a third of the size of the 1200 dpi originals. */
  const DPI = 800;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DRIVE_ID = /^[A-Za-z0-9_-]{20,80}$/;

  const progress = (text, extra = {}) => window.postMessage({ yamaMpcProgress: true, text, ...extra }, location.origin);

  async function defined(test, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (test()) return true;
      } catch {
        // not loaded yet
      }
      await sleep(250);
    }
    return false;
  }

  /** MPC's loading spinner is up, or an upload is still going. */
  function busy() {
    const w = document.getElementById("sysdiv_wait");
    const spinning = !!w && w.offsetParent !== null;
    const uploading = typeof oDesignImage !== "undefined" && oDesignImage.UploadStatus === "Uploading";
    return spinning || uploading;
  }

  async function idle(ms = 180000) {
    const end = Date.now() + ms;
    while (busy() && Date.now() < end) await sleep(250);
    return !busy();
  }

  /** MPC's own alert boxes stop a script; note them instead while Yama is filling. */
  let alerts = [];
  const realAlert = window.alert;
  const quietAlerts = (on) => {
    window.alert = on ? (m) => alerts.push(String(m)) : realAlert;
  };

  const modeFrame = () => {
    const f = document.getElementById("sysifm_loginFrame");
    if (!f) return null;
    try {
      const w = f.contentWindow;
      return w && w.document.getElementById("txt_card_number") && typeof w.setMode === "function" ? w : null;
    } catch {
      return null;
    }
  };

  const slot = (n) => PageLayout.prototype.getElement3("dnImg", String(n));
  const hasSlot = (n) => {
    try {
      return !!slot(n);
    } catch {
      return false;
    }
  };
  const pidIn = (n) => slot(n)?.getAttribute("pid") || null;
  const uploaded = () => (oDesignImage.dn_getImageList() || "").split(";").filter(Boolean);

  async function sha1(buf) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
    return [...d].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  async function download(img) {
    if (!DRIVE_ID.test(img.id)) throw new Error(`not an MPC Autofill image id: ${img.id}`);
    let last;
    for (let t = 0; t < 3; t++) {
      try {
        const res = await fetch(`${IMAGE_SERVICE}${img.id}.jpg?dpi=${DPI}&jpgQuality=100`, { credentials: "omit" });
        if (!res.ok) throw new Error(`image service answered ${res.status}`);
        const blob = await res.blob();
        if (!/^image\//.test(blob.type) || blob.size < 1000) throw new Error("image service sent no image");
        const pid = await sha1(await blob.arrayBuffer());
        return { blob, pid };
      } catch (e) {
        last = e;
        await sleep(1500 * (t + 1));
      }
    }
    throw last;
  }

  /** MPC names an uploaded image by the SHA-1 of its bytes. */
  async function upload(file, pid) {
    if (uploaded().includes(pid)) return true;
    for (let t = 0; t < 3; t++) {
      await idle();
      const before = uploaded().length;
      const input = document.getElementById("uploadId");
      if (!input) throw new Error("MakePlayingCards' upload box isn't on this page");
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Wait for MPC to start (or finish) the upload before judging it, so a slow start isn't
      // taken for a refusal and the same file sent again.
      const end = Date.now() + 15000;
      while (Date.now() < end && !busy() && !uploaded().includes(pid) && uploaded().length <= before) await sleep(200);
      await idle();
      if (uploaded().includes(pid) || uploaded().length > before) return true;
      await sleep(1500);
      if (uploaded().includes(pid) || uploaded().length > before) return true;
    }
    return false;
  }

  async function place(pid, slots) {
    let placed = 0;
    for (const s of slots) {
      if (!hasSlot(s)) continue;
      for (let t = 0; t < 4 && pidIn(s) !== pid; t++) {
        await idle();
        if (t) await sleep(500 * t);
        PageLayout.prototype.applyDragPhoto(slot(s), 0, pid);
        await sleep(300);
        await idle();
      }
      if (pidIn(s) === pid) placed++;
    }
    return placed;
  }

  /**
   * Fill one face. `images` is [{id, name, slots, pid?}]; `same` asks MPC for one image on every
   * card (a common back). The first visit to a face's page answers MPC's "how many cards, same
   * or different images" box, which reloads the page; the next visit uploads and places.
   */
  async function fill({ images, quantity, same, face }) {
    if (!(await defined(() => typeof PageLayout !== "undefined" && typeof oDesignImage !== "undefined" && (modeFrame() || hasSlot(0))))) {
      throw new Error("MakePlayingCards' editor didn't load");
    }
    // Slots mean the box has been answered; MPC can leave its frame in the page after that.
    const frame = hasSlot(0) ? null : modeFrame();
    if (frame) {
      const qty = frame.document.getElementById("txt_card_number");
      if (face === "front") qty.value = String(quantity);
      setTimeout(() => frame.setMode("ImageText", same ? 1 : 0), 50);
      return { reloading: true };
    }
    // Every card the order needs should have a slot: one per card, or one for a common back.
    const expected = same ? 1 : quantity;
    await defined(() => hasSlot(expected - 1), 15000);
    let slots = 0;
    for (let n = 0; n < expected; n++) if (hasSlot(n)) slots++;
    quietAlerts(true);
    alerts = [];
    const pids = {};
    const failed = [];
    let done = 0;
    const total = images.reduce((n, i) => n + i.slots.filter(hasSlot).length, 0);
    try {
      const todo = images.filter((img) => {
        const slots = img.slots.filter(hasSlot);
        const finished = img.pid && slots.every((s) => pidIn(s) === img.pid);
        if (finished) {
          pids[img.id] = img.pid;
          done += slots.length;
        }
        return slots.length && !finished;
      });
      let next = todo.length ? download(todo[0]).catch((e) => e) : null;
      for (let i = 0; i < todo.length; i++) {
        const img = todo[i];
        progress(`${face === "front" ? "Fronts" : "Backs"}: ${done} of ${total} placed. Uploading ${img.name}.`, { done, total });
        const got = await next;
        next = i + 1 < todo.length ? download(todo[i + 1]).catch((e) => e) : null;
        if (got instanceof Error) {
          failed.push(`${img.name} (${got.message})`);
          continue;
        }
        pids[img.id] = got.pid;
        if (!(await upload(new File([got.blob], img.name, { type: got.blob.type }), got.pid))) {
          failed.push(`${img.name} (MakePlayingCards didn't take the upload)`);
          continue;
        }
        const slots = img.slots.filter(hasSlot);
        const placed = await place(got.pid, slots);
        done += placed;
        if (placed < slots.length) failed.push(`${img.name} (${slots.length - placed} of ${slots.length} slots didn't take it)`);
      }
      progress(`${face === "front" ? "Fronts" : "Backs"}: ${done} of ${total} placed.`, { done, total });
      return { done, total, slots, expected, failed, pids, alerts };
    } finally {
      quietAlerts(false);
    }
  }

  let leaving = false;
  window.addEventListener("pagehide", () => (leaving = true));
  window.addEventListener("beforeunload", () => (leaving = true));

  /**
   * MPC's next step. Right after the last image goes in, MPC sometimes ignores the call while it
   * saves in the background, so wait for quiet, then ask again until the page actually changes.
   */
  async function moveOn() {
    // Five tries, each at most 20 s quiet + 3 s + 12 s: under four minutes (mpc.js MOVE_MS).
    for (let t = 0; t < 5; t++) {
      await idle(20000);
      await sleep(t ? 3000 : 1500);
      if (leaving) return { navigating: true };
      oDesign.setNextStep();
      const end = Date.now() + 12000;
      while (Date.now() < end) {
        if (leaving) return { navigating: true };
        await sleep(250);
      }
    }
    throw new Error("MakePlayingCards didn't move on to the next step. Press Continue to try again.");
  }

  const commands = {
    /** Which page this is, and whether someone is signed in. */
    async look() {
      // A visible Sign out link; MPC's editor pages keep a hidden one for guests too.
      const out = [...document.querySelectorAll("a[href]")].some((a) => {
        try {
          return /\/logout\.aspx$/i.test(new URL(a.href, location.href).pathname) && a.offsetParent !== null;
        } catch {
          return false;
        }
      });
      return { signedIn: out, path: location.pathname };
    },

    /** The first page: card stock, project size and foil, then on to the fronts. */
    async setup({ stock, bracket, foil }) {
      if (!(await defined(() => typeof doPersonalize === "function" && document.getElementById("dro_choosesize")))) {
        throw new Error("MakePlayingCards' product page didn't load");
      }
      const pick = (id, test) => {
        const el = document.getElementById(id);
        const opt = el && [...el.options].find(test);
        if (!opt) return false;
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      if (!pick("dro_paper_type", (o) => o.text.trim() === stock)) throw new Error(`MakePlayingCards doesn't offer ${stock} here`);
      if (!pick("dro_choosesize", (o) => Number(o.value) === bracket)) throw new Error(`MakePlayingCards doesn't offer a ${bracket}-card project here`);
      if (foil && !pick("dro_product_effect", (o) => o.value === "EF_055")) throw new Error("MakePlayingCards doesn't offer holographic foil here");
      setTimeout(() => doPersonalize(`${location.origin}/products/pro_item_process_flow.aspx`), 50);
      return { navigating: true };
    },

    fill,

    /** The add-text steps: nothing to add, on to the next. */
    async skipText() {
      if (!(await defined(() => typeof oDesign !== "undefined" && typeof oDesign.setNextStep === "function"))) throw new Error("MakePlayingCards' text step didn't load");
      await sleep(600);
      const close = document.getElementById("closeBtn");
      if (close && close.offsetParent !== null) close.click();
      return moveOn();
    },

    next: () => moveOn(),

    /** Save the project to the signed-in account, so a long upload isn't lost. */
    async save({ name }) {
      const box = document.getElementById("txt_temporaryname");
      if (!box || typeof oDesign === "undefined" || typeof oDesign.setTemporarySave !== "function") return { saved: false };
      box.value = name;
      oDesign.setTemporarySave();
      const status = document.getElementById("div_temporarysavestatus");
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        if (status && /Saved successfully/i.test(status.textContent || "")) return { saved: true };
        await sleep(500);
      }
      return { saved: false };
    },
  };

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || typeof m !== "object" || !m.yamaMpcCmd || !commands[m.cmd]) return;
    try {
      const value = await commands[m.cmd](m.args || {});
      window.postMessage({ yamaMpcRes: m.yamaMpcCmd, ok: true, value }, location.origin);
    } catch (err) {
      window.postMessage({ yamaMpcRes: m.yamaMpcCmd, ok: false, error: String((err && err.message) || err) }, location.origin);
    }
  });
  window.postMessage({ yamaMpcPageReady: true }, location.origin);
})();
