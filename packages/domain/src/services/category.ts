import type { Category } from "../types.js";
import { ConflictError, NotFoundError } from "../errors.js";

export async function createCategory(
  db: D1Database,
  userId: string,
  name: string,
): Promise<Category> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await db
      .prepare(
        "INSERT INTO categories (id, user_id, name, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(id, userId, name, now)
      .run();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      throw new ConflictError(`Category '${name}' already exists`);
    }
    throw e;
  }

  return { id, user_id: userId, name, created_at: now };
}

export async function listCategories(
  db: D1Database,
  userId: string,
): Promise<Category[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM categories WHERE user_id = ? ORDER BY name ASC",
    )
    .bind(userId)
    .all<Category>();
  return results;
}

export async function updateCategory(
  db: D1Database,
  categoryId: string,
  userId: string,
  name: string,
): Promise<Category> {
  try {
    const result = await db
      .prepare(
        "UPDATE categories SET name = ? WHERE id = ? AND user_id = ?",
      )
      .bind(name, categoryId, userId)
      .run();

    if (!result.meta.changes) {
      throw new NotFoundError("Category", categoryId);
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      throw new ConflictError(`Category '${name}' already exists`);
    }
    throw e;
  }

  const updated = await db
    .prepare("SELECT * FROM categories WHERE id = ?")
    .bind(categoryId)
    .first<Category>();
  if (!updated) throw new NotFoundError("Category", categoryId);
  return updated;
}

export async function deleteCategory(
  db: D1Database,
  categoryId: string,
  userId: string,
): Promise<void> {
  const result = await db
    .prepare("DELETE FROM categories WHERE id = ? AND user_id = ?")
    .bind(categoryId, userId)
    .run();

  if (!result.meta.changes) {
    throw new NotFoundError("Category", categoryId);
  }
}
