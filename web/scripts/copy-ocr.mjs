// Copy the OCR engine and English model into public/ocr so the scanner works offline and never
// loads code from a CDN. Runs before dev and build. Licences: tesseract.js and
// tesseract.js-core Apache-2.0; @tesseract.js-data/eng MIT.
// The files go under a versioned folder (ocr-version.mjs), which is all public/ocr holds.
// Then the PaddleOCR models (paddle-models.mjs, Apache-2.0), the browser's main OCR engine, go
// into their own folder named by their checksums. In CI (`CI` set) a build fails if they can't be
// fetched or don't match, so a pull request finds out. Elsewhere (the deploy's Docker build, `npm run
// dev`) the build carries on without them and the scanner reads with Tesseract: a Hugging Face
// outage shouldn't block a release. A checksum mismatch always fails.
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ocrVersion } from "./ocr-version.mjs";
import { ensurePaddleModels, paddleVersion, PADDLE_FILES } from "./paddle-models.mjs";

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

const paddleOut = join(root, paddleVersion());
const cacheDir = process.env.YAMA_OCR_CACHE || new URL("../../node_modules/.cache/yama-ocr/", import.meta.url).pathname;
try {
  const files = await ensurePaddleModels(cacheDir);
  mkdirSync(paddleOut, { recursive: true });
  for (const name of Object.keys(PADDLE_FILES)) copyFileSync(files[name], join(paddleOut, name));
  writeFileSync(
    join(paddleOut, "NOTICE.txt"),
    "PP-OCRv5 English mobile text recogniser and PP-OCRv3 mobile text detector by PaddlePaddle\n" +
      "(https://github.com/PaddlePaddle/PaddleOCR), converted to ONNX by monkt/paddleocr-onnx\n" +
      "(https://huggingface.co/monkt/paddleocr-onnx). Licensed under the Apache License 2.0:\n" +
      "https://www.apache.org/licenses/LICENSE-2.0\n",
  );
  console.log(`OCR models copied to ${paddleOut}`);
} catch (e) {
  rmSync(paddleOut, { recursive: true, force: true });
  if (process.env.CI || e.mismatch) throw e;
  console.warn(`\n*** OCR models unavailable; this build's scanner will read with Tesseract: ${e.message}\n`);
}
