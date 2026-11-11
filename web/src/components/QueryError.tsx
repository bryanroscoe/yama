// A query's failure, placed by whether the page still has something to show (project review,
// 11 Nov 2026: a failed background refetch replaced the list editor, typed edits included, with
// an error page that had no way to try again).
//
//   if (queryFailure(deck) === "page") return <main className="page"><LoadFailed query={deck} /></main>;
//   ...
//   <RefreshFailed query={deck} />   // inside the page, which stays as it is
import { errorMessage } from "../api";

/** What a query's error means for its page: nothing loaded yet, or a refresh of data still shown. */
interface Failing {
  error: unknown;
  data: unknown;
  isFetching?: boolean;
  refetch: () => unknown;
}

/**
 * "page" when there is nothing to show but the error; "notice" when the last good data is still
 * here and only its refresh failed, so the page (and anything typed into it) stays.
 */
export function queryFailure(query: Pick<Failing, "error" | "data">): "none" | "page" | "notice" {
  if (!query.error) return "none";
  return query.data === undefined ? "page" : "notice";
}

/** Nothing loaded: the error, with a way to try again. */
export function LoadFailed({ query }: { query: Failing }) {
  if (queryFailure(query) !== "page") return null;
  return (
    <div className="stack" role="alert">
      <p className="error">{errorMessage(query.error)}</p>
      <div className="row">
        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? "Trying…" : "Try again"}</button>
      </div>
    </div>
  );
}

/** The page is still showing what it last loaded: say the refresh failed, and offer Retry. */
export function RefreshFailed({ query, what = "this page" }: { query: Failing; what?: string }) {
  if (queryFailure(query) !== "notice") return null;
  return (
    <p className="small" role="status">
      <span className="error">Couldn't refresh {what}: {errorMessage(query.error)}</span>{" "}
      It may be out of date.{" "}
      <button type="button" className="small" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? "Trying…" : "Retry"}</button>
    </p>
  );
}
