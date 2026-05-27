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

/**
 * Export expenses as CSV.
 *
 * Only `active` expenses are exported. `processing`, `needs_review`, and
 * `failed` rows are unconfirmed and don't belong in a financial export.
 */
export const GET: APIRoute = async ({ locals, url }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);

  const params = listExpensesSchema.safeParse({
    startDate: url.searchParams.get("startDate") || undefined,
    endDate: url.searchParams.get("endDate") || undefined,
    categoryId: url.searchParams.get("categoryId") || undefined,
    search: url.searchParams.get("search") || undefined,
    limit: 100,
    offset: 0,
  });

  if (!params.success) {
    return new Response(
      JSON.stringify({ error: params.error.issues[0].message }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const MAX_ROWS = 10_000;
  const all: import("@quickspense/domain").Expense[] = [];
  let offset = 0;
  while (all.length < MAX_ROWS) {
    const page = await expenses.listExpenses(db, user.id, {
      ...params.data,
      status: "active",
      limit: 100,
      offset,
    });
    if (page.items.length === 0) break;
    all.push(...page.items);
    offset += page.items.length;
    if (page.items.length < 100) break;
  }

  const categoryList = await categories.listCategories(db, user.id);
  const catMap = new Map(categoryList.map((c) => [c.id, c.name]));

  const header = [
    "id",
    "date",
    "merchant",
    "amount",
    "currency",
    "category",
    "notes",
    "has_image",
    "created_at",
  ].join(",");

  const rows = all.map((e) =>
    [
      csvField(e.id),
      csvField(e.expense_date),
      csvField(e.merchant),
      csvField(e.amount !== null ? (e.amount / 100).toFixed(2) : ""),
      csvField(e.currency),
      csvField(e.category_id ? catMap.get(e.category_id) ?? "" : ""),
      csvField(e.notes),
      csvField(e.file_key ? "yes" : "no"),
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
