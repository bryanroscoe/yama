// "Ask Claude": a button that opens a side sheet (a bottom sheet on phones) for a conversation
// about what the page shows. The server rebuilds the context from your own data on every
// question; this side streams the answer and offers to save a suggested swap as an idea for your
// planner's inbox (plan decks only), the same op "Suggest a change" sends. Changes Claude stages
// with Yama's tools show under the answer that staged them, with Apply and Discard.

import { opTime } from "@yama/core/plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMe, usePower } from "../auth";
import { Details, ErrorText, Sheet } from "../components/ui";
import { deviceId, outbox } from "../plan/outbox";
import { advisorStatus, ask, changesKey, conversation, conversations, deleteConversation, stagedChanges, type AdvisorStatus, type StagedChange } from "./api";
import { ChangeCard } from "./Changes";
import { inline, parseAnswer, pausedText, possessive, sharedLine, starters, toolActivity, unavailableText, type Block, type ContextKind, type Suggestion } from "./logic";
import "./advisor.css";

export interface AskContext {
  kind: ContextKind;
  ref?: string | null;
}

interface Props {
  context: AskContext;
  /** What the conversation is about, for the sheet's subtitle: "the Tricky Terrain plan". */
  about: string;
  /** The plan deck key, when a suggestion can be saved as an idea for it. */
  ideasFor?: string | null;
  className?: string;
}

const statusKey = ["advisor", "status"] as const;

/** The advisor's status, asked only for admins and power users (nobody else may use it). */
export function useAdvisorStatus(enabled = true) {
  const power = usePower();
  return useQuery({ queryKey: statusKey, queryFn: advisorStatus, enabled: enabled && power, staleTime: 60_000 });
}

/** The button and its sheet. */
export function AskClaude({ context, about, ideasFor, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  if (!useAskClaudeOffered()) return null;
  return (
    <>
      <AskClaudeButton className={className} onClick={() => setOpen(true)} />
      {open && <AskClaudeSheet context={context} about={about} ideasFor={ideasFor} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Whether Ask Claude is offered: not on a server without the advisor, not to anyone but admins and
 * power users (also once a grant is withdrawn while a status is still cached), not before the
 * status is known.
 */
export function useAskClaudeOffered(): boolean {
  const power = usePower();
  const status = useAdvisorStatus();
  return !!power && !!status.data && status.data.reason !== "off";
}

/** The button alone, for a menu that keeps the sheet's state itself (MoreMenu closes on a pick). */
export function AskClaudeButton({ className = "", onClick }: { className?: string; onClick: () => void }) {
  return (
    <button type="button" className={`ask-claude-button ${className}`.trim()} onClick={onClick} aria-haspopup="dialog">
      <SparkIcon /> Ask Claude
    </button>
  );
}

export function AskClaudeSheet({ context, about, ideasFor, onClose }: Omit<Props, "className"> & { onClose: () => void }) {
  return (
    <Sheet label="Ask Claude" onClose={onClose}>
      <AskPanel context={context} about={about} ideasFor={ideasFor ?? null} onClose={onClose} />
    </Sheet>
  );
}

function SparkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
    </svg>
  );
}

interface Pending {
  question: string;
  answer: string;
  /** Saved messages shown before this question: the rest of the saved list arrives as it ends. */
  base: number;
  state: "streaming" | "done" | "error" | "stopped";
  error: string | null;
  /** What Claude is doing with a tool, until its next words arrive. */
  activity?: string | null;
}

function AskPanel({ context, about, ideasFor, onClose }: { context: AskContext; about: string; ideasFor: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const status = useAdvisorStatus();
  const ref = context.ref ?? null;
  const listKey = ["advisor", "conversations", context.kind, ref] as const;
  const list = useQuery({ queryKey: listKey, queryFn: () => conversations(context.kind, ref), enabled: status.data?.available === true });
  const [current, setCurrent] = useState<string | null>(null);
  const [chosen, setChosen] = useState(false);
  const detail = useQuery({ queryKey: ["advisor", "conversation", current], queryFn: () => conversation(current!), enabled: !!current });
  const staged = useQuery({ queryKey: [...changesKey, "conversation", current], queryFn: () => stagedChanges({ conversation: current! }), enabled: !!current });
  const [question, setQuestion] = useState("");
  const [model, setModelChoice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [askError, setAskError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: () => {
      setCurrent(null);
      setChosen(true);
      void qc.invalidateQueries({ queryKey: ["advisor", "conversations"] });
    },
  });

  // Open the newest conversation about this page, once, unless the person picked otherwise.
  useEffect(() => {
    if (!chosen && !current && list.data?.length) setCurrent(list.data[0]!.id);
  }, [chosen, current, list.data]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [pending?.answer, detail.data?.items.length]);

  const streaming = pending?.state === "streaming";
  const submit = async (text: string) => {
    const q = text.trim();
    if (!q || streaming) return;
    setAskError(null);
    setQuestion("");
    setPending({ question: q, answer: "", state: "streaming", error: null, base: current ? (detail.data?.items.length ?? 0) : 0 });
    const ctl = new AbortController();
    abort.current = ctl;
    let conversationId = current;
    try {
      await ask(
        { conversation_id: current, context: current ? undefined : { kind: context.kind, ref }, question: q, model: model ?? undefined },
        (e) => {
          if (e.event === "start") {
            conversationId = String(e.data.conversation_id);
            if (!current) {
              setCurrent(conversationId);
              setChosen(true);
            }
          } else if (e.event === "tool") {
            const activity = toolActivity(String(e.data.name ?? ""));
            setPending((p) => (p ? { ...p, activity } : p));
            // A change the last tool staged shows up under the answer while it streams.
            void qc.invalidateQueries({ queryKey: [...changesKey, "conversation", conversationId] });
          } else if (e.event === "text") {
            const t = String(e.data.text ?? "");
            setPending((p) => (p ? { ...p, answer: p.answer + t, activity: null } : p));
          } else if (e.event === "done") {
            setPending((p) => (p ? { ...p, state: "done" } : p));
          } else if (e.event === "error") {
            setPending((p) => (p ? { ...p, state: e.data.status === "stopped" ? "stopped" : "error", error: (e.data.error as string | null) ?? null } : p));
          }
        },
        ctl.signal,
      );
    } catch (err) {
      if (ctl.signal.aborted) setPending((p) => (p ? { ...p, state: "stopped" } : p));
      else {
        setPending(null);
        setQuestion(q);
        setAskError(err);
      }
    } finally {
      abort.current = null;
      void qc.invalidateQueries({ queryKey: statusKey });
      void qc.invalidateQueries({ queryKey: ["advisor", "conversations"] });
      if (conversationId) {
        await qc.invalidateQueries({ queryKey: ["advisor", "conversation", conversationId] });
      }
      void qc.invalidateQueries({ queryKey: changesKey });
      setPending((p) => (p && p.state !== "streaming" ? null : p));
    }
  };

  const s = status.data;
  const onShared = s ? sharedLine(s, model ?? s.model) : null;
  const paused = s?.mode === "shared" && s.shared_paused_until ? pausedText(s.shared_owner, s.shared_paused_until) : null;
  const saved = detail.data?.items ?? [];
  const items = pending ? saved.slice(0, pending.base) : saved;
  const savedIds = new Set(saved.map((m) => m.id));
  const changesFor = (messageId: string | null) => (staged.data ?? []).filter((c) => (messageId ? c.message_id === messageId : !savedIds.has(c.message_id ?? ""))).reverse();
  const empty = !current && !pending;
  return (
    <div className="ask-panel">
      <header className="ask-head">
        <div>
          <h2>Ask Claude</h2>
          <p className="dim small">About {about}</p>
          {onShared && <p className="ask-mode small">{onShared}</p>}
        </div>
        <button type="button" className="quiet" onClick={onClose}>Close</button>
      </header>

      {status.isPending && <p className="dim">Loading…</p>}
      <ErrorText error={status.error} />
      {s && !s.available && (
        <div className="ask-unavailable stack">
          <p>{unavailableText(s.reason, s.can_save_key)}</p>
          {s.reason === "needs_key" && s.can_save_key && (
            <p>
              <Link to="/profile#grp-you" onClick={onClose}>Open settings</Link>
            </p>
          )}
        </div>
      )}

      {s?.mode === "subscription" && s.subscription_connected === false && (
        <p className="ask-unavailable">Your Claude subscription isn't connected on the server yet. Run deploy/advisor-token.sh on the Mac to connect it.</p>
      )}
      {paused && (
        <div className="ask-unavailable stack">
          <p>{paused}</p>
          {s?.can_save_key && (
            <p>
              <Link to="/profile#grp-you" onClick={onClose}>Open settings</Link>
            </p>
          )}
        </div>
      )}
      {s?.available && (
        <>
          {(list.data?.length ?? 0) > 0 && (
            <div className="ask-convos">
              <label>
                <span className="visually-hidden">Conversation</span>
                <select
                  value={current ?? ""}
                  onChange={(e) => {
                    setChosen(true);
                    setCurrent(e.target.value || null);
                  }}
                  disabled={streaming}
                >
                  <option value="">New conversation</option>
                  {list.data!.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              {current && (
                <button type="button" className="quiet" disabled={streaming || remove.isPending} onClick={() => remove.mutate(current)}>
                  Delete
                </button>
              )}
            </div>
          )}
          <ErrorText error={remove.error ?? detail.error} />

          <div className="ask-thread" aria-live="polite">
            {empty && (
              <div className="ask-starters">
                <p className="dim small">Try one of these, or ask your own.</p>
                {starters(context.kind).map((t) => (
                  <button key={t} type="button" className="ask-starter" onClick={() => void submit(t)} disabled={!!paused}>
                    {t}
                  </button>
                ))}
              </div>
            )}
            {items.map((m) =>
              m.role === "user" ? (
                <Question key={m.id} text={m.content} />
              ) : (
                <Answer key={m.id} text={m.content} ideasFor={ideasFor} changes={changesFor(m.id)} onNavigate={onClose} note={m.status === "stopped" ? "Stopped before the end." : m.status === "error" ? (m.error ?? "Claude couldn't answer.") : null} error={m.status === "error"} />
              ),
            )}
            {pending && (
              <>
                <Question text={pending.question} />
                <Answer
                  text={pending.answer}
                  ideasFor={ideasFor}
                  changes={changesFor(null)}
                  onNavigate={onClose}
                  streaming={pending.state === "streaming"}
                  activity={pending.state === "streaming" ? pending.activity : null}
                  note={pending.state === "stopped" ? "Stopped before the end." : pending.state === "error" ? (pending.error ?? "Claude couldn't answer.") : null}
                  error={pending.state === "error"}
                />
              </>
            )}
            <div ref={end} />
          </div>

          <form
            className="ask-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(question);
            }}
          >
            <label className="ask-question">
              <span className="visually-hidden">Your question</span>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={current ? "Ask a follow-up" : "Ask about this"}
                rows={3}
                maxLength={8000}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit(question);
                  }
                }}
              />
            </label>
            <div className="ask-actions">
              <label className="ask-model">
                <span className="visually-hidden">Model</span>
                <select value={model ?? s.model} onChange={(e) => setModelChoice(e.target.value)} disabled={streaming}>
                  {s.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              {streaming ? (
                <button type="button" className="outline" onClick={() => abort.current?.abort()}>Stop</button>
              ) : (
                <button className="primary" disabled={!question.trim() || !!paused}>Ask</button>
              )}
            </div>
            <ErrorText error={askError} />
          </form>
          <Footnote status={s} />
        </>
      )}
    </div>
  );
}

function Footnote({ status }: { status: AdvisorStatus }) {
  const who =
    status.mode === "subscription"
      ? "On the server owner's Claude subscription."
      : status.mode === "shared"
        ? `On ${possessive(status.shared_owner ?? "")} shared API key, which they pay for per question.`
        : `On your own Anthropic API key${status.key_hint ? ` ending ${status.key_hint}` : ""}.`;
  // On the shared key the count is already in the line under the title.
  const used = status.per_day != null && status.mode !== "shared" ? ` ${status.used_today} of ${status.per_day} questions in the last 24 hours.` : "";
  return (
    <div className="ask-foot faint small">
      <p>{who}{used}</p>
      <Details label="About assistant answers">
        <p>Claude can be wrong; check prices and legality before you buy. Simulated results describe the simulation, not your table.</p>
      </Details>
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div className="ask-msg ask-q">
      <span className="ask-who">You</span>
      <p>{text}</p>
    </div>
  );
}

function Answer({
  text,
  ideasFor,
  changes = [],
  onNavigate,
  streaming = false,
  activity = null,
  note,
  error = false,
}: {
  text: string;
  ideasFor: string | null;
  /** Changes this answer staged, waiting for Apply or Discard (or already decided). */
  changes?: StagedChange[];
  onNavigate?: () => void;
  streaming?: boolean;
  /** What Claude is doing right now, while it uses a tool. */
  activity?: string | null;
  note?: string | null;
  error?: boolean;
}) {
  const blocks = parseAnswer(text);
  return (
    <div className={`ask-msg ask-a${error ? " ask-error" : ""}`}>
      <span className="ask-who">Claude</span>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} ideasFor={ideasFor} streaming={streaming} />
      ))}
      {changes.length > 0 && (
        <div className="ask-changes-list">
          {changes.map((c) => (
            <ChangeCard key={c.id} change={c} onNavigate={onNavigate} />
          ))}
        </div>
      )}
      {streaming && (activity || !text) && (
        <p className="dim" role="status">
          {activity ?? "Thinking…"}
        </p>
      )}
      {note && <p className={error ? "error small" : "dim small"}>{note}</p>}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {inline(text).map((s, i) => (s.bold ? <b key={i}>{s.text}</b> : s.code ? <code key={i}>{s.text}</code> : <span key={i}>{s.text}</span>))}
    </>
  );
}

function BlockView({ block, ideasFor, streaming }: { block: Block; ideasFor: string | null; streaming: boolean }): ReactNode {
  switch (block.kind) {
    case "heading":
      return (
        <h3 className="ask-h">
          <Inline text={block.text} />
        </h3>
      );
    case "p":
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );
    case "list": {
      const items = block.items.map((t, i) => (
        <li key={i}>
          <Inline text={t} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "code":
      return <pre className="ask-code">{block.text}</pre>;
    case "suggestion":
      return <SuggestionCard s={block.suggestion} ideasFor={ideasFor} disabled={streaming} />;
  }
}

function SuggestionCard({ s, ideasFor, disabled }: { s: Suggestion; ideasFor: string | null; disabled: boolean }) {
  const userId = useMe().data?.id;
  const [saved, setSaved] = useState(false);
  const save = () => {
    if (!userId || !ideasFor) return;
    outbox.enqueue(userId, { kind: "idea", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), deck_key: ideasFor, in: s.in, out: s.out, why: s.why });
    setSaved(true);
  };
  return (
    <div className="ask-suggestion">
      <p className="ask-swap">
        <b>{s.in}</b>
        {s.out ? (
          <>
            {" "}
            <span aria-hidden="true">for</span>
            <span className="visually-hidden">replacing</span> <b>{s.out}</b>
          </>
        ) : (
          <span className="dim"> (nothing comes out)</span>
        )}
      </p>
      {s.why && <p className="small dim">{s.why}</p>}
      {ideasFor ? (
        saved ? (
          <p className="small" role="status">Saved. It goes to your planner's inbox.</p>
        ) : (
          <button type="button" className="outline" onClick={save} disabled={disabled || !userId}>Save as an idea</button>
        )
      ) : (
        <p className="small dim">To save this as an idea, ask from the deck's plan.</p>
      )}
    </div>
  );
}
