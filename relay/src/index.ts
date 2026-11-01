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
    const room = env.ROOMS.get(env.ROOMS.idFromName(`${gameId}/${key}`));
    // The room needs only the role; the secret and key stay here.
    return room.fetch("https://room/connect", { headers: { Upgrade: "websocket", "X-Yama-Role": role } });
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
  };

  async fetch(req: Request): Promise<Response> {
    const role: Role = req.headers.get("X-Yama-Role") === "host" ? "host" : "guest";
    if (!hasRoom(this.io)) return new Response("this table is full", { status: 429 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    join(this.io, server);
    await this.ctx.storage.setAlarm(Date.now() + KEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg === "string") message(this.io, ws, msg);
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
