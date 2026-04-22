import { useState, useEffect } from "react";
import type { Category } from "@quickspense/domain";

export function CategoryManager() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fetchCategories = async () => {
    try {
      const res = await fetch("/api/categories");
      if (res.ok) setCategories(await res.json());
    } catch {
      setError("Failed to load categories");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCategories();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setError(null);

    const res = await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });

    if (res.ok) {
      setNewName("");
      fetchCategories();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to create category");
    }
  };

  const handleUpdate = async (id: string) => {
    if (!editName.trim()) return;
    setError(null);

    const res = await fetch(`/api/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName.trim() }),
    });

    if (res.ok) {
      setEditingId(null);
      setEditName("");
      fetchCategories();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to update category");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this category?")) return;
    setError(null);

    const res = await fetch(`/api/categories/${id}`, { method: "DELETE" });
    if (res.ok) {
      fetchCategories();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to delete category");
    }
  };

  if (loading) return <p className="text-slate-400">Loading...</p>;

  return (
    <div className="space-y-6">
      {/* Create form */}
      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New category name"
          className="flex-1 px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent"
        />
        <button
          type="submit"
          className="bg-accent-500 text-white px-4 py-2 rounded-xl hover:bg-accent-600 font-medium text-sm transition-colors duration-200 cursor-pointer"
        >
          Add
        </button>
      </form>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* List */}
      {categories.length === 0 ? (
        <p className="text-slate-500 text-center py-8">No categories yet. Create one above.</p>
      ) : (
        <div className="space-y-2">
          {categories.map((cat) => (
            <div
              key={cat.id}
              className="flex items-center justify-between glass rounded-xl p-3"
            >
              {editingId === cat.id ? (
                <div className="flex gap-2 flex-1">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 px-2 py-1 bg-white/10 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                    autoFocus
                  />
                  <button
                    onClick={() => handleUpdate(cat.id)}
                    className="text-sm text-primary-400 hover:text-primary-300 transition-colors duration-200 cursor-pointer"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="text-sm text-slate-400 hover:text-slate-300 transition-colors duration-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-white">{cat.name}</span>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setEditingId(cat.id);
                        setEditName(cat.name);
                      }}
                      className="text-sm text-primary-400 hover:text-primary-300 transition-colors duration-200 cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(cat.id)}
                      className="text-sm text-red-400 hover:text-red-300 transition-colors duration-200 cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
