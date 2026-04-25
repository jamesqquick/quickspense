import { useState, useEffect } from "react";
import type { Category } from "@quickspense/domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

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

  const globalCategories = categories.filter((c) => c.is_global);
  const customCategories = categories.filter((c) => !c.is_global);

  if (loading)
    return (
      <div className="space-y-6">
        <div className="flex gap-2">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-16" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="rounded-xl p-3 flex items-center justify-between">
              <Skeleton className="h-4 w-28" />
              <div className="flex gap-3">
                <Skeleton className="h-4 w-10" />
                <Skeleton className="h-4 w-12" />
              </div>
            </Card>
          ))}
        </div>
      </div>
    );

  return (
    <div className="space-y-6">
      {/* Create custom category form */}
      <form onSubmit={handleCreate} className="flex gap-2">
        <Input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New custom category name"
          className="flex-1"
        />
        <Button type="submit">Add</Button>
      </form>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Default categories */}
      {globalCategories.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-slate-400">Default Categories</h3>
          {globalCategories.map((cat) => (
            <Card
              key={cat.id}
              className="rounded-xl p-3 flex items-center justify-between"
            >
              <span className="text-white">{cat.name}</span>
              <Badge variant="secondary" className="text-xs">Default</Badge>
            </Card>
          ))}
        </div>
      )}

      {/* Custom categories */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-slate-400">Custom Categories</h3>
        {customCategories.length === 0 ? (
          <p className="text-slate-500 text-center py-4">
            No custom categories yet. Add one above.
          </p>
        ) : (
          customCategories.map((cat) => (
            <Card
              key={cat.id}
              className="rounded-xl p-3 flex items-center justify-between"
            >
              {editingId === cat.id ? (
                <div className="flex gap-2 flex-1">
                  <Input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 py-1"
                    autoFocus
                  />
                  <Button variant="link" size="sm" onClick={() => handleUpdate(cat.id)}>
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <span className="text-white">{cat.name}</span>
                  <div className="flex gap-3">
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => {
                        setEditingId(cat.id);
                        setEditName(cat.name);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => handleDelete(cat.id)}
                      className="text-red-400 hover:text-red-300"
                    >
                      Delete
                    </Button>
                  </div>
                </>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
