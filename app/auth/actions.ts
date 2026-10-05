"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authConfig, siteUrl } from "@/lib/supabase/config";

export type AuthState = { error?: string; message?: string };

export async function authenticate(
  _state: AuthState,
  form: FormData,
): Promise<AuthState> {
  if (!authConfig())
    return {
      error: "Account setup is not finished yet. Please try again shortly.",
    };
  const mode = String(form.get("mode") || "login");
  if (!["login", "signup", "forgot"].includes(mode))
    return { error: "Choose a valid sign-in option." };
  if (mode !== "login" && process.env.AUTH_EMAIL_ENABLED !== "true")
    return { error: "Email registration and recovery are not enabled yet. Contact the workspace owner for help." };
  const email = String(form.get("email") || "")
    .trim()
    .toLowerCase();
  const password = String(form.get("password") || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return { error: "Enter a valid email address." };
  if (mode !== "forgot" && (!password || password.length > 128))
    return { error: "Enter a password of no more than 128 characters." };
  if (mode === "signup" && password.length < 12)
    return { error: "Use at least 12 characters for your password." };
  if (
    mode === "signup" &&
    password !== String(form.get("confirmPassword") || "")
  )
    return { error: "The passwords do not match." };
  const supabase = await createClient();
  let signedIn = false;
  try {
    if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${siteUrl()}/auth/callback?next=reset`,
      });
      if (error && error.status === 429)
        return {
          error: "Too many attempts. Please wait a few minutes and try again.",
        };
      if (error && error.status && error.status >= 500)
        return {
          error:
            "We couldn't send a reset email right now. Please try again later.",
        };
      return {
        message:
          "If an account exists for this email, a password reset link will arrive shortly. Open it in this browser.",
      };
    }
    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${siteUrl()}/auth/callback` },
      });
      if (error)
        return {
          error:
            error.status === 429
              ? "Too many attempts. Please wait a few minutes and try again."
              : "We couldn't create your account. Try again, or sign in if you already have an account.",
        };
      signedIn = !!data.session;
      if (!signedIn)
        return {
          message:
            "Check your email to confirm your account, then come back to sign in. Open the confirmation link in this browser. If you already have an account, use sign in.",
        };
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error)
        return {
          error:
            error.status === 429
              ? "Too many attempts. Please wait a few minutes and try again."
              : "We couldn't sign you in. Check your email and password, and confirm your email if you just signed up.",
        };
      signedIn = true;
    }
  } catch {
    return {
      error: "We couldn't reach the sign-in service. Please try again.",
    };
  }
  if (signedIn) redirect("/");
  return {};
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}

export async function updatePassword(
  _state: AuthState,
  form: FormData,
): Promise<AuthState> {
  const password = String(form.get("password") || "");
  if (password.length < 12 || password.length > 128)
    return { error: "Use a password between 12 and 128 characters." };
  if (password !== String(form.get("confirmPassword") || ""))
    return { error: "The passwords do not match." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return {
      error:
        "This reset link has expired. Request a new one from the sign-in page.",
    };
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error)
      return {
        error:
          "We couldn't update your password. Try a different password or request a new reset link.",
      };
    await supabase.auth.signOut({ scope: "global" });
  } catch {
    return {
      error: "We couldn't reach the sign-in service. Please try again.",
    };
  }
  redirect("/login?updated=1");
}
