// Stand-ins: what a page shows while its code is still on the way (Bryan, 2026-11-02: "showing
// placards right there before they do, and having stand-ins is great"). Each is shaped like the
// page it stands in for, inside the same page frame and under the same title, so nothing jumps
// when the real page arrives. Flat blocks in the table's own greys; no card images.

import "./standin.css";

export type StandInKind = "list" | "tiles" | "table" | "detail" | "board" | "counter";

/** A grey block of a given shape. */
function Block({ className = "" }: { className?: string }) {
  return <span className={`si-block ${className}`} />;
}

function Rows({ n }: { n: number }) {
  return (
    <ul className="si-rows">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="si-row">
          <Block className="si-thumb" />
          <span className="si-lines">
            <Block className="si-line" />
            <Block className="si-line si-short" />
          </span>
          <Block className="si-end" />
        </li>
      ))}
    </ul>
  );
}

function Tiles({ n }: { n: number }) {
  return (
    <ul className="si-tiles">
      {Array.from({ length: n }, (_, i) => (
        <li key={i}>
          <Block className="si-tile" />
        </li>
      ))}
    </ul>
  );
}

/**
 * A page's stand-in. `title` is the page's real heading where it's known, so the heading is
 * already there; `kind` is the page's shape. `full` pages (the online board, the life counter)
 * take the whole screen, as the pages do.
 */
export function StandIn({ kind = "list", title }: { kind?: StandInKind; title?: string }) {
  if (kind === "board") {
    return (
      <main className="si-full si-board" aria-busy="true" aria-label="Loading the game">
        <div className="si-opponents">
          <Block className="si-seat" />
          <Block className="si-seat" />
          <Block className="si-seat" />
        </div>
        <Block className="si-field" />
        <div className="si-hand">
          {Array.from({ length: 7 }, (_, i) => (
            <Block key={i} className="si-card" />
          ))}
        </div>
      </main>
    );
  }
  if (kind === "counter") {
    return (
      <main className="si-full si-counter" aria-busy="true" aria-label="Loading the life counter">
        {Array.from({ length: 4 }, (_, i) => (
          <Block key={i} className="si-panel" />
        ))}
      </main>
    );
  }
  return (
    <main className="page si-page" aria-busy="true" aria-label={title ? `Loading ${title}` : "Loading"}>
      {/* The bar stands where most pages put their sections or filters: beside the title on a
          laptop, under it on a phone. */}
      <div className="page-head">
        {title ? <h1>{title}</h1> : <Block className="si-title" />}
        <Block className="si-bar" />
      </div>
      {kind === "tiles" && <Tiles n={6} />}
      {kind === "list" && <Rows n={8} />}
      {kind === "table" && (
        <>
          <Block className="si-strip" />
          <Rows n={10} />
        </>
      )}
      {kind === "detail" && (
        <>
          <Block className="si-hero" />
          <Block className="si-panel-wide" />
          <Rows n={4} />
        </>
      )}
    </main>
  );
}
