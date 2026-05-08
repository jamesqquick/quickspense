import type { APIRoute } from "astro";
import { expenses, createDb } from "@quickspense/domain";

/**
 * Serve an expense's attached image from R2.
 *
 * Authz is enforced via the session cookie: only the owning user can fetch.
 * ETag-based revalidation and a 1-hour private cache keep repeat loads cheap.
 *
 * Returns 404 if the expense has no attached image.
 */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);
  const bucket = locals.runtime.env.BUCKET;
  const expenseId = params.id!;

  const expense = await expenses.getExpense(db, expenseId, user.id);
  if (!expense || !expense.file_key || !expense.file_type) {
    return new Response("Not found", { status: 404 });
  }

  const head = await bucket.head(expense.file_key);
  if (!head) {
    return new Response("File not found", { status: 404 });
  }

  const etag = `"${head.httpEtag.replace(/"/g, "")}"`;
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=3600, must-revalidate",
      },
    });
  }

  const object = await bucket.get(expense.file_key);
  if (!object) {
    return new Response("File not found", { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": expense.file_type,
      "Cache-Control": "private, max-age=3600, must-revalidate",
      ETag: etag,
    },
  });
};
