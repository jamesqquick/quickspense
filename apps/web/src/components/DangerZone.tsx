import { useState } from "react";

export function DangerZone({ userEmail }: { userEmail: string }) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmText === userEmail;

  const handleDelete = async () => {
    if (!canDelete) return;
    if (!confirm("This cannot be undone. Delete your account?")) return;

    setDeleting(true);
    setError(null);

    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      if (res.ok) {
        window.location.href = "/login";
      } else {
        const data = await res.json();
        setError(data.error || "Failed to delete account");
      }
    } catch {
      setError("Failed to delete account");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="border border-red-500/30 rounded-2xl p-6 bg-red-500/5">
      <h3 className="text-sm font-semibold text-red-400 mb-2">Delete Account</h3>
      <p className="text-sm text-red-300/80 mb-3">
        This will permanently delete your account, all receipts (including uploaded files),
        all expenses, categories, and API tokens. This cannot be undone.
      </p>
      <p className="text-sm text-red-300/80 mb-2">
        Type your email (<code className="bg-white/10 px-1.5 py-0.5 rounded text-red-300">{userEmail}</code>) to confirm:
      </p>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder={userEmail}
        className="w-full px-3 py-2 bg-white/5 border border-red-500/30 rounded-xl text-white placeholder-slate-500 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
      />
      {error && <p className="text-red-400 text-sm mb-2">{error}</p>}
      <button
        onClick={handleDelete}
        disabled={!canDelete || deleting}
        className="bg-red-600 text-white px-4 py-2 rounded-xl hover:bg-red-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 cursor-pointer"
      >
        {deleting ? "Deleting..." : "Delete My Account"}
      </button>
    </div>
  );
}
