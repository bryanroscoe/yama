// "Test scanner speed" in Scan settings (speed.ts, speedRun.ts; docs/scanner.md, "Speed test"): one
// tap times the scanner on this device without the camera, shows a plain summary and a small table,
// and keeps the result on the account so an agent can read it (get_scan_speed_tests). It runs only
// when pressed, while Scan settings holds the scanner's own loop paused, and stops if the settings
// close.

import { useEffect, useRef, useState } from "react";
import { ActionBar, Button } from "../components/ui";
import { configFor, speedSummary, type ConfigResult, type SpeedReport, type SpeedRole, type Stat } from "./speed";
import { deleteSpeedTests, runSpeedTest, saveSpeedTest, type SpeedProgress } from "./speedRun";

const ROLE_NAME: Record<SpeedRole, string> = { yours: "Your models", defaults: "The defaults", faster: "The faster ones" };

/** A configuration's name in the table: "Your models (the defaults)". */
export function configName(c: ConfigResult): string {
  const [first, ...rest] = c.roles;
  const head = ROLE_NAME[first ?? "yours"];
  return rest.length ? `${head} (${rest.map((r) => ROLE_NAME[r].toLowerCase()).join(", ")})` : head;
}

const n = (v: number | null | undefined) => (v == null ? "–" : String(Math.round(v)));
const secs = (v: number | null | undefined) => (v == null ? "?" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

function Cell({ s }: { s: Stat | undefined }) {
  return (
    <td>
      {n(s?.median)}
      {s?.p90 != null && <span className="scan-speed-p90">{n(s.p90)}</span>}
    </td>
  );
}

/** What the report says about WebGPU, in words. */
export function webGpuWords(r: SpeedReport): string {
  const g = r.env.webgpu;
  if (!g.api) return "This browser doesn't offer WebGPU.";
  if (!g.adapter) return `This browser has WebGPU but gave no graphics adapter${g.error ? ` (${g.error})` : ""}.`;
  const name = [g.vendor, g.architecture, g.device, g.description].filter(Boolean).join(" ");
  return `WebGPU is available${name ? ` (${name})` : ""}${g.f16 ? ", with 16-bit floats" : ""}${g.fallback ? ", on a software fallback" : ""}.`;
}

export function SpeedResult({ report, saved, kept, onDelete }: { report: SpeedReport; saved: string | null; kept?: boolean; onDelete?: () => void }) {
  const ran = report.configs.filter((c) => c.stats || c.error);
  const look = report.look;
  const yours = configFor(report, "yours");
  return (
    <div className="scan-speed-result">
      <p className="scan-speed-summary">{speedSummary(report)}</p>
      {ran.some((c) => c.stats) && (
        <table className="scan-speed-table">
          <caption className="scan-note">Milliseconds: the median, with the 90th percentile under it.</caption>
          <thead>
            <tr>
              <th scope="col">Models</th>
              <th scope="col">Card finder</th>
              <th scope="col">Art match</th>
              <th scope="col">Search</th>
              <th scope="col">Frame</th>
              <th scope="col">New card</th>
            </tr>
          </thead>
          <tbody>
            {ran.map((c) => (
              <tr key={configName(c)}>
                <th scope="row">{configName(c)}</th>
                {c.stats ? (
                  <>
                    <Cell s={c.stats.detector} />
                    <Cell s={c.stats.embed} />
                    <Cell s={c.stats.search} />
                    <Cell s={c.stats.tracked} />
                    <Cell s={c.stats.fresh} />
                  </>
                ) : (
                  <td colSpan={5}>{c.error}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="scan-note">
        A frame is one the scanner already has the card in (one pass of the card finder); a new card is one it searches the frame for (two passes or more). Card finder is one pass; art match and search are per frame.
      </p>
      {ran.map((c) =>
        c.stats && c.right < c.frames.length ? (
          <p key={`right-${configName(c)}`} className="scan-note">
            {configName(c)} put the right card first on {c.right} of {c.frames.length} frames.
          </p>
        ) : null,
      )}
      {ran.map((c) =>
        c.error && c.stats ? (
          <p key={`error-${configName(c)}`} className="scan-note">
            {configName(c)} stopped early: {c.error}
          </p>
        ) : null,
      )}
      {look && (
        <p className="scan-note">
          {look.error
            ? `The printing look couldn't be timed: ${look.error}`
            : `Printing look (${look.label}): ${n(look.picture.median)} ms to compare a printing's picture, ${n(look.frame.median)} ms for a frame of the card.`}
        </p>
      )}
      <p className="scan-note">
        Warming up: {ran.map((c) => `${configName(c).toLowerCase()} took ${secs(c.loadMs)} to load${c.downloaded ? " (with a download)" : ""}, then ${secs(c.firstFrameMs)} for the first frame`).join("; ")}
        {look && !look.error ? `; the look took ${secs(look.loadMs)} to load and ${secs(look.firstMs)} for its first card` : ""}.
      </p>
      <p className="scan-note">
        {report.device}. {webGpuWords(report)} {report.env.isolated ? "Several processor threads could be used." : "One processor thread (the page isn't cross-origin isolated)"}
        {report.env.cores ? `, of ${report.env.cores} cores` : ""}.
      </p>
      {saved && (
        <p className="scan-note scan-model-runs">
          {saved}
          {kept && onDelete && (
            <>
              {" "}
              <Button className="scan-alt" onClick={onDelete}>
                Delete saved tests
              </Button>
            </>
          )}
        </p>
      )}
      {yours?.ran && (yours.ran.art !== yours.wanted.art.id || yours.ran.detector !== yours.wanted.detector.id) && (
        <p className="scan-note">Your models didn't load, so the defaults ran in their place.</p>
      )}
    </div>
  );
}

export function SpeedTest() {
  const [progress, setProgress] = useState<SpeedProgress | null>(null);
  const [report, setReport] = useState<SpeedReport | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);
  // Closing Scan settings stops a test under way: the scanner reads again then.
  useEffect(() => () => run.current?.abort(), []);
  const start = () => {
    if (run.current) return;
    const stop = new AbortController();
    run.current = stop;
    setReport(null);
    setSaved(null);
    setKept(false);
    setError(null);
    setProgress({ text: "Starting", done: 0, total: 1 });
    runSpeedTest((p) => !stop.signal.aborted && setProgress(p), stop.signal)
      .then(async (r) => {
        if (stop.signal.aborted) return;
        setReport(r);
        setProgress(null);
        if (!r.configs.some((c) => c.stats)) return;
        setSaved("Keeping it on your account…");
        try {
          await saveSpeedTest(r);
          if (stop.signal.aborted) return;
          setSaved("Kept on your account.");
          setKept(true);
        } catch (e) {
          if (!stop.signal.aborted) setSaved(`Not kept: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
      .catch((e: unknown) => {
        if (stop.signal.aborted) return;
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (run.current === stop) run.current = null;
      });
  };
  const remove = () =>
    deleteSpeedTests().then(
      (d) => {
        setKept(false);
        setSaved(`Deleted ${d.deleted} saved ${d.deleted === 1 ? "test" : "tests"}.`);
      },
      (e: unknown) => setSaved(`Not deleted: ${e instanceof Error ? e.message : String(e)}`),
    );
  const cancel = () => {
    run.current?.abort();
    run.current = null;
    setProgress(null);
    setError("Stopped.");
  };
  return (
    <section className="scan-speed" aria-labelledby="scan-speed-title">
      <h3 id="scan-speed-title">Speed</h3>
      <p className="scan-note">
        Times the scanner on this device, with a few cards' pictures from Scryfall instead of the camera: your models, the defaults and the faster ones. It takes about a minute, and may download the faster models. The result is kept on your account, so Yama can see how fast the scanner is on this device.
      </p>
      <ActionBar>
        <Button onClick={start} disabled={!!progress}>
          Test scanner speed
        </Button>
        {progress && (
          <Button variant="quiet" onClick={cancel}>
            Stop
          </Button>
        )}
      </ActionBar>
      {progress && (
        <div className="scan-speed-progress" aria-live="polite">
          <progress max={progress.total} value={progress.done} aria-label="Speed test progress" />
          <p className="scan-note">{progress.text}</p>
        </div>
      )}
      {error && <p className="scan-note">{error}</p>}
      {report && <SpeedResult report={report} saved={saved} kept={kept} onDelete={remove} />}
    </section>
  );
}
