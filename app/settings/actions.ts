"use server";

import { createClient } from "@/lib/supabase/server";

export type PasswordState = { error?: string; message?: string };

export async function changePassword(
  _state: PasswordState,
  form: FormData,
): Promise<PasswordState> {
  const current = String(form.get("current") || "");
  const next = String(form.get("password") || "");
  if (next.length < 12 || next.length > 128)
    return { error: "Use a new password between 12 and 128 characters." };
  if (next !== String(form.get("confirmPassword") || ""))
    return { error: "The new passwords do not match." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: "Your session has ended. Sign in again." };
  // Re-check the current password so an unattended session can't change it.
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: current,
  });
  if (verifyError)
    return {
      error:
        verifyError.status === 429
          ? "Too many attempts. Please wait a few minutes."
          : "Your current password is incorrect.",
    };
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error)
    return { error: "We couldn't update your password. Try a different one." };
  return { message: "Password updated." };
}
