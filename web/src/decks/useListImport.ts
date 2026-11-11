// Reading a pasted, typed, dropped or chosen list through the import preview: shared by Add a deck
// (/decks/import) and Edit the list (/decks/:id/edit).
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
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
 * The box's typing and paste handlers. A paste never replaces a list that's already there
 * (11 Nov 2026: pasting one line used to replace the whole list, past the reach of undo): Yama
 * takes the paste over only when the box is empty; otherwise the browser puts it at the caret, or
 * over the selection, with its own undo. Either way the list is checked at once instead of after
 * the typing pause.
 */
export function boxEdits(
  on: { setUserText: (text: string) => void; runCheck: (sources: Source[]) => void },
  later: (fn: () => void) => void = (fn) => void setTimeout(fn, 0),
) {
  /** Set between a paste the browser is handling and the change it makes. */
  let pasting = false;
  return {
    onChange: (e: { target: { value: string } }) => {
      const next = e.target.value;
      on.setUserText(next);
      if (!pasting) return;
      pasting = false;
      if (next.trim()) on.runCheck([{ text: next }]);
    },
    onPaste: (e: { clipboardData: Pick<DataTransfer, "getData">; currentTarget: { value: string }; preventDefault: () => void }) => {
      const t = e.clipboardData.getData("text/plain");
      if (!t) return;
      if (e.currentTarget.value.trim()) {
        // The change event follows in this same task; a paste that changes nothing never sends
        // one, so the mark is dropped right after.
        pasting = true;
        later(() => (pasting = false));
        return;
      }
      e.preventDefault();
      on.setUserText(t);
      on.runCheck([{ text: t }]);
    },
  };
}

/**
 * What a drop on the box does. Files are read. Text fills an empty box; over a box that has a
 * list it is the browser's own insert at the drop point, and beside the box it does nothing, so a
 * stray drop never replaces the list.
 */
export function dropPlan({ files, boxHasText, overBox }: { files: boolean; boxHasText: boolean; overBox: boolean }): "files" | "fill" | "insert" | "ignore" {
  if (files) return "files";
  if (!boxHasText) return "fill";
  return overBox ? "insert" : "ignore";
}

/**
 * Fetches something to put in the box (the clipboard, chosen files), asks whether it may replace
 * what is there, and gives it back only if the box hasn't changed hands meanwhile: typing or
 * another list arriving while the clipboard is read, or while the question is up, wins, and this
 * one is dropped. `turn()` is the box's turn counter. Nothing is counted here, so a list still
 * loading keeps loading until the replacement really goes in.
 */
export async function ifStillWanted<T>(turn: () => number, get: () => Promise<T | null>, may: (value: T) => Promise<boolean>): Promise<T | null> {
  const asked = turn();
  const value = await get();
  if (value === null || asked !== turn()) return null;
  if (!(await may(value)) || asked !== turn()) return null;
  return value;
}

/** Whether replacing the whole list has to ask first: there is unsaved work in it, and a way to ask. */
export function needsReplaceQuestion(unsaved: boolean, canAsk: boolean): boolean {
  return unsaved && canAsk;
}

/** The question before a whole list replaces unsaved work in the box. `what` is "what's on the clipboard", a file's name or "3 files". */
export function replaceQuestion(what: string): { title: string; body: string; confirm: string; danger: true } {
  // Destructive: Cancel takes focus first, so Enter keeps the list.
  return { title: `Replace the list with ${what}?`, body: "What you typed or changed in the box will be lost.", confirm: "Replace the list", danger: true };
}

/**
 * Whether the box holds work that leaving would lose: a list the person typed, pasted, chose or
 * sent from the share sheet (several files read at once leave the box empty and their decks
 * below), or a fix they made to the reading. A list Yama put there itself (a precon, a shared
 * deck, a deck's own list) isn't.
 */
export function unsavedList({ text, given, drafts, draftEdited }: { text: string; given: string; drafts: number; draftEdited: boolean }): boolean {
  if (draftEdited && drafts > 0) return true;
  if (!text.trim()) return drafts > 0;
  return text !== given;
}

/**
 * The list being read: its text, the preview's answer and the decks found in it. `makeDraft` turns
 * each deck the preview found into a draft (it is read when the answer arrives, so it may change).
 * Every way in (typing, a paste, a file, a drop, a loaded list) cancels a slower answer still on
 * its way, so a late response never replaces newer text.
 */
export function useListImport({
  initialText,
  makeDraft,
  confirmReplace,
}: {
  initialText: () => string;
  makeDraft: (deck: PreviewDeck, source: Source) => Draft;
  /**
   * Asked before Paste, a chosen file or a dropped file replaces a list that holds unsaved work
   * (`replaceQuestion` words it); false keeps the list. Without it they replace at once.
   */
  confirmReplace?: (what: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(initialText);
  /**
   * The text Yama put in the box itself (a precon, a shared deck, a loaded list): not the person's
   * work. The text the box opens with is theirs: a list sent from the phone's share sheet.
   */
  const [given, setGiven] = useState("");
  /** The person fixed something in the reading (a name, a commander, an unknown line). */
  const [draftEdited, setDraftEdited] = useState(false);
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
      setDraftEdited(false);
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
    setGiven((t) => t || next);
  }, []);

  /** Load a list into the box (a start list); a newer load or the person's typing wins. Resolves
   *  to the text put in the box, or null when nothing was (superseded, failed or empty). */
  const loadList = useCallback(async (load: () => Promise<string | null>): Promise<string | null> => {
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
        setGiven(next);
        // Different lists can hold identical text: check explicitly even when React keeps `text`.
        runCheck([{ text: next }]);
        return next;
      }
      return null;
    } catch (err) {
      if (request === sourceRequest.current) setNotice(err instanceof Error ? err.message : "Couldn't load that list.");
      return null;
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

  /**
   * Paste, Choose a file and a dropped file put a whole list in the box. Over work that isn't
   * saved they ask first (11 Nov 2026: they replaced it without a word, and unlike a paste into
   * the box there is no undo).
   */
  /** Moves on whenever the box changes hands: typing, a paste, a file, a loaded list. */
  const turn = () => sourceRequest.current;
  // Leaving the page takes the box's turn too: a clipboard or file still being read then asks
  // nothing (the question would open over the next page) and puts nothing anywhere.
  useEffect(
    () => () => {
      sourceRequest.current++;
    },
    [],
  );
  /** Whether the box holds unsaved work as of the latest render (a Paste asks about the list as it is when its answer comes, not as it was when tapped). */
  const unsavedNow = useRef(false);
  const mayReplace = async (what: string): Promise<boolean> => !needsReplaceQuestion(unsavedNow.current, !!confirmReplace) || (await confirmReplace!(what));

  const readFiles = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const big = list.find((f) => f.size > MAX_FILE);
    if (big) {
      setNotice(`${big.name} is too big for a deck list (2 MB at most).`);
      return;
    }
    if (!(await ifStillWanted(turn, async () => list, () => mayReplace(list.length === 1 ? list[0]!.name : `${list.length} files`)))) return;
    const request = ++sourceRequest.current;
    const sources = await Promise.all(list.map(async (f) => ({ text: await f.text(), fileName: f.name })));
    if (request !== sourceRequest.current) return;
    if (sources.length === 1) setUserText(sources[0]!.text);
    else setUserText("");
    lastChecked.current = sources.length === 1 ? sources[0]!.text : "";
    runCheck(sources);
  };

  const pasteFromClipboard = async () => {
    try {
      const t = await ifStillWanted(
        turn,
        // Read first: the browser only allows it straight from the tap.
        () => navigator.clipboard.readText(),
        // Reached only if the box is still as it was: a paste that lost its turn says nothing.
        async (read) => {
          if (read.trim()) return mayReplace("what's on the clipboard");
          setNotice("The clipboard is empty. Copy the list first, then tap Paste.");
          return false;
        },
      );
      if (t === null) return;
      setUserText(t);
      runCheck([{ text: t }]);
    } catch {
      setNotice("This browser didn't let Yama read the clipboard. Press and hold in the box and choose Paste instead.");
    }
  };

  /** Props for the box: typing, a paste (checked at once) and a dropped file or text. */
  const edits = useMemo(() => boxEdits({ setUserText, runCheck }), [setUserText, runCheck]);
  const boxProps = { value: text, ...edits };
  const planFor = (e: DragEvent, files: boolean) => dropPlan({ files, boxHasText: !!text.trim(), overBox: e.target instanceof HTMLTextAreaElement });
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      const plan = planFor(e, e.dataTransfer.types.includes("Files"));
      // "insert" stays the browser's own drag over the box (it shows where the text will land);
      // "ignore" isn't accepted at all.
      if (plan === "insert" || plan === "ignore") return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      setDragging(false);
      const plan = planFor(e, e.dataTransfer.files.length > 0);
      // The browser's own drop into the box, at the drop point, with its undo.
      if (plan === "insert") return;
      e.preventDefault();
      if (plan === "files") void readFiles(e.dataTransfer.files);
      else if (plan === "fill") {
        const t = e.dataTransfer.getData("text/plain");
        if (t) setUserText(t);
      }
    },
  };

  const draft = drafts[active];
  const setDraft = (d: Draft) => {
    setDraftEdited(true);
    setDrafts((all) => all.map((x, i) => (i === active ? d : x)));
  };
  const unsaved = unsavedList({ text, given, drafts: drafts.length, draftEdited });
  unsavedNow.current = unsaved;

  return {
    text, setUserText, prefill, loadList, sourceLoading,
    preview, drafts, draft, setDraft, active, setActive,
    check, runCheck, notice, setNotice, guideKey, setGuideKey, dragging,
    readFiles, pasteFromClipboard, boxProps, dropProps, unsaved,
  };
}
