import { CardRef } from "../components/CardRef";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GROUP_ORDER, groupOf } from "@yama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { api, type DeckSummary, type DeckView, type PreconList, type PublicDeck } from "../api";
import { AreaHead } from "../components/DeckTabs";
import { hasDeckNamed } from "../components/calendar";
import { ActionBar, Button, CardImage, ErrorText, Field, Loading, Pips, Segmented } from "../components/ui";
import {
  checks,
  commanderChoices,
  commanders,
  diff,
  draftFrom,
  printLine,
  setCommanders,
  sharedText,
  toSave,
  type Draft,
  type ImportCard,
} from "./importLogic";
import { CommanderPicker, GuideTabs, LinkNote, Skipped, UnknownLines } from "./ImportParts";
import { UnsavedPrompt, useUnsavedChanges } from "../unsaved";
import { createOpIds } from "./saveOps";
import { ask } from "../components/confirm";
import { ACCEPT, replaceQuestion, useListImport } from "./useListImport";
import "./import.css";

/**
 * Add a deck from a pasted list, a file or a link: `/decks/import`. `?precon=<file>` starts from a
 * precon's stock list; `?shared=<token>` copies a deck someone shared (`/d/<token>`); `?text=`,
 * `?url=` and `?title=` come from the phone's share sheet (the manifest's share_target).
 * `?deck=<id>` (Update from a list, before 8 Nov 2026) now opens that deck's Edit the list.
 */
export function ImportPage() {
  const location = useLocation();
  const [params] = useSearchParams();
  const deck = params.get("deck");
  if (deck) return <Navigate to={`/decks/${encodeURIComponent(deck)}/edit`} replace state={location.state} />;
  // A new navigation may carry new text, even on this same route.
  return <ImportEditor key={location.key} />;
}

function ImportEditor() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const precon = params.get("precon");
  const shared = params.get("shared");
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  // One op id per deck as it would be saved, kept while this page is open (the save bar comes
  // and goes as the text is edited): a request sent again, after a lost reply or when "Add all"
  // is run again after one deck failed, names the deck already made.
  const [opIdFor] = useState(createOpIds);

  // The precon's stock list, as "Start a deck" on the Cards page and release calendar asks.
  const stock = useQuery({
    queryKey: ["precon", precon],
    queryFn: ({ signal }) => api<PreconList>(`/api/calendar/precons/${encodeURIComponent(precon!)}`, { signal }),
    enabled: !!precon,
    retry: false,
    staleTime: Infinity,
  });
  // A friend's shared deck, as its page's "Save a copy in Yama" asks.
  const friend = useQuery({
    queryKey: ["shared-deck", shared],
    queryFn: ({ signal }) => api<PublicDeck>(`/api/public/decks/${encodeURIComponent(shared!)}`, { signal }),
    enabled: !!shared,
    retry: false,
    staleTime: Infinity,
  });
  const list = useListImport({
    initialText: () => sharedText(params),
    makeDraft: (d, source) => draftFrom(d, stock.data?.name ?? friend.data?.name ?? (source.fileName ? source.fileName.replace(/\.[^.]+$/, "").replace(/_/g, " ") : "")),
    confirmReplace: (what) => ask(replaceQuestion(what)),
  });
  const { prefill } = list;
  useEffect(() => {
    if (stock.data) prefill(stock.data.text);
  }, [stock.data, prefill]);
  useEffect(() => {
    if (friend.data) prefill(friend.data.text);
  }, [friend.data, prefill]);

  const [note, setNote] = useState("");
  const [target, setTarget] = useState<string>("");
  const fileInput = useRef<HTMLInputElement>(null);
  const { text, preview, drafts, draft, setDraft, active, setActive, check, notice } = list;
  const deckNames = decks.data?.map((d) => d.name) ?? [];
  // A list the person brought, a fix to its reading or a typed note: leaving asks first (unsaved.tsx).
  const guard = useUnsavedChanges(list.unsaved || !!note.trim());

  return (
    <main className="page import-page">
      <AreaHead title={precon ? "Start from a precon" : shared ? "Save a copy" : "Add a deck"} back={{ to: "/decks", label: "Back" }} />
      {shared && friend.data && (
        <p className="dim">
          A copy of {friend.data.name}{friend.data.handle ? `, shared by @${friend.data.handle}` : ""}. It becomes your own deck; theirs doesn't change.
        </p>
      )}
      {shared && friend.error && <p className="error">That shared deck isn't available. It may be private now, or its link was reset.</p>}
      <div className="import-grid">
        <section className="import-get" aria-labelledby="imp-get">
          <h2 id="imp-get">Get your list</h2>
          <details className="import-source-help"><summary>Import from a file or another site</summary>
            <GuideTabs guideKey={list.guideKey} setGuideKey={list.setGuideKey} />
          </details>
          {stock.data && (
            <p className="small dim">
              The stock list of {stock.data.name}
              {stock.data.commanders.length ? `, led by ${stock.data.commanders.join(" and ")}` : ""}, from MTGJSON. Check it, then add the deck.
            </p>
          )}
          <ErrorText error={stock.error} />
          <label className={`import-drop${list.dragging ? " dragging" : ""}`} {...list.dropProps}>
            <span className="import-drop-label">Your list, a file or a link</span>
            <textarea
              {...list.boxProps}
              placeholder={"Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n…"}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <span className="import-drop-hint small dim wide-only">Or drop a file here.</span>
          </label>
          <ActionBar>
            <Button onClick={() => void list.pasteFromClipboard()}>Paste</Button>
            <Button onClick={() => fileInput.current?.click()}>Choose a file</Button>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void list.readFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {text && (
              <Button variant="quiet" onClick={() => list.setUserText("")}>
                Clear
              </Button>
            )}
          </ActionBar>
          {notice && (
            <p className="small import-warn" role="status">
              {notice}
            </p>
          )}
        </section>

        <section className="import-check" aria-labelledby="imp-check" aria-busy={check.isPending}>
          <h2 id="imp-check">Check it</h2>
          {check.isPending && <Loading>Reading the list…</Loading>}
          <ErrorText error={check.error} />
          {!check.isPending && !preview && !check.error && <p className="dim">Your deck shows here once there's a list to read.</p>}
          <LinkNote preview={preview} stepsWhere="under Import from a file or another site" />
          {drafts.length > 1 && <Batch drafts={drafts} active={active} setActive={setActive} />}
          {draft && <DraftView draft={draft} setDraft={setDraft} formatLabel={preview?.format_label ?? null} deckNames={deckNames} />}
          <Skipped preview={preview} />
        </section>
      </div>

      {draft && (
        <SaveBar
          opIdFor={opIdFor}
          drafts={drafts}
          draft={draft}
          target={target}
          setTarget={setTarget}
          note={note}
          setNote={setNote}
          decks={decks.data ?? []}
          formatLabel={preview?.format_label ?? preview?.link?.site_name ?? null}
          onSaved={(id) => {
            void qc.invalidateQueries({ queryKey: ["decks"] });
            void qc.invalidateQueries({ queryKey: ["deck", id] });
            // The deck page then offers to add the cards to the collection (CollectSheet).
            guard.allow();
            navigate(`/decks/${id}?collect=1`, { replace: !!precon });
          }}
          onSavedMany={() => {
            void qc.invalidateQueries({ queryKey: ["decks"] });
            guard.allow();
            navigate("/decks");
          }}
        />
      )}
      <UnsavedPrompt guard={guard} what="this list" />
    </main>
  );
}

/** Several decks at once (several files, or a Mythic Tools export with deck containers). */
function Batch({ drafts, active, setActive }: { drafts: Draft[]; active: number; setActive: (i: number) => void }) {
  return (
    <div className="import-batch">
      <p className="small dim">{drafts.length} decks found.</p>
      <ul>
        {drafts.map((d, i) => {
          const c = checks(d);
          return (
            <li key={i}>
              <Button className={`import-batch-row${i === active ? " active" : ""}`} aria-pressed={i === active} onClick={() => setActive(i)}>
                <span className="import-batch-name">{d.name || "Unnamed deck"}</span>
                <span className={`small ${c.ready && !c.problems.length ? "import-good" : "import-warn"}`}>
                  {c.total} cards{!c.ready ? `, ${c.problems.length} to fix` : c.problems.length ? `, ${c.problems.length} to check` : ""}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DraftView({ draft, setDraft, formatLabel, deckNames }: { draft: Draft; setDraft: (d: Draft) => void; formatLabel: string | null; deckNames: string[] }) {
  const c = useMemo(() => checks(draft), [draft]);
  const cmdrs = commanders(draft);
  const choices = commanderChoices(draft);
  const [choosing, setChoosing] = useState(false);
  const groups = useMemo(() => {
    const by = new Map<string, ImportCard[]>();
    for (const card of draft.cards) {
      const g = card.board === "side" ? (card.maybe ? "Considering" : "Sideboard") : groupOf(card.board, card.type_line);
      if (g === "Commander") continue;
      by.set(g, [...(by.get(g) ?? []), card]);
    }
    const order = [...GROUP_ORDER.filter((g) => g !== "Commander" && g !== "Sideboard"), "Sideboard", "Considering"];
    return order.filter((g) => by.has(g)).map((g) => ({ group: g, cards: by.get(g)!.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [draft.cards]);

  return (
    <div className="import-draft">
      <div className="import-summary">
        <span className={`import-count num ${c.total === 100 ? "import-good" : "import-warn"}`}>{c.total}</span>
        <span>
          {c.total === 1 ? "card" : "cards"} with the commander{c.sideboard ? `, ${c.sideboard} more outside the deck` : ""}
          {formatLabel && <span className="dim">. Looks like {formatLabel}.</span>}
        </span>
        {c.identity && <Pips identity={c.identity} />}
      </div>

      <Field label="Name">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Atraxa superfriends" maxLength={120} />
      </Field>
      {draft.name.trim() && hasDeckNamed(deckNames, draft.name) && (
        <p className="small import-warn" role="note">
          You already have a deck called {draft.name.trim()}. Adding this makes a second; to change that one, choose Update one of your decks below.
        </p>
      )}

      <div className="import-commander">
        <h3>Commander</h3>
        {cmdrs.length > 0 && !choosing ? (
          <>
            <div className="import-cmdrs">
              {cmdrs.map((k) => (
                <figure key={k.oracle_id} className="import-cmdr">
                  <CardImage src={k.print_image ?? k.image_normal} name={k.name} />
                  <figcaption><CardRef name={k.name}/></figcaption>
                </figure>
              ))}
            </div>
            <p className="small dim">
              {draft.commanderGuessed ? "Yama guessed this from the list. " : ""}
              {choices.length > cmdrs.length ? (
                <Button className="linkish" onClick={() => setChoosing(true)}>
                  Choose a different commander
                </Button>
              ) : null}
            </p>
          </>
        ) : (
          <CommanderPicker
            choices={choices}
            current={cmdrs.map((k) => k.oracle_id)}
            onPick={(ids) => {
              setDraft(setCommanders(draft, ids));
              setChoosing(false);
            }}
          />
        )}
      </div>

      <UnknownLines draft={draft} setDraft={setDraft} />

      {c.problems.length > 0 && (
        <ul className="import-problems" aria-label="Before you save">
          {c.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="import-groups">
        {groups.map(({ group, cards }) => (
          <section key={group} className="import-group">
            <h3>
              {group} <span className="dim num">{cards.reduce((n, x) => n + x.qty, 0)}</span>
            </h3>
            <ul>
              {cards.map((card) => (
                <CardRow key={`${card.oracle_id}-${card.board}-${card.set_code ?? ""}-${card.maybe}`} card={card} off={c.offIdentity.includes(card)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function CardRow({ card, off }: { card: ImportCard; off: boolean }) {
  const print = printLine(card);
  return (
    <li className={`import-card${off ? " off" : ""}`}>
      <span className="import-thumb">
        <CardImage src={card.print_image ?? card.image_small} name={card.name} />
      </span>
      <span className="import-qty num">{card.qty}</span>
      <span className="import-name">
        <CardRef name={card.name} oracleId={card.oracle_id} image={card.print_image??card.image_small}/>
        {card.written_as && card.written_as !== card.name && <span className="small dim"> (written {card.written_as})</span>}
        {(print || off) && (
          <span className="import-meta small dim">
            {print}
            {card.print_found === false && " (printing not found, the card's kept)"}
            {off && <span className="import-warn">{print ? ", " : ""}outside the commander's colors</span>}
          </span>
        )}
      </span>
    </li>
  );
}

function SaveBar({
  opIdFor,
  drafts,
  draft,
  target,
  setTarget,
  note,
  setNote,
  decks,
  formatLabel,
  onSaved,
  onSavedMany,
}: {
  opIdFor: ReturnType<typeof createOpIds>;
  drafts: Draft[];
  draft: Draft;
  target: string;
  setTarget: (id: string) => void;
  note: string;
  setNote: (n: string) => void;
  decks: DeckSummary[];
  formatLabel: string | null;
  onSaved: (id: string) => void;
  onSavedMany: () => void;
}) {
  const c = checks(draft);
  const [mode, setMode] = useState<"new" | "update">("new");
  const current = useQuery({
    queryKey: ["deck", target],
    queryFn: ({ signal }) => api<DeckView>(`/api/decks/${target}`, { signal }),
    enabled: mode === "update" && !!target,
  });
  const body = toSave(draft);
  const changes = current.data ? diff(current.data.cards, body.cards) : null;
  const create = (d: Draft) => {
    const b = toSave(d);
    const name = d.name.trim();
    return api<{ id: string }>("/api/decks", { method: "POST", json: { name, cards: b.cards, prints: b.prints, maybe: b.maybe, op_id: opIdFor(drafts.indexOf(d), name, b) } });
  };
  const save = useMutation({
    mutationFn: async () => {
      if (mode === "update") {
        // The list the changes above were worked out against: if the deck's list changed
        // elsewhere since, the save is refused instead of replacing it unseen.
        const base_version = current.data?.version_id ?? undefined;
        // A list that brings a maybeboard replaces the deck's Considering list; one without leaves it.
        await api(`/api/decks/${target}`, { method: "PUT", json: { cards: body.cards, prints: body.prints, ...(body.maybe.length ? { maybe: body.maybe } : {}), base_version, note: note.trim() || `Imported${formatLabel ? ` from ${formatLabel}` : ""}` } });
        return target;
      }
      return (await create(draft)).id;
    },
    onSuccess: onSaved,
    // A refused save shows the deck as it is now, so the changes listed are the ones a second try makes.
    onError: () => void (mode === "update" && current.refetch()),
  });
  const ready = drafts.filter((d) => checks(d).ready);
  const saveAll = useMutation({
    mutationFn: async () => {
      for (const d of ready) await create(d);
    },
    onSuccess: onSavedMany,
  });

  return (
    <section className="import-save" aria-labelledby="imp-save">
      <h2 id="imp-save" className="visually-hidden">
        Save
      </h2>
      {decks.length > 0 && (
        <Segmented className="import-mode" label="New deck or new version" value={mode} onChange={setMode} options={[["new", "New deck"], ["update", "Update one of your decks"]]} />
      )}
      {mode === "update" && (
        <div className="stack">
          <Field label="Which deck">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a deck</option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorText error={current.error} />
          {changes && (
            <div className="import-diff">
              {!changes.added.length && !changes.removed.length ? (
                <p className="dim">Same cards as {current.data?.name} now. Saving keeps a version with the printings.</p>
              ) : (
                <>
                  {changes.added.length > 0 && <DiffList title="In" sign="+" tone="import-good" lines={changes.added} />}
                  {changes.removed.length > 0 && <DiffList title="Out" sign="−" tone="import-out" lines={changes.removed} />}
                </>
              )}
            </div>
          )}
          <label>
            Note <span className="dim">(optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Swapped in the new prints" maxLength={200} />
          </label>
        </div>
      )}
      <ErrorText error={save.error ?? saveAll.error} />
      <div className="import-save-row">
        {mode === "update" ? (
          <Button variant="primary" disabled={!target || !current.data || current.isFetching || !c.ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save as a new version"}
          </Button>
        ) : (
          <Button variant="primary" disabled={!c.ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Adding…" : "Add the deck"}
          </Button>
        )}
        {mode === "new" && drafts.length > 1 && (
          <Button disabled={!ready.length || saveAll.isPending} onClick={() => saveAll.mutate()}>
            {saveAll.isPending ? "Adding…" : `Add all ${ready.length} ready`}
          </Button>
        )}
        {!c.ready && <span className="small dim">{c.problems[0]}</span>}
        {c.ready && c.problems.length > 0 && <span className="small dim">You can save now and fix the rest later.</span>}
      </div>
      {mode === "update" && target && (
        <p className="small dim">
          The deck keeps every earlier version.
        </p>
      )}
    </section>
  );
}

/** One side of a new version's changes; long lists fold after the first dozen. */
function DiffList({ title, sign, tone, lines }: { title: string; sign: string; tone: string; lines: { name: string; qty: number; board: string }[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, 12);
  const total = lines.reduce((n, l) => n + l.qty, 0);
  return (
    <div>
      <h3>
        {title} <span className="dim num">{total}</span>
      </h3>
      <ul>
        {shown.map((l) => (
          <li key={`${l.board}-${l.name}`} className={tone}>
            {sign}
            {l.qty} <CardRef name={l.name}/>
            {l.board === "commander" ? " (commander)" : l.board === "side" ? " (sideboard)" : ""}
          </li>
        ))}
      </ul>
      {lines.length > shown.length && (
        <Button className="linkish" onClick={() => setAll(true)}>
          Show all {lines.length}
        </Button>
      )}
    </div>
  );
}
