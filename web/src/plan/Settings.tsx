import { localBuyRule, MAX_TIERS, rulesAt, shoppingRulesDraft, shoppingRulesProblems, type ShoppingRulesDraft } from "@yama/core/plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Details, ErrorText } from "../components/ui";
import { ConnectedApps } from "../oauth/ConnectedApps";
import { publicOrigin } from "../api";
import { createKey, listImports, listKeys, removeShoppingRules, revokeKey, saveShoppingRules, type KeyScope, type ScriptKey } from "./api";
import { outbox, useOutbox } from "./outbox";
import { PlansHead, shortHash, usePlanOutlet } from "./PlanLayout";
import { SettingsHowTo } from "./howto";
import { CopyButton } from "./parts";
import { clearPlanData } from "./store";
import { fmtDate, usd } from "@yama/core";

const VIA: Record<string, string> = { web: "uploaded in the browser", token: "sent by a script", cli: "imported on the server" };

/** `/decks/plans/settings`: connecting Claude, keys for scripts, this device's copy, import history, rules and stores. */
export function PlanSettings() {
  const { view, userId } = usePlanOutlet();
  const { b } = view;
  const managed = (rows: { origin: string }[]) => (rows.length && rows.every((r) => r.origin === "import") ? ` Managed by your ${view.app} export.` : "");
  const stores = b.stores.filter((s) => !s.retired);
  return (
    <div className="plan-settings">
      <PlansHead title="Plan settings" />
      <SettingsHowTo />
      <ConnectedApps />
      <Keys />
      <ThisDevice userId={userId} />
      <Imports />
      <ShoppingRules />
      {stores.length > 0 && (
        <section className="stack">
          <h3>Stores</h3>
          {managed(stores) && <p className="dim small">{managed(stores).trim()}</p>}
          <ul className="small">
            {stores.map((s) => (
              <li key={s.key}>
                {s.name}
                {s.location ? `, ${s.location}` : ""}
                {s.note ? `. ${s.note}` : ""}
                {s.origin !== "import" && managed(stores) === "" && <span className="faint"> Made in Yama.</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="faint small">Unofficial fan software. Not affiliated with, endorsed by, or sponsored by Wizards of the Coast.</p>
    </div>
  );
}

/** A dollar or multiple field: empty is null. */
function numText(v: number | null): string {
  return v == null ? "" : String(v);
}
function textNum(t: string): number | null {
  return t.trim() === "" ? null : Number(t);
}

/**
 * Your buy rule and sealed cap. Each save is a new rule set from today, a copy of the set in force
 * with these replaced, so older checks keep the rules of their own day. A later plan import never
 * replaces a set made in Yama (docs/shopping-design.md).
 */
function ShoppingRules() {
  const { view, userId } = usePlanOutlet();
  const qc = useQueryClient();
  const sets = view.b.settings;
  const inForce = rulesAt(sets, view.today);
  const [draft, setDraft] = useState<ShoppingRulesDraft | null>(null);
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: (d: ShoppingRulesDraft) => saveShoppingRules({ effective_from: view.today, local_buy: d.local_buy, sealed_max_usd: d.sealed_max_usd, note: note.trim() || null }),
    onSuccess: () => {
      setDraft(null);
      setNote("");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["plan", userId] }),
  });
  const remove = useMutation({ mutationFn: removeShoppingRules, onSettled: () => qc.invalidateQueries({ queryKey: ["plan", userId] }) });
  const newest = [...sets].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
  const rule = localBuyRule(inForce);
  const sealed = inForce?.rules.sealed_max_usd;
  const problems = draft ? shoppingRulesProblems(draft) : [];
  const lb = draft?.local_buy;
  const setLb = (change: Partial<ShoppingRulesDraft["local_buy"]>) => draft && setDraft({ ...draft, local_buy: { ...draft.local_buy, ...change } });
  const setTier = (i: number, change: Partial<ShoppingRulesDraft["local_buy"]["tiers"][number]>) =>
    lb && setLb({ tiers: lb.tiers.map((t, n) => (n === i ? { ...t, ...change } : t)) });

  return (
    <section className="stack" aria-labelledby="shopping-rules">
      <h3 id="shopping-rules">Shopping rules</h3>
      <p className="small">
        {inForce ? `In force today, from ${fmtDate(inForce.effective_from)}${inForce.origin === "yama" ? " (made in Yama)" : " (from your import)"}: ` : "No rules yet. "}
        {rule.text}
        {typeof sealed === "number" ? ` Sealed precons: at most ${usd(sealed)} a deck before tax.` : ""}
      </p>
      {!draft && (
        <p>
          <button type="button" className="button outline" onClick={() => setDraft(shoppingRulesDraft(sets, view.today))}>
            Change your buy rule
          </button>
        </p>
      )}
      {draft && lb && (
        <form
          className="stack rules-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problems.length) save.mutate(draft);
          }}
        >
          <label>
            Most a card may cost: $
            <input type="number" inputMode="decimal" min={0} step={0.05} value={numText(lb.max_usd)} onChange={(e) => setLb({ max_usd: textNum(e.target.value) })} placeholder="no limit" />
          </label>
          <label>
            Fine whatever the market at or under: $
            <input type="number" inputMode="decimal" min={0} step={0.05} value={numText(lb.always_ok_usd)} onChange={(e) => setLb({ always_ok_usd: textNum(e.target.value) })} placeholder="none" />
          </label>
          <fieldset className="stack">
            <legend className="small">Compared with market</legend>
            {lb.tiers.map((t, i) => {
              const last = i === lb.tiers.length - 1;
              return (
                <div key={i} className="rules-tier">
                  {last && t.market_under == null ? (
                    <span>{i ? "Otherwise" : "Any market"}</span>
                  ) : (
                    <label>
                      When market is under $
                      <input type="number" inputMode="decimal" min={0} step={0.05} value={numText(t.market_under)} onChange={(e) => setTier(i, { market_under: textNum(e.target.value) })} />
                    </label>
                  )}
                  <label>
                    , at most
                    <input type="number" inputMode="decimal" min={0} step={0.05} value={numText(t.max_multiple)} onChange={(e) => setTier(i, { max_multiple: Number(e.target.value) })} />× market
                  </label>
                  <button type="button" className="button outline" onClick={() => setLb({ tiers: lb.tiers.filter((_, n) => n !== i) })} aria-label={`Remove range ${i + 1}`}>
                    Remove
                  </button>
                </div>
              );
            })}
            {lb.tiers.length < MAX_TIERS && (
              <p>
                <button
                  type="button"
                  className="button outline"
                  onClick={() => {
                    const lastTier = lb.tiers[lb.tiers.length - 1];
                    const before = lb.tiers.slice(0, -1);
                    // A new range goes before an "any market" one, starting a dollar above the range before it.
                    if (lastTier && lastTier.market_under == null)
                      setLb({ tiers: [...before, { market_under: (before[before.length - 1]?.market_under ?? 0) + 1, max_multiple: 2 }, lastTier] });
                    else setLb({ tiers: [...lb.tiers, { market_under: null, max_multiple: 1.5 }] });
                  }}
                >
                  Add a market range
                </button>
              </p>
            )}
            <p className="dim small">No ranges: market isn't checked. With ranges, a card with no market price qualifies only at or under the always-fine price.</p>
          </fieldset>
          <label>
            Sealed precons, at most $
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              value={numText(draft.sealed_max_usd)}
              onChange={(e) => setDraft({ ...draft, sealed_max_usd: textNum(e.target.value) })}
              placeholder="no limit"
            />{" "}
            a deck before tax
          </label>
          <label>
            Note <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="why it changed" />
          </label>
          {problems.length > 0 && (
            <ul className="small" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <p className="dim small">Saves a new rule set from {fmtDate(view.today)}. Checks from earlier days keep the rules of their own day, and a later plan import won't replace it.</p>
          <p className="rules-actions">
            <button type="submit" className="button primary" disabled={save.isPending || problems.length > 0}>
              Save from today
            </button>
            <button type="button" className="button outline" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </p>
          {save.error && <ErrorText error={save.error} />}
        </form>
      )}
      {sets.length > 0 && (
        <Details label={`Every rule set (${sets.length})`}>
          <ul className="small">
            {sets.map((s) => (
              <li key={s.effective_from}>
                Applies from {fmtDate(s.effective_from)}
                {s.note ? `: ${s.note}` : ""}. {s.origin === "yama" ? "Made in Yama." : "From your import."}
                {s.origin === "yama" && s === newest && (
                  <>
                    {" "}
                    <button type="button" className="button outline" disabled={remove.isPending} onClick={() => remove.mutate(s.effective_from)}>
                      Undo this one
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {remove.error && <ErrorText error={remove.error} />}
        </Details>
      )}
    </section>
  );
}

function when(iso: string | null): string {
  return iso ? fmtDate(iso) : "never";
}

const KEY_NAMES: Record<KeyScope, string> = { "plan:sync": "Plan script on my computer", mcp: "Claude Code on my computer" };

/** The command that connects Claude Code to Yama's tools with a new key. */
function claudeCommand(token: string): string {
  return `claude mcp add --transport http yama ${publicOrigin()}/mcp --header "Authorization: Bearer ${token}"`;
}

/** Keys for plan scripts and for Claude's tools: create (shown once), list and revoke. */
function Keys() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["plan-keys"], queryFn: listKeys });
  const [scope, setScope] = useState<KeyScope>("plan:sync");
  const [name, setName] = useState(KEY_NAMES["plan:sync"]);
  const create = useMutation({ mutationFn: () => createKey(name.trim(), scope), onSuccess: () => void qc.invalidateQueries({ queryKey: ["plan-keys"] }) });
  const revoke = useMutation({ mutationFn: revokeKey, onSuccess: () => void qc.invalidateQueries({ queryKey: ["plan-keys"] }) });
  const live = (k: ScriptKey) => !k.revoked_at && (!k.expires_at || k.expires_at > new Date().toISOString());
  return (
    <section className="stack">
      <h3>Keys for scripts and Claude</h3>
      <p className="dim small">
        A script key lets a script of yours send a plan file to Yama and pick up your answers. A Claude key lets Claude Code (or another app that speaks MCP) read your decks,
        plans, collection and lab runs with Yama's tools, for apps that can't sign in. Revoke a key if the computer is lost.
      </p>
      <Details>
        <p>
          A script key only uploads a plan file and downloads your answers to it; it can't read your decks, collection or games. A Claude key reads everything of yours that Ask Claude can,
          and changes nothing. No key can make more keys.
        </p>
      </Details>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <select
          value={scope}
          aria-label="What the key is for"
          onChange={(e) => {
            const next = e.target.value as KeyScope;
            if (name === KEY_NAMES[scope]) setName(KEY_NAMES[next]);
            setScope(next);
          }}
        >
          <option value="plan:sync">For scripts</option>
          <option value="mcp">For Claude</option>
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Where the key is used" required maxLength={100} style={{ flex: "1 1 14rem" }} />
        <button disabled={create.isPending || !name.trim()}>Make a key</button>
      </form>
      <ErrorText error={create.error ?? revoke.error ?? keys.error} />
      {create.data && (
        <div className="plan-banner stack" role="status">
          <p>
            <b>Your new key.</b> Copy it now: Yama shows it only once and keeps only a fingerprint of it.
          </p>
          <code className="plan-key">{create.data.token}</code>
          <div className="row">
            <CopyButton text={create.data.token} label="Copy the key" />
          </div>
          {create.data.scopes.includes("mcp") ? (
            <>
              <p className="small dim">To connect Claude Code, run this in Terminal (it holds the key, so don't share it):</p>
              <code className="plan-key">{claudeCommand(create.data.token)}</code>
              <div className="row">
                <CopyButton text={claudeCommand(create.data.token)} label="Copy the command" />
              </div>
            </>
          ) : (
            <p className="small dim">
              Keep it in a password manager and set <code>YAMA_TOKEN</code> when you run a script. On a Mac you can save it in the Keychain instead: run{" "}
              <code>security add-generic-password -a "$USER" -s yama-plan-sync -w</code> in Terminal and paste the key when it asks.
            </p>
          )}
        </div>
      )}
      {keys.data && keys.data.length > 0 && (
        <div className="list">
          {keys.data.map((k) => (
            <div key={k.id} className="list-row">
              <span>
                <span className="title">{k.name}</span> <span className="small dim">{k.scopes.includes("mcp") ? "for Claude" : "for scripts"}</span>
                <br />
                <span className="small dim">
                  Made {fmtDate(k.created_at)}. Last used {when(k.last_used_at)}.{" "}
                  {k.revoked_at ? `Revoked ${fmtDate(k.revoked_at)}.` : k.expires_at ? `${live(k) ? "Expires" : "Expired"} ${fmtDate(k.expires_at)}.` : ""}
                </span>
              </span>
              {live(k) && (
                <button
                  className="quiet small"
                  disabled={revoke.isPending}
                  onClick={() => window.confirm(`Revoke "${k.name}"? Scripts using it stop working.`) && revoke.mutate(k.id)}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The copy of the plans kept on this phone for offline use. */
function ThisDevice({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const box = useOutbox(userId);
  const clear = async () => {
    const n = box.pending.length;
    const ask = n
      ? `${n === 1 ? "1 answer hasn't" : `${n} answers haven't`} reached Yama yet and will be deleted. Clear the plan data on this device anyway?`
      : "Clear the plan data saved on this device? Your plans stay in Yama and download again when you open them.";
    if (!window.confirm(ask)) return;
    await clearPlanData(userId);
    qc.removeQueries({ queryKey: ["plan"] });
    qc.removeQueries({ queryKey: ["plan-cache"] });
    navigate("/decks");
  };
  return (
    <section className="stack">
      <h3>This device</h3>
      <p className="dim small">
        Your plans are saved on this device so they open with no signal. They include prices you paid, so they're deleted when you sign out.
        {box.pending.length ? ` ${box.pending.length} of your answers are saved here, waiting to sync.` : ""}
      </p>
      <div className="row">
        {box.pending.length > 0 && <button onClick={() => void outbox.sync(userId)}>Send answers now</button>}
        <button onClick={() => void clear()}>Clear plan data on this device</button>
      </div>
    </section>
  );
}

function Imports() {
  const imports = useQuery({ queryKey: ["plan-imports"], queryFn: listImports });
  if (!imports.data?.length) return <ErrorText error={imports.error} />;
  return (
    <section className="stack">
      <h3>Import history</h3>
      <ul className="small">
        {imports.data.map((i) => {
          const sw = i.report.counts?.swaps;
          return (
            <li key={i.id}>
              {fmtDate(i.imported_at)}, {VIA[i.via] ?? i.via}
              {i.meta.guide_version != null ? `: guide v${i.meta.guide_version}` : ""}
              {i.forced ? ", forced" : ""}
              {sw ? `. Swaps: ${sw.added} added, ${sw.changed} changed, ${sw.retired} retired.` : "."}
            </li>
          );
        })}
      </ul>
      <Details>
        {imports.data.map((i) => (
          <p key={i.id}>
            {fmtDate(i.imported_at)}: plan {shortHash(i.content_hash)}
            {i.meta.git_sha ? `, commit ${i.meta.git_sha.slice(0, 7)}` : ""}
            {i.meta.dirty ? " with uncommitted changes" : ""}.
          </p>
        ))}
      </Details>
    </section>
  );
}
