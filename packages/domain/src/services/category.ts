import { eq, and, asc, or, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { categories } from "../db/schema.js";
import type { Category } from "../types.js";
import { ConflictError, NotFoundError, ForbiddenError } from "../errors.js";

export const DEFAULT_CATEGORIES = [
  "Food & Dining",
  "Groceries",
  "Transportation",
  "Shopping",
  "Entertainment",
  "Healthcare",
  "Utilities",
  "Housing",
  "Insurance",
  "Education",
  "Personal Care",
  "Travel",
  "Subscriptions",
  "Gifts & Donations",
  "Automotive",
  "Home & Garden",
  "Pets",
  "Office & Business",
  "Taxes & Fees",
  "Other",
] as const;

/**
 * Seed the global default categories (no user_id, is_global = true).
 * Skips any that already exist. Safe to call multiple times.
 */
export async function seedGlobalCategories(
  db: Database,
): Promise<Category[]> {
  const now = new Date().toISOString();
  const seeded: Category[] = [];

  for (const name of DEFAULT_CATEGORIES) {
    const id = crypto.randomUUID();
    try {
      await db.insert(categories).values({
        id,
        user_id: null,
        name,
        is_global: true,
        created_at: now,
      });
      seeded.push({ id, user_id: null, name, is_global: true, created_at: now });
    } catch (e: unknown) {
      // Skip duplicates (global category already exists)
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        continue;
      }
      throw e;
    }
  }

  return seeded;
}

/**
 * Create a custom (user-owned) category.
 */
export async function createCategory(
  db: Database,
  userId: string,
  name: string,
): Promise<Category> {
  // Check if a global category with the same name already exists
  const [existing] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.is_global, true)));

  if (existing) {
    throw new ConflictError(
      `A global category '${name}' already exists. You can use it directly.`,
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await db.insert(categories).values({
      id,
      user_id: userId,
      name,
      is_global: false,
      created_at: now,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      throw new ConflictError(`Category '${name}' already exists`);
    }
    throw e;
  }

  return { id, user_id: userId, name, is_global: false, created_at: now };
}

/**
 * List all categories visible to a user: global + user's custom categories.
 */
export async function listCategories(
  db: Database,
  userId: string,
): Promise<Category[]> {
  return db
    .select()
    .from(categories)
    .where(
      or(
        eq(categories.is_global, true),
        eq(categories.user_id, userId),
      ),
    )
    .orderBy(asc(categories.name)) as Promise<Category[]>;
}

/**
 * Update a user-owned category. Global categories cannot be edited by users.
 */
export async function updateCategory(
  db: Database,
  categoryId: string,
  userId: string,
  name: string,
): Promise<Category> {
  // Check if this is a global category
  const [cat] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId));

  if (!cat) throw new NotFoundError("Category", categoryId);
  if (cat.is_global) throw new ForbiddenError("Global categories cannot be edited");
  if (cat.user_id !== userId) throw new NotFoundError("Category", categoryId);

  try {
    await db
      .update(categories)
      .set({ name })
      .where(eq(categories.id, categoryId));
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      throw new ConflictError(`Category '${name}' already exists`);
    }
    throw e;
  }

  const [updated] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId));
  if (!updated) throw new NotFoundError("Category", categoryId);
  return updated as Category;
}

/**
 * Delete a user-owned category. Global categories cannot be deleted by users.
 */
export async function deleteCategory(
  db: Database,
  categoryId: string,
  userId: string,
): Promise<void> {
  // Check if this is a global category
  const [cat] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId));

  if (!cat) throw new NotFoundError("Category", categoryId);
  if (cat.is_global) throw new ForbiddenError("Global categories cannot be deleted");
  if (cat.user_id !== userId) throw new NotFoundError("Category", categoryId);

  await db.delete(categories).where(eq(categories.id, categoryId));
}
