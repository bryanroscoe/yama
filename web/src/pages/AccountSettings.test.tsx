import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { User } from "../api";
import { YourName } from "./AccountSettings";

function render(me: Partial<User>) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <YourName me={{ id: "u1", email: "pat@example.com", display_name: "Pat Rivers", ...me } as User} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("the name you go by", () => {
  it("shows the name and the account, and offers to change the name", () => {
    const html = render({});
    expect(html).toContain("<b>Pat Rivers</b>");
    expect(html).toContain("Signed in as pat@example.com");
    expect(html).toContain("Change name");
  });

  it("is read only while an admin views as the person", () => {
    const viewing = { admin_id: "a1", admin_name: "Bryan", admin_email: "bryan@example.com", target_disabled: false, started_at: "2030-01-01T00:00:00Z", expires_at: "2030-01-01T00:30:00Z" };
    const html = render({ viewing });
    expect(html).toContain("<b>Pat Rivers</b>");
    expect(html).not.toContain("Change name");
  });
});
