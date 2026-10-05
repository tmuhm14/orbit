"use client";

import { useEffect, useState } from "react";
import { AUTH_CHANGED_KEY, announceAuthChange } from "@/lib/session";

// Sends the tab back to sign-in when the session ends or switches accounts
// elsewhere. Checked on auth events from other tabs, on focus, and every minute.
export function useSessionWatch(userId: string) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    let active = true;
    async function checkSession() {
      try {
        const response = await fetch("/auth/session", { cache: "no-store" });
        if (response.status !== 401 && !response.ok) return;
        const data = await response.json();
        if (active && data.userId !== userId) {
          setExpired(true);
          window.location.replace("/login");
        }
      } catch {
        /* Offline notes remain usable until the session can be checked. */
      }
    }
    function onStorage(event: StorageEvent) {
      if (event.key === AUTH_CHANGED_KEY) void checkSession();
    }
    function onVisible() {
      if (!document.hidden) void checkSession();
    }
    announceAuthChange();
    const interval = setInterval(checkSession, 60000);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);
  return expired;
}
