import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadFailed, queryFailure, RefreshFailed } from "./QueryError";

const refetch = () => undefined;
const failed = new Error("Server unavailable");

describe("a query that failed", () => {
  it("is the page's error only when nothing has loaded", () => {
    expect(queryFailure({ error: null, data: undefined })).toBe("none");
    expect(queryFailure({ error: null, data: { id: "d1" } })).toBe("none");
    expect(queryFailure({ error: failed, data: undefined })).toBe("page");
    // A background refetch that failed: the last good data is still there.
    expect(queryFailure({ error: failed, data: { id: "d1" } })).toBe("notice");
    // An empty answer is still an answer.
    expect(queryFailure({ error: failed, data: null })).toBe("notice");
    expect(queryFailure({ error: failed, data: [] })).toBe("notice");
  });

  it("shows the error with Try again when there is nothing else to show", () => {
    const html = renderToStaticMarkup(<LoadFailed query={{ error: failed, data: undefined, refetch }} />);
    expect(html).toContain("Server unavailable");
    expect(html).toContain("Try again");
    expect(renderToStaticMarkup(<LoadFailed query={{ error: failed, data: { id: "d1" }, refetch }} />)).toBe("");
  });

  it("keeps the page and says its refresh failed, with Retry", () => {
    const html = renderToStaticMarkup(<RefreshFailed query={{ error: failed, data: { id: "d1" }, refetch }} what="this deck" />);
    expect(html).toContain("Couldn&#x27;t refresh this deck: Server unavailable");
    expect(html).toContain("It may be out of date.");
    expect(html).toContain("Retry");
    expect(renderToStaticMarkup(<RefreshFailed query={{ error: failed, data: undefined, refetch }} />)).toBe("");
    expect(renderToStaticMarkup(<RefreshFailed query={{ error: null, data: { id: "d1" }, refetch }} />)).toBe("");
  });

  it("says when it is trying again", () => {
    expect(renderToStaticMarkup(<RefreshFailed query={{ error: failed, data: {}, isFetching: true, refetch }} />)).toContain("Trying…");
  });
});
