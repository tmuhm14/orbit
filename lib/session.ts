// Written to localStorage whenever an auth page loads, so other open tabs
// re-check their session (the storage event fires only in other tabs).
export const AUTH_CHANGED_KEY = "orbit.auth.changed";

export function announceAuthChange() {
  try {
    localStorage.setItem(AUTH_CHANGED_KEY, String(Date.now()));
  } catch {
    /* Authentication works without local storage. */
  }
}
