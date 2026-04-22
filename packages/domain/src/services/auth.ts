import type { User } from "../types.js";
import { ConflictError, NotFoundError, UnauthorizedError } from "../errors.js";

/** Current iteration count. OWASP 2024 recommendation for PBKDF2-SHA256. */
const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

function bufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

/**
 * Hash format: `iterations:saltHex:keyHex`
 * Legacy format (no iteration prefix): `saltHex:keyHex` -- treated as 100,000 iterations.
 */
function parseHash(hash: string): { iterations: number; saltHex: string; keyHex: string } {
  const parts = hash.split(":");
  if (parts.length === 3) {
    return { iterations: parseInt(parts[0], 10), saltHex: parts[1], keyHex: parts[2] };
  }
  // Legacy hash from before iteration count was embedded
  return { iterations: 100_000, saltHex: parts[0], keyHex: parts[1] };
}

async function deriveKeyHex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  return bufferToHex(derivedBits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const keyHex = await deriveKeyHex(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_ITERATIONS}:${bufferToHex(salt.buffer)}:${keyHex}`;
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const { iterations, saltHex, keyHex } = parseHash(hash);
  const salt = new Uint8Array(hexToBuffer(saltHex));
  const derivedHex = await deriveKeyHex(password, salt, iterations);
  return derivedHex === keyHex;
}

/** Returns true if the stored hash uses fewer iterations than the current standard. */
export function needsRehash(hash: string): boolean {
  const { iterations } = parseHash(hash);
  return iterations < PBKDF2_ITERATIONS;
}

/** Re-hash password and update the user's stored hash. Called during login if needsRehash(). */
export async function upgradePasswordHash(
  db: D1Database,
  userId: string,
  password: string,
): Promise<void> {
  const newHash = await hashPassword(password);
  await db
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(newHash, userId)
    .run();
}

export async function createUser(
  db: D1Database,
  email: string,
  password: string,
): Promise<User> {
  const id = crypto.randomUUID();
  const password_hash = await hashPassword(password);

  try {
    await db
      .prepare(
        "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
      )
      .bind(id, email.toLowerCase(), password_hash)
      .run();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      throw new ConflictError("Email already registered");
    }
    throw e;
  }

  return { id, email: email.toLowerCase(), password_hash, created_at: new Date().toISOString() };
}

export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<User | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<User>();
  return row ?? null;
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ sessionId: string; expiresAt: string }> {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(sessionId, userId, expiresAt)
    .run();

  return { sessionId, expiresAt };
}

export async function validateSession(
  db: D1Database,
  sessionId: string,
): Promise<{ user: User } | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.password_hash, u.created_at
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .bind(sessionId)
    .first<User>();

  if (!row) return null;
  return { user: row };
}

export async function deleteSession(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM sessions WHERE id = ?")
    .bind(sessionId)
    .run();
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return bufferToHex(hash);
}

export async function createApiToken(
  db: D1Database,
  userId: string,
  name: string,
): Promise<{ token: string; tokenId: string }> {
  const tokenId = crypto.randomUUID();
  const rawToken = `qs_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await sha256Hex(rawToken);

  await db
    .prepare(
      "INSERT INTO api_tokens (id, user_id, token_hash, name) VALUES (?, ?, ?, ?)",
    )
    .bind(tokenId, userId, tokenHash, name)
    .run();

  return { token: rawToken, tokenId };
}

export async function validateApiToken(
  db: D1Database,
  rawToken: string,
): Promise<{ user: User } | null> {
  const tokenHash = await sha256Hex(rawToken);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.password_hash, u.created_at
       FROM api_tokens t JOIN users u ON t.user_id = u.id
       WHERE t.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<User>();

  if (!row) return null;
  return { user: row };
}

export async function listApiTokens(
  db: D1Database,
  userId: string,
): Promise<Array<{ id: string; name: string; created_at: string }>> {
  const { results } = await db
    .prepare("SELECT id, name, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<{ id: string; name: string; created_at: string }>();
  return results;
}

export async function deleteApiToken(
  db: D1Database,
  tokenId: string,
  userId: string,
): Promise<void> {
  const result = await db
    .prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
    .bind(tokenId, userId)
    .run();
  if (!result.meta.changes) {
    throw new NotFoundError("API token", tokenId);
  }
}

// --- Password reset ---

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Create a password reset token for a user.
 * Returns the raw token (shown once in the email link) and the token ID.
 * The hash is stored, not the raw token.
 */
export async function createPasswordResetToken(
  db: D1Database,
  userId: string,
): Promise<{ token: string; expiresAt: string }> {
  const tokenId = crypto.randomUUID();
  const rawToken = `qsr_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  await db
    .prepare(
      "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(tokenId, userId, tokenHash, expiresAt)
    .run();

  return { token: rawToken, expiresAt };
}

/**
 * Validate a raw reset token. Returns the associated userId if valid and unused,
 * null otherwise. Does not mark the token as used -- call consumePasswordResetToken
 * after the password has actually been updated.
 */
export async function validatePasswordResetToken(
  db: D1Database,
  rawToken: string,
): Promise<{ userId: string; tokenId: string } | null> {
  const tokenHash = await sha256Hex(rawToken);
  const row = await db
    .prepare(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens
       WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  return { userId: row.user_id, tokenId: row.id };
}

/**
 * Consume a password reset token: update the user's password hash and mark
 * the token as used. Also deletes all other active reset tokens for the user
 * and invalidates all existing sessions.
 */
export async function consumePasswordResetToken(
  db: D1Database,
  tokenId: string,
  userId: string,
  newPassword: string,
): Promise<void> {
  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();

  await db.batch([
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(newHash, userId),
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").bind(now, tokenId),
    // Invalidate all other reset tokens for this user
    db
      .prepare(
        "UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
      )
      .bind(now, userId),
    // Invalidate all existing sessions so the user must log in with the new password
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);
}

/**
 * Delete a user and all their data.
 *
 * Returns the list of R2 file keys that belonged to the user so the caller
 * can delete the objects from R2. D1 rows are cascaded via ON DELETE CASCADE
 * constraints on the sessions, api_tokens, categories, receipts, parsed_receipts,
 * and expenses tables.
 */
export async function deleteUser(
  db: D1Database,
  userId: string,
): Promise<{ fileKeys: string[] }> {
  // Collect file keys before the cascade removes the receipts rows
  const { results } = await db
    .prepare("SELECT file_key FROM receipts WHERE user_id = ?")
    .bind(userId)
    .all<{ file_key: string }>();
  const fileKeys = results.map((r) => r.file_key);

  // The cascade takes care of sessions, api_tokens, categories, receipts,
  // parsed_receipts (via receipts cascade), and expenses.
  const result = await db
    .prepare("DELETE FROM users WHERE id = ?")
    .bind(userId)
    .run();

  if (!result.meta.changes) {
    throw new NotFoundError("User", userId);
  }

  return { fileKeys };
}
