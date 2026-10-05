import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authConfig } from "./config";

export async function createClient() {
  const config = authConfig();
  if (!config) throw new Error("Authentication is not configured.");
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
    cookies: {
      getAll: () => store.getAll(),
      setAll(values) {
        try {
          values.forEach(({ name, value, options }) =>
            store.set(name, value, options),
          );
        } catch {
          /* Server Components cannot set cookies; proxy refreshes them. */
        }
      },
    },
  });
}
