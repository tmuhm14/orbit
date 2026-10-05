"use client";

import { useActionState, useState, useEffect } from "react";
import Link from "next/link";
import {
  Orbit,
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  Mail,
  LockKeyhole,
} from "lucide-react";
import {
  authenticate,
  updatePassword,
  type AuthState,
} from "@/app/auth/actions";
import { announceAuthChange } from "@/lib/session";

type Mode = "login" | "signup" | "forgot" | "reset";
export function AuthForm({
  configured,
  emailEnabled = false,
  initialMode = "login",
  initialMessage,
  initialError,
}: {
  configured: boolean;
  emailEnabled?: boolean;
  initialMode?: Mode;
  initialMessage?: string;
  initialError?: string;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  useEffect(announceAuthChange, []);
  return (
    <main className="auth-page">
      <div className="auth-orbits" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <Link href="/login" className="auth-brand">
        <Orbit size={32} strokeWidth={1.4} />
        <span>orbit.</span>
      </Link>
      <div className="auth-layout">
        <section className="auth-intro">
          <div className="eyebrow">A LITTLE ROOM TO THINK</div>
          <h1>
            Your thoughts.
            <br />
            Your space.
            <br />
            <span>Your orbit.</span>
          </h1>
          <p>
            A calmer place to capture what’s on your mind
            <br />
            and make room for what comes next.
          </p>
          <div className="auth-intro-foot">
            <span />
            One thought at a time.
          </div>
        </section>
        <section className="auth-card">
          <AuthFields
            key={mode}
            mode={mode}
            setMode={setMode}
            configured={configured}
            emailEnabled={emailEnabled}
            initialMessage={mode === initialMode ? initialMessage : undefined}
            initialError={mode === initialMode ? initialError : undefined}
          />
        </section>
      </div>
      <footer className="auth-footer">
        A place for your thoughts. Space for your life.
      </footer>
    </main>
  );
}
function AuthFields({
  mode,
  setMode,
  configured,
  emailEnabled = false,
  initialMessage,
  initialError,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
  configured: boolean;
  emailEnabled?: boolean;
  initialMessage?: string;
  initialError?: string;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [state, action, pending] = useActionState<AuthState, FormData>(
    mode === "reset" ? updatePassword : authenticate,
    { message: initialMessage, error: initialError },
  );
  const labels = {
    login: {
      title: "Welcome back",
      subtitle: "Sign in to your personal workspace.",
      button: "Sign in",
    },
    signup: {
      title: "Make yourself some space",
      subtitle: "Create your Orbit account.",
      button: "Create account",
    },
    forgot: {
      title: "Let’s get you back in",
      subtitle: "We’ll send you a link to reset your password.",
      button: "Send reset link",
    },
    reset: {
      title: "A fresh start",
      subtitle: "Choose a new password for your account.",
      button: "Save new password",
    },
  }[mode];
  return (
    <>
      <div className="auth-card-icon">
        <Orbit size={26} strokeWidth={1.3} />
      </div>
      <h2>{labels.title}</h2>
      <p className="auth-subtitle">{labels.subtitle}</p>
      {!configured && (
        <div className="auth-notice" role="status">
          Account setup is in progress. Sign-in will be available shortly.
        </div>
      )}
      <form action={action} className="auth-form">
        <input type="hidden" name="mode" value={mode} />
        {mode !== "reset" && (
          <label htmlFor="email">
            Email address
            <div className="auth-input">
              <Mail size={17} />
              <input
                autoFocus
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                maxLength={254}
                disabled={pending || !configured}
              />
            </div>
          </label>
        )}
        {mode !== "forgot" && (
          <label htmlFor="password">
            {mode === "reset" ? "New password" : "Password"}
            <div className="auth-input">
              <LockKeyhole size={17} />
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                placeholder={
                  mode === "login" ? "Your password" : "At least 12 characters"
                }
                required
                minLength={mode === "login" ? 1 : 12}
                maxLength={128}
                disabled={pending || !configured}
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </label>
        )}
        {(mode === "signup" || mode === "reset") && (
          <label htmlFor="confirmPassword">
            Confirm password
            <div className="auth-input">
              <LockKeyhole size={17} />
              <input
                id="confirmPassword"
                name="confirmPassword"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder="Enter your password again"
                required
                minLength={12}
                maxLength={128}
                disabled={pending || !configured}
              />
            </div>
          </label>
        )}
        {mode === "login" && emailEnabled && (
          <button
            className="auth-forgot"
            type="button"
            onClick={() => setMode("forgot")}
            disabled={pending}
          >
            Forgot your password?
          </button>
        )}
        {state.error && (
          <p className="auth-error" role="alert">
            {state.error}
          </p>
        )}
        {state.message && (
          <p className="auth-notice" role="status">
            {state.message}
          </p>
        )}
        <button
          className="auth-submit"
          type="submit"
          disabled={pending || !configured}
        >
          {pending ? (
            <>
              <LoaderCircle className="auth-spinner" size={17} />
              One moment…
            </>
          ) : (
            <>
              {labels.button}
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </form>
      <div className="auth-switch">
        {!emailEnabled ? (
          <p>
            Accounts are created by the workspace owner. Contact them for access
            or password help.
          </p>
        ) : mode === "login" ? (
          <>
            New here?{" "}
            <button onClick={() => setMode("signup")} disabled={pending}>
              Create an account
            </button>
          </>
        ) : mode === "signup" ? (
          <>
            Already have an account?{" "}
            <button onClick={() => setMode("login")} disabled={pending}>
              Sign in
            </button>
          </>
        ) : (
          <button onClick={() => setMode("login")} disabled={pending}>
            Back to sign in
          </button>
        )}
      </div>
      <p className="auth-storage-note">
        Your notes currently stay in this browser, separated by account.
        Cross-device sync is coming next.
      </p>
    </>
  );
}
