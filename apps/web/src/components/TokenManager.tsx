import { useState, useEffect } from "react";
import { Skeleton } from "./Skeleton";

type ApiToken = { id: string; name: string; created_at: string };

export function TokenManager() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchTokens = async () => {
    try {
      const res = await fetch("/api/tokens");
      if (res.ok) setTokens(await res.json());
    } catch {
      setError("Failed to load tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTokens();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    setNewToken(null);

    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });

      if (res.ok) {
        const data = await res.json();
        setNewToken(data.token);
        setNewName("");
        fetchTokens();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to create token");
      }
    } catch {
      setError("Failed to create token");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Revoke this token? This cannot be undone.")) return;
    setError(null);

    const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" });
    if (res.ok) {
      fetchTokens();
    } else {
      setError("Failed to revoke token");
    }
  };

  if (loading)
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-72" />
        <div className="flex gap-2">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-28" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between glass rounded-xl p-3"
            >
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-400">
        API tokens allow MCP clients to access your data. Tokens are shown only
        once when created.
      </p>

      {/* Create form */}
      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Token name (e.g., Claude Desktop)"
          className="flex-1 px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent text-sm"
        />
        <button
          type="submit"
          disabled={creating}
          className="bg-accent-500 text-white px-4 py-2 rounded-xl hover:bg-accent-600 font-medium text-sm disabled:opacity-50 transition-colors duration-200 cursor-pointer"
        >
          {creating ? "Creating..." : "Create Token"}
        </button>
      </form>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Show newly created token */}
      {newToken && (
        <div className="glass rounded-2xl p-4 border-green-500/30" style={{ borderColor: "rgba(34, 197, 94, 0.3)" }}>
          <p className="text-sm font-medium text-green-400 mb-2">
            Token created. Copy it now -- it won't be shown again.
          </p>
          <code className="block bg-white/10 border border-white/20 rounded-xl p-3 text-sm text-white break-all select-all">
            {newToken}
          </code>
        </div>
      )}

      {/* Token list */}
      {tokens.length === 0 ? (
        <p className="text-slate-500 text-sm">No API tokens.</p>
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between glass rounded-xl p-3"
            >
              <div>
                <p className="font-medium text-white text-sm">{t.name}</p>
                <p className="text-xs text-slate-500">
                  Created {new Date(t.created_at).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => handleDelete(t.id)}
                className="text-sm text-red-400 hover:text-red-300 transition-colors duration-200 cursor-pointer"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
