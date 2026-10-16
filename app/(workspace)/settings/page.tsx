import { redirect } from "next/navigation";
import { settingsHref } from "@/lib/settings-sections";

// /settings opens its first section. The sub-pages are rendered by the
// workspace shell (../layout.tsx) from the pathname.
export default function SettingsPage() {
  redirect(settingsHref());
}
