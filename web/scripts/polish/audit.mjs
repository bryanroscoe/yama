// The in-page checks. `audit` runs inside the browser (page.evaluate), so it must stay
// self-contained: no imports, no closures over this module.
//
// Rects are viewport coordinates of the frame being audited. Every finding is a lead for a
// person (or Claude) to look at in the screenshot, not a verdict: some truncation is intended.

/**
 * @param {{ minTarget: number, edgePad: number, atEnd: boolean, spacingScale: number[] }} opts
 */
export function audit(opts) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const issues = [];
  const seen = new Set();

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let cur = el;
    for (let n = 0; cur && cur.nodeType === 1 && n < 3; n++, cur = cur.parentElement) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) s += `#${cur.id}`;
      const cls = [...cur.classList].filter((c) => !/^\d/.test(c)).slice(0, 2);
      if (cls.length) s += `.${cls.join(".")}`;
      parts.unshift(s);
      if (cur.id) break;
    }
    return parts.join(" > ");
  };
  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const add = (kind, severity, el, message, rect) => {
    const selector = describe(el);
    const key = `${kind}|${selector}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ kind, severity, selector, message, text: el ? textOf(el) : "", rect: rect ? box(rect) : el ? box(el.getBoundingClientRect()) : null });
  };
  const styleOf = (el) => getComputedStyle(el);
  const visible = (el) => {
    if (!el.isConnected) return false;
    const s = styleOf(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    // Screen-reader-only text.
    if (r.width <= 1 && r.height <= 1) return false;
    if (s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)") return false;
    return true;
  };
  const inView = (r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const ancestorHidden = (el) => {
    for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
      const s = styleOf(cur);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return true;
      if (cur.tagName === "DETAILS" && !cur.open && cur !== el && !el.closest("summary")) return true;
    }
    return false;
  };

  // Every rendered piece of text: its node, element and glyph box.
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n && texts.length < 4000; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(el.tagName)) continue;
    if (el.closest("[data-polish-overlay]")) continue;
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !inView(r)) continue;
    if (!visible(el) || ancestorHidden(el)) continue;
    texts.push({ node: n, el, rect: r, text: n.data.replace(/\s+/g, " ").trim() });
  }

  // 1. The page scrolls sideways, or something pokes out of the viewport.
  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollWidth > vw + 1) {
    add("page-overflow-x", "error", null, `The page is ${doc.scrollWidth}px wide in a ${vw}px viewport`, { left: 0, top: 0, width: doc.scrollWidth, height: 1 });
  }
  const clipsX = (el) => {
    for (let cur = el.parentElement; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      const s = styleOf(cur);
      if (s.overflowX !== "visible") {
        const r = cur.getBoundingClientRect();
        if (r.left >= -1 && r.right <= vw + 1) return true;
      }
    }
    return false;
  };
  const sticking = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("[data-polish-overlay]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > vh) continue;
    if (r.right > vw + 1 || r.left < -1) {
      if (sticking.some((p) => p.contains(el))) continue;
      if (!visible(el) || clipsX(el)) continue;
      const s = styleOf(el);
      if (s.position === "fixed" && (r.right <= 0 || r.left >= vw)) continue; // an off-screen drawer
      sticking.push(el);
      add("off-viewport", "error", el, `Pokes ${r.right > vw ? `${Math.round(r.right - vw)}px past the right` : `${Math.round(-r.left)}px past the left`} edge`, r);
    }
  }

  // 2. Text cut off by its box.
  const checked = new Set();
  for (const t of texts) {
    for (let el = t.el; el && el !== document.body && !checked.has(el); el = el.parentElement) {
      checked.add(el);
      const s = styleOf(el);
      const hiddenX = s.overflowX === "hidden" || s.overflowX === "clip";
      const hiddenY = s.overflowY === "hidden" || s.overflowY === "clip";
      if (hiddenX && el.scrollWidth > el.clientWidth + 1) {
        if (s.textOverflow === "ellipsis") add("truncated", "info", el, `Truncated with an ellipsis (${el.scrollWidth}px of text in ${el.clientWidth}px)`);
        else add("clipped-x", "warn", el, `Text cut off at the side (${el.scrollWidth}px of content in ${el.clientWidth}px)`);
      }
      if (hiddenY && el.scrollHeight > el.clientHeight + 2 && s.webkitLineClamp === "none" && el.clientHeight > 0) {
        add("clipped-y", "warn", el, `Text cut off at the bottom (${el.scrollHeight}px of content in ${el.clientHeight}px)`);
      }
    }
  }

  // 3. Text drawn over other text.
  const opaque = (el) => {
    const s = styleOf(el);
    if (s.backgroundImage !== "none") return true;
    const m = /rgba?\(([^)]+)\)/.exec(s.backgroundColor);
    if (!m) return false;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean);
    return parts.length < 4 || Number(parts[3]) > 0.5;
  };
  const cell = 64;
  const grid = new Map();
  texts.forEach((t, idx) => {
    for (let gx = Math.floor(t.rect.left / cell); gx <= Math.floor(t.rect.right / cell); gx++)
      for (let gy = Math.floor(t.rect.top / cell); gy <= Math.floor(t.rect.bottom / cell); gy++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(idx);
      }
  });
  const pairs = new Set();
  for (const bucket of grid.values()) {
    for (let a = 0; a < bucket.length; a++)
      for (let b = a + 1; b < bucket.length; b++) {
        const A = texts[bucket[a]];
        const B = texts[bucket[b]];
        if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
        const key = `${bucket[a]}-${bucket[b]}`;
        if (pairs.has(key)) continue;
        pairs.add(key);
        // Shrink line boxes a little: glyph boxes of adjacent lines touch by design.
        const ix = Math.min(A.rect.right, B.rect.right) - Math.max(A.rect.left, B.rect.left);
        const iy = Math.min(A.rect.bottom, B.rect.bottom) - Math.max(A.rect.top, B.rect.top);
        if (ix < 3 || iy < Math.min(A.rect.height, B.rect.height) * 0.35) continue;
        const cx = Math.max(A.rect.left, B.rect.left) + ix / 2;
        const cy = Math.max(A.rect.top, B.rect.top) + iy / 2;
        const stack = document.elementsFromPoint(cx, cy);
        const ia = stack.findIndex((e) => e === A.el || A.el.contains(e));
        const ib = stack.findIndex((e) => e === B.el || B.el.contains(e));
        if (ia === -1 || ib === -1) continue;
        const lower = ia > ib ? A.el : B.el;
        const covered = stack.slice(0, Math.max(ia, ib)).some((e) => e !== A.el && e !== B.el && !e.contains(lower) && opaque(e));
        if (covered) continue;
        add("text-overlap", "error", A.el, `"${A.text.slice(0, 30)}" overlaps "${B.text.slice(0, 30)}" (${describe(B.el)})`, {
          left: Math.max(A.rect.left, B.rect.left),
          top: Math.max(A.rect.top, B.rect.top),
          width: ix,
          height: iy,
        });
      }
  }

  // 4. Text against the screen edge (no page padding).
  if (opts.edgePad > 0) {
    for (const t of texts) {
      if (t.rect.left < opts.edgePad - 0.5 || t.rect.right > vw - opts.edgePad + 0.5) {
        if (t.rect.left < -1 || t.rect.right > vw + 1) continue; // reported as off-viewport
        if (styleOf(t.el).position === "fixed" && t.rect.width > vw * 0.9) continue;
        add("edge-text", "warn", t.el, `Text ${t.rect.left < opts.edgePad ? Math.round(t.rect.left) : Math.round(vw - t.rect.right)}px from the screen edge`, t.rect);
      }
    }
  }

  // 5. Small touch targets. Links inside running text are exempt (WCAG 2.5.8).
  const targets = document.querySelectorAll(
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])',
  );
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (!inView(r) || !visible(el) || ancestorHidden(el)) continue;
    if (el.closest("[data-polish-overlay]")) continue;
    const s = styleOf(el);
    if (s.display === "inline" && el.parentElement && textOf(el.parentElement).length > textOf(el).length + 10) continue;
    if (el.tagName === "INPUT" && /^(checkbox|radio)$/.test(el.type) && el.closest("label")) continue;
    if (r.width < opts.minTarget - 0.5 || r.height < opts.minTarget - 0.5) {
      add("small-target", "warn", el, `${Math.round(r.width)}×${Math.round(r.height)}px target (aim for ${opts.minTarget}px)`, r);
    }
  }

  // 6. Night table rules: sentence case (no all caps), no middle-dot meta strings, card images
  //    never filtered, blurred or faded, the artist credited wherever art shows.
  for (const t of texts) {
    const s = styleOf(t.el);
    const letters = t.text.replace(/[^A-Za-z]/g, "");
    if (s.textTransform === "uppercase" && letters.length >= 3) add("all-caps", "warn", t.el, `text-transform: uppercase on "${t.text.slice(0, 40)}"`, t.rect);
    else if (letters.length >= 5 && letters === letters.toUpperCase() && /[A-Z]{4,}/.test(t.text) && t.text.includes(" "))
      add("all-caps", "info", t.el, `All-caps text "${t.text.slice(0, 40)}"`, t.rect);
    if (t.text.includes("·") || t.text.includes("•")) add("middle-dot", "warn", t.el, `Middle-dot meta string "${t.text.slice(0, 50)}"`, t.rect);
  }
  let artShown = false;
  for (const img of document.images) {
    const r = img.getBoundingClientRect();
    if (!inView(r) || r.width < 4 || !visible(img)) continue;
    const src = img.currentSrc || img.src;
    if (img.complete && img.naturalWidth === 0 && src) add("broken-image", "error", img, `Image failed to load: ${src.slice(0, 120)}`, r);
    if (!/scryfall\.(io|com)/.test(src)) continue;
    if (/art_crop/.test(src)) artShown = true;
    let opacity = 1;
    for (let cur = img; cur && cur !== document.body; cur = cur.parentElement) {
      const s = styleOf(cur);
      opacity *= Number(s.opacity);
      if (s.filter !== "none" || (cur === img && s.mixBlendMode !== "normal")) {
        add("card-image-treated", "error", img, `Card image under filter "${s.filter}"${s.mixBlendMode !== "normal" ? ` / blend ${s.mixBlendMode}` : ""} (${describe(cur)})`, r);
        break;
      }
    }
    if (opacity < 0.99) add("card-image-treated", "warn", img, `Card image at ${Math.round(opacity * 100)}% opacity`, r);
  }
  for (const el of document.querySelectorAll("[style*='art_crop']")) {
    const r = el.getBoundingClientRect();
    if (inView(r) && visible(el)) artShown = true;
  }
  if (artShown && !texts.some((t) => /©|Art:|Illustrated|artist/i.test(t.text))) {
    add("art-credit", "warn", null, "Art crop on screen with no artist credit in view", null);
  }

  // 7. Copy: leftovers from code and typos a reader would notice.
  const copyRules = [
    [/\b(undefined|NaN|null|\[object Object\])\b/, "error", "Code value shown as text"],
    [/\b([A-Za-z]{2,})\s+\1\b/i, "warn", "Repeated word"],
    [/[A-Za-z0-9)]\s+[,.;:!?](\s|$)/, "warn", "Space before punctuation"],
    [/\b[a-z]{2,}[,;:!?][A-Za-z]{2,}/, "warn", "No space after punctuation"],
    [/\b[a-z]{3,}\.[A-Z][a-z]+/, "info", "No space after full stop (or a URL)"],
    [/ {2,}\S/, "info", "Double space"],
    [/\.\.\.(?!\.)/, "info", 'Three dots instead of "…"'],
    [/\(\s|\s\)/, "info", "Space inside parentheses"],
  ];
  for (const t of texts) {
    if (t.el.closest("code, pre, kbd, input, textarea, [contenteditable]")) continue;
    for (const [re, severity, label] of copyRules) {
      const m = re.exec(t.node.data);
      if (m) add("copy", severity, t.el, `${label}: "${t.node.data.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).replace(/\s+/g, " ").trim()}"`, t.rect);
    }
  }

  // 8. Content left under a fixed bar at the end of the page.
  if (opts.atEnd) {
    const bars = [...document.body.querySelectorAll("*")].filter((el) => {
      const s = styleOf(el);
      if (s.position !== "fixed" && s.position !== "sticky") return false;
      const r = el.getBoundingClientRect();
      return r.width > vw * 0.6 && r.height < vh * 0.4 && r.bottom >= vh - 2 && visible(el) && opaque(el);
    });
    for (const bar of bars) {
      const br = bar.getBoundingClientRect();
      for (const t of texts) {
        if (bar.contains(t.el) || t.el.contains(bar)) continue;
        if (t.rect.bottom > br.top + 2 && t.rect.top < br.bottom && t.rect.right > br.left && t.rect.left < br.right) {
          const top = document.elementFromPoint(t.rect.left + t.rect.width / 2, t.rect.top + t.rect.height / 2);
          if (top && (bar === top || bar.contains(top))) add("under-fixed-bar", "error", t.el, `Last content sits under ${describe(bar)} at the end of the page`, t.rect);
        }
      }
    }
  }

  // 9. Boxes touching: a visible box (border, fill, shadow, image) that sits flush against, or
  //    within a few px of, another box or a line of text that isn't inside it. Off-scale spacing
  //    can't see this: a missing gap is 0, which is on every scale.
  const minGap = opts.minGap ?? 4;
  const alpha = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const parts = m[1].split(/[ ,/]+/).filter(Boolean);
      return parts.length < 4 ? 1 : Number(parts[3]);
    }
    // color-mix() and friends compute to color(srgb r g b / a).
    if (c.startsWith("color(")) {
      const a = /\/\s*([\d.]+)\s*\)$/.exec(c);
      return a ? Number(a[1]) : 1;
    }
    return 0;
  };
  const boxed = (el, s) => {
    if (/^(IMG|VIDEO|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) return true;
    for (const side of ["Top", "Right", "Bottom", "Left"])
      if (parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none" && alpha(s[`border${side}Color`]) > 0.05) return true;
    return alpha(s.backgroundColor) > 0.04 || s.backgroundImage !== "none" || s.boxShadow !== "none";
  };
  const boxes = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (boxes.length >= 2500) break;
    if (el.closest("[data-polish-overlay], svg")) continue;
    const r = el.getBoundingClientRect();
    if (!inView(r) || r.width < 12 || r.height < 12 || r.width >= vw - 2) continue;
    const s = styleOf(el);
    if (s.display === "inline" || s.display === "contents" || s.position === "fixed") continue;
    if (!boxed(el, s) || !visible(el) || ancestorHidden(el)) continue;
    boxes.push({ el, rect: r, box: true });
  }
  const items = [...boxes, ...texts.map((t) => ({ el: t.el, rect: t.rect, text: t.text, box: false }))];
  const near = new Map();
  items.forEach((it, idx) => {
    // Bucket only the on-screen part: a tall panel on a long page would fill thousands of cells.
    const l = Math.max(it.rect.left, 0) - minGap;
    const r = Math.min(it.rect.right, vw) + minGap;
    const t = Math.max(it.rect.top, 0) - minGap;
    const b = Math.min(it.rect.bottom, vh) + minGap;
    for (let gx = Math.floor(l / cell); gx <= Math.floor(r / cell); gx++)
      for (let gy = Math.floor(t / cell); gy <= Math.floor(b / cell); gy++) {
        const k = `${gx},${gy}`;
        if (!near.has(k)) near.set(k, []);
        near.get(k).push(idx);
      }
  });
  // The layer an element is drawn in: its nearest fixed, sticky or absolute ancestor (null: the
  // page). A bottom tab bar passing over a form, or a dropdown's options over the content under
  // it, isn't a missing gap.
  const layers = new Map();
  const layerOf = (el) => {
    if (layers.has(el)) return layers.get(el);
    let layer = null;
    for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
      const p = styleOf(cur).position;
      if (p === "fixed" || p === "sticky" || (cur !== el && p === "absolute")) {
        layer = cur;
        break;
      }
    }
    layers.set(el, layer);
    return layer;
  };
  const large = (r) => r.width > vw * 0.4 || r.height > vh * 0.4;
  const nearPairs = new Set();
  for (const bucket of near.values()) {
    for (let a = 0; a < bucket.length; a++)
      for (let b = a + 1; b < bucket.length; b++) {
        const A = items[bucket[a]];
        const B = items[bucket[b]];
        if (!A.box && !B.box) continue; // lines of text sit close by design
        if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
        const key = `${bucket[a]}-${bucket[b]}`;
        if (nearPairs.has(key)) continue;
        nearPairs.add(key);
        const ox = Math.min(A.rect.right, B.rect.right) - Math.max(A.rect.left, B.rect.left);
        const oy = Math.min(A.rect.bottom, B.rect.bottom) - Math.max(A.rect.top, B.rect.top);
        // Gap along the axis they face each other on; the other axis must share at least 8px.
        let gap = null;
        if (ox >= 8 && oy <= 0.5) gap = -oy;
        else if (oy >= 8 && ox <= 0.5) gap = -ox;
        if (gap === null || gap < -0.5 || gap >= minGap) continue;
        // A text's own box (a label inside a pill) is already excluded; text in a box next door isn't.
        const [box, other] = A.box ? [A, B] : [B, A];
        if (!other.box && box.el.contains(other.el)) continue;
        // Meant to touch: different layers, tables, things pinned in place, page regions meeting
        // (sidebar and footer), and rows of a divided list.
        if (layerOf(A.el) !== layerOf(B.el)) continue;
        const table = A.el.closest("table");
        if (table && table === B.el.closest("table")) continue;
        if (styleOf(A.el).position === "absolute" || styleOf(B.el).position === "absolute") continue;
        if (large(A.rect) && large(B.rect)) continue;
        // A button or chip set in a line of text has a space or a comma beside it, not a gap.
        if (!other.box && oy >= 8 && styleOf(box.el).display.startsWith("inline")) continue;
        if (
          other.box &&
          A.el.parentElement === B.el.parentElement &&
          A.el.className === B.el.className &&
          gap <= 1 &&
          (oy >= 8 ? Math.abs(A.rect.height - B.rect.height) < 1 : Math.abs(A.rect.width - B.rect.width) < 1)
        )
          continue;
        const what = other.box ? describe(other.el) : `"${other.text.slice(0, 30)}"`;
        add(
          "touching",
          gap <= 1 ? "warn" : "info",
          box.el,
          `${gap <= 1 ? "Touches" : `${Math.round(gap)}px from`} ${what}`,
          {
            left: Math.min(A.rect.left, B.rect.left),
            top: Math.min(A.rect.top, B.rect.top),
            width: Math.max(A.rect.right, B.rect.right) - Math.min(A.rect.left, B.rect.left),
            height: Math.max(A.rect.bottom, B.rect.bottom) - Math.min(A.rect.top, B.rect.top),
          },
        );
      }
  }

  // Spacing off the 8 / 12 / 16 / 24 / 32 scale, counted by element, for the spacing summary.
  const offScale = {};
  const scale = new Set(opts.spacingScale);
  const props = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginBottom", "rowGap", "columnGap"];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!inView(r) || r.width < 2 || el.closest("[data-polish-overlay], svg")) continue;
    const s = styleOf(el);
    if (s.display === "inline" || s.display === "none") continue;
    for (const p of props) {
      const v = s[p];
      if (!v || v === "normal" || !v.endsWith("px")) continue;
      const px = Math.round(parseFloat(v) * 10) / 10;
      if (px === 0 || scale.has(px)) continue;
      const k = `${describe(el)}|${p}|${px}`;
      offScale[k] = (offScale[k] || 0) + 1;
    }
  }

  const loading = texts.filter((t) => /^(Loading|Fetching|Working)…?\.{0,3}$/i.test(t.text)).map((t) => t.text);
  if (loading.length && opts.atStart) add("still-loading", "warn", null, `Still says "${loading[0]}" after the page settled`, null);

  return { issues, offScale };
}

/** Outline the findings on screen for an annotated screenshot. */
export function drawOverlay(issues) {
  document.querySelectorAll("[data-polish-overlay]").forEach((e) => e.remove());
  const root = document.createElement("div");
  root.setAttribute("data-polish-overlay", "");
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const colors = { error: "#ff3b30", warn: "#ffcc00", info: "#5ac8fa" };
  issues.forEach((issue, n) => {
    if (!issue.rect) return;
    const { x, y, w, h } = issue.rect;
    const b = document.createElement("div");
    const c = colors[issue.severity] || "#fff";
    b.style.cssText = `position:absolute;left:${x - 2}px;top:${y - 2}px;width:${Math.max(w, 2) + 4}px;height:${Math.max(h, 2) + 4}px;outline:2px solid ${c};background:${c}22`;
    const tag = document.createElement("span");
    tag.textContent = String(n + 1);
    tag.style.cssText = `position:absolute;left:-2px;top:-18px;font:700 12px/16px system-ui;padding:0 4px;background:${c};color:#000;border-radius:3px`;
    b.appendChild(tag);
    root.appendChild(b);
  });
  document.body.appendChild(root);
}

export function clearOverlay() {
  document.querySelectorAll("[data-polish-overlay]").forEach((e) => e.remove());
}

/** Visible text in reading order, one line per block, for reading the copy. */
export function visibleText() {
  return (document.body.innerText || "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
