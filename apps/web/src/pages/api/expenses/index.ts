import type { APIRoute } from "astro";
import {
  expenses,
  listExpensesSchema,
  createManualExpenseSchema,
  createDb,
} from "@quickspense/domain";
import { triggerExpenseWorkflow } from "../../../lib/workflow";

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

export const GET: APIRoute = async ({ locals, url }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);

  const params = listExpensesSchema.safeParse({
    status: url.searchParams.get("status") || undefined,
    startDate: url.searchParams.get("startDate") || undefined,
    endDate: url.searchParams.get("endDate") || undefined,
    categoryId: url.searchParams.get("categoryId") || undefined,
    search: url.searchParams.get("search") || undefined,
    limit: url.searchParams.get("limit") || 20,
    offset: url.searchParams.get("offset") || 0,
  });

  if (!params.success) {
    return new Response(
      JSON.stringify({ error: params.error.issues[0].message }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const list = await expenses.listExpenses(db, user.id, params.data);
  return new Response(JSON.stringify(list), {
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Create an expense.
 *
 * Two content types are accepted:
 *   1. application/json with manual expense fields. Optional image is not
 *      supported here; use multipart for that path. Result is `active`.
 *   2. multipart/form-data with `file` (an image) and optional manual fields
 *      (merchant, amount, etc.). If `parse=true` is included in the form,
 *      the workflow is triggered (`processing` status). Otherwise the image
 *      is just stored alongside the manual fields (`active` status).
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);

    const contentType = request.headers.get("Content-Type") || "";

    // ---- JSON path: manual expense, no image ----
    if (contentType.includes("application/json")) {
      const body = await request.json();
      const parsed = createManualExpenseSchema.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: parsed.error.issues[0].message }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const expense = await expenses.createManualExpense(db, {
        userId: user.id,
        merchant: parsed.data.merchant,
        amount: parsed.data.amount,
        currency: parsed.data.currency,
        date: parsed.data.expense_date,
        categoryId: parsed.data.category_id,
        notes: parsed.data.notes,
      });

      return new Response(JSON.stringify(expense), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ---- Multipart path: with image ----
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const shouldParse = formData.get("parse") === "true";

    if (!file) {
      return new Response(
        JSON.stringify({ error: "No file provided" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return new Response(
        JSON.stringify({ error: "File must be JPEG, PNG, or WEBP" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (file.size > MAX_IMAGE_SIZE) {
      return new Response(
        JSON.stringify({ error: "File must be under 10MB" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const bucket = locals.runtime.env.BUCKET;

    if (shouldParse) {
      // Workflow path: create processing expense + trigger AI parse.
      const expense = await expenses.createExpenseForUpload(db, {
        userId: user.id,
        file: {
          fileKey: `expenses/${crypto.randomUUID()}/${file.name}`,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
        },
      });
      // We minted the fileKey before the insert; use it for R2 too.
      const fileKey = expense.file_key!;
      await bucket.put(fileKey, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
      });

      const worker = locals.runtime.env.WORKER;
      const logger = locals.logger.child({ expenseId: expense.id });
      logger.info("Expense created for upload, triggering workflow");
      const triggerResult = await triggerExpenseWorkflow(
        db,
        worker,
        expense.id,
        user.id,
        logger,
        locals.runtime.env.WORKER_DEV_URL,
      );

      const finalExpense =
        (await expenses.getExpense(db, expense.id, user.id)) ?? expense;
      return new Response(
        JSON.stringify(
          triggerResult.success
            ? finalExpense
            : { ...finalExpense, trigger_error: triggerResult.error },
        ),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Manual + image attachment path: full expense data plus stored image,
    // no parsing.
    const merchantField = formData.get("merchant");
    const amountField = formData.get("amount");
    const currencyField = formData.get("currency");
    const dateField = formData.get("expense_date");
    const categoryField = formData.get("category_id");
    const notesField = formData.get("notes");

    const parsedManual = createManualExpenseSchema.safeParse({
      merchant: typeof merchantField === "string" ? merchantField : undefined,
      amount:
        typeof amountField === "string" ? parseInt(amountField, 10) : undefined,
      currency:
        typeof currencyField === "string" && currencyField
          ? currencyField
          : "USD",
      expense_date: typeof dateField === "string" ? dateField : undefined,
      category_id:
        typeof categoryField === "string" && categoryField
          ? categoryField
          : undefined,
      notes:
        typeof notesField === "string" && notesField ? notesField : undefined,
    });

    if (!parsedManual.success) {
      return new Response(
        JSON.stringify({ error: parsedManual.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const fileKey = `expenses/${crypto.randomUUID()}/${file.name}`;
    await bucket.put(fileKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });

    const expense = await expenses.createManualExpense(db, {
      userId: user.id,
      merchant: parsedManual.data.merchant,
      amount: parsedManual.data.amount,
      currency: parsedManual.data.currency,
      date: parsedManual.data.expense_date,
      categoryId: parsedManual.data.category_id,
      notes: parsedManual.data.notes,
      file: {
        fileKey,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
      },
    });

    return new Response(JSON.stringify(expense), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    console.error("Create expense error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
