/* Live filters and endless scrolling for the public precon and commander lists. The server still
   renders every list: without this script the form's Apply button and the Next link work as before.
   Typing or changing a filter fetches the same page and swaps in its #results; reaching the
   bottom fetches the next page and appends its rows. Nothing but the filters is sent. */
(() => {
  "use strict";
  const form = document.querySelector("form.public-filters[data-live]");
  const results = document.getElementById("results");
  if (!form || !results || !window.fetch || !window.DOMParser || !window.AbortController) return;

  const status = document.createElement("p");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  form.after(status);
  form.classList.add("is-live");

  let generation = 0;
  let searching = null;
  let paging = null;
  let timer = 0;
  let observer = null;
  let last = location.pathname + location.search;

  const target = () => {
    const u = new URL(form.getAttribute("action") || location.pathname, location.href);
    for (const [k, v] of new FormData(form)) if (typeof v === "string" && v !== "") u.searchParams.append(k, v);
    return u.pathname + u.search;
  };
  const fetchResults = async (href, signal) => {
    const res = await fetch(href, { signal, credentials: "same-origin", headers: { Accept: "text/html" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = new DOMParser().parseFromString(await res.text(), "text/html").getElementById("results");
    if (!next) throw new Error("no results");
    return next;
  };
  const shown = () => results.querySelectorAll("tbody > tr").length;
  // After rows are appended the server's "Page 2 of 8" no longer describes the list.
  const recount = () => {
    const label = results.querySelector(".pagination > span");
    const total = Number(results.dataset.matched);
    if (label && total) label.textContent = `Showing ${shown()} of ${total.toLocaleString("en-US")}`;
  };
  const failed = (what) => {
    form.classList.remove("is-live");
    status.textContent = `Couldn't ${what}. Check the filters, or use Apply.`;
  };

  const loadMore = async () => {
    const link = results.querySelector(".pagination a[rel=next]");
    if (!link || paging) return;
    const mine = generation;
    paging = new AbortController();
    link.setAttribute("aria-disabled", "true");
    try {
      const next = await fetchResults(link.href, paging.signal);
      if (mine !== generation) return;
      const body = results.querySelector("tbody");
      if (body) body.append(...next.querySelectorAll("tbody > tr"));
      const nav = next.querySelector(".pagination");
      if (nav) nav.querySelectorAll("a[rel=prev]").forEach((a) => a.remove());
      results.querySelector(".pagination")?.replaceWith(...(nav ? [nav] : []));
      recount();
      status.textContent = `Showing ${shown()} rows`;
      watch();
    } catch (error) {
      if (error.name === "AbortError") return;
      // Leave the Next link for an ordinary page load.
      observer?.disconnect();
      link.removeAttribute("aria-disabled");
      failed("load more");
    } finally {
      if (mine === generation) paging = null;
    }
  };

  const watch = () => {
    observer?.disconnect();
    const nav = results.querySelector(".pagination");
    if (!nav || !nav.querySelector("a[rel=next]") || !window.IntersectionObserver) return;
    observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: "0px 0px 800px 0px" });
    observer.observe(nav);
  };

  const refresh = async () => {
    const href = target();
    if (href === last) return;
    last = href;
    generation += 1;
    const mine = generation;
    searching?.abort();
    paging?.abort();
    paging = null;
    searching = new AbortController();
    results.setAttribute("aria-busy", "true");
    try {
      const next = await fetchResults(href, searching.signal);
      if (mine !== generation) return;
      results.dataset.matched = next.dataset.matched || "";
      results.replaceChildren(...next.childNodes);
      history.replaceState(history.state, "", href);
      form.classList.add("is-live");
      status.textContent = results.querySelector(".table-note")?.textContent || "";
      watch();
    } catch (error) {
      if (error.name === "AbortError") return;
      last = "";
      failed("update the list");
    } finally {
      if (mine === generation) results.removeAttribute("aria-busy");
    }
  };
  const soon = (wait) => { clearTimeout(timer); timer = setTimeout(refresh, wait); };

  form.addEventListener("input", (event) => {
    // Text fields wait for a pause in typing; a select is one deliberate choice.
    soon(event.target instanceof HTMLSelectElement ? 0 : 250);
  });
  form.addEventListener("change", () => soon(0));
  form.addEventListener("submit", (event) => {
    // After a failed fetch, Apply loads the page the ordinary way.
    if (!form.classList.contains("is-live")) return;
    event.preventDefault();
    last = "";
    soon(0);
  });
  results.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest(".pagination a[rel=next]") : null;
    if (!link || !form.classList.contains("is-live")) return;
    event.preventDefault();
    loadMore();
  });
  watch();
})();
