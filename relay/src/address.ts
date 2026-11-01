// Client addresses as the relay counts them (index.ts rate limits).

/**
 * The key a client address counts under: an IPv4 address as it is, an IPv6 address by its /64
 * (one home or server holds a whole /64, so walking through it gives no fresh allowance), as
 * Yama's server counts them.
 */
export function addressKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
