"use client";

import Link from "next/link";
import { Bot, BookOpen, Inbox, KeyRound, Layers, Plug, UserRound, type LucideIcon } from "lucide-react";
import type { SlackConnection, Workspace } from "@/lib/notes";
import { SETTINGS_SECTIONS, settingsHref, settingsSection, type SettingsSection } from "@/lib/settings-sections";
import { AgentKeysSettings } from "./agent-keys-settings";
import { AccountSection } from "./settings/account-section";
import { CaptureSection } from "./settings/capture-section";
import { IntegrationsSection } from "./settings/integrations-section";
import { ModelSection } from "./settings/model-section";
import { SetupGuide } from "./settings/setup-guide";
import { SpacesSection } from "./settings/spaces-section";

const ICONS: Record<SettingsSection, LucideIcon> = {
  account: UserRound, spaces: Layers, capture: Inbox, model: Bot, integrations: Plug, agents: KeyRound, setup: BookOpen,
};

/** Left section nav on wide screens; a scrollable row of tabs on narrow ones. Plain links: each is a page. */
function SettingsNav({ section }: { section: SettingsSection }) {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <ul>
        {SETTINGS_SECTIONS.map((s) => {
          const Icon = ICONS[s.id];
          const current = s.id === section;
          return (
            <li key={s.id} className={s.id === "setup" ? "is-nested" : undefined}>
              <Link href={settingsHref(s.id)} className={`settings-nav-link${current ? " is-current" : ""}`} aria-current={current ? "page" : undefined}>
                <Icon size={15} aria-hidden="true" />
                <span>{s.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Settings (/settings/*): one section per page. Each shows its state at rest;
 * every edit opens one focused dialog or side panel (components/side-panel).
 */
export function SettingsContent({
  section, email, workspaces, slack, inboundDomain, agentAvailable,
  onSetDefault, onCreateSpace, onRenameSpace, onRecolorSpace, onSetAgentEnabled,
  onNewAddress, onRouteSlack, onDisconnectSlack,
  onOpenScheduled, onOpenAgent, onToast,
}: {
  section: SettingsSection;
  email: string;
  workspaces: Workspace[];
  slack: SlackConnection[];
  inboundDomain: string | null;
  agentAvailable: boolean;
  onSetDefault: (id: string) => Promise<unknown>;
  onCreateSpace: (name: string) => Promise<unknown>;
  onRenameSpace: (id: string, name: string) => Promise<unknown>;
  onRecolorSpace: (id: string, color: string) => Promise<unknown>;
  onSetAgentEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  onNewAddress: (id: string) => Promise<unknown>;
  onRouteSlack: (link: SlackConnection, workspaceId: string) => Promise<unknown>;
  onDisconnectSlack: (link: SlackConnection) => Promise<unknown>;
  onOpenScheduled: () => void;
  onOpenAgent: () => void;
  onToast: (message: string) => void;
}) {
  const info = settingsSection(section);
  return (
    <main className="settings-page">
      <div className="settings-layout">
        <SettingsNav section={section} />
        <div className="settings-main">
          <header className="settings-page-header">
            <div className="eyebrow">{section === "setup" ? "SETTINGS · AGENTS & API KEYS" : "SETTINGS"}</div>
            <h1>{info.label}</h1>
            <p>{info.description}</p>
          </header>
          <div className="settings-sections" key={section}>
            {section === "account" && <AccountSection email={email} />}
            {section === "spaces" && <SpacesSection workspaces={workspaces} onCreate={onCreateSpace} onRename={onRenameSpace}
              onRecolor={onRecolorSpace} onSetDefault={onSetDefault} onToast={onToast} />}
            {section === "capture" && <CaptureSection workspaces={workspaces} slack={slack} inboundDomain={inboundDomain}
              onRouteSlack={onRouteSlack} onDisconnectSlack={onDisconnectSlack} onNewAddress={onNewAddress} onToast={onToast} />}
            {section === "model" && <ModelSection available={agentAvailable} workspaces={workspaces}
              onSetAgentEnabled={onSetAgentEnabled} onOpenAgent={onOpenAgent} onToast={onToast} />}
            {section === "integrations" && <IntegrationsSection onOpenScheduled={onOpenScheduled} onToast={onToast} />}
            {section === "agents" && <AgentKeysSettings workspaces={workspaces} onToast={onToast} />}
            {section === "setup" && <SetupGuide onToast={onToast} onOpenAgent={onOpenAgent} />}
          </div>
        </div>
      </div>
    </main>
  );
}
