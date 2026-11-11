// A query's failure, placed by whether the page still has something to show (project review,
// 11 Nov 2026: a failed background refetch replaced the list editor, typed edits included, with
// an error page that had no way to try again).
//
//   if (queryFailure(deck) === "page") return <main className="page"><LoadFailed query={deck} /></main>;
//   ...
//   <RefreshFailed query={deck} />   // inside the page, which stays as it is
import { ApiError, errorMessage } from "../api";

/** What a query's error means for its page: nothing loaded yet, or a refresh of data still shown. */
interface Failing {
  error: unknown;
  data: unknown;
  isFetching?: boolean;
  refetch: () => Promise<unknown> | unknown;
}

/** The server's answer that the thing is gone, or isn't this account's to see: 403, 404, 410. */
export function gone(error: unknown): boolean {
  return error instanceof ApiError && [403, 404, 410].includes(error.status);
}

/**
 * "page" when there is nothing to show but the error; "notice" when the last good data is still
 * here and only its refresh failed (no answer, a server error), so the page (and anything typed
 * into it) stays. An answer that the thing is gone or not this account's is the page's error
 * whatever was loaded before: a deleted deck mustn't stay on screen as if it were only stale.
 */
export function queryFailure(query: Pick<Failing, "error" | "data">): "none" | "page" | "notice" {
  if (!query.error) return "none";
  return query.data === undefined || gone(query.error) ? "page" : "notice";
}

/** Nothing to show: the error, with a way to try again. */
export function LoadFailed({ query }: { query: Failing }) {
  if (queryFailure(query) !== "page") return null;
  return (
    <div className="stack" role="alert">
      <p className="error">{errorMessage(query.error)}</p>
      <div className="row">
        <button type="button" aria-disabled={query.isFetching || undefined} onClick={() => !query.isFetching && void query.refetch()}>{query.isFetching ? "Trying…" : "Try again"}</button>
      </div>
    </div>
  );
}

/**
 * The page is still showing what it last loaded: say the refresh failed, and offer Retry. An
 * alert, so it is read out when it appears. Retry stays focusable while it works; when the
 * refresh succeeds the notice goes, and focus moves to the page rather than being dropped.
 */
export function RefreshFailed({ query, what = "this page" }: { query: Failing; what?: string }) {
  if (queryFailure(query) !== "notice") return null;
  const retry = async (button: HTMLButtonElement) => {
    if (query.isFetching) return;
    const page = button.closest<HTMLElement>("main");
    const result = (await query.refetch()) as { error?: unknown } | undefined;
    if (result?.error || !page || document.activeElement !== button) return;
    page.tabIndex = -1;
    page.style.outline = "none";
    page.focus({ preventScroll: true });
  };
  return (
    <p className="small" role="alert">
      <span className="error">Couldn't refresh {what}: {errorMessage(query.error)}</span>{" "}
      It may be out of date.{" "}
      <button type="button" className="small" aria-disabled={query.isFetching || undefined} onClick={(e) => void retry(e.currentTarget)}>{query.isFetching ? "Trying…" : "Retry"}</button>
    </p>
  );
}
