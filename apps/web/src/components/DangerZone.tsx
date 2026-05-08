import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { navigateWithFlashToast } from "@/lib/flashToast";

export function DangerZone({ userEmail }: { userEmail: string }) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const canDelete = confirmText === userEmail;

  const handleDelete = async () => {
    if (!canDelete) return;
    if (!confirm("This cannot be undone. Delete your account?")) return;

    setDeleting(true);

    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      if (res.ok) {
        navigateWithFlashToast("/login", "success", "Account deleted");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete account");
        setDeleting(false);
      }
    } catch {
      toast.error("Failed to delete account");
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
      <Input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder={userEmail}
        className="bg-white/5 border-red-500/30 mb-3 focus:ring-red-500"
      />
      <Button
        variant="destructive-solid"
        onClick={handleDelete}
        disabled={!canDelete || deleting}
      >
        {deleting ? "Deleting..." : "Delete My Account"}
      </Button>
    </div>
  );
}
