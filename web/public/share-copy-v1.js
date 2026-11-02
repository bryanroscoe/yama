/* Copy buttons on shared pages: a button[data-copy] copies the text box with that id. The
   buttons start hidden, so without this script the boxes are simply there to select. */
(() => {
  "use strict";
  const reveal = () => document.querySelectorAll("button[data-copy]").forEach((b) => { b.hidden = false; });
  document.addEventListener("click", async (event) => {
    const button = event.target && typeof event.target.closest === "function" ? event.target.closest("button[data-copy]") : null;
    if (!button) return;
    const box = document.getElementById(button.dataset.copy);
    if (!box) return;
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    try {
      await navigator.clipboard.writeText(box.value);
      button.textContent = "Copied";
    } catch {
      box.focus();box.select();
      button.textContent = "Selected: press copy";
    }
    setTimeout(() => { button.textContent = label; }, 2000);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reveal); else reveal();
})();
