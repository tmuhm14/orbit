import { noteDrafts } from "./notes.ts";

// Written to localStorage whenever an auth page loads, so other open tabs
// re-check their session (the storage event fires only in other tabs).
export const AUTH_CHANGED_KEY = "orbit.auth.changed";

/**
 * Called by auth pages with no account (signed out) and by the workspace with
 * the signed-in account. Conflicted note drafts (ADR 002 §6) belong to a
 * session, so drafts of any other account are removed, and all of them on
 * the sign-in page.
 */
export function announceAuthChange(signedInUserId?: string) {
  try {
    noteDrafts.clear(
      typeof signedInUserId === "string" ? signedInUserId : undefined,
    );
  } catch {
    /* No drafts can exist without local storage. */
  }
  try {
    localStorage.setItem(AUTH_CHANGED_KEY, String(Date.now()));
  } catch {
    /* Authentication works without local storage. */
  }
}
