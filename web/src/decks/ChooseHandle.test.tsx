import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChooseHandle, handleProblem, typedHandle } from "./ChooseHandle";

describe("a handle being typed", () => {
  it("is stored trimmed, without its @ and in lowercase", () => {
    expect(typedHandle("  @Saget ")).toBe("saget");
    expect(typedHandle("")).toBe("");
  });

  it("is checked for its shape before the server is asked, as the server checks it", () => {
    for (const ok of ["saget", "@Saget", "a-b_c9", "abc"]) expect(handleProblem(ok), ok).toBeNull();
    for (const bad of ["ab", "1abc", "has space", "trailing-", "trailing_", "ünicode", "a".repeat(31)]) expect(handleProblem(bad), bad).toMatch(/3 to 30 letters/);
    // Nothing typed is not a problem: the deck is saved public by link.
    expect(handleProblem("  ")).toBeNull();
  });
});

describe("picking a handle from a public deck", () => {
  it("says the deck is public by link until then, and never asks for a name or email", () => {
    const client = new QueryClient();
    client.setQueryData(["me"], { id: "u1" });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ChooseHandle />
      </QueryClientProvider>,
    );
    expect(html).toContain("public by link");
    expect(html).toContain("joins your profile");
    expect(html).toContain("Your handle");
    expect(html).toContain("Save handle");
    expect(html).toContain("your Google name and email never are");
    client.clear();
  });
});
