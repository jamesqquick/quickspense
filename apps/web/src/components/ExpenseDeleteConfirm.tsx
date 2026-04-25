import { useState } from "react";
import type { Expense } from "@quickspense/domain";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

type ExpenseDeleteConfirmProps = {
  expense: Expense;
  onConfirm: () => void;
  onCancel: () => void;
};

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function ExpenseDeleteConfirm({
  expense,
  onConfirm,
  onCancel,
}: ExpenseDeleteConfirmProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/expenses/${expense.id}`, {
        method: "DELETE",
      });

      if (res.ok || res.status === 204) {
        onConfirm();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to delete expense");
      }
    } catch {
      setError("Failed to delete expense");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete Expense</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete{" "}
            <span className="text-white font-medium">{expense.merchant}</span>{" "}
            for{" "}
            <span className="text-white font-medium">
              ${formatCents(expense.amount)}
            </span>
            ? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
