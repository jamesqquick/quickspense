import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";

export type StatusUpdate = {
  status: string;
  step: string;
  detail: string;
  timestamp: number;
};

export class ReceiptStatusDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async notify(update: StatusUpdate): Promise<void> {
    const message = JSON.stringify(update);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Client may have disconnected; ignore send errors
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // Clients can send "ping" to keep alive; respond with "pong"
    if (message === "ping") {
      ws.send("pong");
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close(1011, "WebSocket error");
  }
}
