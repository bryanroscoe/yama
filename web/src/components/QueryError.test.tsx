import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { gone, LoadFailed, queryFailure, RefreshFailed } from "./QueryError";

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

  it("is the page's error when the thing is gone or isn't this account's, whatever was loaded", () => {
    // A deck deleted elsewhere (404) mustn't stay on screen as if it were only out of date.
    for (const status of [403, 404, 410]) {
      expect(gone(new ApiError(status, "Not found"))).toBe(true);
      expect(queryFailure({ error: new ApiError(status, "Not found"), data: { id: "d1" } })).toBe("page");
    }
    // No answer, or the server's own trouble: the page stays.
    for (const error of [new ApiError(500, "Server error"), new ApiError(503, "Server unavailable"), new TypeError("Failed to fetch")]) {
      expect(gone(error)).toBe(false);
      expect(queryFailure({ error, data: { id: "d1" } })).toBe("notice");
    }
    const html = renderToStaticMarkup(<LoadFailed query={{ error: new ApiError(404, "No such deck"), data: { id: "d1" }, refetch }} />);
    expect(html).toContain("No such deck");
    expect(renderToStaticMarkup(<RefreshFailed query={{ error: new ApiError(404, "No such deck"), data: { id: "d1" }, refetch }} />)).toBe("");
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
    const html = renderToStaticMarkup(<RefreshFailed query={{ error: failed, data: {}, isFetching: true, refetch }} />);
    expect(html).toContain("Trying…");
    // Still focusable while it works, and read out when it appears.
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("disabled=\"\"");
    expect(html).toContain('role="alert"');
  });
});
