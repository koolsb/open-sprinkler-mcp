/**
 * Verifies that OS_READ_ONLY correctly gates write tools.
 *
 * Each test resets the module registry and dynamically imports server.ts so that
 * the WRITE_ENABLED constant is re-evaluated with the current env var value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const READ_ONLY_TOOLS = [
  'get_controller_status',
  'get_stations',
  'get_programs',
  'get_options',
  'get_watering_history',
  'get_queue_status',
  'get_sensor_status',
];

const WRITE_TOOLS = [
  'run_station',
  'stop_station',
  'stop_all_stations',
  'set_rain_delay',
  'set_controller_enabled',
  'reboot_controller',
  'run_program',
  'set_queue_paused',
  'set_water_level',
  'run_once_program',
];

async function getToolNames(readOnly: string | undefined): Promise<string[]> {
  vi.resetModules();
  if (readOnly !== undefined) {
    vi.stubEnv('OS_READ_ONLY', readOnly);
  } else {
    vi.unstubAllEnvs();
  }

  // Dynamic import picks up the freshly stubbed env var
  const { createMcpServer } = await import('../src/server.js');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();

  await client.close();
  await server.close();

  return tools.map((t) => t.name);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OS_READ_ONLY not set (default)', () => {
  it('exposes all read-only tools', async () => {
    const names = await getToolNames(undefined);
    for (const tool of READ_ONLY_TOOLS) {
      expect(names, `expected ${tool} to be present`).toContain(tool);
    }
  });

  it('exposes all write tools', async () => {
    const names = await getToolNames(undefined);
    for (const tool of WRITE_TOOLS) {
      expect(names, `expected ${tool} to be present`).toContain(tool);
    }
  });

  it('registers exactly 17 tools', async () => {
    const names = await getToolNames(undefined);
    expect(names).toHaveLength(17);
  });
});

describe('OS_READ_ONLY=true', () => {
  it('exposes all read-only tools', async () => {
    const names = await getToolNames('true');
    for (const tool of READ_ONLY_TOOLS) {
      expect(names, `expected ${tool} to be present`).toContain(tool);
    }
  });

  it('hides all write tools', async () => {
    const names = await getToolNames('true');
    for (const tool of WRITE_TOOLS) {
      expect(names, `expected ${tool} to be absent`).not.toContain(tool);
    }
  });

  it('registers exactly 7 tools', async () => {
    const names = await getToolNames('true');
    expect(names).toHaveLength(7);
  });
});

describe('OS_READ_ONLY=1', () => {
  it('hides write tools (numeric form)', async () => {
    const names = await getToolNames('1');
    for (const tool of WRITE_TOOLS) {
      expect(names, `expected ${tool} to be absent`).not.toContain(tool);
    }
  });
});

describe('OS_READ_ONLY=false', () => {
  it('exposes write tools when explicitly set to false', async () => {
    const names = await getToolNames('false');
    for (const tool of WRITE_TOOLS) {
      expect(names, `expected ${tool} to be present`).toContain(tool);
    }
  });
});
