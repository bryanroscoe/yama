// The OCR engine's folder name under /ocr/: its packages' versions, so a new engine or model gets
// a new address and no browser or CDN keeps serving the old one (ARCHITECTURE.md, "Caching and
// cache busting"). Shared by copy-ocr.mjs and vite.config.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function ocrVersion() {
  const versions = ["tesseract.js", "tesseract.js-core", "@tesseract.js-data/eng"].map(
    (name) => `${name}@${JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version}`,
  );
  return createHash("sha256").update(versions.join("\n")).digest("hex").slice(0, 12);
}
