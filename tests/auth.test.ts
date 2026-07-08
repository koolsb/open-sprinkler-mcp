/**
 * Unit tests for the optional OAuth resource-server layer (src/auth.ts).
 *
 * Tokens are signed with an ephemeral RS256 key pair and verified against an
 * in-memory JWKS (createLocalJWKSet), so no network/Authentik is involved.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type CryptoKey,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { AuthentikTokenVerifier, loadAuthConfig, type AuthConfig } from '../src/auth.js';

const ISSUER = 'https://auth.test/application/o/open-sprinkler-mcp/';
const RESOURCE = 'https://open-sprinkler.mcp.test';
const KID = 'test-key-1';

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

const baseConfig: AuthConfig = {
  issuer: ISSUER,
  audience: RESOURCE,
  resourceUrl: RESOURCE,
  requiredScopes: [],
  allowedGroups: [],
  publicPort: 3001,
};

interface TokenOverrides {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  scope?: string;
  groups?: string[];
  email?: string;
  sub?: string;
}

async function makeToken(o: TokenOverrides = {}): Promise<string> {
  const jwt = new SignJWT({
    scope: o.scope ?? 'openid profile',
    groups: o.groups ?? ['mcp-users'],
    email: o.email ?? 'me@test',
    azp: 'claude-client',
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(o.sub ?? 'user-123')
    .setIssuer(o.issuer ?? ISSUER)
    .setAudience(o.audience ?? RESOURCE)
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '5m');
  return jwt.sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  getKey = createLocalJWKSet({ keys: [publicJwk] });
});

function verifier(cfg: Partial<AuthConfig> = {}): AuthentikTokenVerifier {
  return new AuthentikTokenVerifier({ ...baseConfig, ...cfg }, getKey);
}

describe('AuthentikTokenVerifier', () => {
  it('accepts a valid token and surfaces identity claims', async () => {
    const info = await verifier().verifyAccessToken(await makeToken());
    expect(info.clientId).toBe('claude-client');
    expect(info.scopes).toEqual(['openid', 'profile']);
    expect(info.resource?.toString()).toBe(new URL(RESOURCE).toString());
    expect(info.expiresAt).toBeTypeOf('number');
    expect(info.extra).toMatchObject({ sub: 'user-123', email: 'me@test', groups: ['mcp-users'] });
  });

  it('rejects a token with the wrong audience', async () => {
    await expect(
      verifier().verifyAccessToken(await makeToken({ audience: 'https://someone-else.test' })),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token with the wrong issuer', async () => {
    await expect(
      verifier().verifyAccessToken(await makeToken({ issuer: 'https://evil.test/' })),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects an expired token', async () => {
    await expect(
      verifier().verifyAccessToken(await makeToken({ expiresIn: '-1m' })),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token whose groups do not intersect allowedGroups', async () => {
    await expect(
      verifier({ allowedGroups: ['admins'] }).verifyAccessToken(
        await makeToken({ groups: ['guests'] }),
      ),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('accepts a token when groups intersect allowedGroups', async () => {
    const info = await verifier({ allowedGroups: ['admins', 'mcp-users'] }).verifyAccessToken(
      await makeToken({ groups: ['mcp-users'] }),
    );
    expect(info.extra?.groups).toEqual(['mcp-users']);
  });

  it('rejects a garbage token', async () => {
    await expect(verifier().verifyAccessToken('not-a-jwt')).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('loadAuthConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns undefined when AUTH_ISSUER is unset (auth disabled)', () => {
    vi.stubEnv('AUTH_ISSUER', '');
    expect(loadAuthConfig()).toBeUndefined();
  });

  it('throws when AUTH_ISSUER is set without a resource URL', () => {
    vi.stubEnv('AUTH_ISSUER', ISSUER);
    vi.stubEnv('MCP_RESOURCE_URL', '');
    vi.stubEnv('AUTH_AUDIENCE', '');
    expect(() => loadAuthConfig()).toThrow(/MCP_RESOURCE_URL/);
  });

  it('parses scopes and groups from delimited env vars', () => {
    vi.stubEnv('AUTH_ISSUER', ISSUER);
    vi.stubEnv('MCP_RESOURCE_URL', RESOURCE);
    vi.stubEnv('AUTH_REQUIRED_SCOPES', 'openid profile');
    vi.stubEnv('AUTH_ALLOWED_GROUPS', 'mcp-users,admins');
    vi.stubEnv('PUBLIC_PORT', '4001');
    const cfg = loadAuthConfig();
    expect(cfg).toMatchObject({
      issuer: ISSUER,
      audience: RESOURCE,
      resourceUrl: RESOURCE,
      requiredScopes: ['openid', 'profile'],
      allowedGroups: ['mcp-users', 'admins'],
      publicPort: 4001,
    });
  });
});
