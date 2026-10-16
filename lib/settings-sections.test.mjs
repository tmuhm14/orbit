import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS_SECTION, GUIDE_ANCHORS, PLACEHOLDER_KEY, SETTINGS_SECTIONS, TROUBLESHOOTING,
  curlExample, guideHref, isDirty, isSettingsSection, maskedHint, mcpConfigExample, mcpServerUrl, parseSettingsSection, settingsHref,
} from './settings-sections.ts';
import { parseRoute } from './workspace-routes.ts';

test('every section has a unique path and round-trips through parseRoute', () => {
  const paths = new Set(SETTINGS_SECTIONS.map((s) => s.path));
  assert.equal(paths.size, SETTINGS_SECTIONS.length);
  for (const section of SETTINGS_SECTIONS) {
    assert.ok(isSettingsSection(section.id));
    assert.deepEqual(parseRoute(settingsHref(section.id)), { page: 'settings', section: section.id });
  }
});

test('settings paths parse, defaulting /settings to account and rejecting unknowns', () => {
  assert.equal(parseSettingsSection([]), DEFAULT_SETTINGS_SECTION);
  assert.equal(parseSettingsSection(['model']), 'model');
  assert.equal(parseSettingsSection(['agents', 'setup']), 'setup');
  assert.equal(parseSettingsSection(['setup']), null);
  assert.equal(parseSettingsSection(['agents', 'nope']), null);
  assert.equal(isSettingsSection('nope'), false);
});

test('hrefs add an anchor only when asked', () => {
  assert.equal(settingsHref(), '/settings/account');
  assert.equal(settingsHref('setup'), '/settings/agents/setup');
  assert.equal(guideHref(GUIDE_ANCHORS.mcp), '/settings/agents/setup#mcp');
  assert.equal(guideHref(), '/settings/agents/setup');
});

test('isDirty compares plain values and sets', () => {
  assert.equal(isDirty({ a: 'x', b: true }, { a: 'x', b: true }), false);
  assert.equal(isDirty({ a: 'x' }, { a: 'y' }), true);
  assert.equal(isDirty({ g: new Set(['1:a', '2:b']) }, { g: new Set(['2:b', '1:a']) }), false);
  assert.equal(isDirty({ g: new Set(['1:a']) }, { g: new Set(['1:a', '2:b']) }), true);
  assert.equal(isDirty({ g: new Set(['1:a']) }, { g: new Set(['2:b']) }), true);
});

test('masked hints never show more than the last four characters', () => {
  assert.equal(maskedHint('abcd1234'), '•••• 1234');
  assert.equal(maskedHint('12'), '•••• 12');
  assert.equal(maskedHint(''), 'Not saved');
  assert.equal(maskedHint(null), 'Not saved');
});

test('troubleshooting covers each documented error code once', () => {
  const codes = TROUBLESHOOTING.map((row) => row.code);
  assert.deepEqual(codes, ['invalid_credentials', 'client_revoked', 'capability_denied', 'agent_disabled', 'not_configured']);
  for (const row of TROUBLESHOOTING) assert.ok(row.fix.length > 20 && row.meaning.length > 10);
});

test('examples use the origin and only the placeholder key', () => {
  const curl = curlExample('https://orbit.test');
  assert.match(curl, /ORBIT_URL="https:\/\/orbit\.test"/);
  assert.match(curl, /\/api\/v1\/workspaces/);
  assert.match(curl, /Authorization: Bearer \$ORBIT_API_KEY/);
  assert.ok(curl.includes(PLACEHOLDER_KEY));
  const config = JSON.parse(mcpConfigExample('https://orbit.test'));
  assert.deepEqual(config.mcpServers.orbit.env, { ORBIT_URL: 'https://orbit.test', ORBIT_API_KEY: PLACEHOLDER_KEY });
  assert.equal(config.mcpServers.orbit.command, 'node');
  assert.match(config.mcpServers.orbit.args[0], /scripts\/orbit-mcp\.mjs$/);
  // A real key is orbit_sk_<12 hex>_<43 base64url>; the placeholder must not look like one.
  assert.doesNotMatch(PLACEHOLDER_KEY, /^orbit_sk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
});

test('the hosted MCP server URL is the origin plus /api/mcp (ADR 008)', () => {
  assert.equal(mcpServerUrl('https://orbit.test'), 'https://orbit.test/api/mcp');
  assert.equal(mcpServerUrl('https://orbit.test/'), 'https://orbit.test/api/mcp');
  assert.equal(guideHref(GUIDE_ANCHORS.connectApps), '/settings/agents/setup#connect-apps');
});
