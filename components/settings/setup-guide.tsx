"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { Bot, KeyRound, LifeBuoy, PlugZap, Sparkles } from "lucide-react";
import {
  EXAMPLE_ORIGIN, GUIDE_ANCHORS as A, PLACEHOLDER_KEY, TROUBLESHOOTING, curlExample, mcpConfigExample, mcpServerUrl, settingsHref,
} from "@/lib/settings-sections";
import { CodeBlock, CopyButton } from "./copy";

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
  { id: A.connectApps, label: "C. Connect from Grok or Claude" },
  { id: A.externalBots, label: "D. Scripted bots: API keys and local MCP" },
  { id: A.troubleshooting, label: "E. Troubleshooting" },
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
        <p className="settings-hint">Four ways an agent works with Orbit: the built-in organizing agent tidies your notes, delegation hands one item to it with the context you choose, apps such as Grok or Claude connect to Orbit’s MCP server after you approve them, and scripted bots use their own API key.</p>
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

      <section className="settings-card settings-guide-part" aria-labelledby={A.connectApps}>
        <h2 {...heading(A.connectApps)}><PlugZap size={16} aria-hidden="true" /> C. Connect from Grok or Claude</h2>
        <p>Orbit runs a hosted MCP server. Apps such as the Grok app, Claude and Claude Cowork add it as a <strong>custom connector</strong> (a remote MCP server), and you sign in to Orbit and approve it. No key to copy: Orbit asks you which spaces the app may use.</p>
        <p>The server URL to paste:</p>
        <div className="settings-guide-url">
          <code aria-label="Orbit MCP server URL">{mcpServerUrl(origin)}</code>
          <CopyButton text={mcpServerUrl(origin)} label="Copy server URL" showLabel className="secondary-button" onToast={onToast} />
        </div>
        <ol className="settings-steps">
          <li>Make sure the agent is on for each space the app should use (<Link href={settingsHref("model")}>Model &amp; agent</Link>). A space that is off is shown as <em>agent access off</em> on the approval screen, and the app can’t use it until you turn it on.</li>
          <li>In the app, open its connector settings and choose to <strong>add a custom connector</strong> (it may be called a remote MCP server or a custom integration). Give it a name such as “Orbit”, paste the server URL above and save. Leave any client ID and secret fields empty; Orbit registers the app itself.</li>
          <li>Choose <strong>Connect</strong> (or Sign in). Your browser opens Orbit. Sign in if asked.</li>
          <li>On Orbit’s approval screen, check two things before anything else: the <strong>app name</strong>, and the <strong>address Orbit will send you back to</strong> (for example <code>grok.com</code> or <code>claude.ai</code>). If either looks wrong, choose <em>Deny</em>.</li>
          <li><strong>Pick the spaces.</strong> Tick <em>Read</em> to let the app list a space’s notes and <em>Capture</em> to let it add Inbox notes. It can’t change or delete anything. Tick only what it needs, then choose <em>Allow access</em>.</li>
          <li>You’re sent back to the app, which can now use <code>orbit_list_workspaces</code>, <code>orbit_list_notes</code> and <code>orbit_capture_note</code>.</li>
        </ol>
        <p className="settings-hint">Grok’s and Claude’s menu names change from time to time, so yours may differ. The steps are always the same: add a custom connector or remote MCP server, paste the URL, sign in to Orbit, approve.</p>
        <ul className="settings-bullets">
          <li><strong>Change what it may do:</strong> in <Link href={settingsHref("agents")}>Agents &amp; API keys</Link>, find the app under <em>Connected apps</em> and choose <em>Edit access</em>. It applies on the app’s next request.</li>
          <li><strong>Disconnect:</strong> choose <em>Disconnect</em> there. The app loses access on its next request and every token it holds stops working. To use it again, connect it again from the app.</li>
          <li><strong>What it did:</strong> its requests appear in <em>Recent access</em>, marked “(app)”, without note content.</li>
          <li><strong>Sign-ins:</strong> the app holds an access token for an hour and renews it in the background. If it hasn’t been used for 30 days, it asks you to sign in again.</li>
        </ul>
      </section>

      <section className="settings-card settings-guide-part" aria-labelledby={A.externalBots}>
        <h2 {...heading(A.externalBots)}><KeyRound size={16} aria-hidden="true" /> D. Scripted bots: API keys and local MCP</h2>
        <p>For a bot you run yourself (a script, a server, or a local MCP client), create an <strong>Orbit API key</strong>, limited to the spaces and actions you grant. For the Grok or Claude apps, use <a href={`#${A.connectApps}`}>part C</a> instead. It can list notes (Read) and add Inbox notes (Capture). It can’t edit or delete anything.</p>

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
        <p className="settings-hint">The adapter offers <code>orbit_list_workspaces</code>, <code>orbit_list_notes</code> (needs Read) and <code>orbit_capture_note</code> (needs Capture). It never prints the key. It runs on your computer; for cloud apps use the hosted server in <a href={`#${A.connectApps}`}>part C</a>. A scripted MCP client can also call the hosted server at <code>{mcpServerUrl(origin)}</code> with <code>Authorization: Bearer</code> and an API key.</p>

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
        <h2 {...heading(A.troubleshooting)}><LifeBuoy size={16} aria-hidden="true" /> E. Troubleshooting</h2>
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
