import { useState, useEffect, useRef, useCallback } from "react";
import type { Expense, ExpenseStatus, Category } from "@quickspense/domain";
import { ExpenseDeleteConfirm } from "./ExpenseDeleteConfirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { Trash2, Search, X, Image as ImageIcon, ChevronRight } from "lucide-react";

const PAGE_SIZE = 20;

type BadgeVariant = "muted" | "warning" | "info" | "success" | "destructive";

const STATUS_BADGE_VARIANT: Record<ExpenseStatus, BadgeVariant> = {
  active: "success",
  processing: "warning",
  needs_review: "info",
  failed: "destructive",
};

const STATUS_LABELS: Record<ExpenseStatus, string> = {
  active: "Active",
  processing: "Processing",
  needs_review: "Needs Review",
  failed: "Failed",
};

const STATUS_TABS: Array<{ value: "" | ExpenseStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "needs_review", label: "Needs Review" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
  { value: "", label: "All" },
];

function formatCents(cents: number | null): string {
  if (cents === null) return "—";
  return (cents / 100).toFixed(2);
}

type Props = {
  /** Initial status tab. Defaults to "active". */
  initialStatus?: "" | ExpenseStatus;
};

export function ExpenseList({ initialStatus = "active" }: Props) {
  const [items, setItems] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const [status, setStatus] = useState<"" | ExpenseStatus>(initialStatus);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [categoryId, setCategoryId] = useState("");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [deletingExpense, setDeletingExpense] = useState<Expense | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
  }, []);

  const fetchExpenses = async (requestedOffset = offset) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    if (categoryId) params.set("categoryId", categoryId);
    if (debouncedSearch) params.set("search", debouncedSearch);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(requestedOffset));

    try {
      const res = await fetch(`/api/expenses?${params}`);
      if (res.ok) {
        const data = await res.json();
        setItems(data.items);
        setTotal(data.total);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const res = await fetch("/api/categories");
      if (res.ok) setCategories(await res.json());
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchCategories();
  }, []);

  // On filter change, jump back to page 0
  useEffect(() => {
    setOffset(0);
    fetchExpenses(0);
  }, [status, startDate, endDate, categoryId, debouncedSearch]);

  useEffect(() => {
    if (offset !== 0) fetchExpenses(offset);
  }, [offset]);

  // Sync `?status=` in URL so the dashboard cards can deep-link to a tab.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (status) url.searchParams.set("status", status);
    else url.searchParams.delete("status");
    window.history.replaceState({}, "", url);
  }, [status]);

  const handleDeleteConfirm = () => {
    if (deletingExpense) {
      setItems((prev) => prev.filter((e) => e.id !== deletingExpense.id));
    }
    setDeletingExpense(null);
  };

  const getCategoryName = (id: string | null) => {
    if (!id) return "Uncategorized";
    return categories.find((c) => c.id === id)?.name || "Unknown";
  };

  const exportHref = (() => {
    const p = new URLSearchParams();
    if (startDate) p.set("startDate", startDate);
    if (endDate) p.set("endDate", endDate);
    if (categoryId) p.set("categoryId", categoryId);
    if (debouncedSearch) p.set("search", debouncedSearch);
    const qs = p.toString();
    return `/api/expenses/export${qs ? `?${qs}` : ""}`;
  })();

  return (
    <div className="space-y-6">
      {/* Status tabs */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value || "all"}
            onClick={() => setStatus(tab.value)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-200 cursor-pointer ${
              status === tab.value
                ? "bg-primary-500 text-white"
                : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Input
          type="text"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search by merchant or notes..."
          className="pl-10"
        />
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
        {search && (
          <button
            onClick={() => handleSearchChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors duration-200 cursor-pointer"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-2 sm:flex gap-3 sm:gap-4 sm:flex-wrap sm:items-end">
        <div>
          <Label className="text-xs text-slate-400">From</Label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs text-slate-400">To</Label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <Label className="text-xs text-slate-400">Category</Label>
          <Select
            value={categoryId || "__all__"}
            onValueChange={(v) => setCategoryId(v === "__all__" ? "" : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button asChild>
          <a href="/expenses/new">+ New Expense</a>
        </Button>
        <Button variant="outline" asChild>
          <a href="/expenses/upload">Upload Receipts</a>
        </Button>
        <Button variant="outline" asChild>
          <a href={exportHref}>Export CSV</a>
        </Button>
      </div>

      {/* Expense list */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="rounded-xl p-4 flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-48" />
              </div>
              <div className="space-y-2 text-right">
                <Skeleton className="h-4 w-16 ml-auto" />
                <Skeleton className="h-3 w-10 ml-auto" />
              </div>
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-slate-400 text-center py-12">No expenses found.</p>
      ) : (
        <div className="space-y-2">
          {items.map((exp) => {
            const subtitle =
              exp.status === "active"
                ? `${exp.expense_date ?? ""} · ${getCategoryName(exp.category_id)}`
                : exp.file_name ?? "";

            return (
              <Card
                key={exp.id}
                className="rounded-xl p-4 flex flex-wrap items-center justify-between gap-2 hover:bg-white/[0.08] transition-colors duration-200"
              >
                <a
                  href={`/expenses/${exp.id}`}
                  className="flex items-center justify-between gap-4 flex-1 min-w-0 cursor-pointer"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-white truncate">
                        {exp.merchant || (
                          <span className="text-slate-500">Pending parse...</span>
                        )}
                      </p>
                      {exp.status !== "active" && (
                        <Badge variant={STATUS_BADGE_VARIANT[exp.status]}>
                          {STATUS_LABELS[exp.status]}
                        </Badge>
                      )}
                      {exp.file_key && (
                        <ImageIcon
                          className="size-3.5 text-slate-500"
                          aria-label="Has attached image"
                        />
                      )}
                    </div>
                    <p className="text-sm text-slate-500">{subtitle}</p>
                    {exp.notes && (
                      <p className="text-xs text-slate-500 mt-1 truncate">
                        {exp.notes}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-semibold text-white">
                      ${formatCents(exp.amount)}
                    </p>
                    <p className="text-xs text-slate-500">{exp.currency}</p>
                  </div>
                </a>
                <div className="flex gap-1 shrink-0">
                  {exp.status === "active" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDeletingExpense(exp);
                      }}
                      title="Delete expense"
                      className="size-8 hover:text-red-400"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                  <ChevronRight
                    className="size-4 text-slate-500 self-center"
                    aria-hidden="true"
                  />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Pagination
        total={total}
        limit={PAGE_SIZE}
        offset={offset}
        onPageChange={setOffset}
      />

      {deletingExpense && (
        <ExpenseDeleteConfirm
          expense={deletingExpense}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeletingExpense(null)}
        />
      )}
    </div>
  );
}
