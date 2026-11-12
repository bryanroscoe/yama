import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorText } from "../components/ui";
import { adminApi, type UsageRow } from "./api";
import { advisorLine, holdings, nearLimits, searchAccounts, today } from "./logic";
import { count } from "@yama/core";


export function UsagePage() {
  const usage = useQuery({ queryKey: ["admin-usage"], queryFn: adminApi.usage, refetchInterval: 30_000 });
  const [q, setQ] = useState("");
  const t = usage.data?.totals;
  const near = (usage.data?.accounts ?? []).map((a) => ({ a, warnings: nearLimits(a) })).filter((x) => x.warnings.length);
  const list = searchAccounts(usage.data?.accounts ?? [], q);
  return (
    <>
      <ErrorText error={usage.error} />
      {t && (
        <section className="admin-section" aria-labelledby="adm-totals">
          <h2 id="adm-totals">Everyone</h2>
          <div className="admin-figures">
            <Figure value={count(t.accounts)} label={`accounts, ${count(t.open_signup_accounts)} on the standard allowance${t.disabled ? `, ${count(t.disabled)} disabled` : ""}`} />
            <Figure value={count(t.seen_today)} label="used Yama in the last 24 hours" />
            <Figure value={count(t.lab_games_today)} label="lab games asked for in the last 24 hours" />
            <Figure
              value={count(t.lab_games_queued)}
              label={`lab games waiting, of ${count(t.lab_queue_cap)} allowed; ${count(t.lab_open_queue_games)} of ${count(t.lab_open_queue_cap)} from accounts with a daily number of games`}
            />
            <Figure value={count(t.advisor_today)} label="questions to Claude in the last 24 hours" />
            <Figure value={count(t.watch_running)} label="watched games running" />
            <Figure value={count(t.online_games_live)} label="online games being played" />
          </div>
        </section>
      )}
      {usage.data && (
        <section className="admin-section" aria-labelledby="adm-near">
          <h2 id="adm-near">Near a limit</h2>
          {near.length === 0 ? (
            <p className="dim">Nobody has used 80% of an allowance.</p>
          ) : (
            <ul className="admin-list">
              {near.map(({ a, warnings }) => (
                <li key={a.id}>
                  <div className="admin-text">
                    <b>{a.display_name}</b>
                    <span>{a.email}</span>
                    {warnings.map((w) => (
                      <span key={w} className="admin-warn">
                        {w}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {usage.data && (
        <section className="admin-section" aria-labelledby="adm-each">
          <div className="admin-section-head">
            <h2 id="adm-each">Each account</h2>
            <span className="dim">The last 24 hours, and what each has in Yama.</span>
          </div>
          <label className="admin-search">
            <span className="visually-hidden">Search accounts</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" />
          </label>
          <ul className="admin-list">
            {list.map((a) => (
              <AccountUsage key={a.id} a={a} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function AccountUsage({ a }: { a: UsageRow }) {
  const day = today(a);
  return (
    <li className={a.disabled ? "is-off" : undefined}>
      <div className="admin-text">
        <b>
          {a.display_name}
          {a.is_admin ? " (admin)" : a.limited ? " (standard allowance)" : ""}
        </b>
        <span>{a.email}</span>
        <span>{holdings(a)}</span>
        {day && <span>{day}</span>}
        <span>
          {advisorLine(a)}
          {a.advisor_total ? ` ${count(a.advisor_total)} questions so far.` : ""}
        </span>
      </div>
    </li>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="admin-figure">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}
