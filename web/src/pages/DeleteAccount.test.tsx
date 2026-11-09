import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { confirmsEmail, DeleteAccount } from "./DeleteAccount";

vi.mock("../auth", () => ({ useDeleteAccount: () => ({ mutate: () => undefined, isPending: false, error: null }) }));

const page = (path: string) => readFileSync(new URL(`../../public/${path}`, import.meta.url), "utf8");

describe("deleting your own account", () => {
  it("is confirmed only by the account's own email, ignoring case and spaces at the ends", () => {
    expect(confirmsEmail("pat@example.com", " PAT@example.com ")).toBe(true);
    expect(confirmsEmail("pat@example.com", "pat@exampel.com")).toBe(false);
    expect(confirmsEmail("pat@example.com", "")).toBe(false);
    expect(confirmsEmail("", "")).toBe(false);
  });

  it("shows a Delete account row the public page can link to", () => {
    const html = renderToStaticMarkup(<DeleteAccount email="pat@example.com" />);
    expect(html).toContain('id="delete-account"');
    expect(html).toContain("Delete account");
  });

  it("has a public page that works without the app, linked from the privacy policy", () => {
    const html = page("delete-account/index.html");
    expect(html).toContain('href="/profile#delete-account"');
    expect(html).toContain("mailto:bryanroscoe@gmail.com");
    expect(html).toContain("What is deleted");
    expect(html).toContain("not affiliated with, endorsed by, or sponsored by Wizards of the Coast");
    expect(page("privacy/index.html")).toContain('href="/delete-account/"');
  });
});
