import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { businessProfiles } from "../db/schema.js";
import type { BusinessProfile } from "../types.js";

export type UpsertBusinessProfileInput = {
  business_name: string;
  business_email?: string | null;
  business_phone?: string | null;
  business_address?: string | null;
};

/**
 * Returns the business profile for a user, or `null` if none has been set yet.
 * Callers should fall back to a generic display value (e.g. EMAIL_FROM_NAME)
 * when this returns `null`.
 */
export async function getBusinessProfile(
  db: Database,
  userId: string,
): Promise<BusinessProfile | null> {
  const rows = await db
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.user_id, userId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Inserts or updates the business profile for a user.
 *
 * The profile is 1:1 with the user (PK = user_id) so this is always an upsert.
 * Optional fields default to `null` on first insert; on update, omitting a
 * field leaves the existing value alone, while passing `null` clears it.
 */
export async function upsertBusinessProfile(
  db: Database,
  userId: string,
  input: UpsertBusinessProfileInput,
): Promise<BusinessProfile> {
  const now = new Date().toISOString();

  const existing = await getBusinessProfile(db, userId);

  if (!existing) {
    await db.insert(businessProfiles).values({
      user_id: userId,
      business_name: input.business_name,
      business_email: input.business_email ?? null,
      business_phone: input.business_phone ?? null,
      business_address: input.business_address ?? null,
      created_at: now,
      updated_at: now,
    });
  } else {
    // For PATCH-style semantics: only overwrite fields that were provided.
    // `undefined` means "leave alone", `null` means "clear".
    const updates: Partial<BusinessProfile> & { updated_at: string } = {
      business_name: input.business_name,
      updated_at: now,
    };
    if (input.business_email !== undefined) {
      updates.business_email = input.business_email;
    }
    if (input.business_phone !== undefined) {
      updates.business_phone = input.business_phone;
    }
    if (input.business_address !== undefined) {
      updates.business_address = input.business_address;
    }

    await db
      .update(businessProfiles)
      .set(updates)
      .where(eq(businessProfiles.user_id, userId));
  }

  const after = await getBusinessProfile(db, userId);
  // Should be impossible: we just inserted/updated. Guard for type narrowing.
  if (!after) {
    throw new Error("Business profile vanished after upsert");
  }
  return after;
}
