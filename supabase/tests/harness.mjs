import { readFileSync, readdirSync } from "node:fs";

// Disposable in-process Postgres (PGlite) with minimal stand-ins for what
// Supabase provides, for the migration tests. PGlite is not a dependency;
// suites skip unless it is installed locally:
//   npm install --no-save @electric-sql/pglite && npm test
// Never point these tests at a real project database.
export const pglite = await import("@electric-sql/pglite").catch(() => null);
export const skip = pglite ? false : "PGlite not installed (npm install --no-save @electric-sql/pglite)";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
export const migrationFiles = () =>
  readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

/** A fresh database with the Supabase stand-ins and no migrations yet. */
export async function createDb() {
  const db = new pglite.PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  return db;
}

/** Applies migrations in filename order; `until` excludes it and later ones. */
export async function migrate(db, { from, until } = {}) {
  for (const file of migrationFiles()) {
    if (from && file < from) continue;
    if (until && file >= until) break;
    await db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
}

/** Runs one statement as a role, with auth.uid() set to `user`. */
export async function as(db, role, user, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ""}', false); set role ${role};`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role;");
  }
}
