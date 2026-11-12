import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { User } from "../api";
import { AdvancedSetting, YourName } from "./AccountSettings";

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

describe("the Advanced switch", () => {
  const setting = (me: Partial<User>) => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AdvancedSetting me={{ id: "u1", email: "pat@example.com", display_name: "Pat Rivers", is_admin: false, ...me } as User} />
      </QueryClientProvider>,
    );
    client.clear();
    return html;
  };

  it("says whether the Workshop is showing and offers the other choice", () => {
    const off = setting({ advanced: false });
    expect(off).toContain("<b>Advanced: off</b>");
    expect(off).toContain("Turn on Advanced");
    expect(off).toContain("plans, getting the cards, swap sheets, simulations and datasets");
    const on = setting({ advanced: true });
    expect(on).toContain("<b>Advanced: on</b>");
    expect(on).toContain("Turn off Advanced");
  });

  it("reads an account cached before the switch as on for admins and power users only", () => {
    expect(setting({})).toContain("Advanced: off");
    expect(setting({ is_admin: true })).toContain("Advanced: on");
    expect(setting({ power: true })).toContain("Advanced: on");
    // The account's own choice wins over what it is.
    expect(setting({ is_admin: true, advanced: false })).toContain("Advanced: off");
  });
});

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
