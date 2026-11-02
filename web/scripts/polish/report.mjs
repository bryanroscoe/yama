// A polish run's outputs: report.json (everything), report.md (findings to read first),
// index.html (a contact sheet to page through) and copy.txt (every page's visible text).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const RANK = { error: 0, warn: 1, info: 2 };

/** One finding per page for the same thing at several sizes or frames. */
export function groupIssues(page) {
  const groups = new Map();
  for (const [vp, view] of Object.entries(page.views)) {
    for (const shot of view.shots) {
      for (const issue of shot.issues) {
        const key = `${issue.kind}|${issue.selector}|${issue.message.replace(/-?\d+(\.\d+)?/g, "#")}`;
        let g = groups.get(key);
        if (!g) {
          g = { ...issue, viewports: [], shots: [] };
          groups.set(key, g);
        }
        if (!g.viewports.includes(vp)) g.viewports.push(vp);
        const file = shot.annotated ?? shot.file;
        if (g.shots.length < 3 && !g.shots.includes(file)) g.shots.push(file);
        if (RANK[issue.severity] < RANK[g.severity]) g.severity = issue.severity;
      }
    }
  }
  return [...groups.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.kind.localeCompare(b.kind));
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function writeReports(outDir, run) {
  const pages = run.pages.map((p) => ({ ...p, findings: groupIssues(p) }));
  const offScale = Object.values(run.offScale)
    .map((o) => ({ ...o, pages: [...o.pages], viewports: [...o.viewports] }))
    .sort((a, b) => b.pages.length - a.pages.length || b.count - a.count);
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ ...run, pages, offScale, copy: undefined }, null, 1));

  // copy.txt
  const copy = Object.entries(run.copy)
    .map(([url, text]) => `==== ${url}\n${text}\n`)
    .join("\n");
  writeFileSync(join(outDir, "copy.txt"), copy);

  // report.md
  const totals = { error: 0, warn: 0, info: 0 };
  const byKind = {};
  for (const p of pages)
    for (const f of p.findings) {
      totals[f.severity]++;
      (byKind[f.kind] ??= { count: 0, pages: new Set(), severity: f.severity }).count++;
      byKind[f.kind].pages.add(p.url);
      // The kind's most severe finding, not its first: 261 warnings shouldn't read as notes.
      if (RANK[f.severity] < RANK[byKind[f.kind].severity]) byKind[f.kind].severity = f.severity;
    }
  const shots = pages.reduce((n, p) => n + Object.values(p.views).reduce((m, v) => m + v.shots.length, 0), 0);
  const md = [];
  md.push(`# Polish run ${run.started.slice(0, 16).replace("T", " ")}`, "");
  md.push(`- Base: ${run.base}; ${run.signedInAs ? `signed in as ${run.signedInAs.email ?? run.signedInAs.name}` : "signed out"}`);
  md.push(`- Sizes: ${run.viewports.join(", ")}; presses: ${run.interact}`);
  md.push(`- ${pages.length} pages, ${shots} screens. Findings: ${totals.error} errors, ${totals.warn} warnings, ${totals.info} notes`);
  md.push(`- Writes blocked: ${run.blockedWrites.length}${run.blockedWrites.length ? ` (${[...new Set(run.blockedWrites.map((b) => `${b.method} ${new URL(b.url).pathname}`))].slice(0, 8).join(", ")})` : ""}`);
  md.push("", "Findings are leads, not verdicts: look at the screenshot. `-marked` screenshots outline them, numbered in the order listed in report.json.", "");
  md.push("## By kind", "", "| Kind | Severity | Findings | Pages |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(byKind).sort((a, b) => RANK[a[1].severity] - RANK[b[1].severity] || b[1].count - a[1].count))
    md.push(`| ${k} | ${v.severity} | ${v.count} | ${v.pages.size} |`);
  md.push("", "## Pages", "");
  for (const p of pages) {
    md.push(`### ${p.url}${p.finalUrl && p.finalUrl !== p.url ? ` → ${p.finalUrl}` : ""}`, "");
    md.push(`${p.title ? `"${p.title}", ` : ""}pattern \`${p.pattern ?? p.url}\``, "");
    for (const [vp, v] of Object.entries(p.views)) {
      const page = v.shots.filter((s) => /^(page|open)-/.test(s.name)).map((s) => s.file);
      const pops = v.shots.filter((s) => s.label);
      md.push(`- **${vp}** (${v.height}px tall${v.truncated ? ", more below the last frame" : ""}): ${page.join(", ") || "no screens"}`);
      if (pops.length) md.push(`  - pressed: ${pops.map((s) => `${s.kind} "${s.label}" → ${s.file}`).join("; ")}`);
      const errs = [...new Set(v.errors)];
      if (errs.length) md.push(`  - errors: ${errs.slice(0, 6).map((e) => `\`${e.replace(/`/g, "'")}\``).join("; ")}${errs.length > 6 ? ` (+${errs.length - 6})` : ""}`);
    }
    const shown = p.findings.filter((f) => f.severity !== "info");
    const notes = p.findings.length - shown.length;
    if (shown.length) {
      md.push("");
      for (const f of shown.slice(0, 40))
        md.push(`- [${f.severity}] ${f.kind} (${f.viewports.join(", ")}): ${f.message}${f.selector ? ` — \`${f.selector}\`` : ""}${f.text ? ` "${f.text.slice(0, 50)}"` : ""} → ${f.shots[0] ?? ""}`);
      if (shown.length > 40) md.push(`- …and ${shown.length - 40} more in report.json`);
    }
    if (notes) md.push(`- ${notes} notes (truncation, all-caps text, copy nits) in report.json`);
    md.push("");
  }
  md.push("## Spacing off the 8 / 12 / 16 / 24 / 32 scale", "", "Most-used first. 20px and 40px+ steps count as on scale.", "");
  md.push("| Element | Property | px | Pages | Sizes |", "|---|---|---|---|---|");
  for (const o of offScale.slice(0, 60)) md.push(`| \`${o.selector}\` | ${o.prop} | ${o.px} | ${o.pages.length} | ${o.viewports.join(", ")} |`);
  writeFileSync(join(outDir, "report.md"), md.join("\n") + "\n");

  // index.html: a contact sheet, one row per page, one column per size.
  const sev = (s) => `<span class="sev ${s}">${s}</span>`;
  const html = `<!doctype html><meta charset="utf-8"><title>Polish run ${esc(run.started)}</title>
<style>
body{margin:0;background:#0b0c0e;color:#f2efe8;font:14px/1.45 system-ui,sans-serif}
header{position:sticky;top:0;background:#15171a;padding:12px 20px;border-bottom:1px solid #2a2e33;z-index:2}
h1{font-size:18px;margin:0}h2{font-size:16px;margin:0 0 8px}
.page{padding:20px;border-bottom:1px solid #2a2e33}
.row{display:flex;gap:16px;overflow-x:auto;align-items:flex-start}
.col{flex:none}.col h3{font-size:13px;color:#a9adb3;margin:0 0 6px;font-weight:600}
.strip{display:flex;gap:6px;flex-wrap:wrap;max-width:900px}
.strip a{display:block;position:relative}.strip img{display:block;height:220px;border:1px solid #2a2e33;border-radius:4px}
.strip a span{position:absolute;left:2px;bottom:2px;background:#000c;font-size:11px;padding:0 4px;border-radius:3px;max-width:100%;overflow:hidden;white-space:nowrap}
ul{margin:8px 0 0;padding-left:18px}li{margin:2px 0}.dim{color:#a9adb3}
.sev{font-size:11px;padding:0 6px;border-radius:9px;margin-right:4px}.error{background:#ff3b30;color:#000}.warn{background:#ffcc00;color:#000}.info{background:#5ac8fa;color:#000}
nav a{color:#a9adb3;margin-right:10px;font-size:12px}
</style>
<header><h1>Polish run, ${esc(run.base)}</h1><div class="dim">${esc(run.started)}; ${pages.length} pages, ${shots} screens; ${totals.error} errors, ${totals.warn} warnings, ${totals.info} notes. <a href="report.md">report.md</a> <a href="copy.txt">copy.txt</a></div>
<nav>${pages.map((p, i) => `<a href="#p${i}">${esc(p.url)}</a>`).join("")}</nav></header>
${pages
  .map(
    (p, i) => `<section class="page" id="p${i}"><h2>${esc(p.url)} <span class="dim">${esc(p.title)}</span></h2><div class="row">${Object.entries(p.views)
      .map(
        ([vp, v]) =>
          `<div class="col"><h3>${esc(vp)}</h3><div class="strip">${v.shots
            .map((s) => `<a href="${esc(s.annotated ?? s.file)}" target="_blank"><img loading="lazy" src="${esc(s.file)}"><span>${esc(s.label ?? s.name)}${s.annotated ? " ●" : ""}</span></a>`)
            .join("")}</div></div>`,
      )
      .join("")}</div>${
      p.findings.length
        ? `<ul>${p.findings
            .slice(0, 30)
            .map((f) => `<li>${sev(f.severity)}<b>${esc(f.kind)}</b> <span class="dim">${esc(f.viewports.join(", "))}</span> ${esc(f.message)} <span class="dim">${esc(f.selector)}</span></li>`)
            .join("")}</ul>`
        : ""
    }</section>`,
  )
  .join("\n")}`;
  writeFileSync(join(outDir, "index.html"), html);
}
