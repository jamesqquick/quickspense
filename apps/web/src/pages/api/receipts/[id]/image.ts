import type { APIRoute } from "astro";
import { receipts, createDb } from "@quickspense/domain";

/**
 * Serve a receipt image from R2.
 *
 * Authz is enforced via the session cookie: only the owning user can fetch.
 * ETag-based revalidation and a 1-hour private cache keep repeat loads cheap
 * for the small number of users we support.
 *
 * If/when this endpoint becomes a hot path, replace with R2 signed URLs so the
 * image bytes no longer traverse the Worker. For ~100 users this is overkill.
 */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);
  const bucket = locals.runtime.env.BUCKET;
  const receiptId = params.id!;

  const receipt = await receipts.getReceipt(db, receiptId, user.id);
  if (!receipt) {
    return new Response("Not found", { status: 404 });
  }

  // HEAD the object to get the ETag cheaply without streaming bytes
  const head = await bucket.head(receipt.file_key);
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

  const object = await bucket.get(receipt.file_key);
  if (!object) {
    return new Response("File not found", { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": receipt.file_type,
      "Cache-Control": "private, max-age=3600, must-revalidate",
      ETag: etag,
    },
  });
};
