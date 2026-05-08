import type { APIRoute } from "astro";

/**
 * WebSocket upgrade for live expense workflow status. Forwards via Service
 * Binding to the worker's `/ws/expense/:id` route, which routes to the
 * `EXPENSE_STATUS_DO` Durable Object.
 */
export const GET: APIRoute = async (context) => {
  const { id } = context.params;
  if (!id) {
    return new Response("Missing expense ID", { status: 400 });
  }

  const upgradeHeader = context.request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const worker = context.locals.runtime.env.WORKER;
  const workerUrl = `https://worker/ws/expense/${id}`;

  return worker.fetch(workerUrl, context.request);
};
