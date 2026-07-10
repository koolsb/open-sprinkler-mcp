/**
 * Tool handler tests.
 *
 * apiGet is mocked so no network calls are made. Each test exercises a tool's
 * full request/response path through the real MCP InMemoryTransport + Client,
 * validating both the formatted output and the API calls made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// vi.mock is hoisted — runs before imports, so createMcpServer gets the mock
vi.mock('../src/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.js')>();
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import {
  JC_IDLE, JC_RUNNING, JC_DISABLED_RAIN,
  JO, JO_WITH_MASTER, JN, JN_WITH_FLAGS, JS, JP, JL,
  CV_OK, CM_OK, MP_OK, PQ_OK, CO_OK, CR_OK, CP_OK, DP_OK, UP_OK, DB,
} from './fixtures.js';

const mockApiGet = vi.mocked(apiGet);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createTestClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { client, cleanup } = await createTestClient();
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await cleanup();
  }
}

function getText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('Expected text content');
  return first.text as string;
}

beforeEach(() => {
  mockApiGet.mockReset();
});

// ── get_controller_status ─────────────────────────────────────────────────────

describe('get_controller_status', () => {
  it('shows ENABLED and key fields when controller is on', async () => {
    mockApiGet.mockResolvedValueOnce(JC_IDLE).mockResolvedValueOnce(JO);

    const text = getText(await callTool('get_controller_status'));

    expect(text).toContain('Controller:         ENABLED');
    expect(text).toContain('Rain Delay:         None');
    expect(text).toContain('Weather Adjust:     100%');
    expect(text).toContain('6:00 AM');  // sunrise
    expect(text).toContain('Firmware:           v221');
  });

  it('shows DISABLED when controller is off', async () => {
    mockApiGet.mockResolvedValueOnce(JC_DISABLED_RAIN).mockResolvedValueOnce(JO);

    const text = getText(await callTool('get_controller_status'));

    expect(text).toContain('Controller:         DISABLED');
  });

  it('shows rain delay details when active', async () => {
    mockApiGet.mockResolvedValueOnce(JC_DISABLED_RAIN).mockResolvedValueOnce(JO);

    const text = getText(await callTool('get_controller_status'));

    expect(text).toContain('12h remaining');
  });

  it('returns an error result when the API call fails', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('Unauthorized — check your OS_PASSWORD'));

    const result = await callTool('get_controller_status');

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('Unauthorized');
  });
});

// ── get_stations ──────────────────────────────────────────────────────────────

describe('get_stations', () => {
  it('lists all stations with names', async () => {
    mockApiGet
      .mockResolvedValueOnce(JN)
      .mockResolvedValueOnce(JS)
      .mockResolvedValueOnce(JC_IDLE);

    const text = getText(await callTool('get_stations'));

    expect(text).toContain('Front Lawn');
    expect(text).toContain('Back Patio');
    expect(text).toContain('Drip Zone');
    expect(text).toContain('8 total');
  });

  it('marks running stations with remaining time and program', async () => {
    mockApiGet
      .mockResolvedValueOnce(JN)
      .mockResolvedValueOnce(JS)
      .mockResolvedValueOnce(JC_RUNNING);

    const text = getText(await callTool('get_stations'));

    expect(text).toContain('RUNNING');
    expect(text).toContain('4m 30s remaining');
    expect(text).toContain('via Program 1');
  });

  it('shows DISABLED and MASTER flags', async () => {
    mockApiGet
      .mockResolvedValueOnce(JN_WITH_FLAGS)
      .mockResolvedValueOnce(JS)
      .mockResolvedValueOnce(JC_IDLE);

    const text = getText(await callTool('get_stations'));

    expect(text).toContain('[MASTER]');
    expect(text).toContain('[DISABLED]');
  });
});

// ── get_programs ──────────────────────────────────────────────────────────────

describe('get_programs', () => {
  it('shows program names, schedules, and station durations', async () => {
    mockApiGet.mockResolvedValueOnce(JP).mockResolvedValueOnce(JN);

    const text = getText(await callTool('get_programs'));

    expect(text).toContain('Morning Cycle');
    expect(text).toContain('Drip Evening');
    expect(text).toContain('Weekly');
    expect(text).toContain('Mon, Wed, Fri');
    expect(text).toContain('6:00 AM');
    expect(text).toContain('Front Lawn: 5m');
    expect(text).toContain('Back Patio: 10m');
  });

  it('shows Disabled status for disabled programs', async () => {
    mockApiGet.mockResolvedValueOnce(JP).mockResolvedValueOnce(JN);

    const text = getText(await callTool('get_programs'));

    // Program 2 (Drip Evening) has enabled bit = 0 in fixture
    const lines = text.split('\n');
    const dripIdx = lines.findIndex((l) => l.includes('Drip Evening'));
    const statusLine = lines[dripIdx + 1];
    expect(statusLine).toContain('Disabled');
  });

  it('returns a message when no programs exist', async () => {
    mockApiGet.mockResolvedValueOnce({ nprogs: 0, nbrd: 1, mnp: 40, pdata: [] });
    mockApiGet.mockResolvedValueOnce(JN);

    const text = getText(await callTool('get_programs'));
    expect(text).toBe('No programs configured.');
  });
});

// ── get_options ───────────────────────────────────────────────────────────────

describe('get_options', () => {
  it('shows firmware, hardware, and key options', async () => {
    mockApiGet.mockResolvedValueOnce(JO).mockResolvedValueOnce(JC_IDLE);

    const text = getText(await callTool('get_options'));

    expect(text).toContain('v221');
    expect(text).toContain('AC (24VAC)');
    expect(text).toContain('UTC+0:00');
    expect(text).toContain('Test Sprinklers'); // dname sourced from /jc
    expect(text).toContain('100%');
  });

  it('shows the weather method by name (not a boolean)', async () => {
    mockApiGet.mockResolvedValueOnce(JO).mockResolvedValueOnce(JC_IDLE); // uwt: 1

    const text = getText(await callTool('get_options'));

    expect(text).toContain('Weather Method:      Zimmerman');
    expect(text).not.toContain('Use Weather Adjust');
  });

  it('shows the configured location (from /jc)', async () => {
    mockApiGet.mockResolvedValueOnce(JO).mockResolvedValueOnce(JC_IDLE);

    const text = getText(await callTool('get_options'));

    expect(text).toContain('Seattle,WA');
  });

  it('shows master station on/off timing when a master is set', async () => {
    mockApiGet.mockResolvedValueOnce(JO_WITH_MASTER).mockResolvedValueOnce(JC_IDLE);

    const text = getText(await callTool('get_options'));

    expect(text).toContain('Master Station:      Station 1 (on 10s / off -5s)');
  });
});

// ── get_weather_status ────────────────────────────────────────────────────────

describe('get_weather_status', () => {
  it('shows the algorithm method, water level, and decoded wto parameters', async () => {
    mockApiGet.mockResolvedValueOnce(JC_IDLE).mockResolvedValueOnce(JO);

    const text = getText(await callTool('get_weather_status'));

    expect(text).toContain('Method:            Zimmerman');
    expect(text).toContain('Current Water Lvl: 100%');
    expect(text).toContain('Humidity weight (%)');
    expect(text).toContain('Temperature weight (%)');
    expect(text).toContain('Rain weight (%)');
  });

  it('shows recent watering levels and no weather error', async () => {
    mockApiGet.mockResolvedValueOnce(JC_IDLE).mockResolvedValueOnce(JO);

    const text = getText(await callTool('get_weather_status'));

    expect(text).toContain('80%, 90%, 100%');
    expect(text).toContain('Last Weather Error:   none');
  });

  it('reports a weather error code when present', async () => {
    mockApiGet
      .mockResolvedValueOnce({ ...JC_IDLE, wterr: -3 })
      .mockResolvedValueOnce(JO);

    const text = getText(await callTool('get_weather_status'));

    expect(text).toContain('code -3');
  });
});

// ── get_diagnostics ───────────────────────────────────────────────────────────

describe('get_diagnostics', () => {
  it('reads /db and prints the returned fields', async () => {
    mockApiGet.mockResolvedValueOnce(DB);

    const text = getText(await callTool('get_diagnostics'));

    expect(mockApiGet).toHaveBeenCalledWith('/db');
    expect(text).toContain('freemem');
    expect(text).toContain('44280');
  });
});

// ── get_watering_history ──────────────────────────────────────────────────────

describe('get_watering_history', () => {
  it('shows formatted runs with station names and source', async () => {
    mockApiGet.mockResolvedValueOnce(JL).mockResolvedValueOnce(JN);

    const text = getText(await callTool('get_watering_history', { days: 7 }));

    expect(text).toContain('Total runs: 3');
    expect(text).toContain('Front Lawn');
    expect(text).toContain('Back Patio');
    expect(text).toContain('Side Yard');
    expect(text).toContain('Program 1');
    expect(text).toContain('Manual');
    expect(text).toContain('Total watering time: 17m'); // 300+600+120 = 1020s = 17m
  });

  it('defaults to 7 days', async () => {
    mockApiGet.mockResolvedValueOnce([]).mockResolvedValueOnce(JN);

    await callTool('get_watering_history');

    expect(mockApiGet).toHaveBeenCalledWith('/jl', { hist: 7 });
  });

  it('passes custom days to the API', async () => {
    mockApiGet.mockResolvedValueOnce([]).mockResolvedValueOnce(JN);

    await callTool('get_watering_history', { days: 30 });

    expect(mockApiGet).toHaveBeenCalledWith('/jl', { hist: 30 });
  });

  it('shows a message when there are no runs', async () => {
    mockApiGet.mockResolvedValueOnce([]).mockResolvedValueOnce(JN);

    const text = getText(await callTool('get_watering_history', { days: 7 }));

    expect(text).toContain('No watering history');
  });
});

// ── get_queue_status ──────────────────────────────────────────────────────────

describe('get_queue_status', () => {
  it('reports no active stations when queue is empty', async () => {
    mockApiGet.mockResolvedValueOnce(JC_IDLE).mockResolvedValueOnce(JN);

    const text = getText(await callTool('get_queue_status'));

    expect(text).toContain('No stations currently running or queued.');
  });

  it('shows running station with remaining time', async () => {
    mockApiGet.mockResolvedValueOnce(JC_RUNNING).mockResolvedValueOnce(JN);

    const text = getText(await callTool('get_queue_status'));

    expect(text).toContain('Front Lawn');
    expect(text).toContain('RUNNING');
    expect(text).toContain('4m 30s remaining');
  });
});

// ── get_sensor_status ─────────────────────────────────────────────────────────

describe('get_sensor_status', () => {
  it('shows sensor readings and weather info', async () => {
    mockApiGet.mockResolvedValueOnce(JC_IDLE).mockResolvedValueOnce(JO);

    const text = getText(await callTool('get_sensor_status'));

    expect(text).toContain('Rain Sensor');
    expect(text).toContain('100%');
  });
});

// ── run_station ───────────────────────────────────────────────────────────────

describe('run_station', () => {
  it('calls /cm with the correct 0-based station index and duration', async () => {
    mockApiGet.mockResolvedValueOnce(CM_OK);

    await callTool('run_station', { station: 3, duration: 300 });

    expect(mockApiGet).toHaveBeenCalledWith('/cm', { sid: 2, en: 1, t: 300 });
  });

  it('returns a success message with human-readable duration', async () => {
    mockApiGet.mockResolvedValueOnce(CM_OK);

    const text = getText(await callTool('run_station', { station: 1, duration: 600 }));

    expect(text).toContain('Station 1');
    expect(text).toContain('10m');
  });

  it('returns an error result when the API fails', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('Value out of range'));

    const result = await callTool('run_station', { station: 1, duration: 300 });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('Value out of range');
  });
});

// ── stop_station ──────────────────────────────────────────────────────────────

describe('stop_station', () => {
  it('calls /cm with en=0 and the correct 0-based station index', async () => {
    mockApiGet.mockResolvedValueOnce(CM_OK);

    await callTool('stop_station', { station: 2 });

    expect(mockApiGet).toHaveBeenCalledWith('/cm', { sid: 1, en: 0, t: 0 });
  });

  it('returns a success message', async () => {
    mockApiGet.mockResolvedValueOnce(CM_OK);
    const text = getText(await callTool('stop_station', { station: 2 }));
    expect(text).toContain('Station 2 stopped');
  });
});

// ── stop_all_stations ─────────────────────────────────────────────────────────

describe('stop_all_stations', () => {
  it('calls /cv with rsn=1', async () => {
    mockApiGet.mockResolvedValueOnce(CV_OK);

    await callTool('stop_all_stations');

    expect(mockApiGet).toHaveBeenCalledWith('/cv', { rsn: 1 });
  });
});

// ── set_rain_delay ────────────────────────────────────────────────────────────

describe('set_rain_delay', () => {
  it('calls /cv with the given hours', async () => {
    mockApiGet.mockResolvedValueOnce(CV_OK);

    await callTool('set_rain_delay', { hours: 24 });

    expect(mockApiGet).toHaveBeenCalledWith('/cv', { rd: 24 });
  });

  it('returns a "set" message for positive hours', async () => {
    mockApiGet.mockResolvedValueOnce(CV_OK);
    const text = getText(await callTool('set_rain_delay', { hours: 24 }));
    expect(text).toContain('24 hours');
  });

  it('returns a "cleared" message when hours=0', async () => {
    mockApiGet.mockResolvedValueOnce(CV_OK);
    const text = getText(await callTool('set_rain_delay', { hours: 0 }));
    expect(text).toContain('cleared');
  });
});

// ── set_controller_enabled ────────────────────────────────────────────────────

describe('set_controller_enabled', () => {
  it('calls /cv with en=1 to enable', async () => {
    mockApiGet.mockResolvedValueOnce(CV_OK);

    await callTool('set_controller_enabled', { enabled: true });

    expect(mockApiGet).toHaveBeenCalledWith('/cv', { en: 1 });
  });

  it('calls /cv with en=0 to disable', async () => {
    mockApiGet.mockResolvedValueOnce(CV_OK);

    await callTool('set_controller_enabled', { enabled: false });

    expect(mockApiGet).toHaveBeenCalledWith('/cv', { en: 0 });
  });
});

// ── reboot_controller ─────────────────────────────────────────────────────────

describe('reboot_controller', () => {
  it('calls /cv with rbt=1', async () => {
    mockApiGet.mockResolvedValueOnce(CV_OK);

    await callTool('reboot_controller');

    expect(mockApiGet).toHaveBeenCalledWith('/cv', { rbt: 1 });
  });

  it('handles a dropped connection gracefully', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await callTool('reboot_controller');

    // A dropped connection is expected during reboot — not an error
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain('restarting');
  });
});

// ── run_program ───────────────────────────────────────────────────────────────

describe('run_program', () => {
  it('calls /mp with 0-based program index', async () => {
    mockApiGet.mockResolvedValueOnce(MP_OK);

    await callTool('run_program', { program: 2, use_weather_adjustment: false });

    expect(mockApiGet).toHaveBeenCalledWith('/mp', { pid: 1, uwt: 0 });
  });

  it('passes uwt=1 when weather adjustment is requested', async () => {
    mockApiGet.mockResolvedValueOnce(MP_OK);

    await callTool('run_program', { program: 1, use_weather_adjustment: true });

    expect(mockApiGet).toHaveBeenCalledWith('/mp', { pid: 0, uwt: 1 });
  });
});

// ── set_queue_paused ──────────────────────────────────────────────────────────

describe('set_queue_paused', () => {
  it('calls /pq with repl=duration to pause', async () => {
    mockApiGet.mockResolvedValueOnce(PQ_OK);

    await callTool('set_queue_paused', { duration: 3600 });

    expect(mockApiGet).toHaveBeenCalledWith('/pq', { repl: 3600 });
  });

  it('returns a paused message with formatted duration', async () => {
    mockApiGet.mockResolvedValueOnce(PQ_OK);
    const text = getText(await callTool('set_queue_paused', { duration: 3600 }));
    expect(text).toContain('1h');
  });

  it('calls /pq with repl=0 to resume', async () => {
    mockApiGet.mockResolvedValueOnce(PQ_OK);

    await callTool('set_queue_paused', { duration: 0 });

    expect(mockApiGet).toHaveBeenCalledWith('/pq', { repl: 0 });
  });

  it('returns a resumed message when duration=0', async () => {
    mockApiGet.mockResolvedValueOnce(PQ_OK);
    const text = getText(await callTool('set_queue_paused', { duration: 0 }));
    expect(text).toBe('Queue resumed.');
  });
});

// ── set_water_level ───────────────────────────────────────────────────────────

describe('set_water_level', () => {
  it('calls /co with the given water level', async () => {
    mockApiGet.mockResolvedValueOnce(CO_OK);

    await callTool('set_water_level', { level: 75 });

    expect(mockApiGet).toHaveBeenCalledWith('/co', { wl: 75 });
  });

  it('mentions the percentage in the response', async () => {
    mockApiGet.mockResolvedValueOnce(CO_OK);
    const text = getText(await callTool('set_water_level', { level: 75 }));
    expect(text).toContain('75%');
  });
});

// ── run_once_program ──────────────────────────────────────────────────────────

describe('run_once_program', () => {
  it('builds the correct full-length duration array for /cr', async () => {
    mockApiGet
      .mockResolvedValueOnce(JS)    // /js to get nstations
      .mockResolvedValueOnce(CR_OK);

    await callTool('run_once_program', {
      stations: [
        { station: 1, duration: 300 },
        { station: 3, duration: 600 },
      ],
    });

    const crCall = mockApiGet.mock.calls[1];
    expect(crCall[0]).toBe('/cr');
    const durationArray = JSON.parse(crCall[1].t as string) as number[];
    expect(durationArray[0]).toBe(300); // station 1 → index 0
    expect(durationArray[2]).toBe(600); // station 3 → index 2
    expect(durationArray[1]).toBe(0);   // station 2 → skipped
  });

  it('includes station names in the success message', async () => {
    mockApiGet.mockResolvedValueOnce(JS).mockResolvedValueOnce(CR_OK);

    const text = getText(
      await callTool('run_once_program', {
        stations: [{ station: 2, duration: 120 }],
      }),
    );

    expect(text).toContain('Station 2');
    expect(text).toContain('2m');
  });

  it('applies uwt=1 with weather adjustment', async () => {
    mockApiGet.mockResolvedValueOnce(JS).mockResolvedValueOnce(CR_OK);

    await callTool('run_once_program', {
      stations: [{ station: 1, duration: 300 }],
      use_weather_adjustment: true,
    });

    expect(mockApiGet.mock.calls[1][1]).toMatchObject({ uwt: 1 });
  });
});

// ── queue option (qo) ─────────────────────────────────────────────────────────

describe('queue_mode', () => {
  it('omits qo from /cm when not specified', async () => {
    mockApiGet.mockResolvedValueOnce(CM_OK);

    await callTool('run_station', { station: 1, duration: 300 });

    expect(mockApiGet).toHaveBeenCalledWith('/cm', { sid: 0, en: 1, t: 300 });
  });

  it('maps run_station queue_mode=replace to qo=2', async () => {
    mockApiGet.mockResolvedValueOnce(CM_OK);

    await callTool('run_station', { station: 1, duration: 300, queue_mode: 'replace' });

    expect(mockApiGet).toHaveBeenCalledWith('/cm', { sid: 0, en: 1, t: 300, qo: 2 });
  });

  it('maps run_program queue_mode=front to qo=1', async () => {
    mockApiGet.mockResolvedValueOnce(MP_OK);

    await callTool('run_program', { program: 1, queue_mode: 'front' });

    expect(mockApiGet).toHaveBeenCalledWith('/mp', { pid: 0, uwt: 0, qo: 1 });
  });

  it('maps run_once_program queue_mode=append to qo=0', async () => {
    mockApiGet.mockResolvedValueOnce(JS).mockResolvedValueOnce(CR_OK);

    await callTool('run_once_program', {
      stations: [{ station: 1, duration: 300 }],
      queue_mode: 'append',
    });

    expect(mockApiGet.mock.calls[1][1]).toMatchObject({ qo: 0 });
  });
});

// ── set_weather_method ────────────────────────────────────────────────────────

describe('set_weather_method', () => {
  it('maps method names to the uwt value via /co', async () => {
    mockApiGet.mockResolvedValueOnce(CO_OK);

    await callTool('set_weather_method', { method: 'eto' });

    expect(mockApiGet).toHaveBeenCalledWith('/co', { uwt: 3 });
  });

  it('reports the method name in the response', async () => {
    mockApiGet.mockResolvedValueOnce(CO_OK);

    const text = getText(await callTool('set_weather_method', { method: 'zimmerman' }));

    expect(text).toContain('Zimmerman');
  });
});

// ── set_weather_options ───────────────────────────────────────────────────────

describe('set_weather_options', () => {
  it('merges provided Zimmerman keys into existing wto and strips outer braces', async () => {
    mockApiGet.mockResolvedValueOnce(JC_IDLE).mockResolvedValueOnce(CO_OK); // wto read from /jc

    await callTool('set_weather_options', { humidity_weight: 40, rain_weight: 50 });

    const coCall = mockApiGet.mock.calls[1];
    expect(coCall[0]).toBe('/co');
    const wtoStr = (coCall[1] as Record<string, string>).wto;
    // No outer braces in the transmitted value
    expect(wtoStr.startsWith('{')).toBe(false);
    const parsed = JSON.parse(`{${wtoStr}}`) as Record<string, number>;
    expect(parsed.h).toBe(40); // updated
    expect(parsed.r).toBe(50); // updated
    expect(parsed.t).toBe(70); // preserved from existing wto
  });

  it('does nothing when no options are provided', async () => {
    const text = getText(await callTool('set_weather_options', {}));

    expect(text).toContain('nothing changed');
    expect(mockApiGet).not.toHaveBeenCalled();
  });
});

// ── create_program ────────────────────────────────────────────────────────────

describe('create_program', () => {
  it('builds a weekly program v-array and posts to /cp with pid=-1', async () => {
    mockApiGet.mockResolvedValueOnce(JS).mockResolvedValueOnce(CP_OK);

    await callTool('create_program', {
      name: 'Morning',
      schedule_type: 'weekly',
      days_of_week: ['mon', 'wed', 'fri'],
      start_times: ['06:00'],
      stations: [{ station: 1, duration: 600 }],
    });

    const cpCall = mockApiGet.mock.calls[1];
    expect(cpCall[0]).toBe('/cp');
    const params = cpCall[1] as Record<string, string | number>;
    expect(params.pid).toBe(-1);
    expect(params.name).toBe('Morning');
    const v = JSON.parse(params.v as string) as [number, number, number, number[], number[]];
    // flag: enabled(1) | weekly(0<<4) = 1
    expect(v[0]).toBe(1);
    // days0: Mon(bit0)+Wed(bit2)+Fri(bit4) = 21
    expect(v[1]).toBe(21);
    // start time 06:00 = 360 minutes, rest disabled
    expect(v[3]).toEqual([360, -1, -1, -1]);
    // station 1 → index 0 = 600s
    expect(v[4][0]).toBe(600);
  });

  it('encodes an interval schedule and sunset-relative start time', async () => {
    mockApiGet.mockResolvedValueOnce(JS).mockResolvedValueOnce(CP_OK);

    await callTool('create_program', {
      name: 'Drip',
      enabled: false,
      use_weather: true,
      schedule_type: 'interval',
      interval_days: 3,
      interval_offset: 1,
      start_times: ['sunset-15'],
      stations: [{ station: 2, duration: 300 }],
    });

    const v = JSON.parse((mockApiGet.mock.calls[1][1] as Record<string, string>).v) as
      [number, number, number, number[], number[]];
    // flag: !enabled(0) | weather(2) | interval(3<<4)=48 → 50
    expect(v[0]).toBe(50);
    expect(v[2]).toBe(3); // interval days
    expect(v[1]).toBe(1); // offset
    // sunset(0x2000) | negative(0x1000) | 15 = 0x300F = 12303
    expect(v[3][0]).toBe(0x2000 | 0x1000 | 15);
  });

  it('errors when a weekly program has no days', async () => {
    mockApiGet.mockResolvedValueOnce(JS);

    const result = await callTool('create_program', {
      name: 'Bad',
      schedule_type: 'weekly',
      start_times: ['06:00'],
      stations: [{ station: 1, duration: 600 }],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('at least one day');
  });
});

// ── update_program ────────────────────────────────────────────────────────────

describe('update_program', () => {
  it('posts to /cp with the 0-based program index', async () => {
    mockApiGet.mockResolvedValueOnce(JS).mockResolvedValueOnce(CP_OK);

    await callTool('update_program', {
      program: 2,
      name: 'Evening',
      schedule_type: 'weekly',
      days_of_week: ['sat', 'sun'],
      start_times: ['20:00'],
      stations: [{ station: 1, duration: 300 }],
    });

    expect((mockApiGet.mock.calls[1][1] as Record<string, number>).pid).toBe(1);
  });
});

// ── set_program_enabled ───────────────────────────────────────────────────────

describe('set_program_enabled', () => {
  it('toggles a program via /cp with the en bit', async () => {
    mockApiGet.mockResolvedValueOnce(CP_OK);

    await callTool('set_program_enabled', { program: 3, enabled: false });

    expect(mockApiGet).toHaveBeenCalledWith('/cp', { pid: 2, en: 0 });
  });
});

// ── delete_program ────────────────────────────────────────────────────────────

describe('delete_program', () => {
  it('deletes a program via /dp with the 0-based index', async () => {
    mockApiGet.mockResolvedValueOnce(DP_OK);

    await callTool('delete_program', { program: 2 });

    expect(mockApiGet).toHaveBeenCalledWith('/dp', { pid: 1 });
  });
});

// ── move_program_up ───────────────────────────────────────────────────────────

describe('move_program_up', () => {
  it('moves a program up via /up with the 0-based index', async () => {
    mockApiGet.mockResolvedValueOnce(UP_OK);

    await callTool('move_program_up', { program: 3 });

    expect(mockApiGet).toHaveBeenCalledWith('/up', { pid: 2 });
  });
});
