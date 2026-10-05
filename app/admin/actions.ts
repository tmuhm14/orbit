"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdminResult = { error?: string; message?: string };

function client() {
  const admin = createAdminClient();
  if (!admin) throw new Error("SUPABASE_SECRET_KEY is not configured.");
  return admin;
}

const validEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
const validPassword = (password: string) =>
  password.length >= 12 && password.length <= 128;

/** Creates a confirmed account (sign-up is closed while email is off). */
export async function createUser(form: FormData): Promise<AdminResult> {
  await requireAdmin();
  const email = String(form.get("email") || "")
    .trim()
    .toLowerCase();
  const password = String(form.get("password") || "");
  if (!validEmail(email)) return { error: "Enter a valid email address." };
  if (!validPassword(password))
    return { error: "Use a temporary password of 12–128 characters." };
  const { error } = await client().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error)
    return {
      error: /already|registered|exists/i.test(error.message)
        ? "An account with that email already exists."
        : `Couldn't create the account: ${error.message}`,
    };
  revalidatePath("/admin");
  return {
    message: `Created ${email}. Share the temporary password privately.`,
  };
}

export async function setUserPassword(
  userId: string,
  password: string,
): Promise<AdminResult> {
  await requireAdmin();
  if (!validPassword(password))
    return { error: "Use a password of 12–128 characters." };
  const { error } = await client().auth.admin.updateUserById(userId, {
    password,
  });
  if (error) return { error: `Couldn't set the password: ${error.message}` };
  return { message: "Password set. Share it privately." };
}

/** Disabling bans sign-in and refreshes; existing sessions end within an hour. */
export async function setUserDisabled(
  userId: string,
  disabled: boolean,
): Promise<AdminResult> {
  const me = await requireAdmin();
  if (userId === me.id) return { error: "You can't disable your own account." };
  const { error } = await client().auth.admin.updateUserById(userId, {
    ban_duration: disabled ? "876000h" : "none",
  });
  if (error) return { error: `Couldn't update the account: ${error.message}` };
  revalidatePath("/admin");
  return { message: disabled ? "Account disabled." : "Account enabled." };
}
