import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, publicOrigin, type DeckView } from "../../api";
import { Button, Details, Dialog, ErrorText, Field, Loading } from "../../components/ui";
import { sendCards, useMythicBridge, type MythicDeckLink } from "./mythic";
import { mythicSendSnippet } from "./snippet";
import "./mythic.css";

const PRIVACY: { value: string; label: string }[] = [
  { value: "private", label: "Private: only you" },
  { value: "shared", label: "Shared: your Mythic friends" },
  { value: "unlisted", label: "Unlisted: anyone with the link" },
  { value: "public", label: "Public" },
];

/** The deck page's button for sending the deck to Mythic Tools, when the bridge is on. */
export function MythicSendButton({ className, onClick }: { className: string; onClick: () => void }) {
  if (!useMythicBridge()) return null;
  return <Button className={className} onClick={onClick}>Send to Mythic Tools</Button>;
}

/**
 * Send a deck to Mythic Tools (ARCHITECTURE.md, "Mythic Tools bridge"): a snippet with the deck
 * in it, pasted into the console on mythic.tools, makes the Mythic deck or brings the linked one
 * in step, then opens Yama again to link them.
 */
export function MythicSend({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const qc = useQueryClient();
  const link = useQuery({ queryKey: ["mythic-deck", deck.id], queryFn: ({ signal }) => api<MythicDeckLink>(`/api/bridges/mythic/decks/${deck.id}`, { signal }) });
  const [privacy, setPrivacy] = useState("private");
  const [copied, setCopied] = useState(false);
  const { cards, missing } = sendCards(deck);
  const send = useMutation({
    mutationFn: () => api<{ code: string; mythic_id: string | null }>(`/api/bridges/mythic/decks/${deck.id}/send`, { method: "POST", json: { version_id: deck.version_id } }),
    onSuccess: () => setCopied(false),
  });
  const unlink = useMutation({
    mutationFn: () => api(`/api/bridges/mythic/decks/${deck.id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["mythic-deck", deck.id] }),
  });
  const snippet = send.data
    ? mythicSendSnippet({ code: send.data.code, mythic_id: send.data.mythic_id, name: deck.name, privacy, cards, back: `${publicOrigin()}/mythic/sent` })
    : null;
  const copy = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const linked = link.data?.mythic_id ?? null;

  return (
    <Dialog title="Send to Mythic Tools" onClose={onClose}>
      <div className="stack mythic-send">
        {linked ? (
          <p>
            Linked to your Mythic deck {linked}. {link.data?.same ? "Its list matched this one when they last synced." : "This list has changed since they last synced."} Sending replaces the Mythic deck's name, commander and main deck with this one.
          </p>
        ) : (
          <>
            <p>Makes this deck in Mythic Tools and links the two, so later sends and imports update each other.</p>
            <Field label="Who can see it in Mythic">
              <select value={privacy} onChange={(e) => { setPrivacy(e.target.value); send.reset(); }}>
                {PRIVACY.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </Field>
          </>
        )}
        {missing.length > 0 && (
          <p className="small dim">
            {missing.length === 1 ? "1 card has" : `${missing.length} cards have`} no paper printing on file and won't go: {missing.join(", ")}.
          </p>
        )}
        {!snippet ? (
          <div className="row">
            <Button disabled={send.isPending || !deck.version_id} onClick={() => send.mutate()}>Make the snippet</Button>
            {linked && <Button variant="outline" disabled={unlink.isPending} onClick={() => unlink.mutate()}>Unlink</Button>}
          </div>
        ) : (
          <>
            <ol>
              <li>Open <a href="https://mythic.tools" target="_blank" rel="noreferrer">mythic.tools</a> in this browser and sign in.</li>
              <li>Open the browser's console there: Ctrl+Shift+J, or Cmd+Option+J on a Mac.</li>
              <li>Paste the snippet and press Enter. When it's done it opens Yama to link the deck; if your browser blocks that, open the link it prints.</li>
            </ol>
            <div className="row">
              <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy the snippet"}</Button>
            </div>
            <p className="small dim">The snippet works once, for a day. Make a new one after changing the deck.</p>
            <Details label="What the snippet does">
              <p>It reads Mythic's web settings and your sign-in from the mythic.tools page, makes the deck or updates the linked one through Mythic's own requests, and opens Yama with the Mythic deck's id. Your Mythic sign-in never leaves that page.</p>
              <pre className="mythic-snippet small">{snippet}</pre>
            </Details>
          </>
        )}
        <ErrorText error={link.error ?? send.error ?? unlink.error} />
      </div>
    </Dialog>
  );
}

/** Where the send snippet comes back to: links the deck to the Mythic deck it made or updated. */
export function MythicSentPage() {
  const [search] = useSearchParams();
  const qc = useQueryClient();
  const code = search.get("code") ?? "";
  const mythic = search.get("mythic") ?? "";
  const done = useMutation({
    mutationFn: () => api<{ deck_id: string }>("/api/bridges/mythic/decks/sent", { method: "POST", json: { code, mythic_id: mythic, print: search.get("print") } }),
    onSuccess: (r) => void qc.invalidateQueries({ queryKey: ["mythic-deck", r.deck_id] }),
  });
  // Once per visit, even if React runs the effect twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !code || !mythic) return;
    started.current = true;
    done.mutate();
  }, [code, mythic]);

  return (
    <main className="page stack">
      <h1>Sent to Mythic Tools</h1>
      {!code || !mythic ? (
        <p>This link is missing the send's details. Send the deck again from its page.</p>
      ) : done.isPending ? (
        <Loading>Linking the deck…</Loading>
      ) : done.data ? (
        <p>
          The deck is in Mythic and linked. <Link to={`/decks/${done.data.deck_id}`}>Back to the deck</Link>
        </p>
      ) : null}
      <ErrorText error={done.error} />
    </main>
  );
}
