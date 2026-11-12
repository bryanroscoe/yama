// Pieces Add a deck (/decks/import) and Edit the list (/decks/:id/edit) share.
import { useState } from "react";
import { CardHover } from "../components/CardRef";
import { Button, CardImage } from "../components/ui";
import { GUIDES, guideFor } from "./guides";
import { dropUnknown, fixUnknown, type Draft, type ImportCard, type ImportPreview } from "./importLogic";

/** Where a list can come from (Moxfield, Archidekt, a file…), each with its steps. */
export function GuideTabs({ guideKey, setGuideKey }: { guideKey: string | null; setGuideKey: (k: string | null) => void }) {
  const guide = guideFor(guideKey);
  return (
    <>
      {/* Each one opens its steps and closes them again, so they are disclosures, not tabs:
          a tab can't be closed and one is always chosen. */}
      <div className="import-sources" role="group" aria-label="Where your deck is">
        {GUIDES.map((g) => (
          <Button
            key={g.key}
            aria-expanded={guideKey === g.key}
            aria-controls={guideKey === g.key ? "import-guide" : undefined}
            className={`import-source${guideKey === g.key ? " active" : ""}`}
            onClick={() => setGuideKey(guideKey === g.key ? null : g.key)}
          >
            {g.name}
          </Button>
        ))}
      </div>
      {guide && (
        <div className="import-guide" id="import-guide" role="region" aria-label={`From ${guide.name}`}>
          <ol>
            {guide.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {guide.note && <p className="small dim">{guide.note}</p>}
        </div>
      )}
    </>
  );
}

/** Lines that matched no card: pick a suggestion ("did you mean") or leave the line out. Saving waits for these. */
export function UnknownLines({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  if (!draft.unknown.length) return null;
  return (
    <div className="import-unknown" role="group" aria-label="Lines that didn't match a card">
      <h3>Didn't match a card</h3>
      <ul>
        {draft.unknown.map((u, i) => (
          <li key={`${u.name}-${i}`}>
            <p>
              <b>{u.qty > 1 ? `${u.qty} ` : ""}{u.name}</b>
              {u.suggestions.length ? " Did you mean:" : " No close match. Check the spelling on Scryfall, or leave it out (brand-new cards arrive with the weekly card update)."}
            </p>
            <div className="import-suggest">
              {u.suggestions.map((s) => (
                <Button key={s.oracle_id} onClick={() => setDraft(fixUnknown(draft, i, s))}>
                  {s.name}
                </Button>
              ))}
              <Button variant="quiet" onClick={() => setDraft(dropUnknown(draft, i))}>
                Leave it out
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CommanderPicker({ choices, current, onPick }: { choices: ImportCard[]; current: string[]; onPick: (ids: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>(current);
  if (!choices.length) {
    return <p className="small import-warn">No card in this list can lead a deck. Add your commander to the list (a line like "Commander" then "1 Name") and Yama reads it again.</p>;
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1]!, id] : [...p, id]));
  return (
    <div className="import-picker">
      <p className="small dim">Who leads this deck? Pick one, or two partners.</p>
      <div className="import-picker-grid">
        {choices.map((k) => (
          <Button key={k.oracle_id} className={`import-pick${picked.includes(k.oracle_id) ? " active" : ""}`} aria-pressed={picked.includes(k.oracle_id)} onClick={() => toggle(k.oracle_id)}>
            <CardImage src={k.print_image ?? k.image_small} name={k.name} />
            <span><CardHover name={k.name}/></span>
          </Button>
        ))}
      </div>
      <Button variant="primary" disabled={!picked.length} onClick={() => onPick(picked)}>
        {picked.length === 2 ? "Use these two" : "Use this commander"}
      </Button>
    </div>
  );
}

/** A link Yama couldn't read: what to do instead (its site's steps open with it). */
export function LinkNote({ preview, stepsWhere }: { preview: ImportPreview | null; stepsWhere?: string }) {
  return (
    <>
      {preview?.link && !preview.link.fetched && (
        <div className="import-link-note" role="status">
          <p>
            <b>That's a {preview.link.site_name} link.</b> {preview.link.message}
          </p>
          {stepsWhere && guideFor(preview.link.site) && <p className="small dim">The steps for {preview.link.site_name} are {stepsWhere}.</p>}
        </div>
      )}
      {preview && !preview.link?.fetched && preview.decks.length === 0 && !preview.link && (
        <p className="import-warn">No cards found in that. {preview.skipped[0] ?? "Paste a list with one card per line."}</p>
      )}
      {preview?.link?.fetched && <p className="small dim">Read from {preview.link.site_name}.</p>}
    </>
  );
}

/** Lines the preview couldn't read, in one fold. */
export function Skipped({ preview }: { preview: ImportPreview | null }) {
  if (!preview || !preview.skipped.length || !preview.decks.length) return null;
  return (
    <details className="details-fold">
      <summary>{preview.skipped.length === 1 ? "1 line Yama skipped" : `${preview.skipped.length} lines Yama skipped`}</summary>
      <ul className="small dim">
        {preview.skipped.slice(0, 30).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </details>
  );
}
