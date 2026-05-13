import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { BASE_URL } from './client.js';

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

const app = express();
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'open-sprinkler-mcp',
    openSprinklerHost: BASE_URL,
    timestamp: new Date().toISOString(),
  });
});

// ── MCP endpoint (stateless StreamableHTTP) ───────────────────────────────────
// Each POST creates an isolated server+transport, handles the request, then tears down.
// This is the correct pattern for stateless Kubernetes deployments.
app.post('/mcp', async (req: Request, res: Response) => {
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
});

// GET /mcp — stateless mode does not support SSE upgrade via GET
app.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({
    error: 'Method Not Allowed',
    message:
      'This MCP server operates in stateless mode. Send JSON-RPC requests via POST /mcp.',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`OpenSprinkler MCP server listening on port ${PORT}`);
  console.log(`Connected to OpenSprinkler at: ${BASE_URL}`);
  console.log('Endpoints:');
  console.log(`  POST http://localhost:${PORT}/mcp   — MCP JSON-RPC`);
  console.log(`  GET  http://localhost:${PORT}/health — Health check`);
});
