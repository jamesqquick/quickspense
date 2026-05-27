import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";

export type StatusUpdate = {
  status: string;
  step: string;
  detail: string;
  timestamp: number;
};

/**
 * Per-expense Durable Object that fan-outs workflow status updates to any
 * connected WebSocket clients (e.g. the review page in the web app).
 *
 * Renamed from `ReceiptStatusDO` when the receipts/expenses concepts merged.
 * The wrangler `renamed_classes` migration handles existing prod DO state.
 */
export class ExpenseStatusDO extends DurableObject<Env> {
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
