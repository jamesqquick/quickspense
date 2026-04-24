import type { APIRoute } from "astro";
import { expenses, categories, listExpensesSchema, createDb } from "@quickspense/domain";

/** Escape a CSV field per RFC 4180. */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const GET: APIRoute = async ({ locals, url }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);

  // Reuse the same filter schema as the regular list endpoint.
  // Override limit to max so all matching rows are exported.
  const params = listExpensesSchema.safeParse({
    startDate: url.searchParams.get("startDate") || undefined,
    endDate: url.searchParams.get("endDate") || undefined,
    categoryId: url.searchParams.get("categoryId") || undefined,
    limit: 100,
    offset: 0,
  });

  if (!params.success) {
    return new Response(
      JSON.stringify({ error: params.error.issues[0].message }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Fetch all matching expenses by paging. Cap at 10,000 rows for safety.
  const MAX_ROWS = 10_000;
  const all: Awaited<ReturnType<typeof expenses.listExpenses>> = [];
  let offset = 0;
  while (all.length < MAX_ROWS) {
    const page = await expenses.listExpenses(db, user.id, {
      ...params.data,
      limit: 100,
      offset,
    });
    if (page.length === 0) break;
    all.push(...page);
    offset += page.length;
    if (page.length < 100) break;
  }

  // Resolve category names once.
  const categoryList = await categories.listCategories(db, user.id);
  const catMap = new Map(categoryList.map((c) => [c.id, c.name]));

  // Build CSV
  const header = [
    "id",
    "date",
    "merchant",
    "amount",
    "currency",
    "category",
    "notes",
    "receipt_id",
    "created_at",
  ].join(",");

  const rows = all.map((e) =>
    [
      csvField(e.id),
      csvField(e.expense_date),
      csvField(e.merchant),
      csvField((e.amount / 100).toFixed(2)),
      csvField(e.currency),
      csvField(e.category_id ? catMap.get(e.category_id) ?? "" : ""),
      csvField(e.notes),
      csvField(e.receipt_id),
      csvField(e.created_at),
    ].join(","),
  );

  const csv = [header, ...rows].join("\n") + "\n";
  const filename = `quickspense-expenses-${new Date().toISOString().slice(0, 10)}.csv`;

  locals.logger.info("Exported expenses", { count: all.length });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
