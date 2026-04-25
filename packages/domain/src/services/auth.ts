import { eq, and, desc, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  users,
  sessions,
  apiTokens,
  receipts,
  passwordResetTokens,
} from "../db/schema.js";
import type { User } from "../types.js";
import { ConflictError, NotFoundError } from "../errors.js";

/** Current iteration count. Cloudflare Workers limits PBKDF2 to 100,000 iterations. */
const PBKDF2_ITERATIONS = 100_000;
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
function parseHash(hash: string): {
  iterations: number;
  saltHex: string;
  keyHex: string;
} {
  const parts = hash.split(":");
  if (parts.length === 3) {
    return {
      iterations: parseInt(parts[0], 10),
      saltHex: parts[1],
      keyHex: parts[2],
    };
  }
  return { iterations: 100_000, saltHex: parts[0], keyHex: parts[1] };
}

async function deriveKeyHex(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
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
  db: Database,
  userId: string,
  password: string,
): Promise<void> {
  const newHash = await hashPassword(password);
  await db
    .update(users)
    .set({ password_hash: newHash })
    .where(eq(users.id, userId));
}

export async function createUser(
  db: Database,
  email: string,
  password: string,
): Promise<User> {
  const id = crypto.randomUUID();
  const password_hash = await hashPassword(password);

  try {
    await db.insert(users).values({
      id,
      email: email.toLowerCase(),
      password_hash,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      throw new ConflictError("Email already registered");
    }
    throw e;
  }

  return {
    id,
    email: email.toLowerCase(),
    password_hash,
    created_at: new Date().toISOString(),
  };
}

export async function getUserByEmail(
  db: Database,
  email: string,
): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()));
  return row ?? null;
}

export async function createSession(
  db: Database,
  userId: string,
): Promise<{ sessionId: string; expiresAt: string }> {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  await db.insert(sessions).values({
    id: sessionId,
    user_id: userId,
    expires_at: expiresAt,
  });

  return { sessionId, expiresAt };
}

export async function validateSession(
  db: Database,
  sessionId: string,
): Promise<{ user: User } | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      password_hash: users.password_hash,
      created_at: users.created_at,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.user_id, users.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        sql`${sessions.expires_at} > datetime('now')`,
      ),
    );

  if (!row) return null;
  return { user: row };
}

export async function deleteSession(
  db: Database,
  sessionId: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return bufferToHex(hash);
}

export async function createApiToken(
  db: Database,
  userId: string,
  name: string,
): Promise<{ token: string; tokenId: string }> {
  const tokenId = crypto.randomUUID();
  const rawToken = `qs_${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await sha256Hex(rawToken);

  await db.insert(apiTokens).values({
    id: tokenId,
    user_id: userId,
    token_hash: tokenHash,
    name,
  });

  return { token: rawToken, tokenId };
}

export async function validateApiToken(
  db: Database,
  rawToken: string,
): Promise<{ user: User } | null> {
  const tokenHash = await sha256Hex(rawToken);

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      password_hash: users.password_hash,
      created_at: users.created_at,
    })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.user_id, users.id))
    .where(eq(apiTokens.token_hash, tokenHash));

  if (!row) return null;
  return { user: row };
}

export async function listApiTokens(
  db: Database,
  userId: string,
): Promise<Array<{ id: string; name: string; created_at: string }>> {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      created_at: apiTokens.created_at,
    })
    .from(apiTokens)
    .where(eq(apiTokens.user_id, userId))
    .orderBy(desc(apiTokens.created_at));
}

export async function deleteApiToken(
  db: Database,
  tokenId: string,
  userId: string,
): Promise<void> {
  const result = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.user_id, userId)));
  if (!result.meta.changes) {
    throw new NotFoundError("API token", tokenId);
  }
}

// --- Password reset ---

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function createPasswordResetToken(
  db: Database,
  userId: string,
): Promise<{ token: string; expiresAt: string }> {
  const tokenId = crypto.randomUUID();
  const rawToken = `qsr_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  await db.insert(passwordResetTokens).values({
    id: tokenId,
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });

  return { token: rawToken, expiresAt };
}

export async function validatePasswordResetToken(
  db: Database,
  rawToken: string,
): Promise<{ userId: string; tokenId: string } | null> {
  const tokenHash = await sha256Hex(rawToken);

  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      user_id: passwordResetTokens.user_id,
      expires_at: passwordResetTokens.expires_at,
      used_at: passwordResetTokens.used_at,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.token_hash, tokenHash));

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  return { userId: row.user_id, tokenId: row.id };
}

export async function consumePasswordResetToken(
  db: Database,
  tokenId: string,
  userId: string,
  newPassword: string,
): Promise<void> {
  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();

  await db.batch([
    db
      .update(users)
      .set({ password_hash: newHash })
      .where(eq(users.id, userId)),
    db
      .update(passwordResetTokens)
      .set({ used_at: now })
      .where(eq(passwordResetTokens.id, tokenId)),
    db
      .update(passwordResetTokens)
      .set({ used_at: now })
      .where(
        and(
          eq(passwordResetTokens.user_id, userId),
          isNull(passwordResetTokens.used_at),
        ),
      ),
    db.delete(sessions).where(eq(sessions.user_id, userId)),
  ]);
}

export async function deleteUser(
  db: Database,
  userId: string,
): Promise<{ fileKeys: string[] }> {
  // Collect file keys before the cascade removes the receipts rows
  const rows = await db
    .select({ file_key: receipts.file_key })
    .from(receipts)
    .where(eq(receipts.user_id, userId));
  const fileKeys = rows.map((r) => r.file_key);

  const result = await db.delete(users).where(eq(users.id, userId));

  if (!result.meta.changes) {
    throw new NotFoundError("User", userId);
  }

  return { fileKeys };
}
