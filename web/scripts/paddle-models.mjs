// PaddleOCR models for the scanner's browser OCR (docs/scanner.md, "Browser OCR: PP-OCRv5").
// Apache-2.0 weights by PaddlePaddle, converted to ONNX and published by monkt/paddleocr-onnx on
// Hugging Face. Pinned to one commit of that repository and checked by SHA-256, so a build gets
// exactly these bytes or fails. Downloaded once into a cache (YAMA_OCR_CACHE, or
// node_modules/.cache/yama-ocr), then copied into public/ocr by copy-ocr.mjs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65";

/** name in the app: source path in the repository, size and SHA-256. */
export const PADDLE_FILES = {
  // PP-OCRv5 English mobile text recogniser (en_PP-OCRv5_mobile_rec).
  "rec.onnx": { path: "languages/english/rec.onnx", size: 7830888, sha256: "4e16deb22c4da6468bdca539b2cd3c8687825538b67109177c47d359ab994cd7" },
  // Its character list.
  "dict.txt": { path: "languages/english/dict.txt", size: 1416, sha256: "e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6" },
  // PP-OCRv3 mobile text detector, for the two-line collector block.
  "det.onnx": { path: "detection/v3/det.onnx", size: 2429873, sha256: "ee40e80071ba3a320d4efda75f3e22047a7d049e9bf7bcaaf9daea23fc21b935" },
};

/** The models' folder name under /ocr/: named by their checksums, so new models get a new address. */
export function paddleVersion() {
  const sums = Object.entries(PADDLE_FILES).map(([name, f]) => `${name}:${f.sha256}`);
  return `paddle-${createHash("sha256").update(sums.join("\n")).digest("hex").slice(0, 12)}`;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Every model file in the cache, downloaded and checked if missing. Returns name -> local path. */
export async function ensurePaddleModels(cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const out = {};
  for (const [name, f] of Object.entries(PADDLE_FILES)) {
    const local = join(cacheDir, `${f.sha256}-${name}`);
    if (!existsSync(local) || sha256(readFileSync(local)) !== f.sha256) {
      const res = await fetch(`${REPO}/${f.path}`, { redirect: "follow", signal: AbortSignal.timeout(5 * 60 * 1000) });
      if (!res.ok) throw new Error(`OCR model ${name}: HTTP ${res.status} from ${REPO}/${f.path}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (buf.length !== f.size || got !== f.sha256) throw new Error(`OCR model ${name}: ${buf.length} bytes, SHA-256 ${got}; expected ${f.size} bytes, ${f.sha256}`);
      writeFileSync(`${local}.part`, buf);
      renameSync(`${local}.part`, local);
    }
    out[name] = local;
  }
  return out;
}
