import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * OAuth is OPTIONAL and only enabled on the public listener. When AUTH_ISSUER is
 * unset the server runs exactly as before (no auth) — that is the path hermes and
 * local development use. When set, the server becomes an OAuth 2.0 resource server
 * that validates Authentik-issued JWTs; identity claims are attached to the request
 * (see AuthInfo.extra) so tools can branch on the calling user in the future.
 */
export interface AuthConfig {
  /** Token issuer — must match the `iss` claim exactly (e.g. https://auth.kools.us/application/o/open-sprinkler-mcp/). */
  issuer: string;
  /** Expected `aud` claim (RFC 8707 resource). Defaults to resourceUrl. */
  audience: string;
  /** This server's public resource identifier, e.g. https://open-sprinkler.mcp.kools.us. */
  resourceUrl: string;
  /** JWKS endpoint. Optional — derived from OIDC discovery when omitted. */
  jwksUri?: string;
  /** Scopes the token must carry (empty = no scope requirement). */
  requiredScopes: string[];
  /** If non-empty, the token's `groups` claim must intersect this list. */
  allowedGroups: string[];
  /** Port for the authenticated public listener. */
  publicPort: number;
}

// Scopes are whitespace- or comma-delimited (OAuth scopes never contain spaces).
function parseList(value: string | undefined): string[] {
  return value ? value.split(/[\s,]+/).filter(Boolean) : [];
}

// Groups are comma-delimited only, since a group name may itself contain spaces
// (e.g. "Kools.us Admins"). Splitting on whitespace would break such names.
function parseGroupList(value: string | undefined): string[] {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Reads auth config from the environment. Returns undefined when auth is disabled. */
export function loadAuthConfig(): AuthConfig | undefined {
  const issuer = process.env.AUTH_ISSUER;
  if (!issuer) return undefined;

  const resourceUrl = process.env.MCP_RESOURCE_URL ?? process.env.AUTH_AUDIENCE;
  if (!resourceUrl) {
    throw new Error(
      'AUTH_ISSUER is set but MCP_RESOURCE_URL (or AUTH_AUDIENCE) is required to enable OAuth',
    );
  }

  return {
    issuer,
    audience: process.env.AUTH_AUDIENCE ?? resourceUrl,
    resourceUrl,
    jwksUri: process.env.AUTH_JWKS_URI,
    requiredScopes: parseList(process.env.AUTH_REQUIRED_SCOPES),
    allowedGroups: parseGroupList(process.env.AUTH_ALLOWED_GROUPS),
    publicPort: parseInt(process.env.PUBLIC_PORT ?? '3001', 10),
  };
}

/**
 * Fetches the authorization server's OAuth/OIDC metadata via discovery. Retried a
 * few times so a briefly-unavailable Authentik doesn't crash-loop the pod on boot.
 */
export async function fetchOAuthMetadata(
  issuer: string,
  attempts = 5,
  delayMs = 2000,
): Promise<OAuthMetadata> {
  const base = issuer.replace(/\/$/, '');
  const url = `${base}/.well-known/openid-configuration`;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`OIDC discovery ${res.status} ${res.statusText} from ${url}`);
      }
      return (await res.json()) as OAuthMetadata;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `Unable to load OIDC discovery after ${attempts} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Verifies Authentik-issued JWT access tokens against the JWKS, pinning issuer and
 * audience, and optionally enforcing group membership. Any verification failure is
 * surfaced as InvalidTokenError so requireBearerAuth returns a spec-compliant 401.
 */
export class AuthentikTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly cfg: AuthConfig,
    private readonly getKey: JWTVerifyGetKey,
  ) {}

  /** Production factory: resolves signing keys from the issuer's remote JWKS endpoint. */
  static fromJwksUri(cfg: AuthConfig, jwksUri: string): AuthentikTokenVerifier {
    return new AuthentikTokenVerifier(cfg, createRemoteJWKSet(new URL(jwksUri)));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.getKey, {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
      }));
    } catch (err) {
      throw new InvalidTokenError(
        err instanceof Error ? err.message : 'Token verification failed',
      );
    }

    const groups = Array.isArray(payload.groups) ? (payload.groups as string[]) : [];
    if (this.cfg.allowedGroups.length > 0) {
      const allowed = groups.some((g) => this.cfg.allowedGroups.includes(g));
      if (!allowed) {
        throw new InvalidTokenError('Token subject is not in an allowed group');
      }
    }

    const scope = typeof payload.scope === 'string' ? payload.scope : '';
    const scopes = scope.split(' ').filter(Boolean);

    return {
      token,
      clientId:
        (payload.azp as string | undefined) ??
        (payload.client_id as string | undefined) ??
        '',
      scopes,
      expiresAt: payload.exp,
      resource: new URL(this.cfg.resourceUrl),
      extra: {
        sub: payload.sub,
        email: payload.email,
        groups,
      },
    };
  }
}
