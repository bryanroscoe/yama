import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RELAY_TOKEN, relayShareKey, sha256Hex } from "./relayKey";

describe("sha256Hex", () => {
  it("matches the standard test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with node's own across block edges and non-ASCII text", () => {
    for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const s = "é".repeat(n % 7) + "x".repeat(n);
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
});

describe("relayShareKey", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  it("is a token, fixed for a game and secret, and differs for either", () => {
    const key = relayShareKey("g1", secret);
    expect(key).toMatch(RELAY_TOKEN);
    expect(relayShareKey("g1", secret)).toBe(key);
    expect(relayShareKey("g2", secret)).not.toBe(key);
    expect(relayShareKey("g1", secret.replace("0", "1"))).not.toBe(key);
    // Never the secret itself, nor any part of it.
    expect(key).not.toBe(secret);
  });
});
