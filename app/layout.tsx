import type { Metadata } from "next";
import "./globals.css";
// Per-feature styles, moving out of globals.css one feature at a time.
import "./styles/settings.css";
import "./styles/action-feedback.css";
import "./styles/oauth.css";
import "./styles/workflows.css";
import "./styles/jira.css";

export const metadata: Metadata = {
  title: "Orbit — A little space for a clearer mind",
  description:
    "Capture your thoughts, organize your next steps, and make space for what matters. A calm workspace built around Getting Things Done.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
