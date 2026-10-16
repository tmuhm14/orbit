import { BUCKETS } from "./notes.ts";

/** Only known successful actions celebrate; unfamiliar messages stay neutral. */
export function actionFeedback(message: string): {
  kind: "capture" | "complete" | "move" | "saved" | "info";
  caption: string;
} {
  if (BUCKETS.some((bucket) => message === `Captured in ${bucket.name}`))
    return { kind: "capture", caption: "A little more headspace." };
  if (message === "Note completed")
    return { kind: "complete", caption: "One less thing. Nicely done." };
  if (BUCKETS.some((bucket) => message === `Moved to ${bucket.name}`))
    return { kind: "move", caption: "Everything in its orbit." };
  if (["Saved to Reference", "Agent settings saved", "Note restored", "Reopened", "Your notes have been exported"].includes(message))
    return { kind: "saved", caption: "" };
  return { kind: "info", caption: "" };
}
