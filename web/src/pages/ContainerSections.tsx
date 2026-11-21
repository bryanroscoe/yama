// One container, opened on the Collection page: where it sits (its path, each step a way up), its
// sections as a tree with their own and rolled-up counts, and what can be done with it: a new
// section, rename, move into another container, and scan what's physically in it.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Container } from "../api";
import { ActionBar, Button, ButtonLink, Dialog, ErrorText, Field } from "../components/ui";
import { plural } from "@yama/core";
import { MenuSeparator, MoreMenu } from "../components/MoreMenu";
import { money } from "./collectionFilters";
import { ancestorsOf, childrenOf, kindWord, moveTargets, optionLabel, pathLabel } from "./containerTree";

const refresh = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || ["containers", "decks", "deck"].includes(String(q.queryKey[0])) });

/**
 * "12 cards here, 340 in all, $210": a section's own and rolled-up counts. One with nothing in
 * it is "Empty", and no value is printed when nothing in it has one.
 */
export function sectionMeta(c: Container): string {
  const total = c.total_copies ?? c.copies;
  if (total <= 0) return "Empty";
  const own = plural(c.copies, "card");
  const value = c.total_market_value_usd ?? c.market_value_usd;
  const parts = [c.sections ? (c.copies > 0 ? `${own} here, ${total} in all` : `${plural(total, "card")} in its sections`) : own];
  if (value) parts.push(money(value));
  return parts.join(", ");
}

/** The way up: each container this one sits in, then its own name. */
export function Breadcrumb({ id, all, onOpen }: { id: string; all: Container[]; onOpen: (id: string) => void }) {
  const up = ancestorsOf(id, all);
  if (!up.length) return null;
  const me = all.find((c) => c.id === id);
  return (
    <nav className="coll-crumbs small" aria-label="Where it sits">
      {up.map((c) => (
        <span key={c.id}>
          <Button variant="quiet" size="small" onClick={() => onOpen(c.id)}>{c.name}</Button>
          <span className="dim" aria-hidden="true"> › </span>
        </span>
      ))}
      <span aria-current="page">{me?.name}</span>
    </nav>
  );
}

function SectionTree({ parent, all, onOpen }: { parent: string; all: Container[]; onOpen: (id: string) => void }) {
  const kids = childrenOf(parent, all);
  if (!kids.length) return null;
  return (
    <ul className="coll-sections">
      {kids.map((c) => (
        <li key={c.id}>
          <Button className="coll-section" onClick={() => onOpen(c.id)}>
            <span className="coll-section-name">{c.name}</span>
            <span className="coll-section-meta small dim num">{sectionMeta(c)}</span>
          </Button>
          <SectionTree parent={c.id} all={all} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

export function ContainerSections({
  container,
  all,
  onOpen,
  onDone,
  onDelete,
  onImport,
}: {
  container: Container;
  all: Container[];
  onOpen: (id: string) => void;
  onDone: (said: string) => void;
  /** Ask to delete it (the page owns the question and where to go afterwards). */
  onDelete?: () => void;
  /** Open the import with this container as the place. */
  onImport?: () => void;
}) {
  const qc = useQueryClient();
  const [doing, setDoing] = useState<"new" | "rename" | "move" | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/api/containers", { method: "POST", json: { name: name.trim(), parent_id: container.id } }),
    onSuccess: () => {
      void refresh(qc);
      onDone(`Made the section ${name.trim()} in ${pathLabel(container, all)}.`);
      setDoing(null);
    },
  });
  const edit = useMutation({
    mutationFn: (body: { name?: string; parent_id?: string | null }) => api(`/api/containers/${encodeURIComponent(container.id)}`, { method: "PATCH", json: body }),
    onSuccess: (_, body) => {
      void refresh(qc);
      const where = body.parent_id === undefined ? null : body.parent_id === null ? "the top level" : pathLabel(all.find((c) => c.id === body.parent_id) ?? container, all);
      onDone(where ? `${container.name} is now in ${where}.` : `Renamed it ${body.name}.`);
      setDoing(null);
    },
  });
  const open = (what: "new" | "rename" | "move") => {
    create.reset();
    edit.reset();
    setName(what === "rename" ? container.name : "");
    setTarget(container.parent_id ?? "");
    setDoing(what);
  };
  const targets = moveTargets(container.id, all);
  const kind = kindWord(container);
  return (
    <div className="coll-sections-panel stack">
      <SectionTree parent={container.id} all={all} onOpen={onOpen} />
      {/* One primary action; what is done once in a while sits behind More, the destructive one
          last. Three buttons didn't fit a phone's row beside "Scan this deck box". */}
      <ActionBar>
        <ButtonLink variant="primary" size="small" to={`/collection/check/${encodeURIComponent(container.id)}`}>Scan this {kind}</ButtonLink>
        <MoreMenu size="small" title={container.name}>
          <Button onClick={() => open("new")}>New section</Button>
          <Button onClick={() => open("rename")}>Rename</Button>
          <Button onClick={() => open("move")}>Move</Button>
          {onImport && <Button onClick={onImport}>Import cards into it</Button>}
          {onDelete && (
            <>
              <MenuSeparator />
              <Button className="danger" onClick={onDelete}>Delete {kind}</Button>
            </>
          )}
        </MoreMenu>
      </ActionBar>
      {(doing === "new" || doing === "rename") && (
        <form
          className="row coll-section-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            if (doing === "new") create.mutate();
            else if (name.trim() !== container.name) edit.mutate({ name: name.trim() });
            else setDoing(null);
          }}
        >
          <Field label={doing === "new" ? `New section in ${container.name}` : "New name"}>
            <input value={name} maxLength={80} required autoFocus placeholder={doing === "new" ? "Plains" : undefined} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={create.isPending || edit.isPending}>{doing === "new" ? "Make it" : "Rename"}</Button>
          <Button variant="quiet" onClick={() => setDoing(null)}>Cancel</Button>
          <ErrorText error={create.error ?? edit.error} />
        </form>
      )}
      {doing === "move" && (
        <Dialog title={`Move ${container.name}`} onClose={() => setDoing(null)}>
          <div className="stack">
            <p className="dim">Its cards and sections go with it.</p>
            <Field label="Put it in">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Top level (in no other box)</option>
                {targets.map((c) => <option key={c.id} value={c.id}>{optionLabel(c, all)}</option>)}
              </select>
            </Field>
            <div className="row">
              <Button
                variant="primary"
                disabled={edit.isPending || target === (container.parent_id ?? "")}
                onClick={() => edit.mutate({ parent_id: target || null })}
              >
                {edit.isPending ? "Moving…" : "Move it"}
              </Button>
              <Button variant="quiet" onClick={() => setDoing(null)}>Cancel</Button>
            </div>
            <ErrorText error={edit.error} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
