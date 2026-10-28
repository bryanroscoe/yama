// The card scanner. See docs/scanner.md.
//
//   <ScannerView onAccept={(card) => ...} />              the camera screen
//   scanFrame(image, { ocr, catalog, names, guide })      the pure pipeline, one frame at a time

export { ScannerView, type ScannerViewProps } from "./ScannerView";
export { AddedList, type AddedListProps } from "./AddedList";
export { addOp, changedElsewhere, findRow, identity, noteWrite, planFix, settled, touched, type Added, type CollectionOp, type Finish, type Fix, type Pending } from "./session";
export { scanFrame, decide, nameAgreement, SURE, COLLECTOR_REGION, NAME_REGION, type ScanOptions } from "./pipeline";
export { pickPrinting } from "./pick";
export { NameIndex } from "./fuzzy";
export { parseCollector, setVariants, normaliseName } from "./parse";
export { refineQuad } from "./locate";
export { rectQuad } from "./image";
export { createTesseractOcr, type TesseractPaths } from "./tesseract";
export { createServerCatalog } from "./serverCatalog";
export type * from "./types";
