import { useEffect, useState } from "react";
import type { Invoice, InvoiceStatus } from "@quickspense/domain";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";

const PAGE_SIZE = 20;
const FILTERS: { label: string; value: InvoiceStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Draft", value: "draft" },
  { label: "Sent", value: "sent" },
  { label: "Paid", value: "paid" },
  { label: "Void", value: "void" },
];

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function InvoiceList() {
  const [items, setItems] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<InvoiceStatus | "all">("all");
  const [loading, setLoading] = useState(true);

  const fetchInvoices = async (requestedOffset = offset) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter !== "all") params.set("status", filter);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(requestedOffset));

    try {
      const res = await fetch(`/api/invoices?${params}`);
      if (res.ok) {
        const data = await res.json();
        setItems(data.items);
        setTotal(data.total);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setOffset(0);
    fetchInvoices(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => {
    if (offset !== 0) fetchInvoices(offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-200 cursor-pointer ${
                filter === f.value
                  ? "bg-accent-500 text-white"
                  : "bg-white/5 text-slate-400 hover:text-white"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Button asChild>
          <a href="/invoices/new">New Invoice</a>
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card
              key={i}
              className="rounded-xl p-4 flex items-center justify-between"
            >
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-4 w-20" />
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-slate-400 text-center py-12">
          No invoices yet. Create your first one.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((invoice) => (
            <a
              key={invoice.id}
              href={`/invoices/${invoice.id}`}
              className="block"
            >
              <Card className="rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 hover:bg-white/5 transition-colors duration-200">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-white">
                      {invoice.invoice_number}
                    </p>
                    <InvoiceStatusBadge status={invoice.status} />
                  </div>
                  <p className="text-sm text-slate-500 truncate">
                    {invoice.client_name} &middot; {invoice.client_email}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Created {invoice.created_at.split("T")[0]}
                    {invoice.due_date ? ` · Due ${invoice.due_date}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-white">
                    ${formatCents(invoice.total)}
                  </p>
                  <p className="text-xs text-slate-500">{invoice.currency}</p>
                </div>
              </Card>
            </a>
          ))}
        </div>
      )}

      <Pagination
        total={total}
        limit={PAGE_SIZE}
        offset={offset}
        onPageChange={setOffset}
      />
    </div>
  );
}
