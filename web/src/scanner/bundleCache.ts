// Which of the art worker's cached files to drop (its Cache API is keyed by URL): any under
// /scan-bundle/ that the server's bundle info no longer names. That is an older bundle's files,
// an embed graph the server replaced (the bundle's embed.onnx once Yama's query model is served,
// or the other way round when it's switched off; server/src/scan.rs), and supplements other than
// the current one.

import type { BundleInfo } from "./artClient";
import { modelFiles } from "./models";

/**
 * The paths of the files `info` names, resolved against `base` (the server's origin): the bundle's,
 * and every option's on offer in its slots (models.ts), so a model chosen in Scan settings and the
 * one it replaced both stay cached for switching back.
 */
export function namedPaths(info: Pick<BundleInfo, "files" | "models">, base: string): Set<string> {
  const { detector, embed, search, arts, supplement } = info.files;
  return new Set([detector, embed, search, arts, supplement, ...modelFiles(info)].filter((u): u is string => !!u).map((u) => new URL(u, base).pathname));
}

/** Whether the cached file at `url` is a scanner file the server no longer names. */
export function isStale(url: string, named: Set<string>): boolean {
  const path = new URL(url).pathname;
  return path.startsWith("/scan-bundle/") && !named.has(path);
}
