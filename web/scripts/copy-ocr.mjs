// Copy the OCR engine and English model into public/ocr so the scanner works offline and never
// loads code from a CDN. Runs before dev and build. Licences: tesseract.js and
// tesseract.js-core Apache-2.0; @tesseract.js-data/eng MIT.
// The files go under a versioned folder (ocr-version.mjs), which is all public/ocr holds.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ocrVersion } from "./ocr-version.mjs";

const require = createRequire(import.meta.url);
const root = new URL("../public/ocr/", import.meta.url).pathname;
const out = join(root, ocrVersion());
const pkg = (name) => dirname(require.resolve(`${name}/package.json`));

rmSync(root, { recursive: true, force: true });

mkdirSync(join(out, "core"), { recursive: true });
mkdirSync(join(out, "lang"), { recursive: true });
copyFileSync(join(pkg("tesseract.js"), "dist/worker.min.js"), join(out, "worker.min.js"));
const core = pkg("tesseract.js-core");
for (const f of readdirSync(core).filter((f) => f.endsWith("lstm.wasm.js"))) copyFileSync(join(core, f), join(out, "core", f));
copyFileSync(join(pkg("@tesseract.js-data/eng"), "4.0.0_best_int/eng.traineddata.gz"), join(out, "lang/eng.traineddata.gz"));
console.log(`OCR assets copied to ${out}`);
