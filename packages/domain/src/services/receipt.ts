import { eq, and, desc, sql, count } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { receipts } from "../db/schema.js";
import type { Receipt, ReceiptStatus, PaginatedResult } from "../types.js";
import { NotFoundError, InvalidStateTransitionError } from "../errors.js";

const VALID_TRANSITIONS: Record<ReceiptStatus, ReceiptStatus[]> = {
  uploaded: ["processing", "failed"],
  processing: ["needs_review", "failed"],
  needs_review: ["processing", "finalized"],
  finalized: [],
  failed: ["processing"],
};

export async function createReceipt(
  db: Database,
  params: {
    userId: string;
    fileKey: string;
    fileName: string;
    fileSize: number;
    fileType: string;
  },
): Promise<Receipt> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(receipts).values({
    id,
    user_id: params.userId,
    file_key: params.fileKey,
    file_name: params.fileName,
    file_size: params.fileSize,
    file_type: params.fileType,
    status: "uploaded",
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    user_id: params.userId,
    file_key: params.fileKey,
    file_name: params.fileName,
    file_size: params.fileSize,
    file_type: params.fileType,
    status: "uploaded",
    error_message: null,
    workflow_id: null,
    created_at: now,
    updated_at: now,
  };
}

export async function getReceipt(
  db: Database,
  receiptId: string,
  userId?: string,
): Promise<Receipt | null> {
  const conditions = userId
    ? and(eq(receipts.id, receiptId), eq(receipts.user_id, userId))
    : eq(receipts.id, receiptId);

  const [row] = await db.select().from(receipts).where(conditions);
  return (row as Receipt | undefined) ?? null;
}

export async function listReceipts(
  db: Database,
  userId: string,
  opts: { status?: ReceiptStatus; limit?: number; offset?: number } = {},
): Promise<PaginatedResult<Receipt>> {
  const { status, limit = 20, offset = 0 } = opts;

  const where = status
    ? and(eq(receipts.user_id, userId), eq(receipts.status, status))
    : eq(receipts.user_id, userId);

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(receipts)
      .where(where)
      .orderBy(desc(receipts.updated_at))
      .limit(limit)
      .offset(offset) as Promise<Receipt[]>,
    db
      .select({ total: count() })
      .from(receipts)
      .where(where),
  ]);

  return { items, total, limit, offset };
}

export async function updateReceiptStatus(
  db: Database,
  receiptId: string,
  newStatus: ReceiptStatus,
  errorMessage?: string,
): Promise<void> {
  const receipt = await getReceipt(db, receiptId);
  if (!receipt) throw new NotFoundError("Receipt", receiptId);

  const allowed = VALID_TRANSITIONS[receipt.status];
  if (!allowed.includes(newStatus)) {
    throw new InvalidStateTransitionError(receipt.status, newStatus);
  }

  await db
    .update(receipts)
    .set({
      status: newStatus,
      error_message: errorMessage ?? null,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(receipts.id, receiptId));
}

export async function updateReceiptWorkflowId(
  db: Database,
  receiptId: string,
  workflowId: string,
): Promise<void> {
  await db
    .update(receipts)
    .set({
      workflow_id: workflowId,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(receipts.id, receiptId));
}

export async function countReceiptsByStatus(
  db: Database,
  userId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      status: receipts.status,
      count: count(),
    })
    .from(receipts)
    .where(eq(receipts.user_id, userId))
    .groupBy(receipts.status);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

/**
 * Directly finalize a receipt without state transition validation.
 * Used by finalize endpoints that have already validated the transition is valid.
 */
export async function finalizeReceipt(
  db: Database,
  receiptId: string,
): Promise<void> {
  await db
    .update(receipts)
    .set({
      status: "finalized",
      updated_at: sql`datetime('now')`,
    })
    .where(eq(receipts.id, receiptId));
}
