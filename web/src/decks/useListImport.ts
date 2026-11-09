// Reading a pasted, typed, dropped or chosen list through the import preview: shared by Add a deck
// (/decks/import) and Edit the list (/decks/:id/edit).
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api } from "../api";
import { guideFor } from "./guides";
import type { Draft, ImportPreview, PreviewDeck } from "./importLogic";

/** The most one file may weigh (a deck list is a few KB; a big CSV export about 1 MB). */
export const MAX_FILE = 2 << 20;
export const ACCEPT = ".txt,.dek,.dec,.csv,.json,.cod,.mwdeck,text/plain,text/csv,application/json";

export interface Source {
  text: string;
  fileName?: string;
}

/**
 * The list being read: its text, the preview's answer and the decks found in it. `makeDraft` turns
 * each deck the preview found into a draft (it is read when the answer arrives, so it may change).
 * Every way in (typing, a paste, a file, a drop, a loaded list) cancels a slower answer still on
 * its way, so a late response never replaces newer text.
 */
export function useListImport({ initialText, makeDraft }: { initialText: () => string; makeDraft: (deck: PreviewDeck, source: Source) => Draft }) {
  const [text, setText] = useState(initialText);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [guideKey, setGuideKey] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const sourceRequest = useRef(0);
  const previewRequest = useRef(0);
  const lastChecked = useRef("");
  /** Set once the text came from the person or a chosen list, so a late preload never replaces it. */
  const touched = useRef(false);
  const draftOf = useRef(makeDraft);
  draftOf.current = makeDraft;

  const check = useMutation({
    mutationFn: async ({ sources }: { sources: Source[]; request: number }) => {
      const out: { source: Source; preview: ImportPreview }[] = [];
      for (const s of sources) {
        out.push({ source: s, preview: await api<ImportPreview>("/api/decks/import/preview", { method: "POST", json: { text: s.text, file_name: s.fileName ?? null } }) });
      }
      return out;
    },
    onSuccess: (results, { request }) => {
      if (request !== previewRequest.current) return;
      const first = results[0]?.preview ?? null;
      setPreview(first);
      if (first?.link && !first.link.fetched) setGuideKey(guideFor(first.link.site)?.key ?? "text");
      setDrafts(results.flatMap(({ source, preview }) => preview.decks.map((d) => draftOf.current(d, source))));
      setActive(0);
    },
  });

  const runCheck = useCallback(
    (sources: Source[]) => {
      lastChecked.current = sources.map((s) => s.text).join("\u0000");
      setNotice(null);
      check.mutate({ sources, request: ++previewRequest.current });
    },
    // check.mutate is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** New text from the person: any answer or list still loading is for the old text. */
  const setUserText = useCallback((next: string) => {
    touched.current = true;
    sourceRequest.current++;
    setSourceLoading(false);
    previewRequest.current++;
    setDrafts([]);
    setPreview(null);
    setText(next);
    lastChecked.current = "";
  }, []);

  /** Fill an empty box from a preload (the deck's list, a precon, a shared deck), unless the person got there first. */
  const prefill = useCallback((next: string) => {
    if (touched.current) return;
    touched.current = true;
    setText((t) => t || next);
  }, []);

  /** Load a list into the box (a start list); a newer load or the person's typing wins. */
  const loadList = useCallback(async (load: () => Promise<string | null>) => {
    touched.current = true;
    const request = ++sourceRequest.current;
    previewRequest.current++;
    setDrafts([]);
    setPreview(null);
    setNotice(null);
    setSourceLoading(true);
    try {
      const next = await load();
      if (request === sourceRequest.current && next !== null) {
        previewRequest.current++;
        setDrafts([]);
        setPreview(null);
        setText(next);
        // Different lists can hold identical text: check explicitly even when React keeps `text`.
        runCheck([{ text: next }]);
      }
      return request === sourceRequest.current;
    } catch (err) {
      if (request === sourceRequest.current) setNotice(err instanceof Error ? err.message : "Couldn't load that list.");
      return false;
    } finally {
      if (request === sourceRequest.current) setSourceLoading(false);
    }
  }, [runCheck]);

  // Check the box a moment after typing stops (and straight away after a paste, a file or a share).
  useEffect(() => {
    if (sourceLoading || !text.trim() || text === lastChecked.current) return;
    const request = sourceRequest.current;
    const t = setTimeout(() => {
      if (request === sourceRequest.current) runCheck([{ text }]);
    }, 700);
    return () => clearTimeout(t);
  }, [text, runCheck, sourceLoading]);

  const readFiles = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const big = list.find((f) => f.size > MAX_FILE);
    if (big) {
      setNotice(`${big.name} is too big for a deck list (2 MB at most).`);
      return;
    }
    const request = ++sourceRequest.current;
    const sources = await Promise.all(list.map(async (f) => ({ text: await f.text(), fileName: f.name })));
    if (request !== sourceRequest.current) return;
    if (sources.length === 1) setUserText(sources[0]!.text);
    else setUserText("");
    lastChecked.current = sources.length === 1 ? sources[0]!.text : "";
    runCheck(sources);
  };

  const pasteFromClipboard = async () => {
    const request = ++sourceRequest.current;
    try {
      const t = await navigator.clipboard.readText();
      if (request !== sourceRequest.current) return;
      if (!t.trim()) {
        setNotice("The clipboard is empty. Copy the list first, then tap Paste.");
        return;
      }
      setUserText(t);
      runCheck([{ text: t }]);
    } catch {
      setNotice("This browser didn't let Yama read the clipboard. Press and hold in the box and choose Paste instead.");
    }
  };

  /** Props for the box: typing, a paste (checked at once) and a dropped file or text. */
  const boxProps = {
    value: text,
    onChange: (e: { target: { value: string } }) => setUserText(e.target.value),
    onPaste: (e: { clipboardData: DataTransfer; preventDefault: () => void }) => {
      const t = e.clipboardData.getData("text/plain");
      if (t) {
        e.preventDefault();
        setUserText(t);
        runCheck([{ text: t }]);
      }
    },
  };
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) void readFiles(e.dataTransfer.files);
      else {
        const t = e.dataTransfer.getData("text/plain");
        if (t) setUserText(t);
      }
    },
  };

  const draft = drafts[active];
  const setDraft = (d: Draft) => setDrafts((all) => all.map((x, i) => (i === active ? d : x)));

  return {
    text, setUserText, prefill, loadList, sourceLoading,
    preview, drafts, draft, setDraft, active, setActive,
    check, runCheck, notice, setNotice, guideKey, setGuideKey, dragging,
    readFiles, pasteFromClipboard, boxProps, dropProps,
  };
}
