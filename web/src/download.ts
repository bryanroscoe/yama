// Saving a file the app made or fetched (a deck list, an export). A browser downloads it; Android's
// web view can't, so inside the app it's written to the app's cache and handed to the share sheet
// (save to Files or Drive, send it, open it in another app).

import type { MouseEvent } from "react";
import { API_BASE, apiBlob } from "./api";
import { isNative } from "./native";

export async function saveFile(blob: Blob, name: string): Promise<void> {
  if (isNative()) return shareFile(blob, name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Let the browser start saving before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An export from the API, with the app's sign-in, saved as `name`. */
export async function saveExport(path: string, name: string): Promise<void> {
  return saveFile(await apiBlob(path), name);
}

/**
 * Props for a link to an API export: a browser follows it and downloads with its cookie; inside the
 * app, where the link would open the browser without the app's sign-in, it's fetched with the
 * app's token and shared instead.
 */
export function exportLink(path: string, name: string) {
  return {
    href: API_BASE + path,
    onClick: (e: MouseEvent) => {
      if (!isNative()) return;
      e.preventDefault();
      saveExport(path, name).catch((err: unknown) => window.alert(`Couldn't export: ${err instanceof Error ? err.message : String(err)}`));
    },
  };
}

async function shareFile(blob: Blob, name: string): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
  const safe = name.replace(/[^\w.-]+/g, "_");
  const { uri } = await Filesystem.writeFile({ path: `exports/${safe}`, data: await base64(blob), directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: name, files: [uri] });
  } catch (e) {
    // Closing the share sheet without picking anything isn't a failure.
    if (!/cancel/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file"));
    reader.readAsDataURL(blob);
  });
}
