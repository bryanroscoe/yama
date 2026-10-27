/* Card-only progressive enhancement for the public stock lists. No account or list is sent. */
(() => {
  "use strict";
  let anchor = null;
  let panel = null;
  let pinned = false;
  let suppressFocus = false;
  const imageUrl = (raw) => {
    try { const u = new URL(raw); return u.protocol === "https:" && u.hostname === "cards.scryfall.io" ? u.href : null; } catch { return null; }
  };
  const ref = (target) => target && typeof target.closest === "function" ? target.closest(".public-card-ref") : null;
  const close = (restore) => {
    const previous = anchor;
    if (panel) panel.remove();
    if (anchor) { anchor.removeAttribute("aria-describedby"); anchor.removeAttribute("aria-expanded"); }
    panel = null;anchor = null;pinned = false;
    if (restore && previous) { suppressFocus = true;previous.focus(); }
  };
  const place = () => {
    if (!anchor || !panel) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(310, Math.max(1, window.innerWidth - 24));
    const h = Math.min(540, Math.max(1, window.innerHeight - 24));
    const right = r.right + 12;
    const x = right + w <= window.innerWidth - 12 ? right : Math.max(12, r.left - w - 12);
    panel.style.left = `${Math.min(x, Math.max(12, window.innerWidth - w - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(r.top, window.innerHeight - h - 12))}px`;
    panel.style.width = `${w}px`;panel.style.maxHeight = `${h}px`;
  };
  const show = (node, pin) => {
    const src = imageUrl(node.dataset.cardImage || "");
    if (!src) return false;
    if (anchor === node && panel) {
      pinned = pinned || pin;panel.classList.toggle("is-pinned", pinned);
      panel.setAttribute("role", pinned ? "dialog" : "tooltip");
      node.setAttribute("aria-expanded", String(pinned));if (pin) panel.querySelector("button").focus();return true;
    }
    close(false);anchor = node;pinned = !!pin;
    panel = document.createElement("div");panel.id = "public-card-preview";
    panel.className = `public-card-preview${pinned ? " is-pinned" : ""}`;
    panel.setAttribute("role", pinned ? "dialog" : "tooltip");
    panel.setAttribute("aria-label", node.dataset.cardName || node.textContent.trim());
    const image = document.createElement("img");image.src = src;image.alt = node.dataset.cardName || "Card";panel.appendChild(image);
    const footer = document.createElement("div");footer.className = "public-card-preview-actions";
    const details = document.createElement("a");details.href = node.href;details.textContent = "Open card details";details.target = "_blank";details.rel = "noreferrer";
    const button = document.createElement("button");button.type = "button";button.textContent = "Close";button.addEventListener("click", () => close(true));
    footer.appendChild(details);footer.appendChild(button);panel.appendChild(footer);
    image.addEventListener("error", () => { image.remove();const fallback = document.createElement("p");fallback.textContent = `${node.dataset.cardName || "Card"}: image unavailable. Open card details to inspect it.`;panel.insertBefore(fallback, footer); });
    document.body.appendChild(panel);node.setAttribute("aria-describedby", panel.id);node.setAttribute("aria-expanded", String(pinned));place();if (pin) button.focus();return true;
  };
  const enhance = () => {
    document.querySelectorAll(".public-card-ref").forEach((node) => {
      const src = imageUrl(node.dataset.cardImage || "");
      if (!src) return;
      node.setAttribute("aria-haspopup", "dialog");
      if (!node.querySelector("img")) { const thumb = document.createElement("img");thumb.src = src;thumb.alt = "";thumb.loading = "lazy";thumb.className = "public-card-thumb";node.insertBefore(thumb, node.firstChild); }
    });
  };
  document.addEventListener("pointerover", (event) => { if (event.pointerType === "touch" || pinned) return;const node = ref(event.target);if (node) show(node, false); });
  document.addEventListener("pointerout", (event) => { if (!pinned && anchor && ref(event.target) === anchor && ref(event.relatedTarget) !== anchor) close(false); });
  document.addEventListener("focusin", (event) => { if (suppressFocus) { suppressFocus = false;return; }if (pinned) return;const node = ref(event.target);if (node) show(node, false); });
  document.addEventListener("focusout", () => { if (!pinned) close(false); });
  document.addEventListener("click", (event) => {
    const node = ref(event.target);
    if (node && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && (!event.button || event.button === 0)) { if (show(node, true)) event.preventDefault();return; }
    if (pinned && panel && !panel.contains(event.target)) close(false);
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && panel) { event.preventDefault();close(true); } });
  window.addEventListener("resize", place);window.addEventListener("scroll", place, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhance); else enhance();
})();
