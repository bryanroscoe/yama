import { expect, it } from "vitest";
import { shellBuild } from "./AppUpdate";

it("only recognizes the app's versioned build manifest, not sign-in or error HTML", () => {
  expect(shellBuild('<html><meta name="yama-precache" content="/assets/precache-ab12.json"></html>')).toBe("/assets/precache-ab12.json");
  for (const html of ["", "<h1>Sign in</h1>", '<meta name="yama-precache" content="https://other.example/file.json">']) expect(shellBuild(html)).toBeNull();
});
