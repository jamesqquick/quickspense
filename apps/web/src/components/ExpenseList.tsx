import { useState, useEffect, useRef, useCallback } from "react";
import type { Expense, Category } from "@quickspense/domain";
import { ExpenseForm, type ExpenseFormValues } from "./ExpenseForm";
import { ExpenseEditModal } from "./ExpenseEditModal";
import { ExpenseDeleteConfirm } from "./ExpenseDeleteConfirm";
import { Skeleton } from "./Skeleton";

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function ExpenseList() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
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

  const labelClasses = "block text-xs text-slate-400 mb-1";

  // Debounce search input
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
  }, []);

  const fetchExpenses = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    if (categoryId) params.set("categoryId", categoryId);
    if (debouncedSearch) params.set("search", debouncedSearch);
    params.set("limit", "50");

    try {
      const res = await fetch(`/api/expenses?${params}`);
      if (res.ok) setExpenses(await res.json());
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

  useEffect(() => {
    fetchExpenses();
  }, [startDate, endDate, categoryId, debouncedSearch]);

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

    setShowForm(false);
    fetchExpenses();
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
        <input
          type="text"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search by merchant or notes..."
          className="w-full px-4 py-2.5 pl-10 bg-white/10 border border-white/20 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent"
        />
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>
        {search && (
          <button
            onClick={() => handleSearchChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors duration-200 cursor-pointer"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
            >
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-2 sm:flex gap-3 sm:gap-4 sm:flex-wrap sm:items-end">
        <div>
          <label className={labelClasses}>From</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>
        <div>
          <label className={labelClasses}>To</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <label className={labelClasses}>Category</label>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-accent-500 text-white px-4 py-2 rounded-xl hover:bg-accent-600 text-sm font-medium transition-colors duration-200 cursor-pointer"
        >
          {showForm ? "Cancel" : "Add Expense"}
        </button>
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
          className="bg-white/10 text-slate-300 px-4 py-2 rounded-xl hover:bg-white/20 text-sm font-medium transition-colors duration-200"
        >
          Export CSV
        </a>
      </div>

      {/* Manual expense form */}
      {showForm && (
        <div className="glass rounded-2xl p-6">
          <ExpenseForm
            categories={categories}
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
            submitLabel="Create Expense"
            submittingLabel="Creating..."
          />
        </div>
      )}

      {/* Expense list */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="glass rounded-xl p-4 flex items-center justify-between"
            >
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-48" />
              </div>
              <div className="space-y-2 text-right">
                <Skeleton className="h-4 w-16 ml-auto" />
                <Skeleton className="h-3 w-10 ml-auto" />
              </div>
            </div>
          ))}
        </div>
      ) : expenses.length === 0 ? (
        <p className="text-slate-400 text-center py-12">No expenses found.</p>
      ) : (
        <div className="space-y-2">
          {expenses.map((exp) => (
            <div
              key={exp.id}
              className="glass rounded-xl p-4 flex items-center justify-between"
            >
              <div>
                <p className="font-medium text-white">{exp.merchant}</p>
                <p className="text-sm text-slate-500">
                  {exp.expense_date} &middot; {getCategoryName(exp.category_id)}
                </p>
                {exp.notes && (
                  <p className="text-xs text-slate-500 mt-1">{exp.notes}</p>
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
                  <button
                    onClick={() => setEditingExpense(exp)}
                    className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors duration-200 cursor-pointer"
                    title="Edit expense"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="w-4 h-4"
                    >
                      <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setDeletingExpense(exp)}
                    className="text-slate-400 hover:text-red-400 p-1.5 rounded-lg hover:bg-white/10 transition-colors duration-200 cursor-pointer"
                    title="Delete expense"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="w-4 h-4"
                    >
                      <path
                        fillRule="evenodd"
                        d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

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
