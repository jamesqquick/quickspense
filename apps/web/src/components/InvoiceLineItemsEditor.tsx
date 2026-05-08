import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2, Plus } from "lucide-react";

export type LineItemDraft = {
  description: string;
  quantity: string;
  unit_price: string; // dollars as string for input control
};

export function emptyLineItem(): LineItemDraft {
  return { description: "", quantity: "1", unit_price: "0.00" };
}

export function InvoiceLineItemsEditor({
  items,
  onChange,
}: {
  items: LineItemDraft[];
  onChange: (items: LineItemDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<LineItemDraft>) => {
    const next = items.map((item, i) =>
      i === index ? { ...item, ...patch } : item,
    );
    onChange(next);
  };

  const remove = (index: number) => {
    if (items.length === 1) return;
    onChange(items.filter((_, i) => i !== index));
  };

  const add = () => {
    onChange([...items, emptyLineItem()]);
  };

  return (
    <div className="space-y-3">
      <Label className="text-sm text-slate-300">Line Items</Label>
      <div className="space-y-2">
        {items.map((item, i) => {
          const qty = parseFloat(item.quantity || "0");
          const price = parseFloat(item.unit_price || "0");
          const total = Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;
          return (
            <div
              key={i}
              className="grid grid-cols-12 gap-2 items-start rounded-lg bg-white/5 p-3"
            >
              <div className="col-span-12 sm:col-span-5">
                <Label className="text-xs text-slate-400">Description</Label>
                <Input
                  value={item.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                  placeholder="e.g. Consulting hours"
                />
              </div>
              <div className="col-span-4 sm:col-span-2">
                <Label className="text-xs text-slate-400">Qty</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.quantity}
                  onChange={(e) => update(i, { quantity: e.target.value })}
                />
              </div>
              <div className="col-span-4 sm:col-span-2">
                <Label className="text-xs text-slate-400">Unit Price</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.unit_price}
                  onChange={(e) => update(i, { unit_price: e.target.value })}
                />
              </div>
              <div className="col-span-3 sm:col-span-2">
                <Label className="text-xs text-slate-400">Total</Label>
                <div className="px-3 py-2 text-sm text-white">
                  ${total.toFixed(2)}
                </div>
              </div>
              <div className="col-span-1 flex justify-end pt-5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(i)}
                  disabled={items.length === 1}
                  title="Remove line item"
                  className="size-8 hover:text-red-400"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="size-4" />
        Add line item
      </Button>
    </div>
  );
}
