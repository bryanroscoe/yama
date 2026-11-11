import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Playgroup } from "../api";
import { Members } from "./GroupMembers";

const group: Playgroup = {
  id: "pg",
  name: "Thursday",
  owner_id: "bryan",
  join_code: "ABC234",
  members: [
    { id: "m1", user_id: "bryan", guest_name: null, display_name: "Bryan", handle: null },
    { id: "m2", user_id: "pat", guest_name: null, display_name: "Pat", handle: null },
    { id: "m3", user_id: null, guest_name: "Sam", display_name: "Sam", handle: null },
  ],
};

function render(me: string, g: Playgroup = group) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], { id: me });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><Members group={g} /></QueryClientProvider>);
  client.clear();
  return html;
}

describe("the playgroup's members", () => {
  it("lists everyone with their role and marks you", () => {
    const html = render("pat");
    expect(html).toContain("Bryan</b><span>Owner</span>");
    expect(html).toContain("Pat (you)</b><span>Member</span>");
    expect(html).toContain("Sam</b><span>Guest, no account</span>");
    expect(html).toContain("ABC234");
  });

  it("gives the owner remove, make owner, rename, a new code and delete", () => {
    const html = render("bryan");
    expect(html).toContain('aria-label="Remove Pat"');
    expect(html).toContain('aria-label="Remove Sam"');
    // Only an account can own a playgroup, and nobody removes themselves here (that is Leave).
    expect(html.match(/Make owner/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Remove Bryan"');
    for (const text of ["Rename", "New code", "Delete this playgroup", "Leave this playgroup"]) expect(html).toContain(text);
    // Deleting waits until no other account is in the group.
    expect(html).toMatch(/<button class="outline" disabled="">Delete<\/button>/);
  });

  it("lets the only account delete the group, not leave it to nobody", () => {
    const alone = { ...group, members: group.members.filter((m) => m.user_id !== "pat") };
    const html = render("bryan", alone);
    expect(html).toMatch(/<button class="outline">Delete<\/button>/);
    expect(html).not.toContain("Leave this playgroup");
  });

  it("gives other members only Leave", () => {
    const html = render("pat");
    for (const text of ["Remove", "Make owner", "Rename", "New code", "Delete this playgroup"]) expect(html).not.toContain(text);
    expect(html).toContain("Leave this playgroup");
    expect(html).toContain("Add guest");
  });
});
