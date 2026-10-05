import "server-only";
import { notFound } from "next/navigation";
import { createClient } from "./supabase/server";
import { authConfig } from "./supabase/config";

/** Owner emails from ORBIT_ADMIN_EMAILS (comma-separated). Empty means no admins. */
function adminEmails() {
  return (process.env.ORBIT_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | undefined | null) {
  return !!email && adminEmails().includes(email.toLowerCase());
}

/**
 * The signed-in admin, or a 404 for everyone else so the page's existence
 * isn't revealed. Call at the top of every admin page and action.
 */
export async function requireAdmin() {
  if (!authConfig()) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdminEmail(user.email)) notFound();
  return user;
}
