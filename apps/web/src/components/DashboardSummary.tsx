import { useState, useEffect } from "react";
import type { Expense, ExpenseSummary, Receipt } from "@quickspense/domain";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function DashboardSummary() {
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [recentExpenses, setRecentExpenses] = useState<Expense[]>([]);
  const [needsReview, setNeedsReview] = useState<Receipt[]>([]);
  const [receiptCounts, setReceiptCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [expRes, summaryRes, reviewRes, allReceiptsRes] = await Promise.all([
          fetch("/api/expenses?limit=5"),
          fetch("/api/dashboard/summary"),
          fetch("/api/receipts?status=needs_review&limit=5"),
          fetch("/api/dashboard/receipt-counts"),
        ]);

        if (expRes.ok) setRecentExpenses(await expRes.json());
        if (summaryRes.ok) setSummary(await summaryRes.json());
        if (reviewRes.ok) setNeedsReview(await reviewRes.json());
        if (allReceiptsRes.ok) setReceiptCounts(await allReceiptsRes.json());
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading)
    return (
      <div className="space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="space-y-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-3 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>

        <div>
          <Skeleton className="h-5 w-44 mb-3" />
          <Card>
            <div className="divide-y divide-white/5">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between p-4">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {Array.from({ length: 2 }).map((_, col) => (
            <div key={col}>
              <div className="flex items-center justify-between mb-3">
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-4 w-14" />
              </div>
              <Card>
                <div className="divide-y divide-white/5">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-4">
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                      <Skeleton className="h-4 w-16" />
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <div className="space-y-8">
      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent>
            <p className="text-sm text-slate-400">Total Spending</p>
            <p className="text-3xl font-bold text-primary-400 mt-1">
              ${formatCents(summary?.total ?? 0)}
            </p>
            <p className="text-sm text-slate-500 mt-1">
              {summary?.count ?? 0} expenses
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-400">Needs Review</p>
            <p className="text-3xl font-bold text-blue-400 mt-1">
              {receiptCounts["needs_review"] ?? 0}
            </p>
            <p className="text-sm text-slate-500 mt-1">receipts awaiting review</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-400">Processing</p>
            <p className="text-3xl font-bold text-yellow-400 mt-1">
              {receiptCounts["processing"] ?? 0}
            </p>
            <p className="text-sm text-slate-500 mt-1">receipts being processed</p>
          </CardContent>
        </Card>
      </div>

      {/* Spending by category */}
      {summary && summary.byCategory.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-white mb-3">
            Spending by Category
          </h2>
          <Card>
            <div className="divide-y divide-white/5">
              {summary.byCategory.map((cat, i) => (
                <div key={i} className="flex items-center justify-between p-4">
                  <span className="text-slate-300">
                    {cat.category_name || "Uncategorized"}
                  </span>
                  <div className="text-right">
                    <span className="font-medium text-white">
                      ${formatCents(cat.total)}
                    </span>
                    <span className="text-xs text-slate-500 ml-2">
                      ({cat.count})
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent expenses */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-white">
              Recent Expenses
            </h2>
            <a
              href="/expenses"
              className="text-sm text-primary-400 hover:text-primary-300 transition-colors duration-200"
            >
              View all
            </a>
          </div>
          {recentExpenses.length === 0 ? (
            <p className="text-slate-500 text-sm">No expenses yet.</p>
          ) : (
            <Card>
              <div className="divide-y divide-white/5">
                {recentExpenses.map((exp) => (
                  <div
                    key={exp.id}
                    className="flex items-center justify-between p-4"
                  >
                    <div>
                      <p className="font-medium text-white text-sm">
                        {exp.merchant}
                      </p>
                      <p className="text-xs text-slate-500">{exp.expense_date}</p>
                    </div>
                    <span className="font-medium text-white text-sm">
                      ${formatCents(exp.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Receipts needing review */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-white">
              Needs Review
            </h2>
            <a
              href="/receipts"
              className="text-sm text-primary-400 hover:text-primary-300 transition-colors duration-200"
            >
              View all
            </a>
          </div>
          {needsReview.length === 0 ? (
            <p className="text-slate-500 text-sm">No receipts need review.</p>
          ) : (
            <Card>
              <div className="divide-y divide-white/5">
                {needsReview.map((r) => (
                  <a
                    key={r.id}
                    href={`/receipts/${r.id}`}
                    className="flex items-center justify-between p-4 hover:bg-white/5 block transition-colors duration-200 cursor-pointer"
                  >
                    <div>
                      <p className="font-medium text-white text-sm">
                        {r.file_name}
                      </p>
                      <p className="text-xs text-slate-500">
                        {new Date(r.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <span className="text-primary-400 text-sm">Review &rarr;</span>
                  </a>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
