import { createMcpHandler } from "agents/mcp";
import { createLogger, newRequestId } from "@quickspense/domain";
import { createServer } from "./mcp/server.js";

export { ReceiptProcessingWorkflow } from "./workflow.js";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AI: Ai;
  RECEIPT_WORKFLOW: Workflow;
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function authenticateBearer(
  db: D1Database,
  request: Request,
): Promise<{ userId: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const rawToken = authHeader.slice(7);
  const tokenHash = await sha256Hex(rawToken);

  const row = await db
    .prepare(
      "SELECT u.id as user_id FROM api_tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ?",
    )
    .bind(tokenHash)
    .first<{ user_id: string }>();

  return row ? { userId: row.user_id } : null;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const requestId = newRequestId();
    const logger = createLogger({
      service: "worker",
      requestId,
      path: url.pathname,
      method: request.method,
    });

    // Workflow trigger endpoint (called via Service Binding from web app)
    if (url.pathname === "/workflow/trigger" && request.method === "POST") {
      try {
        const { receiptId, userId } = (await request.json()) as {
          receiptId: string;
          userId: string;
        };
        logger.info("Workflow trigger received", { receiptId, userId });
        const instance = await env.RECEIPT_WORKFLOW.create({
          params: { receiptId, userId },
        });
        logger.info("Workflow instance created", {
          receiptId,
          userId,
          workflowId: instance.id,
        });
        return Response.json({ workflowId: instance.id });
      } catch (e) {
        logger.error("Workflow trigger error", { error: e });
        return Response.json(
          { error: "Failed to trigger workflow" },
          { status: 500 },
        );
      }
    }

    // MCP endpoint with bearer token auth
    if (url.pathname.startsWith("/mcp")) {
      const auth = await authenticateBearer(env.DB, request);
      if (!auth) {
        logger.warn("MCP request unauthorized");
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      logger.info("MCP request authorized", { userId: auth.userId });

      // Create a fresh MCP server instance per request
      const server = createServer(env, auth.userId);
      const handler = createMcpHandler(server, { endpoint: "/mcp" });
      return handler(request, env, ctx);
    }

    return new Response("Quickspense Worker", { status: 200 });
  },
};
