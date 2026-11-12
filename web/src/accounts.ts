// Words for accounts in the admin area's People list.

import type { AccountInfo } from "./api";
import { fmtDate } from "@yama/core";

/** One plain line about an account: its email, its allowance (an invite gives the larger one), power user, and whether it's turned off. */
export function accountLine(a: AccountInfo): string {
  const parts = [a.email];
  if (a.is_admin) parts.push("Admin");
  else if (a.invited) parts.push("Invited");
  else if (a.limited) parts.push("Standard allowance");
  else if (a.password) parts.push("Password account");
  if (a.power_user && !a.is_admin) parts.push("Power user");
  parts.push(`Joined ${fmtDate(a.created_at)}`);
  if (a.disabled_at) parts.push(`Disabled ${fmtDate(a.disabled_at)}`);
  return `${parts.join(". ")}.`;
}
