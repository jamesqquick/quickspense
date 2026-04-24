import { eq, and, asc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { categories } from "../db/schema.js";
import type { Category } from "../types.js";
import { ConflictError, NotFoundError } from "../errors.js";

export async function createCategory(
  db: Database,
  userId: string,
  name: string,
): Promise<Category> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await db.insert(categories).values({
      id,
      user_id: userId,
      name,
      created_at: now,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      throw new ConflictError(`Category '${name}' already exists`);
    }
    throw e;
  }

  return { id, user_id: userId, name, created_at: now };
}

export async function listCategories(
  db: Database,
  userId: string,
): Promise<Category[]> {
  return db
    .select()
    .from(categories)
    .where(eq(categories.user_id, userId))
    .orderBy(asc(categories.name));
}

export async function updateCategory(
  db: Database,
  categoryId: string,
  userId: string,
  name: string,
): Promise<Category> {
  try {
    const result = await db
      .update(categories)
      .set({ name })
      .where(and(eq(categories.id, categoryId), eq(categories.user_id, userId)));

    if (!result.meta.changes) {
      throw new NotFoundError("Category", categoryId);
    }
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
  return updated;
}

export async function deleteCategory(
  db: Database,
  categoryId: string,
  userId: string,
): Promise<void> {
  const result = await db
    .delete(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.user_id, userId)));

  if (!result.meta.changes) {
    throw new NotFoundError("Category", categoryId);
  }
}
