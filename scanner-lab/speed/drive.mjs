// The scanner's speed bench: runs web/src/scanner/recognizer.ts in Chrome on the bench frames
// (speed_frames.py), once per configuration, and prints each graph's median time.
//
//   node <repo>/scanner-lab/speed/drive.mjs --bundle bundle --embed models/yama-art-20261118.onnx \
//     --frames speed/frames --out out/speed.json "ep=wasm&threads=1" "build=ort.webgpu.min.mjs&ep=webgpu"
//
// The page is served cross-origin isolated (COOP and COEP), so threads above 1 work; Yama itself isn't,
// so its scanner runs one thread. Chrome is the installed one (playwright-core's "chrome" channel).
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "rolldown";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const [v] = args.splice(i, 2).slice(1);
  return v;
};
const bundleDir = path.resolve(opt("bundle", "bundle"));
const embedFile = path.resolve(opt("embed", path.join(bundleDir, "embed.onnx")));
const framesDir = path.resolve(opt("frames", "speed/frames"));
const outFile = opt("out", null);
const configs = args.length ? args : ["ep=wasm&threads=1"];

// What was measured, so saved results can't be credited to other inputs: the bundle's version, and the
// SHA-256 of each graph and of the frame set's index (its cards and true quads).
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const inputs = {
  bundle: JSON.parse(fs.readFileSync(path.join(bundleDir, "manifest.json"), "utf8")).version ?? null,
  detector: sha(path.join(bundleDir, "detector.onnx")),
  embed: { file: path.basename(embedFile), sha256: sha(embedFile) },
  search: sha(path.join(bundleDir, "search.onnx")),
  frames: sha(path.join(framesDir, "index.json")),
};
console.log(`bundle ${inputs.bundle}, --embed ${inputs.embed.file} ${inputs.embed.sha256.slice(0, 12)}, frames ${inputs.frames.slice(0, 12)}`);

const built = await build({ input: path.join(here, "entry.ts"), write: false, output: { format: "esm" } });
const recognizerJs = built.output[0].code;
const ortDir = path.join(repo, "node_modules/onnxruntime-web/dist");
const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (url === "/bench/recognizer.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(recognizerJs);
  const file = url === "/bench/bench.html" ? path.join(here, "bench.html")
    : url === "/embed.onnx" ? embedFile
    : url.startsWith("/ort/") ? path.join(ortDir, path.basename(url))
    : url.startsWith("/bundle/") ? path.join(bundleDir, path.basename(url))
    : url.startsWith("/frames/") ? path.join(framesDir, path.basename(url)) : null;
  if (!file || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: "chrome", headless: !process.env.HEADED, args: ["--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-");
const all = [];
for (const q of configs) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("  page error:", String(e).slice(0, 300)));
  await page.goto(`${base}/bench/bench.html?${q}`);
  await page.waitForFunction(() => window.__bench, null, { timeout: 600_000 });
  const r = await page.evaluate(() => window.__bench);
  // The embed graph this configuration ran: --embed, or the bundle's own when the query names it.
  const named = new URLSearchParams(q).get("embedFile");
  const ran = !named || named === "/embed.onnx" ? embedFile : named.startsWith("/bundle/") ? path.join(bundleDir, path.basename(named)) : null;
  r.inputs = { ...inputs, embed: ran && fs.existsSync(ran) ? { file: path.basename(ran), sha256: sha(ran) } : { file: named, sha256: null } };
  await page.close();
  all.push(r);
  if (r.loadError) {
    console.log(`${q}: didn't load: ${r.loadError}`);
    continue;
  }
  // Times leave out the first card's four frames (it warms up), unless that's all there is; the
  // right-card rate counts every frame.
  const res = r.results.length > 4 ? r.results.slice(4) : r.results;
  const right = r.results.length ? `${(100 * r.results.filter((x) => x.right).length / r.results.length).toFixed(1)}% of ${r.results.length}` : "-";
  const tracked = res.filter((x) => x.runs.detector.length === 1).map((x) => x.timings.totalMs);
  const fresh = res.filter((x) => x.runs.detector.length > 1).map((x) => x.timings.totalMs);
  console.log(`${q} (embed ${r.inputs.embed.file} ${r.inputs.embed.sha256?.slice(0, 12) ?? "?"}): detector ${f(med(res.flatMap((x) => x.runs.detector)))} ms a pass, embed ${f(med(res.flatMap((x) => x.runs.embed)))}, search ${f(med(res.flatMap((x) => x.runs.search)))}; ` +
    `frame ${f(med(tracked))} tracked (${tracked.length}), ${f(med(fresh))} fresh (${fresh.length}); right card first ${right}; ` +
    `synthetic frame read ${f(med(r.grab))} ms; isolated ${r.isolated}, gpu ${r.gpu ?? "none"}`);
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(all));
await browser.close();
server.close();
