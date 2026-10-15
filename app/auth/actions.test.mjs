import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "../../tests/load-ts.mjs";

// Loads the actions with a fake Supabase auth client and a redirect that
// records its target instead of throwing.
function load(signIn) {
  const redirects = [];
  const actions = loadTs(new URL("./actions.ts", import.meta.url), {
    "next/navigation": { redirect: (url) => redirects.push(url) },
    "@/lib/supabase/server": {
      createClient: async () => ({ auth: { signInWithPassword: signIn } }),
    },
    "@/lib/supabase/config": {
      authConfig: () => ({ url: "https://example.supabase.co", key: "anon" }),
      siteUrl: () => "http://localhost:3000",
    },
  });
  return { actions, redirects };
}
function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
const credentials = { mode: "login", email: "Someone@Example.com ", password: "secret" };

test("a successful sign-in returns signedIn instead of redirecting inside the action", async () => {
  const seen = [];
  const { actions, redirects } = load(async (input) => (seen.push(input), { error: null }));
  assert.deepEqual(await actions.authenticate({}, form(credentials)), { signedIn: true });
  assert.deepEqual(redirects, []);
  assert.deepEqual(seen, [{ email: "someone@example.com", password: "secret" }]);
});

test("a wrong password or rate limit keeps the user on the sign-in form", async () => {
  for (const [status, pattern] of [[400, /couldn't sign you in/], [429, /Too many attempts/]]) {
    const { actions, redirects } = load(async () => ({ error: { status } }));
    const state = await actions.authenticate({}, form(credentials));
    assert.match(state.error, pattern);
    assert.equal(state.signedIn, undefined);
    assert.deepEqual(redirects, []);
  }
});

test("an unreachable sign-in service is reported without signing in", async () => {
  const { actions } = load(async () => {
    throw new Error("network");
  });
  const state = await actions.authenticate({}, form(credentials));
  assert.match(state.error, /couldn't reach the sign-in service/);
  assert.equal(state.signedIn, undefined);
});
