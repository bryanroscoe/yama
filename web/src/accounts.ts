// Words for accounts in the admin area's People list.

import type { AccountInfo } from "./api";

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** One plain line about an account: its email, how it came in, and whether it's turned off. */
export function accountLine(a: AccountInfo): string {
  const parts = [a.email];
  if (a.is_admin) parts.push("Admin");
  else if (a.invited) parts.push("Invited");
  else if (a.limited) parts.push("No invite, so the smaller allowance");
  else if (a.password) parts.push("Password account");
  parts.push(`Joined ${shortDate(a.created_at)}`);
  if (a.disabled_at) parts.push(`Disabled ${shortDate(a.disabled_at)}`);
  return `${parts.join(". ")}.`;
}
