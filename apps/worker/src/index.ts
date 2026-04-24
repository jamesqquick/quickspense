import { createMcpHandler } from "agents/mcp";
import { createDb, createLogger, newRequestId, auth } from "@quickspense/domain";
import { createServer } from "./mcp/server.js";

export { ReceiptProcessingWorkflow } from "./workflow.js";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AI: Ai;
  RECEIPT_WORKFLOW: Workflow;
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

    const db = createDb(env.DB);

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
      const authHeader = request.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        logger.warn("MCP request unauthorized");
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const rawToken = authHeader.slice(7);
      const result = await auth.validateApiToken(db, rawToken);
      if (!result) {
        logger.warn("MCP request unauthorized");
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      logger.info("MCP request authorized", { userId: result.user.id });

      const server = createServer(env, db, result.user.id);
      const handler = createMcpHandler(server, { endpoint: "/mcp" });
      return handler(request, env, ctx);
    }

    return new Response("Quickspense Worker", { status: 200 });
  },
};
