import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCOPE, isLoopbackRedirect, parseClientMetadata, parseScope, redirectHost, redirectUriProblem, safeNext, sameResource,
  scopeCapabilities, wwwAuthenticate,
} from './validation.ts';
import * as validation from './validation.ts';
import { loadTs } from '../../tests/load-ts.mjs';

const { checkAuthorize, consentGrants, readAuthorizeParams, redirectWith } =
  loadTs(new URL('./authorize.ts', import.meta.url), { '@/lib/oauth/validation': validation });

test('redirect URIs: https, or http on loopback only; no fragments, user info or custom schemes', () => {
  for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'https://grok.com/cb?x=1', 'http://localhost:33418/callback',
    'http://127.0.0.1:8080/cb', 'http://[::1]:9000/cb', 'https://app.test'])
    assert.equal(redirectUriProblem(ok), null, ok);
  for (const bad of ['http://evil.test/cb', 'http://localhost.evil.test/cb', 'https://a.test/cb#x', 'https://user:pw@a.test/cb',
    'cursor://anysphere.cursor-retrieval/callback', 'javascript:alert(1)', 'HTTPS://A.TEST/cb', '', 'https://a test/cb',
    `https://a.test/${'x'.repeat(2000)}`, 42, null])
    assert.notEqual(redirectUriProblem(bad), null, String(bad).slice(0, 40));
  assert.equal(isLoopbackRedirect('http://localhost:1/cb'), true);
  assert.equal(isLoopbackRedirect('https://localhost/cb'), false);
  assert.equal(redirectHost('https://claude.ai/api/cb'), 'claude.ai');
  assert.equal(redirectHost('http://localhost:33418/cb'), 'localhost:33418');
});

test('safe next: relative same-origin paths only', () => {
  assert.equal(safeNext('/oauth/authorize?client_id=a&state=b'), '/oauth/authorize?client_id=a&state=b');
  assert.equal(safeNext('/settings#x'), '/settings#x');
  for (const bad of ['https://evil.test', '//evil.test/x', '/\\evil.test', '\\\\evil.test', 'evil.test', '/x\n', '/x\u0000', '', null,
    undefined, ['/a'], `/${'a'.repeat(4000)}`, 'javascript:alert(1)', '/%0a'.replace('%0a', '\n')])
    assert.equal(safeNext(bad), null, String(bad).slice(0, 30));
});

test('scopes: canonical order, unknown ignored, default both, none known is refused', () => {
  assert.equal(parseScope(null), DEFAULT_SCOPE);
  assert.equal(parseScope(''), DEFAULT_SCOPE);
  assert.equal(parseScope('orbit:capture orbit:read'), 'orbit:read orbit:capture');
  assert.equal(parseScope('openid orbit:read offline_access'), 'orbit:read');
  assert.equal(parseScope('admin'), null);
  assert.deepEqual(scopeCapabilities('orbit:read'), ['workspace.read']);
  assert.deepEqual(scopeCapabilities('orbit:read orbit:capture'), ['workspace.read', 'item.write']);
  assert.deepEqual(scopeCapabilities(''), []);
});

test('resource comparison ignores case of scheme and host and a trailing slash, nothing else', () => {
  const r = 'https://orbit.test/api/mcp';
  assert.equal(sameResource('https://orbit.test/api/mcp', r), true);
  assert.equal(sameResource('HTTPS://Orbit.Test/api/mcp/', r), true);
  for (const bad of ['https://orbit.test/api/MCP', 'https://orbit.test', 'https://orbit.test/api/mcp#x', 'http://orbit.test/api/mcp',
    'https://evil.test/api/mcp', 'orbit.test/api/mcp', 'https://orbit.test:8443/api/mcp'])
    assert.equal(sameResource(bad, r), false, bad);
});

test('the WWW-Authenticate challenge has the exact RFC 6750 / RFC 9728 form', () => {
  const md = 'https://orbit.test/.well-known/oauth-protected-resource';
  assert.equal(wwwAuthenticate(md), `Bearer resource_metadata="${md}", scope="orbit:read orbit:capture"`);
  assert.equal(wwwAuthenticate(md, { error: 'invalid_token', description: 'Expired "now"' }),
    `Bearer error="invalid_token", error_description="Expired now", resource_metadata="${md}", scope="orbit:read orbit:capture"`);
});

test('client metadata: public clients with code + refresh only; names cleaned; non-https URIs dropped', () => {
  const ok = parseClientMetadata({ client_name: '  Grok‮  Connector\u0007 ', redirect_uris: ['https://grok.com/cb', 'https://grok.com/cb'],
    client_uri: 'https://grok.com', logo_uri: 'http://x.test/l.png', token_endpoint_auth_method: 'client_secret_basic' });
  assert.deepEqual(ok, { ok: true, value: { clientName: 'Grok Connector', redirectUris: ['https://grok.com/cb'], clientUri: 'https://grok.com', logoUri: null } });
  assert.equal(parseClientMetadata({ redirect_uris: ['https://a.test/cb'], client_name: '​' }).value.clientName, null);
  assert.equal(parseClientMetadata({ redirect_uris: ['https://a.test/cb'], client_name: 'x'.repeat(300) }).value.clientName.length, 100);
  for (const [body, error] of [[null, 'invalid_client_metadata'], [[], 'invalid_client_metadata'], [{}, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://a.test/1', 'https://a.test/2', 'https://a.test/3', 'https://a.test/4', 'https://a.test/5', 'https://a.test/6'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['http://a.test/cb'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://a.test/cb'], grant_types: ['implicit'] }, 'invalid_client_metadata'],
    [{ redirect_uris: ['https://a.test/cb'], grant_types: ['refresh_token'] }, 'invalid_client_metadata'],
    [{ redirect_uris: ['https://a.test/cb'], response_types: ['code', 'token'] }, 'invalid_client_metadata']])
    assert.equal(parseClientMetadata(body).error, error, JSON.stringify(body));
});

const client = { clientId: 'orbit_ci_' + '1'.repeat(32), clientName: 'App', redirectUris: ['https://app.test/cb'], clientUri: null };
const endpoints = { issuer: 'https://orbit.test', resource: 'https://orbit.test/api/mcp' };
const params = (extra = {}) => new URLSearchParams({ client_id: client.clientId, redirect_uri: 'https://app.test/cb', response_type: 'code',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 's', ...extra });

test('authorize checks: never redirect to an unverified URI; errors carry state and iss', () => {
  assert.equal(checkAuthorize(readAuthorizeParams(params()), client, endpoints).kind, 'ok');
  assert.equal(checkAuthorize(readAuthorizeParams(params()), null, endpoints).kind, 'invalid');
  assert.equal(checkAuthorize(readAuthorizeParams(params({ redirect_uri: 'https://app.test/cb2' })), client, endpoints).kind, 'invalid');
  const long = checkAuthorize(readAuthorizeParams(params({ state: 'x'.repeat(2001) })), client, endpoints);
  assert.equal(new URL(long.url).searchParams.get('error'), 'invalid_request');
  const plain = checkAuthorize(readAuthorizeParams(params({ code_challenge_method: 'plain' })), client, endpoints);
  assert.deepEqual([...new URL(plain.url).searchParams.keys()], ['error', 'error_description', 'state', 'iss']);
  assert.equal(redirectWith('https://app.test/cb?keep=1', { code: 'c', state: undefined }), 'https://app.test/cb?keep=1&code=c');
});

test('consent grants: only offered capabilities, valid ids, deduplicated', () => {
  const w = '12345678-1234-4234-8234-123456789abc';
  assert.deepEqual(consentGrants([`${w}:workspace.read`, `${w.toUpperCase()}:workspace.read`, `${w}:item.write`, `${w}:assignment.execute`,
    'nope:workspace.read', `${w}:workspace.read:x`], 'orbit:read'), [{ workspaceId: w, capability: 'workspace.read' }]);
  assert.equal(consentGrants([`${w}:item.write`], 'orbit:read orbit:capture').length, 1);
});
