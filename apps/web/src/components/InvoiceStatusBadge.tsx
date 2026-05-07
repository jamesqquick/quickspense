import type { InvoiceStatus } from "@quickspense/domain";
import { Badge } from "@/components/ui/badge";

const VARIANT_BY_STATUS: Record<
  InvoiceStatus,
  "muted" | "info" | "success" | "destructive"
> = {
  draft: "muted",
  sent: "info",
  paid: "success",
  void: "destructive",
};

const LABEL_BY_STATUS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  void: "Void",
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <Badge variant={VARIANT_BY_STATUS[status]}>{LABEL_BY_STATUS[status]}</Badge>
  );
}
