import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createMcpServer } from './server.js';
import { BASE_URL } from './client.js';
import { AuthentikTokenVerifier, fetchOAuthMetadata, loadAuthConfig } from './auth.js';

// Validate required env vars before starting
if (!process.env.OS_HOST) {
  console.error('ERROR: OS_HOST environment variable is required (hostname, IP, or URL of your OpenSprinkler device)');
  process.exit(1);
}
if (!process.env.OS_PASSWORD) {
  console.error('ERROR: OS_PASSWORD environment variable is required (plain-text device password)');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── MCP request handler (stateless StreamableHTTP) ────────────────────────────
// Each POST creates an isolated server+transport, handles the request, then tears down.
// This is the correct pattern for stateless Kubernetes deployments.
const handleMcpPost: RequestHandler = async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session persistence across requests
  });

  const server = createMcpServer();

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on('finish', () => {
      void transport.close();
      void server.close();
    });
  } catch (err) {
    console.error('[MCP] Request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

// GET /mcp — stateless mode does not support SSE upgrade via GET
const handleMcpGet: RequestHandler = (_req: Request, res: Response) => {
  res.status(405).json({
    error: 'Method Not Allowed',
    message:
      'This MCP server operates in stateless mode. Send JSON-RPC requests via POST /mcp.',
  });
};

// Builds an Express app with JSON parsing and the shared /health endpoint.
function buildBaseApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'open-sprinkler-mcp',
      openSprinklerHost: BASE_URL,
      timestamp: new Date().toISOString(),
    });
  });
  return app;
}

// Mounts the MCP endpoint, optionally behind auth (or any other) middleware.
function mountMcp(app: express.Express, middleware: RequestHandler[] = []): void {
  app.post('/mcp', ...middleware, handleMcpPost);
  app.get('/mcp', handleMcpGet);
}

async function main(): Promise<void> {
  // ── Internal listener (no auth) — used by in-cluster clients such as hermes ──
  const internalApp = buildBaseApp();
  mountMcp(internalApp);
  internalApp.listen(PORT, () => {
    console.log(`OpenSprinkler MCP (internal, no auth) listening on port ${PORT}`);
    console.log(`Connected to OpenSprinkler at: ${BASE_URL}`);
  });

  // ── Public listener (Authentik OAuth) — only when AUTH_ISSUER is configured ──
  const authCfg = loadAuthConfig();
  if (!authCfg) {
    console.log('OAuth disabled (AUTH_ISSUER unset) — public listener not started.');
    return;
  }

  // Isolated from the internal listener: if Authentik is unreachable we log and
  // carry on serving in-cluster clients (e.g. hermes) rather than crash-looping.
  try {
    await startPublicListener(authCfg);
  } catch (err) {
    console.error('Failed to start public OAuth listener (internal listener unaffected):', err);
  }
}

async function startPublicListener(authCfg: NonNullable<ReturnType<typeof loadAuthConfig>>): Promise<void> {
  const oauthMetadata = await fetchOAuthMetadata(authCfg.issuer);
  // OAuthMetadata is a "loose" schema, so jwks_uri is untyped — narrow it explicitly.
  const discoveredJwks =
    typeof oauthMetadata.jwks_uri === 'string' ? oauthMetadata.jwks_uri : undefined;
  const jwksUri = authCfg.jwksUri ?? discoveredJwks;
  if (!jwksUri) {
    throw new Error('No JWKS URI: set AUTH_JWKS_URI or ensure the issuer publishes jwks_uri via discovery');
  }

  const verifier = AuthentikTokenVerifier.fromJwksUri(authCfg, jwksUri);
  const resourceServerUrl = new URL(authCfg.resourceUrl);

  const publicApp = buildBaseApp();
  // Serve protected-resource + authorization-server metadata for OAuth discovery.
  publicApp.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      scopesSupported: authCfg.requiredScopes.length > 0 ? authCfg.requiredScopes : undefined,
      resourceName: 'OpenSprinkler MCP',
    }),
  );

  const bearer = requireBearerAuth({
    verifier,
    requiredScopes: authCfg.requiredScopes,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  mountMcp(publicApp, [bearer]);

  publicApp.listen(authCfg.publicPort, () => {
    console.log(`OpenSprinkler MCP (public, Authentik OAuth) listening on port ${authCfg.publicPort}`);
    console.log(`  Resource:  ${authCfg.resourceUrl}`);
    console.log(`  Issuer:    ${authCfg.issuer}`);
    console.log(`  JWKS:      ${jwksUri}`);
    if (authCfg.allowedGroups.length > 0) {
      console.log(`  Groups:    ${authCfg.allowedGroups.join(', ')}`);
    }
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
