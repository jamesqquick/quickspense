import { useState, useEffect } from "react";
import type { Expense, Category } from "@quickspense/domain";

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

  // Manual expense form
  const [showForm, setShowForm] = useState(false);
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [date, setDate] = useState("");
  const [expCategoryId, setExpCategoryId] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const inputClasses =
    "w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent text-sm";
  const labelClasses = "block text-xs text-slate-400 mb-1";

  const fetchExpenses = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    if (categoryId) params.set("categoryId", categoryId);
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
  }, [startDate, endDate, categoryId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setCreating(true);

    const amountCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      setFormError("Amount must be greater than 0");
      setCreating(false);
      return;
    }

    try {
      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant,
          amount: amountCents,
          currency: currency || "USD",
          expense_date: date,
          category_id: expCategoryId || undefined,
          notes: notes || undefined,
        }),
      });

      if (res.ok) {
        setShowForm(false);
        setMerchant("");
        setAmount("");
        setDate("");
        setExpCategoryId("");
        setNotes("");
        fetchExpenses();
      } else {
        const data = await res.json();
        setFormError(data.error || "Failed to create expense");
      }
    } catch {
      setFormError("Failed to create expense");
    } finally {
      setCreating(false);
    }
  };

  const getCategoryName = (id: string | null) => {
    if (!id) return "Uncategorized";
    return categories.find((c) => c.id === id)?.name || "Unknown";
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex gap-4 flex-wrap items-end">
        <div>
          <label className={labelClasses}>From</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>
        <div>
          <label className={labelClasses}>To</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>
        <div>
          <label className={labelClasses}>Category</label>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
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
        <form onSubmit={handleCreate} className="glass rounded-2xl p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Merchant</label>
              <input
                type="text"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                required
                className={inputClasses}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Amount ($)</label>
              <input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                className={inputClasses}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className={inputClasses}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Category</label>
              <select
                value={expCategoryId}
                onChange={(e) => setExpCategoryId(e.target.value)}
                className={inputClasses}
              >
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={inputClasses}
            />
          </div>
          {formError && <p className="text-red-400 text-sm">{formError}</p>}
          <button
            type="submit"
            disabled={creating}
            className="bg-green-500/20 text-green-300 px-4 py-2 rounded-xl hover:bg-green-500/30 text-sm font-medium disabled:opacity-50 transition-colors duration-200 cursor-pointer"
          >
            {creating ? "Creating..." : "Create Expense"}
          </button>
        </form>
      )}

      {/* Expense list */}
      {loading ? (
        <p className="text-slate-400">Loading...</p>
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
              <div className="text-right">
                <p className="font-semibold text-white">
                  ${formatCents(exp.amount)}
                </p>
                <p className="text-xs text-slate-500">{exp.currency}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
