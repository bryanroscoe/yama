import { fmtDate } from "@yama/core/plan";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMe } from "../auth";
import { artCredits } from "../components/ArtPanel";
import { ArtMosaic } from "../components/ArtMosaic";
import { ErrorText } from "../components/ui";
import { planSummaries, planSummariesKey, type PlanSummary } from "./view";
import "./research.css";

/** "Shared by link", "Public on your profile", or nothing for a private plan. */
function sharing(p: PlanSummary): string | null {
  return p.visibility === "link" ? "Shared by link" : p.visibility === "public" ? "Public on your profile" : null;
}

/**
 * Every plan the person has, as art tiles: notes their agents saved and copies of plans others
 * shared. Each opens the plan's page, the same page a shared link shows.
 */
export function PlanTiles({ empty }: { empty: ReactNode }) {
  const userId = useMe().data?.id;
  const plans = useQuery({ queryKey: planSummariesKey(userId), queryFn: planSummaries, enabled: !!userId });
  if (plans.error) return <ErrorText error={plans.error} />;
  if (!plans.data) return plans.isPending ? <p className="dim">Loading your plans…</p> : null;
  if (!plans.data.length) return <>{empty}</>;
  return (
    <>
      <div className="plan-deck-grid note-plans">
        {plans.data.map((p) => (
          <Link key={p.id} to={`/decks/research/${encodeURIComponent(p.id)}`} className="note-plan-tile">
            <ArtMosaic className="note-plan-art" arts={p.art.map((a) => a.image)} />
            <span className="note-plan-body">
              <span className="note-plan-title">{p.title}</span>
              <span className="small dim">
                {p.decks} {p.decks === 1 ? "deck" : "decks"}. {p.copied_by ? `Copied from @${p.copied_by}, ` : ""}
                {p.copied_by ? "saved" : "Saved"} {fmtDate(p.updated_at)}.
              </span>
              {sharing(p) && <span className="pill quiet">{sharing(p)}</span>}
            </span>
          </Link>
        ))}
      </div>
      {plans.data.some((p) => p.art.length) && <p className="small dim art-credits">{artCredits(plans.data.flatMap((p) => p.art.map((a) => a.artist)))}</p>}
    </>
  );
}
