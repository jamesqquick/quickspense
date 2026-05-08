import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

type BusinessProfile = {
  user_id: string;
  business_name: string;
  business_email: string | null;
  business_phone: string | null;
  business_address: string | null;
  created_at: string;
  updated_at: string;
};

type FormValues = {
  business_name: string;
  business_email: string;
  business_phone: string;
  business_address: string;
};

const EMPTY: FormValues = {
  business_name: "",
  business_email: "",
  business_phone: "",
  business_address: "",
};

function profileToFormValues(profile: BusinessProfile): FormValues {
  return {
    business_name: profile.business_name,
    business_email: profile.business_email ?? "",
    business_phone: profile.business_phone ?? "",
    business_address: profile.business_address ?? "",
  };
}

/**
 * Convert form values to API payload.
 * Empty strings on optional fields become `null` so the server clears them.
 */
function formValuesToPayload(values: FormValues) {
  return {
    business_name: values.business_name.trim(),
    business_email: values.business_email.trim() || null,
    business_phone: values.business_phone.trim() || null,
    business_address: values.business_address.trim() || null,
  };
}

export function BusinessProfileForm() {
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/me/business-profile");
        if (res.status === 404) {
          // No profile yet — leave form empty
          if (mounted) setLoading(false);
          return;
        }
        if (!res.ok) {
          if (mounted) {
            toast.error("Failed to load business profile");
            setLoading(false);
          }
          return;
        }
        const data = (await res.json()) as BusinessProfile;
        if (!mounted) return;
        setValues(profileToFormValues(data));
      } catch {
        if (mounted) toast.error("Failed to load business profile");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const update = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    if (!values.business_name.trim()) {
      setValidationError("Business name is required");
      return;
    }

    setSaving(true);

    try {
      const res = await fetch("/api/me/business-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formValuesToPayload(values)),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save");
      }

      const updated = (await res.json()) as BusinessProfile;
      setValues(profileToFormValues(updated));
      toast.success("Business profile saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-4 space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-32" />
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-slate-400">
        This information appears on the invoices and emails you send to clients.
      </p>

      <div className="space-y-2">
        <Label htmlFor="business_name">
          Business name <span className="text-red-400">*</span>
        </Label>
        <Input
          id="business_name"
          type="text"
          value={values.business_name}
          onChange={(e) => update("business_name", e.target.value)}
          placeholder="Acme Consulting LLC"
          maxLength={200}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="business_email">Business email</Label>
        <Input
          id="business_email"
          type="email"
          value={values.business_email}
          onChange={(e) => update("business_email", e.target.value)}
          placeholder="billing@acme.com"
          maxLength={320}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="business_phone">Business phone</Label>
        <Input
          id="business_phone"
          type="tel"
          value={values.business_phone}
          onChange={(e) => update("business_phone", e.target.value)}
          placeholder="+1 (555) 123-4567"
          maxLength={50}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="business_address">Business address</Label>
        <Textarea
          id="business_address"
          value={values.business_address}
          onChange={(e) => update("business_address", e.target.value)}
          placeholder={"123 Main St\nSuite 100\nAustin, TX 78701"}
          maxLength={1000}
          rows={3}
        />
      </div>

      {validationError && (
        <p className="text-sm text-red-400" role="alert">
          {validationError}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
