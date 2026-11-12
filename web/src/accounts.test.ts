import { describe, expect, it } from "vitest";
import { accountLine } from "./accounts";
import type { AccountInfo } from "./api";

const account = (over: Partial<AccountInfo>): AccountInfo => ({
  id: "u1",
  email: "pat@gmail.com",
  display_name: "Pat",
  is_admin: false,
  limited: false,
  invited: false,
  power_user: false,
  google: true,
  password: false,
  disabled_at: null,
  created_at: "2026-10-20T12:00:00Z",
  last_sign_in: null,
  ...over,
});

describe("account lines", () => {
  it("say each account's allowance, in plain sentences", () => {
    expect(accountLine(account({ limited: true }))).toBe("pat@gmail.com. Standard allowance. Joined Oct 20, 2026.");
    expect(accountLine(account({ invited: true }))).toBe("pat@gmail.com. Invited. Joined Oct 20, 2026.");
    expect(accountLine(account({ invited: true, power_user: true }))).toBe("pat@gmail.com. Invited. Power user. Joined Oct 20, 2026.");
    expect(accountLine(account({ limited: true, power_user: true }))).toBe("pat@gmail.com. Standard allowance. Power user. Joined Oct 20, 2026.");
    expect(accountLine(account({ is_admin: true, invited: true }))).toBe("pat@gmail.com. Admin. Joined Oct 20, 2026.");
    expect(accountLine(account({ google: false, password: true }))).toBe("pat@gmail.com. Password account. Joined Oct 20, 2026.");
  });

  it("say when an account was turned off", () => {
    const line = accountLine(account({ limited: true, disabled_at: "2026-10-21T12:00:00Z" }));
    expect(line).toBe("pat@gmail.com. Standard allowance. Joined Oct 20, 2026. Disabled Oct 21, 2026.");
    expect(line).not.toContain("·");
  });
});
