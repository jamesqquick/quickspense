import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import type { Expense, Category } from "@quickspense/domain";
import { ExpenseForm, type ExpenseFormValues } from "./ExpenseForm";
import { ExpenseEditModal } from "./ExpenseEditModal";
import { ExpenseDeleteConfirm } from "./ExpenseDeleteConfirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { Pencil, Trash2, Search, X } from "lucide-react";

const PAGE_SIZE = 20;

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function ExpenseList() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [categoryId, setCategoryId] = useState("");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [deletingExpense, setDeletingExpense] = useState<Expense | null>(null);

  // Debounce search input
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
        setExpenses(data.items);
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

  // Reset to first page when filters change
  useEffect(() => {
    setOffset(0);
    fetchExpenses(0);
  }, [startDate, endDate, categoryId, debouncedSearch]);

  // Fetch when page changes (but not on filter change -- handled above)
  useEffect(() => {
    if (offset !== 0) fetchExpenses(offset);
  }, [offset]);

  const handleCreate = async (values: ExpenseFormValues) => {
    const amountCents = Math.round(parseFloat(values.amount) * 100);

    const res = await fetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merchant: values.merchant,
        amount: amountCents,
        currency: values.currency || "USD",
        expense_date: values.expense_date,
        category_id: values.category_id || undefined,
        notes: values.notes || undefined,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to create expense");
    }

    toast.success("Expense created");
    setShowForm(false);
    setOffset(0);
    fetchExpenses(0);
  };

  const handleEditSave = (updated: Expense) => {
    setExpenses((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e)),
    );
    setEditingExpense(null);
  };

  const handleDeleteConfirm = () => {
    if (deletingExpense) {
      setExpenses((prev) => prev.filter((e) => e.id !== deletingExpense.id));
    }
    setDeletingExpense(null);
  };

  const getCategoryName = (id: string | null) => {
    if (!id) return "Uncategorized";
    return categories.find((c) => c.id === id)?.name || "Unknown";
  };

  return (
    <div className="space-y-6">
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
        <Button onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Add Expense"}
        </Button>
        <Button variant="outline" asChild>
          <a
            href={(() => {
              const p = new URLSearchParams();
              if (startDate) p.set("startDate", startDate);
              if (endDate) p.set("endDate", endDate);
              if (categoryId) p.set("categoryId", categoryId);
              if (debouncedSearch) p.set("search", debouncedSearch);
              const qs = p.toString();
              return `/api/expenses/export${qs ? `?${qs}` : ""}`;
            })()}
          >
            Export CSV
          </a>
        </Button>
      </div>

      {/* Manual expense form */}
      {showForm && (
        <Card className="p-6">
          <ExpenseForm
            categories={categories}
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
            submitLabel="Create Expense"
            submittingLabel="Creating..."
          />
        </Card>
      )}

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
      ) : expenses.length === 0 ? (
        <p className="text-slate-400 text-center py-12">No expenses found.</p>
      ) : (
        <div className="space-y-2">
          {expenses.map((exp) => (
            <Card
              key={exp.id}
              className="rounded-xl p-4 flex flex-wrap items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-white truncate">{exp.merchant}</p>
                <p className="text-sm text-slate-500">
                  {exp.expense_date} &middot; {getCategoryName(exp.category_id)}
                </p>
                {exp.notes && (
                  <p className="text-xs text-slate-500 mt-1 truncate">{exp.notes}</p>
                )}
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="font-semibold text-white">
                    ${formatCents(exp.amount)}
                  </p>
                  <p className="text-xs text-slate-500">{exp.currency}</p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditingExpense(exp)}
                    title="Edit expense"
                    className="size-8"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeletingExpense(exp)}
                    title="Delete expense"
                    className="size-8 hover:text-red-400"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Pagination
        total={total}
        limit={PAGE_SIZE}
        offset={offset}
        onPageChange={setOffset}
      />

      {/* Edit modal */}
      {editingExpense && (
        <ExpenseEditModal
          expense={editingExpense}
          categories={categories}
          onSave={handleEditSave}
          onClose={() => setEditingExpense(null)}
        />
      )}

      {/* Delete confirmation */}
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
