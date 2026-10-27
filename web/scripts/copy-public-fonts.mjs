// Stable font URLs for the server-rendered public pages; same fonts as the app.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const out = new URL('../public/precon-fonts/', import.meta.url);
await mkdir(out, { recursive: true });
for (const [family, weights] of [
  ['big-shoulders-display', [700, 800]],
  ['atkinson-hyperlegible-next', [400, 700]],
]) {
  const root = dirname(require.resolve(`@fontsource/${family}/package.json`));
  for (const weight of weights) {
    const file = `${family}-latin-${weight}-normal.woff2`;
    await copyFile(join(root, 'files', file), new URL(file, out));
  }
  await copyFile(join(root, 'LICENSE'), new URL(`${family}-LICENSE.txt`, out));
}
