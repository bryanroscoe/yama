import { describe, expect, it } from "vitest";
import { allows, appKind, appName, authParams, caution, claudeCodeCommand, returnsTo } from "./logic";

describe("the consent page's words", () => {
  it("passes on only the authorization parameters, first value of each", () => {
    const p = authParams(
      "?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback&code_challenge=xyz&code_challenge_method=S256" +
        "&scope=mcp+offline_access&state=s1&resource=https%3A%2F%2Fyama.saget.org%2Fmcp&evil=1&state=s2",
    );
    expect(p).toEqual({
      response_type: "code",
      client_id: "abc",
      redirect_uri: "http://localhost:3118/callback",
      code_challenge: "xyz",
      code_challenge_method: "S256",
      scope: "mcp offline_access",
      state: "s1",
      resource: "https://yama.saget.org/mcp",
    });
    expect(authParams("")).toEqual({});
  });

  it("names the app plainly, even when it gave no name", () => {
    expect(appName("Claude Code (yama)")).toBe("Claude Code (yama)");
    expect(appName(null)).toBe("An app that gave no name");
    expect(appName("   ")).toBe("An app that gave no name");
  });

  it("says when codes go to a program on this computer", () => {
    expect(returnsTo("localhost", true)).toBe("a program on this computer (localhost)");
    expect(returnsTo("claude.ai", false)).toBe("claude.ai");
    expect(caution(true)).toContain("/mcp in Claude Code");
    expect(caution(false)).toContain("Never allow a sign-in link someone sent you");
  });

  it("lists what the tools allow today, read only", () => {
    expect(allows(["mcp"])).toHaveLength(3);
    expect(allows(["mcp"])[2]).toMatch(/waits in Yama for you to apply or discard/);
    expect(allows(["mcp", "offline_access"])).toHaveLength(4);
    expect(allows([])).toEqual([]);
  });

  it("gives Settings the command and a kind for each app", () => {
    expect(claudeCodeCommand("https://yama.saget.org/mcp")).toBe("claude mcp add --transport http yama https://yama.saget.org/mcp");
    expect(appKind({ redirect_host: "localhost", loopback: true })).toBe("On this computer, such as Claude Code");
    expect(appKind({ redirect_host: "claude.ai", loopback: false })).toBe("Claude on the web, desktop and phone");
    expect(appKind({ redirect_host: "example.org", loopback: false })).toBe("example.org");
  });
});
