import type { Metadata } from "next";
import "./globals.css";

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
