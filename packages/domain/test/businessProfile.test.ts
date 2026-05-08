import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createDb } from "../src/db/index.js";
import * as auth from "../src/services/auth.js";
import * as businessProfiles from "../src/services/businessProfile.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS business_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  business_email TEXT,
  business_phone TEXT,
  business_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

async function resetDb() {
  await env.DB.prepare("DROP TABLE IF EXISTS business_profiles").run();
  await env.DB.prepare("DROP TABLE IF EXISTS users").run();
  for (const stmt of SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
}

describe("businessProfiles", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns null when no profile exists", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    const profile = await businessProfiles.getBusinessProfile(db, user.id);
    expect(profile).toBeNull();
  });

  it("creates a profile on first upsert", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    const created = await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "Acme Consulting",
      business_email: "billing@acme.test",
      business_phone: "+1 555 1234",
      business_address: "1 Main St\nAustin, TX",
    });

    expect(created.user_id).toBe(user.id);
    expect(created.business_name).toBe("Acme Consulting");
    expect(created.business_email).toBe("billing@acme.test");
    expect(created.business_phone).toBe("+1 555 1234");
    expect(created.business_address).toBe("1 Main St\nAustin, TX");
    expect(created.created_at).toBeTruthy();
    expect(created.updated_at).toBeTruthy();

    const refetched = await businessProfiles.getBusinessProfile(db, user.id);
    expect(refetched?.business_name).toBe("Acme Consulting");
  });

  it("creates a profile with only required fields", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    const created = await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "Solo Freelancer",
    });

    expect(created.business_name).toBe("Solo Freelancer");
    expect(created.business_email).toBeNull();
    expect(created.business_phone).toBeNull();
    expect(created.business_address).toBeNull();
  });

  it("updates an existing profile (overwrites provided fields)", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "Old Name",
      business_email: "old@test.com",
      business_phone: "111",
    });

    const updated = await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "New Name",
      business_email: "new@test.com",
      business_phone: "222",
      business_address: "Brand new address",
    });

    expect(updated.business_name).toBe("New Name");
    expect(updated.business_email).toBe("new@test.com");
    expect(updated.business_phone).toBe("222");
    expect(updated.business_address).toBe("Brand new address");
  });

  it("leaves omitted optional fields unchanged on update", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "Acme",
      business_email: "billing@acme.test",
      business_phone: "555-1234",
      business_address: "1 Main St",
    });

    // Only sending business_name; other fields should be preserved.
    const updated = await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "Acme LLC",
    });

    expect(updated.business_name).toBe("Acme LLC");
    expect(updated.business_email).toBe("billing@acme.test");
    expect(updated.business_phone).toBe("555-1234");
    expect(updated.business_address).toBe("1 Main St");
  });

  it("clears optional fields when explicitly set to null", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "Acme",
      business_email: "billing@acme.test",
      business_phone: "555-1234",
      business_address: "1 Main St",
    });

    const updated = await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "Acme",
      business_email: null,
      business_phone: null,
      business_address: null,
    });

    expect(updated.business_email).toBeNull();
    expect(updated.business_phone).toBeNull();
    expect(updated.business_address).toBeNull();
  });

  it("scopes profiles by user", async () => {
    const db = createDb(env.DB);
    const userA = await auth.createUser(db, "a@test.com", "password123");
    const userB = await auth.createUser(db, "b@test.com", "password123");

    await businessProfiles.upsertBusinessProfile(db, userA.id, {
      business_name: "A Inc",
    });
    await businessProfiles.upsertBusinessProfile(db, userB.id, {
      business_name: "B Inc",
    });

    const a = await businessProfiles.getBusinessProfile(db, userA.id);
    const b = await businessProfiles.getBusinessProfile(db, userB.id);
    expect(a?.business_name).toBe("A Inc");
    expect(b?.business_name).toBe("B Inc");
  });

  it("cascades when the user is deleted", async () => {
    const db = createDb(env.DB);
    const user = await auth.createUser(db, "user@test.com", "password123");

    await businessProfiles.upsertBusinessProfile(db, user.id, {
      business_name: "Acme",
    });

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();

    const profile = await businessProfiles.getBusinessProfile(db, user.id);
    expect(profile).toBeNull();
  });
});
