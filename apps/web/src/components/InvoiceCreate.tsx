import { InvoiceForm, buildInvoicePayload, type InvoiceFormValues } from "./InvoiceForm";
import { navigateWithFlashToast } from "@/lib/flashToast";
import { getApiErrorMessage } from "@/lib/apiError";
import type { InvoiceWithLineItems } from "@quickspense/domain";

async function createInvoice(values: InvoiceFormValues) {
  const res = await fetch("/api/invoices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildInvoicePayload(values)),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(getApiErrorMessage(data, "Failed to create invoice"));
  }
  return (await res.json()) as InvoiceWithLineItems;
}

async function sendInvoice(id: string) {
  const res = await fetch(`/api/invoices/${id}/send`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(getApiErrorMessage(data, "Failed to send invoice"));
  }
}

export function InvoiceCreate() {
  return (
    <InvoiceForm
      submitLabel="Save draft"
      onCancel={() => {
        window.location.href = "/invoices";
      }}
      onSubmit={async (values) => {
        const created = await createInvoice(values);
        navigateWithFlashToast(`/invoices/${created.id}`, "success", "Draft saved");
      }}
      secondaryAction={{
        label: "Save & send",
        onClick: async (values) => {
          const created = await createInvoice(values);
          await sendInvoice(created.id);
          navigateWithFlashToast(`/invoices/${created.id}`, "success", "Invoice sent");
        },
      }}
    />
  );
}
