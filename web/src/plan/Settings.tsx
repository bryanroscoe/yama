import { fmtDate } from "@yama/core/plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Details, ErrorText } from "../components/ui";
import { createKey, listImports, listKeys, revokeKey, type ScriptKey } from "./api";
import { outbox, useOutbox } from "./outbox";
import { PlansHead, shortHash, usePlanOutlet } from "./PlanLayout";
import { CopyButton } from "./parts";
import { clearPlanData } from "./store";

const VIA: Record<string, string> = { web: "uploaded in the browser", token: "sent by a script", cli: "imported on the server" };

/** `/decks/plan/settings`: keys for scripts, this device's copy, import history, rules and stores. */
export function PlanSettings() {
  const { view, userId } = usePlanOutlet();
  const { b } = view;
  const managed = (rows: { origin: string }[]) => (rows.length && rows.every((r) => r.origin === "import") ? ` Managed by your ${view.app} export.` : "");
  const stores = b.stores.filter((s) => !s.retired);
  return (
    <div className="plan-settings">
      <PlansHead title="Plan settings" />
      <Keys />
      <ThisDevice userId={userId} />
      <Imports />
      {b.settings.length > 0 && (
        <section className="stack">
          <h3>Shopping rules</h3>
          <p className="dim small">Each set applies from its date, so a purchase is judged by the rules of its day.{managed(b.settings)}</p>
          <ul className="small">
            {b.settings.map((s) => (
              <li key={s.effective_from}>
                Applies from {fmtDate(s.effective_from)}
                {s.note ? `: ${s.note}` : ""}
                {s.origin !== "import" && managed(b.settings) === "" && <span className="faint"> Made in Yama.</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
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

function when(iso: string | null): string {
  return iso ? fmtDate(iso) : "never";
}

/** Keys for publish.py and pull.py: create (shown once), list and revoke. */
function Keys() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["plan-keys"], queryFn: listKeys });
  const [name, setName] = useState("commander-decks on the Mac");
  const create = useMutation({ mutationFn: () => createKey(name.trim()), onSuccess: () => void qc.invalidateQueries({ queryKey: ["plan-keys"] }) });
  const revoke = useMutation({ mutationFn: revokeKey, onSuccess: () => void qc.invalidateQueries({ queryKey: ["plan-keys"] }) });
  const live = (k: ScriptKey) => !k.revoked_at && (!k.expires_at || k.expires_at > new Date().toISOString());
  return (
    <section className="stack">
      <h3>Keys for scripts</h3>
      <p className="dim small">
        A key lets a script on your computer send your plan file to Yama and pick up your answers, and nothing else. Revoke it if the computer is lost.
      </p>
      <Details>
        <p>The scripts are commander-decks' publish.py and pull.py. A key can't read your decks, collection or games, or make more keys.</p>
      </Details>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
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
          <p className="small dim">
            On the Mac, save it in the Keychain, where the scripts look for it: run <code>security add-generic-password -a "$USER" -s yama-plan-sync -w</code>{" "}
            in Terminal and paste the key when it asks. Or keep it in 1Password and set <code>YAMA_TOKEN</code> when you run a script.
          </p>
        </div>
      )}
      {keys.data && keys.data.length > 0 && (
        <div className="list">
          {keys.data.map((k) => (
            <div key={k.id} className="list-row">
              <span>
                <span className="title">{k.name}</span>
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
