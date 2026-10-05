// Shared by the browser (showing addresses) and the inbound webhook (parsing
// them), so this file must not import Node-only modules.

/** "Waltz", "a1b2c3d4e5f6", "x.resend.app" → "waltz-a1b2c3d4e5f6@x.resend.app" */
export function inboundAddress(name: string, token: string, domain: string) {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${slug ? `${slug}-` : ""}${token}@${domain}`;
}

/** Extracts inbox tokens from recipient strings like "Name <waltz-abc…@domain>". */
export function inboxTokens(recipients: string[], domain: string): string[] {
  const tokens = new Set<string>();
  const suffix = `@${domain.toLowerCase()}`;
  for (const recipient of recipients) {
    const address = (recipient.match(/<([^<>]+)>/)?.[1] ?? recipient)
      .trim()
      .toLowerCase();
    if (!address.endsWith(suffix)) continue;
    const token = address
      .slice(0, -suffix.length)
      .match(/(?:^|-)([0-9a-f]{12})$/)?.[1];
    if (token) tokens.add(token);
  }
  return [...tokens];
}
