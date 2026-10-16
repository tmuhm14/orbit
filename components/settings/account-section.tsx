"use client";

import { startTransition, useActionState, useState } from "react";
import { KeyRound, LogOut, Mail } from "lucide-react";
import { signOut, updatePassword, type AuthState } from "@/app/auth/actions";
import { FormDialog } from "../side-panel";

/**
 * Change password in a short dialog. It uses the same server action as the
 * reset-password page: a new password signs you out on every device and
 * returns you to sign in.
 */
function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [state, action, pending] = useActionState<AuthState, FormData>(updatePassword, {});
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = !!confirm && password !== confirm;
  const short = !!password && password.length < 12;
  return (
    <FormDialog
      title="Change password"
      description="Use at least 12 characters. Saving signs you out on every device, so you’ll sign in again with the new password."
      onClose={onClose}
      dirty={!!(password || confirm)}
      busy={pending}
      error={state.error}
      submitLabel="Change password"
      busyLabel="Changing…"
      submitDisabled={!password || short || mismatch}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        startTransition(() => action(form));
      }}
    >
      <div className="settings-fields">
        <label className="settings-field">
          New password
          <input data-autofocus name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128}
            value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={short ? "password-short" : undefined} required />
        </label>
        {short && <p className="settings-hint" id="password-short">At least 12 characters.</p>}
        <label className="settings-field">
          Confirm new password
          <input name="confirmPassword" type="password" autoComplete="new-password" maxLength={128}
            value={confirm} onChange={(event) => setConfirm(event.target.value)} aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? "password-mismatch" : undefined} required />
        </label>
        {mismatch && <p className="settings-hint is-warning" id="password-mismatch">The passwords don’t match yet.</p>}
      </div>
    </FormDialog>
  );
}

export function AccountSection({ email }: { email: string }) {
  const [changing, setChanging] = useState(false);
  return (
    <>
      <section className="settings-card" aria-labelledby="account-signin">
        <div className="settings-card-heading">
          <h2 id="account-signin">Sign-in</h2>
        </div>
        <dl className="settings-summary">
          <div><dt><Mail size={13} aria-hidden="true" /> Email</dt><dd>{email}</dd></div>
          <div><dt><KeyRound size={13} aria-hidden="true" /> Password</dt><dd>••••••••••••</dd></div>
        </dl>
        <div className="settings-card-actions">
          <button type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => setChanging(true)}>
            <KeyRound size={14} aria-hidden="true" /> Change password
          </button>
        </div>
      </section>
      <section className="settings-card" aria-labelledby="account-session">
        <div className="settings-card-heading">
          <h2 id="account-session">This session</h2>
          <p>Sign out of Orbit in this browser. Your notes stay safe in your account.</p>
        </div>
        <form action={signOut} className="settings-card-actions">
          <button className="secondary-button" type="submit"><LogOut size={14} aria-hidden="true" /> Sign out</button>
        </form>
      </section>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
    </>
  );
}
