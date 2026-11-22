// "Test scanner speed" in Scan settings (speed.ts, speedRun.ts; docs/scanner.md, "Speed test"): one
// tap times the scanner on this device without the camera, shows a plain summary and a small table,
// and keeps the result on the account so an agent can read it (get_scan_speed_tests). It runs only
// when pressed, while Scan settings holds the scanner's own loop paused, and stops if the settings
// close.

import { useEffect, useRef, useState } from "react";
import { ActionBar, Button } from "../components/ui";
import { NATIVE_RUNTIME } from "./nativeModels";
import { speedSummary, type Alongside, type ConfigResult, type SpeedReport, type SpeedRole, type Stat } from "./speed";
import { deleteSpeedTests, runSpeedTest, saveSpeedTest, speedTestCount, type SpeedProgress } from "./speedRun";

const ROLE_NAME: Record<SpeedRole, string> = { yours: "Your models", defaults: "The defaults", faster: "The faster ones" };

/** A configuration's name in the table: "Your models (the defaults)", and ", card finder in the app" when it ran there. */
export function configName(c: ConfigResult): string {
  const [first, ...rest] = c.roles;
  const head = ROLE_NAME[first ?? "yours"];
  const name = rest.length ? `${head} (${rest.map((r) => ROLE_NAME[r].toLowerCase()).join(", ")})` : head;
  return c.runtimes?.detector === NATIVE_RUNTIME ? `${name}, card finder in the app` : name;
}

/** "The app's card finder matched the web view's on 32 of 32 frames, corners within 0.4 px." */
export function parityLine(c: ConfigResult): string | null {
  const p = c.parity;
  if (!p || p.frames === 0) return null;
  const agreed = p.frames - p.disagreed;
  const corners = p.maxPx == null ? "" : `, corners within ${p.maxPx} px (median ${p.medianPx})`;
  return `${configName(c)}: found a card where the web view's finder did on ${agreed} of ${p.frames} frames${corners}; the same best match on ${p.sameTop}.`;
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

export function SpeedResult({ report }: { report: SpeedReport }) {
  const ran = report.configs.filter((c) => c.stats || c.error);
  const look = report.look;
  return (
    <div className="scan-speed-result">
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
      {ran.map((c) => {
        const line = parityLine(c);
        return line ? (
          <p key={`parity-${configName(c)}`} className="scan-note">
            {line}
          </p>
        ) : null;
      })}
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
        {report.alongside ? " The scanner's own models stayed loaded beside the test, as they are when you switch models here." : ""}
      </p>
    </div>
  );
}

/**
 * Whether the scanner's own recognizer is done loading and switching models (ScannerView's state:
 * its mode is known, nothing is downloading, and no Models note says "Loading …"), so a speed test
 * started now doesn't time against that work.
 */
export const scannerSettled = (mode: string | null, loading: unknown, notes: Partial<Record<string, string | undefined>>): boolean =>
  mode !== null && !loading && !Object.values(notes).some((n) => n?.startsWith("Loading "));

const say = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The Speed part of Scan settings. `ready` is false while the scanner's own recognizer is still
 * loading or switching a model: the test doesn't start then, and one running stops when that
 * begins (a model chosen in Models above, say), so it never times against that work. `alongside`
 * is what that recognizer holds loaded meanwhile, recorded with the result (Codex review of #182:
 * its memory is part of what the phone was doing).
 */
export function SpeedTest({ ready = true, alongside = null, onFinished }: { ready?: boolean; alongside?: Alongside | null; onFinished?: () => void }) {
  const [progress, setProgress] = useState<SpeedProgress | null>(null);
  /** Running the test, then keeping it; busy either way. */
  const [stage, setStage] = useState<"running" | "saving" | null>(null);
  const busy = stage !== null;
  const [report, setReport] = useState<SpeedReport | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const run = useRef<AbortController | null>(null);
  /** Why the run under way was stopped, when not by Stop. */
  const why = useRef<string | null>(null);
  const live = useRef(true);
  const recount = () =>
    speedTestCount().then(
      (n) => live.current && setCount(n),
      () => undefined,
    );
  useEffect(() => {
    if (!ready && run.current && stage === "running") {
      why.current = "Stopped: the scanner began loading a model. Test again once it's done.";
      run.current.abort();
    }
  }, [ready, stage]);
  useEffect(() => {
    live.current = true;
    void recount();
    // Closing Scan settings stops a test under way, its workers at once: the scanner reads again then.
    return () => {
      live.current = false;
      run.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const start = () => {
    if (run.current || !ready) return;
    const stop = new AbortController();
    run.current = stop;
    why.current = null;
    setStage("running");
    setReport(null);
    setStatus(null);
    setError(null);
    setProgress({ text: "Starting", done: 0, total: 1 });
    runSpeedTest((p) => !stop.signal.aborted && setProgress(p), stop.signal, undefined, alongside)
      .then(async (r) => {
        if (stop.signal.aborted) throw new Error("stopped");
        setReport(r);
        setProgress(null);
        if (!r.configs.some((c) => c.stats)) return;
        // Past the point of stopping: the test has run, and keeping it finishes even if Scan
        // settings closes.
        setStage("saving");
        setStatus("Keeping it on your account…");
        try {
          await saveSpeedTest(r);
          if (!live.current) return;
          setStatus("Kept on your account.");
          void recount();
        } catch (e) {
          if (live.current) setStatus(`Not kept: ${say(e)}`);
        }
      })
      .catch((e: unknown) => setError(stop.signal.aborted ? (why.current ?? "Stopped.") : say(e)))
      // Another test can start only once this one has ended, its workers gone.
      .finally(() => {
        if (run.current === stop) run.current = null;
        setProgress(null);
        setStage(null);
        // (The scanner loads its own models again where the test replaced them: the app's finder.)
        onFinished?.();
      });
  };
  const cancel = () => {
    run.current?.abort();
    setProgress((p) => (p ? { ...p, text: "Stopping" } : p));
  };
  const remove = () =>
    deleteSpeedTests().then(
      (d) => {
        setCount(0);
        setStatus(`Deleted ${d.deleted} saved ${d.deleted === 1 ? "test" : "tests"}.`);
      },
      (e: unknown) => setStatus(`Not deleted: ${say(e)}`),
    );
  return (
    <section className="scan-speed" aria-labelledby="scan-speed-title">
      <h3 id="scan-speed-title">Speed</h3>
      <p className="scan-note">
        Times the scanner on this device, with a few cards' pictures from Scryfall instead of the camera: your models, the defaults and the faster ones, and the printing look. It takes about a minute, and may download the faster models and the look's model. The result is kept on your account, so Yama can see how fast the scanner is on this device.
      </p>
      <ActionBar>
        <Button onClick={start} disabled={busy || !ready}>
          Test scanner speed
        </Button>
        {stage === "running" && (
          <Button variant="quiet" onClick={cancel} disabled={!!run.current?.signal.aborted}>
            Stop
          </Button>
        )}
      </ActionBar>
      {!ready && !busy && <p className="scan-note">The scanner is still loading its models; the test can start once it's done.</p>}
      {busy && progress && (
        <>
          <progress className="scan-speed-bar" max={progress.total} value={progress.done} aria-label="Speed test progress" />
          <p className="scan-note">{progress.text}</p>
        </>
      )}
      {/* Announced: how it ended, not every step on the way. */}
      <div className="scan-speed-status" aria-live="polite">
        {error && <p className="scan-note">{error}</p>}
        {report && <p className="scan-speed-summary">{speedSummary(report)}</p>}
        {status && <p className="scan-note scan-model-runs">{status}</p>}
      </div>
      {report && <SpeedResult report={report} />}
      {!busy && !!count && (
        <p className="scan-note">
          {count === 1 ? "1 test" : `${count} tests`} saved on your account.{" "}
          <Button className="scan-alt" onClick={remove}>
            Delete saved tests
          </Button>
        </p>
      )}
    </section>
  );
}
