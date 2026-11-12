import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContentReport, Moderation } from "./api";
import { ModerationPage } from "./Moderation";

const report = (over: Partial<ContentReport>): ContentReport => ({
  id: "r1",
  kind: "deck",
  reason: "spam",
  details: null,
  created_at: "2026-11-12T10:00:00Z",
  resolved_at: null,
  resolution: null,
  note: null,
  owner_id: "u1",
  owner_email: "builder@example.com",
  handle: "builder",
  deck_id: "d1",
  deck_name: "Spam deck",
  deck_token: "abc123",
  deck_visibility: "public",
  deck_taken_down: false,
  deck_archived: false,
  ...over,
});

function page(data: Moderation) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["admin-moderation"], data);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ModerationPage />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

const reasons: [string, string][] = [
  ["spam", "Spam or advertising"],
  ["other", "Something else"],
];

describe("the admin's reports", () => {
  it("shows each open report with its reason in words, what was written, and the page", () => {
    const html = page({
      reasons,
      open: [report({ details: "Sells cards" }), report({ id: "r2", kind: "profile", reason: "other", deck_id: null, deck_name: null, deck_token: null, deck_visibility: null })],
      resolved: [],
      takedowns: [],
    });
    expect(html).toContain("Spam deck");
    expect(html).toContain("Spam or advertising, reported");
    expect(html).toContain("Sells cards");
    expect(html).toContain('href="/d/abc123"');
    expect(html).toContain("Profile @builder");
    expect(html).toContain('href="/u/builder"');
    // A deck report can be acted on with a reason its owner will see; a profile report can only be dismissed here.
    expect(html.match(/Take down<\/button>/g)?.length).toBe(2); // the report's own, and the form by address
    expect(html.match(/Dismiss<\/button>/g)?.length).toBe(2);
    expect(html).toContain('value="Spam or advertising"');
  });

  it("says so when nothing is waiting, and lists takedowns with who, why and a way back", () => {
    const html = page({
      reasons,
      open: [],
      resolved: [report({ resolved_at: "2026-11-12T11:00:00Z", resolution: "taken_down", note: "Advertising", deck_taken_down: true, deck_visibility: "private" })],
      takedowns: [
        { id: "t1", deck_id: "d1", deck_name: "Spam deck", owner_email: "builder@example.com", handle: "builder", admin_email: "admin@example.com", reason: "Advertising", was_visibility: "public", created_at: "2026-11-12T11:00:00Z", restored_at: null },
        { id: "t2", deck_id: "d2", deck_name: "Old deck", owner_email: "other@example.com", handle: null, admin_email: null, reason: "Mistake", was_visibility: "link", created_at: "2026-11-01T11:00:00Z", restored_at: "2026-11-02T11:00:00Z" },
      ],
    });
    expect(html).toContain("No reports are waiting.");
    expect(html).toContain("by admin@example.com; it was public");
    expect(html).toContain("by an admin who has left; it was shared by link");
    expect(html.match(/Restore<\/button>/g)?.length).toBe(1);
    expect(html).toContain("It stays private until its owner shares it again.");
    expect(html).toContain("Taken down");
    expect(html).not.toContain("No handle");
  });

  it("links no page once a reported deck is private or taken down", () => {
    const html = page({ reasons, open: [report({ deck_visibility: "private" })], resolved: [], takedowns: [] });
    expect(html).not.toContain('href="/d/abc123"');
    expect(page({ reasons, open: [report({ deck_archived: true })], resolved: [], takedowns: [] })).not.toContain('href="/d/abc123"');
    expect(html).toContain("The page is no longer shared.");
  });
});
