import type { APIRoute } from "astro";

export const GET: APIRoute = async (context) => {
  const { id } = context.params;
  if (!id) {
    return new Response("Missing receipt ID", { status: 400 });
  }

  const upgradeHeader = context.request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const worker = context.locals.runtime.env.WORKER;
  const workerUrl = `https://worker/ws/receipt/${id}`;

  // Forward the WebSocket upgrade request to the worker via Service Binding
  return worker.fetch(workerUrl, context.request);
};
