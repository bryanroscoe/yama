// Yama's shared-table relay on Cloudflare: every phone at the table follows one life-counter
// game, even when Yama's own server (at Bryan's house) is offline. One Durable Object per shared
// game, with hibernating WebSockets, so an idle table costs nothing.
//
// GET /table/<gameId>/ws?role=host&secret=<host secret>   the phone running the game
// GET /table/<gameId>/ws?role=guest&key=<share key>       everyone who scanned its code
//
// No accounts: the share key from the QR code is a guest's only credential. A room is named by
// its game and share key, and the key is derived from the host's secret (packages/core
// relayKey.ts), so only the phone holding that secret can be the host. Any other secret, or a
// wrong key, leads to a different, empty room.

import { DurableObject } from "cloudflare:workers";
import { RELAY_TOKEN, relayShareKey } from "../../packages/core/src/relayKey";
import { hasRoom, join, leave, message, type Role, type RoomIo } from "./room";

interface Env {
  ROOMS: DurableObjectNamespace<TableRoom>;
  /**
   * Connections per client address and role (Workers rate limiting, wrangler.toml), counted
   * before a room is touched, so a flood can't spend the plan's Durable Object requests. It can't
   * spare the Worker's own daily requests (each one has counted by then): the zone's rate
   * limiting rule in front of the Worker does that (relay/waf-rule.py). Missing (a plan or a
   * local run without it): no limit.
   */
  CONNECTS?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /**
   * Messages per client address across all its sockets and rooms (Workers rate limiting), hosts
   * and guests apart: one address keeping many sockets open can't add up past what the day's
   * allowance can take, and a table's guests can't use up its host's share.
   */
  MESSAGES_HOST?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  MESSAGES_GUEST?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** "off" refuses phones joining by code (guests): the switch if joining without an account is abused. */
  GUEST_JOIN?: string;
}

/** Close codes a refused phone sees (GuestTable.tsx says why instead of retrying blindly). */
export const CLOSE_GUESTS_OFF = 4403;
export const CLOSE_TOO_MANY = 4429;

/** Accept and close at once with a reason: a browser can't read an HTTP refusal of a WebSocket. */
function refuse(code: number, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/** A room's snapshot outlives its last connection by this long (a long night, a slow host). */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const GAME_ID = /^[A-Za-z0-9-]{8,64}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    const path = /^\/table\/([^/]+)\/ws$/.exec(url.pathname);
    if (!path) return new Response("Not found", { status: 404 });
    const gameId = path[1]!;
    if (!GAME_ID.test(gameId)) return new Response("bad game id", { status: 400 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });

    const role = url.searchParams.get("role");
    let key: string;
    if (role === "host") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!RELAY_TOKEN.test(secret)) return new Response("missing host secret", { status: 400 });
      key = relayShareKey(gameId, secret);
    } else if (role === "guest") {
      key = url.searchParams.get("key") ?? "";
      if (!RELAY_TOKEN.test(key)) return new Response("missing share key", { status: 400 });
    } else {
      return new Response("bad role", { status: 400 });
    }
    if (role === "guest" && env.GUEST_JOIN === "off") {
      return refuse(CLOSE_GUESTS_OFF, "Joining a table by its code is turned off right now.");
    }
    // Per role: a table's phones usually share one Wi-Fi address, and guests coming and going
    // mustn't use up the host phone's own allowance.
    const address = req.headers.get("CF-Connecting-IP");
    if (env.CONNECTS && address && !(await env.CONNECTS.limit({ key: `${role}:${address}` })).success) {
      return refuse(CLOSE_TOO_MANY, "Too many connections from this network. Wait a minute.");
    }
    const room = env.ROOMS.get(env.ROOMS.idFromName(`${gameId}/${key}`));
    // The room needs only the role and the address (for its message limit); the secret and key
    // stay here.
    return room.fetch("https://room/connect", { headers: { Upgrade: "websocket", "X-Yama-Role": role, "X-Yama-Address": address ?? "" } });
  },
} satisfies ExportedHandler<Env>;

export class TableRoom extends DurableObject<Env> {
  private io: RoomIo<WebSocket> = {
    sockets: (role) => this.ctx.getWebSockets(role).filter((s) => s.readyState === WebSocket.OPEN),
    roleOf: (s) => (this.ctx.getTags(s)[0] === "host" ? "host" : "guest"),
    send: (s, text) => {
      try {
        s.send(text);
      } catch {
        /* closing; its close handler tidies up */
      }
    },
    close: (s, code, reason) => {
      try {
        s.close(code, reason);
      } catch {
        /* already closed */
      }
    },
    loadSnapshot: () => this.ctx.storage.kv.get<string>("snapshot"),
    saveSnapshot: (text) => this.ctx.storage.kv.put("snapshot", text),
    memory: {},
    now: () => Date.now(),
  };

  async fetch(req: Request): Promise<Response> {
    const role: Role = req.headers.get("X-Yama-Role") === "host" ? "host" : "guest";
    if (!hasRoom(this.io, role)) return new Response("this table is full", { status: 429 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    // Kept with the socket, so its address survives the room sleeping.
    server.serializeAttachment({ address: req.headers.get("X-Yama-Address") ?? "" });
    join(this.io, server);
    await this.ctx.storage.setAlarm(Date.now() + KEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    // Phones send only text; anything else is closed rather than ignored, so it can't run up
    // the room's message count unseen.
    if (typeof msg !== "string") return this.io.close(ws, 1003, "text messages only");
    const address = (ws.deserializeAttachment() as { address?: string } | null)?.address;
    const limiter = this.io.roleOf(ws) === "host" ? this.env.MESSAGES_HOST : this.env.MESSAGES_GUEST;
    if (limiter && address && !(await limiter.limit({ key: address })).success) {
      return this.io.close(ws, CLOSE_TOO_MANY, "Too many messages from this network. Wait a minute.");
    }
    message(this.io, ws, msg);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    leave(this.io, ws);
    this.io.close(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  async webSocketError(ws: WebSocket) {
    leave(this.io, ws);
  }

  /** Days after the last connection: forget the room, unless someone is still here. */
  async alarm() {
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + KEEP_MS);
    else await this.ctx.storage.deleteAll();
  }
}
