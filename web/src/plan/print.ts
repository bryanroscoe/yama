/** Wait for the pictures actually on the selected sheet before opening the print dialog. */
export async function prepareSheetForPrint(sheet: HTMLElement, timeoutMs = 30_000): Promise<void> {
  const images = [...sheet.querySelectorAll<HTMLImageElement>("img.ss-thumb")];
  const ready = await Promise.allSettled(images.map((image) => readyImage(image, timeoutMs)));
  const failed = [...new Set(images.filter((_, i) => ready[i]?.status === "rejected").map((image) => image.dataset.printCard ?? "a card"))];
  if (failed.length) {
    throw new Error(`Card pictures couldn't load: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""}. Check your connection and try Print again.`);
  }
  await sheet.ownerDocument.fonts?.ready;
}

function readyImage(image: HTMLImageElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(new Error("Image failed to load"));
    const loaded = () => {
      if (!image.complete) return;
      if (!image.naturalWidth) return failed();
      // A downloaded image may still need decoding before the print renderer can paint it.
      void image.decode().then(() => finish(), failed);
    };
    const timer = setTimeout(() => finish(new Error("Image timed out")), timeoutMs);
    image.addEventListener("load", loaded);
    image.addEventListener("error", failed);
    image.loading = "eager";
    if (image.complete && !image.naturalWidth) image.src = image.src; // Retry a previous failed request.
    if (image.complete) loaded();
  });
}
