// Opt-in provider + server-route checks. Creates and deletes only a disposable test account.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
assert.equal(
  process.env.ORBIT_AUTH_INTEGRATION,
  "1",
  "Set ORBIT_AUTH_INTEGRATION=1 to run against the configured Supabase project.",
);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const secret =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url && key && secret, "Supabase test configuration required.");
const base = process.env.ORBIT_TEST_URL || "http://localhost:3000";
const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = `orbit-auth-test-${randomUUID()}@example.com`;
const password = randomUUID() + randomUUID();
const jar = new Map();
const auth = createServerClient(url, key, {
  cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (values) =>
      values.forEach(({ name, value }) => {
        if (value) jar.set(name, value);
        else jar.delete(name);
      }),
  },
});
const cookie = () =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
let userId;
try {
  const anonymous = await fetch(base, { redirect: "manual" });
  assert.equal(anonymous.status, 307);
  assert.equal(
    new URL(anonymous.headers.get("location"), base).pathname,
    "/login",
  );
  assert.equal((await fetch(base + "/auth/session")).status, 401);
  assert.equal(
    (await fetch(base + "/auth/reset-password", { redirect: "manual" })).status,
    307,
  );
  console.log(
    "PASS: workspace, session endpoint, and password reset are protected",
  );
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.equal(
    error?.message,
    undefined,
    "Could not provision the disposable test account.",
  );
  userId = data.user.id;
  const invalid = await auth.auth.signInWithPassword({
    email,
    password: "incorrect-password",
  });
  assert.ok(invalid.error);
  const valid = await auth.auth.signInWithPassword({ email, password });
  assert.equal(
    valid.error?.message,
    undefined,
    "Provider rejected valid test credentials.",
  );
  const session = await fetch(base + "/auth/session", {
    headers: { cookie: cookie() },
  });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).userId, userId);
  const workspace = await fetch(base, {
    headers: { cookie: cookie() },
    redirect: "manual",
  });
  assert.equal(workspace.status, 200);
  assert.match(await workspace.text(), /Your buckets/);
  assert.match(workspace.headers.get("cache-control"), /no-store/);
  console.log(
    "PASS: invalid credentials rejected; verified session unlocks the correct workspace",
  );
  const forged = [...jar].map(([name]) => `${name}=forged`).join("; ");
  assert.equal(
    (await fetch(base + "/auth/session", { headers: { cookie: forged } }))
      .status,
    401,
  );
  await auth.auth.signOut({ scope: "local" });
  assert.equal(jar.size, 0);
  assert.equal(
    (await fetch(base + "/auth/session", { headers: { cookie: cookie() } }))
      .status,
    401,
  );
  console.log("PASS: forged cookies rejected and signed-out sessions denied");
} finally {
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    assert.equal(
      error?.message,
      undefined,
      "Disposable account cleanup failed.",
    );
    console.log("Disposable test account removed.");
  }
}
