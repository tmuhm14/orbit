"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { Bot, KeyRound, LifeBuoy, Sparkles } from "lucide-react";
import {
  EXAMPLE_ORIGIN, GUIDE_ANCHORS as A, PLACEHOLDER_KEY, TROUBLESHOOTING, curlExample, mcpConfigExample, settingsHref,
} from "@/lib/settings-sections";
import { CodeBlock } from "./copy";

const noop = () => () => {};
/** This Orbit's origin for the examples; a placeholder while server rendering. */
const useOrigin = () => useSyncExternalStore(noop, () => window.location.origin, () => EXAMPLE_ORIGIN);

/** Scrolls to the #anchor after client navigation from another Settings page. */
function useHashScroll() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, []);
}

const CONTENTS = [
  { id: A.organizingAgent, label: "A. The organizing agent" },
  { id: A.delegation, label: "B. Delegating work" },
  { id: A.externalBots, label: "C. External bots and MCP" },
  { id: A.troubleshooting, label: "D. Troubleshooting" },
];

/** Settings → Agents & API keys → Setup guide. Accurate to docs/api/agents.md, connect-a-bot.md and ADR 007. */
export function SetupGuide({ onToast, onOpenAgent }: { onToast: (message: string) => void; onOpenAgent: () => void }) {
  const origin = useOrigin();
  useHashScroll();
  const heading = (id: string) => ({ id, tabIndex: -1 });
  return (
    <div className="settings-guide">
      <nav className="settings-card settings-guide-contents" aria-labelledby="guide-contents">
        <h2 id="guide-contents">On this page</h2>
        <ol>{CONTENTS.map((c) => <li key={c.id}><a href={`#${c.id}`}>{c.label}</a></li>)}</ol>
        <p className="settings-hint">Three ways an agent works with Orbit: the built-in organizing agent tidies your notes, delegation hands one item to it with the context you choose, and external bots use their own API key.</p>
      </nav>

      <section className="settings-card settings-guide-part" aria-labelledby={A.organizingAgent}>
        <h2 {...heading(A.organizingAgent)}><Bot size={16} aria-hidden="true" /> A. Set up the organizing agent</h2>
        <p>The organizing agent triages your Inbox and organizes notes when you ask. It runs on a model provider you choose, with your own API key.</p>
        <ol className="settings-steps">
          <li>
            <strong>Get an API key from a provider.</strong> Orbit works with Anthropic, OpenAI and xAI (Grok). Create a key in that provider’s console. Usage is billed to your provider account.
          </li>
          <li>
            <strong>Pick the provider and paste the key.</strong> Open <Link href={settingsHref("model")}>Settings → Model &amp; agent</Link> and choose <em>Connect a provider</em> (or <em>Change model or key</em>). Choose the provider and paste the key. Orbit checks it, encrypts it on the server and only ever shows its last four characters.
          </li>
          <li>
            <strong>Choose a model.</strong> A sensible default is filled in for each provider; you can type another model name the provider offers. Leave <em>Triage Slack and email captures as they arrive</em> on if you want new captures sorted automatically. Click <em>Check key and save</em>.
          </li>
          <li>
            <strong>Turn the agent on for each space.</strong> Under <em>Where the agent may work</em>, switch on each space the agent may use. Every space starts off. You can also open the <button type="button" className="settings-inline-link" onClick={onOpenAgent}>Agent</button> from the top bar and use its Settings.
          </li>
        </ol>
        <div className="settings-callout">
          <strong>What is sent to the provider</strong>
          <p>Only notes in spaces where the agent is on, when the agent runs (a triage, a request you send, or auto-triage of a new capture). For delegation, only the item you delegate and the context items you pick. Nothing from spaces that are off is ever sent. Don’t turn the agent on for spaces that may hold patient or other regulated data unless your agreement with the provider covers it.</p>
        </div>
        <p><strong>To turn it off:</strong> switch the space off in <Link href={settingsHref("model")}>Model &amp; agent</Link>; it applies immediately, and blocks external API keys in that space too. To stop the agent everywhere, choose <em>Change model or key</em> → <em>Remove key</em>. Agent changes can be undone from the Agent’s Outputs.</p>
      </section>

      <section className="settings-card settings-guide-part" aria-labelledby={A.delegation}>
        <h2 {...heading(A.delegation)}><Sparkles size={16} aria-hidden="true" /> B. Delegate work to the agent</h2>
        <p>Delegation hands one item to the agent to prepare a draft or summary. It needs a saved model key and the agent turned on for the item’s space.</p>
        <ol className="settings-steps">
          <li><strong>Open an item</strong> (any note, task or project) and find the <em>Agent</em> row in its properties. Choose <em>Delegate</em>.</li>
          <li><strong>Say what you want back</strong> and, under <em>Context to share</em>, pick the other items the agent may read. It works only from what you write and the items you pick. Choose <em>Delegate</em>.</li>
          <li><strong>Follow it on the <Link href="/agents">Agents</Link> page.</strong> <em>Needs you</em> lists assignments waiting on an answer or a review; <em>In progress</em> shows work underway.</li>
          <li><strong>Review the result.</strong> Open the assignment and choose <em>Accept</em>, <em>Request changes</em> or <em>Reject</em>. Accepting doesn’t complete the original item; mark it done yourself when you’re ready.</li>
          <li><strong>Keep it.</strong> After accepting, choose <em>Save as document</em> to file the result as a document, optionally in a project.</li>
        </ol>
      </section>

      <section className="settings-card settings-guide-part" aria-labelledby={A.externalBots}>
        <h2 {...heading(A.externalBots)}><KeyRound size={16} aria-hidden="true" /> C. Connect an external bot or MCP client</h2>
        <p>A bot (Grok, Claude, or your own) gets its own <strong>Orbit API key</strong>, limited to the spaces and actions you grant. It can list notes (Read) and add Inbox notes (Capture). It can’t edit or delete anything.</p>

        <h3 {...heading(A.createKey)}>1. Create a key</h3>
        <ol className="settings-steps">
          <li>Make sure the agent is on for each space the bot should use (<Link href={settingsHref("model")}>Model &amp; agent</Link>). When a space is off, no key can use it.</li>
          <li>Open <Link href={settingsHref("agents")}>Settings → Agents &amp; API keys</Link> and choose <em>New key</em>.</li>
          <li>Name it after the bot, for example “Grok bot”. Tick <em>Read</em> and/or <em>Capture</em> for each space it needs, and nothing more.</li>
          <li>Choose <em>Create key</em>. Copy the key that appears (it starts with <code>orbit_sk_</code>) into the bot’s secret store, then choose <em>I’ve saved it</em>. <strong>Orbit shows it once.</strong></li>
        </ol>

        <h3 {...heading(A.callApi)}>2. Call the API</h3>
        <p>Send the key as a bearer token on every request to <code>/api/v1</code>. Use HTTPS. This example lists the spaces the key can use, then captures a note:</p>
        <CodeBlock label="curl example" language="shell" code={curlExample(origin)} onToast={onToast} />
        <p className="settings-hint">Each POST creates a new note, so don’t retry one automatically after an unclear timeout. Treat note text the bot reads as untrusted data.</p>

        <h3 {...heading(A.mcp)}>3. Or use the local MCP adapter</h3>
        <p>Orbit ships a local stdio MCP adapter, <code>scripts/orbit-mcp.mjs</code>. Run <code>npm install</code> in an Orbit checkout, then add an entry like this to your MCP client’s config (for example Claude Desktop’s <code>claude_desktop_config.json</code>). Replace the path, and supply the key through the client’s environment or secret settings:</p>
        <CodeBlock label="MCP client config" language="json" code={mcpConfigExample(origin)} onToast={onToast} />
        <p className="settings-hint">The adapter offers <code>orbit_list_workspaces</code>, <code>orbit_list_notes</code> (needs Read) and <code>orbit_capture_note</code> (needs Capture). It never prints the key. It’s a local process, not a hosted MCP endpoint.</p>

        <h3 {...heading(A.revoke)}>4. Revoke or rotate a key</h3>
        <ul className="settings-bullets">
          <li><strong>Change access:</strong> choose <em>Edit access</em> on the key. The change applies on the bot’s next request.</li>
          <li><strong>Revoke:</strong> choose <em>Revoke</em>. The key stops working on its next request and can’t be restored.</li>
          <li><strong>Rotate:</strong> create a new key with the same access, swap it into the bot, check it works, then revoke the old one. If a key leaks, revoke it first.</li>
        </ul>

        <h3 {...heading(A.accessLog)}>5. Read the access log</h3>
        <p><em>Recent access</em> on <Link href={settingsHref("agents")}>Agents &amp; API keys</Link> lists each request: when, which key, what it did (<em>Listed spaces</em>, <em>Read notes</em>, <em>Captured a note</em>), in which space, and whether it was allowed or refused, with the reason. It never records note content. Entries are kept 90 days. Each key also shows when it was last used. <em>Session token (deprecated)</em> means a bot is still signing in with your own session instead of a key.</p>

        <div className="settings-callout" {...heading(A.security)} role="note" aria-label="Security notes">
          <strong>Security notes</strong>
          <ul className="settings-bullets">
            <li><strong>Keys are shown once.</strong> Orbit stores only a fingerprint. A lost key can’t be recovered; create a new one.</li>
            <li><strong>Store keys like passwords:</strong> in a secret store or environment variable, never in prompts, logs, chats or source control.</li>
            <li><strong>Least privilege per space.</strong> One key per bot, with only the spaces and actions it needs.</li>
            <li><strong>Revocation is immediate.</strong> Orbit checks the key and its access on every request, so revoking or removing access applies to the very next call.</li>
            <li><strong>Signing a bot in with your own session token is deprecated.</strong> It still works for now, but it can’t be limited or revoked separately. Move the bot to an API key (replace <code>ORBIT_ACCESS_TOKEN</code> with <code>ORBIT_API_KEY</code>).</li>
          </ul>
        </div>
      </section>

      <section className="settings-card settings-guide-part" aria-labelledby={A.troubleshooting}>
        <h2 {...heading(A.troubleshooting)}><LifeBuoy size={16} aria-hidden="true" /> D. Troubleshooting</h2>
        <p>Errors from <code>/api/v1</code> come back as <code>{"{ \"error\": …, \"code\": … }"}</code>. Find the <code>code</code> here:</p>
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead><tr><th scope="col">Code</th><th scope="col">What it means</th><th scope="col">How to fix it</th></tr></thead>
            <tbody>{TROUBLESHOOTING.map((row) => (
              <tr key={row.code}>
                <th scope="row"><code>{row.code}</code><small>{row.status}</small></th>
                <td>{row.meaning}</td>
                <td>{row.fix}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="settings-hint">The examples use the placeholder <code>{PLACEHOLDER_KEY}</code>. Replace it with your own key from your secret store, never by pasting it into a shared file.</p>
      </section>
    </div>
  );
}
