import type { Receipt, ReceiptStatus } from "../types.js";
import { NotFoundError, InvalidStateTransitionError } from "../errors.js";

const VALID_TRANSITIONS: Record<ReceiptStatus, ReceiptStatus[]> = {
  // `uploaded -> failed` covers the case where the workflow trigger itself fails
  // (e.g. Service Binding unavailable) before the workflow runs.
  uploaded: ["processing", "failed"],
  processing: ["needs_review", "failed"],
  needs_review: ["processing", "finalized"],
  finalized: [],
  failed: ["processing"],
};

export async function createReceipt(
  db: D1Database,
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

  await db
    .prepare(
      `INSERT INTO receipts (id, user_id, file_key, file_name, file_size, file_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`,
    )
    .bind(id, params.userId, params.fileKey, params.fileName, params.fileSize, params.fileType, now, now)
    .run();

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
  db: D1Database,
  receiptId: string,
  userId?: string,
): Promise<Receipt | null> {
  const sql = userId
    ? "SELECT * FROM receipts WHERE id = ? AND user_id = ?"
    : "SELECT * FROM receipts WHERE id = ?";
  const stmt = userId
    ? db.prepare(sql).bind(receiptId, userId)
    : db.prepare(sql).bind(receiptId);
  const row = await stmt.first<Receipt>();
  return row ?? null;
}

export async function listReceipts(
  db: D1Database,
  userId: string,
  opts: { status?: ReceiptStatus; limit?: number; offset?: number } = {},
): Promise<Receipt[]> {
  const { status, limit = 20, offset = 0 } = opts;

  if (status) {
    const { results } = await db
      .prepare(
        "SELECT * FROM receipts WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .bind(userId, status, limit, offset)
      .all<Receipt>();
    return results;
  }

  const { results } = await db
    .prepare(
      "SELECT * FROM receipts WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    )
    .bind(userId, limit, offset)
    .all<Receipt>();
  return results;
}

export async function updateReceiptStatus(
  db: D1Database,
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
    .prepare(
      "UPDATE receipts SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(newStatus, errorMessage ?? null, receiptId)
    .run();
}

export async function updateReceiptWorkflowId(
  db: D1Database,
  receiptId: string,
  workflowId: string,
): Promise<void> {
  await db
    .prepare("UPDATE receipts SET workflow_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(workflowId, receiptId)
    .run();
}

export async function countReceiptsByStatus(
  db: D1Database,
  userId: string,
): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      "SELECT status, COUNT(*) as count FROM receipts WHERE user_id = ? GROUP BY status",
    )
    .bind(userId)
    .all<{ status: string; count: number }>();

  const counts: Record<string, number> = {};
  for (const row of results) {
    counts[row.status] = row.count;
  }
  return counts;
}
