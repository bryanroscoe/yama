// Test scan (Bryan, 22 Nov 2026: "a test scan mode for me so I can back to back scan cards without
// having to save them"). A switch in Scan settings, in every scanner (collection, deck scan, deck
// check, box check, swap check, rescan): while it's on, the scanner goes on from card to card by
// itself, each card it finds is shown and counted on this screen only, and the host's own Add,
// Count it or Use this printing is never called, so nothing is saved, filed or checked off. It is
// off each time the scanner opens, so a forgotten switch never loses a real session's cards.
//
// The same place offers Clear the list (Bryan: "maybe even clear the current scan list"): the
// test list here, or the host's own list through its `onClear`.
//
// And, while it's on, "Read the text on every card" (Bryan, 23 Nov 2026: "a text reading test ...
// so I can test it in test mode"): each card the art names has its title and collector line read
// too, and the sheet says, card by card, what was read and whether it was right (textTest.ts).

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { pickFinish } from "@yama/core";
import { Button } from "../components/ui";
import type { RecentCard, ScanFinish } from "./price";
import type { ScanCandidate } from "./types";
import type { ScannerViewProps } from "./ScannerView";
import { textTestSummary, type TextTest } from "./textTest";

/** Cards whose text test is shown on the sheet, newest first. */
const TEXT_TESTS_SHOWN = 8;

/** One card seen in test scan. */
interface Tested extends RecentCard {
  /** What the scanner was given back for it, for Undo and Wrong printing. */
  card: ScanCandidate;
}

/** A test card's tile: its printing and price when the scanner settled one, else its name. */
export function testedCard(card: ScanCandidate, finish: ScanFinish, key: string): Tested {
  // (Or the finish its sheen says, foil.ts, when the one chosen is regular.)
  const want: ScanFinish = finish === "proxy" ? "proxy" : (card.finish ?? finish);
  const filed: ScanFinish = want === "proxy" ? "proxy" : (pickFinish({ finishes: card.finishes }, want) as ScanFinish);
  return { key, card, name: card.name, set: card.set, number: card.number, finish: filed, copies: 1, prices: card.prices ?? null, image: card.thumb ?? card.image ?? null, oracleId: card.oracle_id };
}

/** "Test scan" in the settings summary: also what makes the scanner drop a held card's Scan anyway on a switch. */
export const TEST_SUMMARY = "Test scan, nothing saved";

/**
 * The props the scanner runs with: the host's as they are, or, in test scan, the host's with every
 * write swapped for this screen's own list. Also the switch and Clear the list, for Scan settings.
 */
export function useTestScan(props: ScannerViewProps): ScannerViewProps {
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<Tested[]>([]);
  /** "Read the text on every card", and what it read, newest first. */
  const [readText, setReadText] = useState(false);
  const [textTests, setTextTestsState] = useState<TextTest[]>([]);
  /** Moves on each time the list starts again: a read still on its way from before is dropped. */
  const [textRun, setTextRun] = useState(0);
  const textRunRef = useRef(0);
  const setTextTests = (list: TextTest[]) => {
    if (list.length === 0) {
      textRunRef.current += 1;
      setTextRun(textRunRef.current);
    }
    setTextTestsState(list);
  };
  const onTextTest = useCallback(
    (t: TextTest) => {
      if (textRun === textRunRef.current) setTextTestsState((list) => [t, ...list]);
    },
    [textRun],
  );
  const listRef = useRef<Tested[]>([]);
  const put = (list: Tested[]) => {
    listRef.current = list;
    setTested(list);
  };
  const keyOf = useRef(new WeakMap<ScanCandidate, string>());
  const finish = props.finish ?? "nonfoil";
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const accept = useCallback((card: ScanCandidate): Promise<boolean> => {
    const key = crypto.randomUUID();
    keyOf.current.set(card, key);
    put([testedCard(card, finishRef.current, key), ...listRef.current]);
    return Promise.resolve(true);
  }, []);
  const undo = useCallback(async (card: ScanCandidate) => {
    const key = keyOf.current.get(card);
    if (!key || !listRef.current.some((t) => t.key === key)) throw new Error("It's no longer in the test list");
    put(listRef.current.filter((t) => t.key !== key));
  }, []);
  const correct = useCallback(async (from: ScanCandidate, to: ScanCandidate): Promise<"changed" | "kept"> => {
    const key = keyOf.current.get(from);
    if (!key || !listRef.current.some((t) => t.key === key)) throw new Error("It's no longer in the test list");
    keyOf.current.set(to, key);
    put(listRef.current.map((t) => (t.key === key ? testedCard(to, finishRef.current, key) : t)));
    return "changed";
  }, []);
  /** Foil or not on the test list only: nothing reaches the host. */
  const flip = useCallback(async (card: ScanCandidate, to: "foil" | "nonfoil") => {
    const key = keyOf.current.get(card);
    if (!key || !listRef.current.some((t) => t.key === key)) throw new Error("It's no longer in the test list");
    put(listRef.current.map((t) => (t.key === key ? { ...t, finish: to } : t)));
  }, []);
  const entryOf = useCallback((card: ScanCandidate) => keyOf.current.get(card), []);
  const clearTested = useCallback(() => {
    put([]);
    setTextTests([]);
  }, []);

  const { onClear, clearNote, settings, settingsSummary, controls, addedCount = 0, recentCards } = props;
  const count = testing ? tested.length : (recentCards?.reduce((n, c) => n + c.copies, 0) ?? addedCount);
  const clear = testing ? clearTested : onClear;
  const switchBox = (
    <TestScanSettings
      testing={testing}
      onTesting={(on) => {
        setTesting(on);
        // Each test starts with an empty list.
        if (on) {
          put([]);
          setTextTests([]);
        }
      }}
      readText={readText}
      onReadText={(on) => {
        setReadText(on);
        setTextTests([]);
      }}
      count={count}
      onClear={clear}
      note={testing ? "Starts the test list again." : (clearNote ?? "Starts the list of cards scanned again.")}
    />
  );
  const shownSettings = (
    <>
      {settings}
      {switchBox}
    </>
  );
  // Memoised so a host's own render doesn't make new props for nothing.
  const recent = useMemo(() => tested.map(({ card: _, ...t }) => t), [tested]);
  if (!testing) return { ...props, settings: shownSettings };
  return {
    ...props,
    testScan: true,
    onAccept: accept,
    onUndo: undo,
    onCorrect: correct,
    onFinish: props.onFinish ? flip : undefined,
    // Card first saves its rows through the host's own path: never in a test (Codex review of #211).
    onProvisional: undefined,
    entryOf,
    // A tile opens nothing: there is no saved copy to fix.
    onOpenCard: undefined,
    onShowAdded: undefined,
    onClear: clearTested,
    unsavedCount: 0,
    addedCount: tested.length,
    // With prices where the host shows them (the collection), names elsewhere.
    recentCards: props.recentCards ? recent : undefined,
    recent: recent.map((t) => t.name),
    autoAdd: true,
    single: false,
    addedWord: "Scanned",
    acceptLabel: "Scan next",
    settings: shownSettings,
    settingsSummary: settingsSummary ? `${TEST_SUMMARY}; ${settingsSummary}` : TEST_SUMMARY,
    ...(readText ? { onTextTest } : {}),
    controls: (
      <>
        <TestScanNote count={tested.length} onStop={() => setTesting(false)} />
        {readText && <TextTestNote tests={textTests} />}
        {controls}
      </>
    ),
  };
}

/** On the sheet while test scan is on: what it means, and the way out. */
function TestScanNote({ count, onStop }: { count: number; onStop: () => void }) {
  return (
    <div className="scan-test-note" role="status">
      <p>
        <strong>Test scan.</strong> {count === 0 ? "Nothing is saved: scan card after card." : `${count === 1 ? "1 card" : `${count} cards`} scanned, none saved.`}
      </p>
      <Button size="small" onClick={onStop}>
        Stop testing
      </Button>
    </div>
  );
}

/** The text reading test's results: the tally, then card by card, newest first. */
function TextTestNote({ tests }: { tests: readonly TextTest[] }) {
  return (
    <div className="scan-text-test" role="status">
      <p>
        <strong>Text reading test.</strong> {textTestSummary(tests)}
      </p>
      {tests.length > 0 && (
        <ul>
          {tests.slice(0, TEXT_TESTS_SHOWN).map((t, i) => (
            <li key={tests.length - i}>
              <strong>{t.name}</strong>
              <span className="dim">
                {" "}
                {t.titleOk ? "Name read." : t.title ? `Name not read (read "${t.title}").` : "Name not read."}{" "}
                {t.settled ? `Read ${t.read}.` : t.twin ? `Read ${t.read}, which a twin printing shows too.` : t.read ? `Read only ${t.read}.` : t.line ? `Number not read (read "${t.line}").` : "Number not read."}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The switch, Read the text on every card, and Clear the list, in Scan settings. */
function TestScanSettings({
  testing,
  onTesting,
  readText,
  onReadText,
  count,
  onClear,
  note,
}: {
  testing: boolean;
  onTesting: (on: boolean) => void;
  readText: boolean;
  onReadText: (on: boolean) => void;
  count: number;
  onClear?: () => void;
  note: string;
}): ReactNode {
  return (
    <>
      <label className="scan-keep">
        <input type="checkbox" checked={testing} onChange={(e) => onTesting(e.target.checked)} />
        <span>
          <strong>Test scan.</strong> Scan card after card to try the scanner. Each card it finds is shown and counted here, and nothing is saved, added or checked off, nor kept as a scan photo. Off again next time the scanner opens.
        </span>
      </label>
      {testing && (
        <label className="scan-keep">
          <input type="checkbox" checked={readText} onChange={(e) => onReadText(e.target.checked)} />
          <span>
            <strong>Read the text on every card.</strong> Reads each card's name and collector number too, whatever its art said, and says on the sheet what was read and whether it was right. Slower: for testing the text reader.
          </span>
        </label>
      )}
      {onClear && count > 0 && (
        <div className="scan-clear">
          <Button size="small" variant="outline" onClick={onClear}>
            Clear the list ({count})
          </Button>
          <span className="scan-note">{note}</span>
        </div>
      )}
    </>
  );
}
