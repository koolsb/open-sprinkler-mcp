import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  apiGet,
  isStationRunning,
  isBitSet,
  formatDuration,
  formatTimestamp,
  minutesToTimeStr,
  decodeTimezone,
  BASE_URL,
} from './client.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function errorResult(err: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true as const,
  };
}

// Write access is enabled by default. Set OS_READ_ONLY=true (or =1) to expose
// only read-only monitoring tools and prevent any changes to the controller.
const WRITE_ENABLED =
  process.env.OS_READ_ONLY !== 'true' && process.env.OS_READ_ONLY !== '1';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'open-sprinkler-mcp',
    version: '1.0.2',
  });

  // ── READ-ONLY TOOLS ────────────────────────────────────────────────────────

  server.registerTool(
    'get_controller_status',
    {
      description:
        'Get current OpenSprinkler controller status: device time, enabled state, rain delay, weather adjustment level, sensor status, last run, and firmware info.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const [jc, jo] = await Promise.all([
          apiGet('/jc') as Promise<AnyRecord>,
          apiGet('/jo') as Promise<AnyRecord>,
        ]);

        const rainDelay =
          jc.rd > 0
            ? `${jc.rd}h remaining (until ${formatTimestamp(jc.rdst)})`
            : 'None';

        const lrun = jc.lrun as [number, number, number, number] | undefined;
        const lastRun =
          lrun && lrun[3] > 0
            ? `Station ${lrun[0] + 1}, ${formatDuration(lrun[2])}, ended ${formatTimestamp(lrun[3])}`
            : 'None';

        const hwTypes: Record<number, string> = {
          172: 'AC (24VAC)',
          220: 'DC (Latching)',
          26: 'OS-Pi',
        };

        const lines = [
          `=== OpenSprinkler Controller Status ===`,
          `URL:                ${BASE_URL}`,
          `Device Time:        ${formatTimestamp(jc.devt as number)}`,
          `Controller:         ${jc.en ? 'ENABLED' : 'DISABLED'}`,
          `Rain Delay:         ${rainDelay}`,
          `Rain Sensor:        ${jc.sn1 ? 'ACTIVE (rain detected)' : 'Clear'}`,
          `Weather Adjust:     ${jo.wl}%`,
          `Sunrise / Sunset:   ${minutesToTimeStr(jc.sunrise as number)} / ${minutesToTimeStr(jc.sunset as number)}`,
          `Boards:             ${jc.nbrd} (${(jc.nbrd as number) * 8} total station slots)`,
          `Last Run:           ${lastRun}`,
          `Current Draw:       ${jc.curr ?? 'N/A'} mA`,
          `Firmware:           v${jo.fwv}`,
          `Hardware:           v${jo.hwv} — ${hwTypes[jo.hwt as number] ?? `Type ${jo.hwt}`}`,
          `Timezone:           ${decodeTimezone(jo.tz as number)}`,
        ];

        if (jc.lwc) lines.push(`Last Weather Call:  ${formatTimestamp(jc.lwc as number)}`);
        if (jc.lswc) lines.push(`Last Successful ☁: ${formatTimestamp(jc.lswc as number)}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_stations',
    {
      description:
        'Get all irrigation stations with their names, current running/idle state, remaining runtime, and configuration flags (disabled, master, ignore-rain).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const [jn, js, jc] = await Promise.all([
          apiGet('/jn') as Promise<AnyRecord>,
          apiGet('/js') as Promise<AnyRecord>,
          apiGet('/jc') as Promise<AnyRecord>,
        ]);

        const total = js.nstations as number;
        const lines = [`=== Stations (${total} total) ===`];

        for (let i = 0; i < total; i++) {
          const name: string = jn.snames[i] ?? `Station ${i + 1}`;
          const running = isStationRunning(jc.sbits as number[], i);
          const disabled = isBitSet(jn.stn_dis as number[], i);
          const ignoreRain = isBitSet(jn.ignore_rain as number[], i);
          const isMaster = isBitSet(jn.masop as number[], i);
          const isMaster2 = jn.masop2 ? isBitSet(jn.masop2 as number[], i) : false;

          const ps = jc.ps as [number, number, number, number][];
          const remaining = running && ps?.[i]?.[1] > 0 ? ps[i][1] : 0;
          const programId = running && ps?.[i]?.[0] > 0 ? ps[i][0] : 0;

          const flags: string[] = [];
          if (disabled) flags.push('DISABLED');
          if (isMaster) flags.push('MASTER');
          if (isMaster2) flags.push('MASTER-2');
          if (ignoreRain) flags.push('IGNORE-RAIN');

          const icon = disabled ? '○' : running ? '▶' : '·';
          const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
          let statusStr = '';
          if (running) {
            const remStr = remaining > 0 ? `, ${formatDuration(remaining)} remaining` : '';
            let progStr = '';
            if (programId === 99) progStr = ' (Manual)';
            else if (programId === 254 || programId === 255) progStr = ' (Run-Once)';
            else if (programId > 0) progStr = ` via Program ${programId}`;
            statusStr = `  ← RUNNING${remStr}${progStr}`;
          }

          lines.push(`  ${icon} [${(i + 1).toString().padStart(2, ' ')}] ${name}${statusStr}${flagStr}`);
        }

        lines.push('');
        lines.push('Legend: ▶ Running  · Idle  ○ Disabled');

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_programs',
    {
      description:
        'Get all watering programs with their schedules, start times, station durations, and settings.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const [jp, jn] = await Promise.all([
          apiGet('/jp') as Promise<AnyRecord>,
          apiGet('/jn') as Promise<AnyRecord>,
        ]);

        if (!jp.nprogs || jp.nprogs === 0) {
          return { content: [{ type: 'text', text: 'No programs configured.' }] };
        }

        const lines = [`=== Watering Programs (${jp.nprogs}) ===`];
        // bits[4-5]: 0=Weekly, 1=Single-run (specific date), 2=Monthly, 3=Interval-day
        const SCHED_TYPES = ['Weekly', 'Single-run', 'Monthly', 'Interval'];
        const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        // Date restriction encoding: (month << 5) + day
        function decodeDateRestriction(val: number): string {
          const month = val >> 5;
          const day = val & 0x1F;
          return `${MONTH_NAMES[month - 1] ?? `M${month}`} ${day}`;
        }

        // Decode a single start-time slot value (16-bit, may be sunrise/sunset-relative or -1=disabled)
        function decodeStartTimeSlot(val: number): string | null {
          if (val < 0) return null; // bit[15] set → disabled
          if (val & 0x4000) { // bit[14] = sunrise-based
            const offset = val & 0x07FF;
            const sign = (val & 0x1000) ? -1 : 1;
            const signStr = sign > 0 ? `+${offset}` : `-${offset}`;
            return `Sunrise${signStr}min`;
          }
          if (val & 0x2000) { // bit[13] = sunset-based
            const offset = val & 0x07FF;
            const sign = (val & 0x1000) ? -1 : 1;
            const signStr = sign > 0 ? `+${offset}` : `-${offset}`;
            return `Sunset${signStr}min`;
          }
          return minutesToTimeStr(val); // standard time (0-1439)
        }

        const programs = (jp.pd ?? jp.pdata) as Array<[number, number, number, number[], number[], string, number[]?]>;
        for (let i = 0; i < jp.nprogs; i++) {
          const prog = programs[i];
          const [flag, days0, days1, startTimes, durations, name, dateRange] = prog;

          const enabled = !!(flag & 0x01);
          const useWeather = !!(flag & 0x02);
          const schedType = (flag >> 4) & 0x03;
          // bit[6]: 0 = fixed start times (up to 4, each independent), 1 = repeating (start/count/interval)
          const isRepeating = !!((flag >> 6) & 0x01);

          lines.push('');
          lines.push(`[${i + 1}] ${name ?? `Program ${i + 1}`}`);
          lines.push(`  Status:       ${enabled ? 'Enabled' : 'Disabled'}`);
          lines.push(`  Schedule:     ${SCHED_TYPES[schedType] ?? 'Unknown'}`);
          lines.push(`  Weather Adj:  ${useWeather ? 'Yes' : 'No'}`);

          if (dateRange && dateRange[0] === 1 && dateRange[1] && dateRange[2]) {
            lines.push(`  Active:       ${decodeDateRestriction(dateRange[1])} – ${decodeDateRestriction(dateRange[2])}`);
          }

          if (schedType === 0) {
            // Weekly: days0.bits[0-6] = Mon..Sun
            const activeDays = DAY_NAMES.filter((_, idx) => days0 & (1 << idx));
            lines.push(`  Days:         ${activeDays.length > 0 ? activeDays.join(', ') : 'None'}`);
          } else if (schedType === 1) {
            // Single-run: days0 (low byte) + days1 (high byte) = days since Unix epoch
            const dayIndex = (days1 << 8) | days0;
            const runDate = new Date(dayIndex * 86400 * 1000);
            const dateStr = runDate.toISOString().slice(0, 10); // YYYY-MM-DD
            lines.push(`  Run Date:     ${dateStr}`);
          } else if (schedType === 2) {
            // Monthly: days0 is day of month 1-31 (0 = last day)
            const dayLabel = days0 === 0 ? 'Last day' : `Day ${days0}`;
            lines.push(`  Day of Month: ${dayLabel}`);
          } else if (schedType === 3) {
            // Interval: days1 = every N days, days0 = starting offset (remainder)
            lines.push(`  Every:        ${days1} day${days1 === 1 ? '' : 's'}`);
            lines.push(`  Starting in:  ${days0} day${days0 === 1 ? '' : 's'}`);
          }

          if (!isRepeating) {
            // Fixed mode (bit[6]=0): start0..3 are independent times; -1 = disabled slot
            const active = (startTimes as number[])
              .map((t) => decodeStartTimeSlot(t))
              .filter((s): s is string => s !== null);
            lines.push(`  Start Times:  ${active.length > 0 ? active.join(', ') : 'None'}`);
          } else {
            // Repeating mode (bit[6]=1): [firstTime, repeatCount, intervalMinutes, unused]
            const [firstTime, repeatCount, intervalMin] = startTimes as number[];
            const firstStr = decodeStartTimeSlot(firstTime);
            if (firstStr !== null) {
              lines.push(`  Starts:       ${firstStr}`);
              if (repeatCount > 0 && intervalMin > 0) {
                lines.push(`  Repeats:      Every ${formatDuration(intervalMin * 60)}, ${repeatCount} more time${repeatCount === 1 ? '' : 's'}`);
              }
            }
          }

          const stationEntries: string[] = [];
          for (let sid = 0; sid < (durations as number[]).length; sid++) {
            const dur = (durations as number[])[sid];
            if (dur > 0) {
              const stName = jn.snames?.[sid] ?? `Station ${sid + 1}`;
              stationEntries.push(`    [${sid + 1}] ${stName}: ${formatDuration(dur)}`);
            }
          }
          if (stationEntries.length > 0) {
            lines.push(`  Stations:`);
            lines.push(...stationEntries);
          } else {
            lines.push(`  Stations:     None configured`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_options',
    {
      description:
        'Get the controller configuration options and settings (firmware, hardware, network, sensor config, water level, etc.).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const jo = (await apiGet('/jo')) as AnyRecord;

        const hwTypes: Record<number, string> = {
          172: 'AC (24VAC)',
          220: 'DC (Latching)',
          26: 'OS-Pi',
        };

        const lines = [
          '=== Controller Options ===',
          `Firmware Version:    v${jo.fwv}`,
          `Hardware Version:    v${jo.hwv}  ${hwTypes[jo.hwt as number] ?? `(Type ${jo.hwt})`}`,
          `Device Name:         ${jo.dname ?? '(not set)'}`,
          `Timezone:            ${decodeTimezone(jo.tz as number)}`,
          `NTP Sync:            ${jo.ntp ? 'Enabled' : 'Disabled'}`,
          `DHCP:                ${jo.dhcp ? 'Enabled (DHCP)' : 'Disabled (Static IP)'}`,
          `Water Level:         ${jo.wl}%  (weather-based adjustment)`,
          `Use Weather Adjust:  ${jo.uwt ? 'Enabled' : 'Disabled'}`,
          `Station Delay:       ${jo.sdt}s between stations`,
          `Sequential Mode:     ${jo.seq ? 'Yes (one station at a time)' : 'No (parallel)'}`,
          `Master Station:      ${jo.mas > 0 ? `Station ${jo.mas}` : 'None'}`,
          `Master Station 2:    ${jo.mas2 > 0 ? `Station ${jo.mas2}` : 'None'}`,
          `Sensor 1:            ${jo.sn1t > 0 && jo.sn1t !== 240 ? `Enabled (${jo.sn1o ? 'Normally Open' : 'Normally Closed'})` : 'Disabled'}`,
          `Sensor 2:            ${jo.sn2t !== undefined && jo.sn2t > 0 && jo.sn2t !== 240 ? `Enabled (${jo.sn2o ? 'Normally Open' : 'Normally Closed'})` : 'Disabled'}`,
          `Expansion Boards:    ${jo.ext}`,
          `Logging:             ${jo.lg ? 'Enabled' : 'Disabled'}`,
          `Device ID:           ${jo.devid ?? 'N/A'}`,
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_watering_history',
    {
      description:
        'Get the watering history log showing past station runs with start time, duration, and source program. Defaults to the last 7 days.',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(7)
          .describe('Number of past days to retrieve (default: 7, max: 365)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      try {
        const [rawLog, jn] = await Promise.all([
          apiGet('/jl', { hist: days }),
          apiGet('/jn') as Promise<AnyRecord>,
        ]);

        const allRecords = Array.isArray(rawLog) ? rawLog : [];

        // Special events: pid=0 AND sid is a string code (rd, wl, s1, s2, fl) — not watering runs
        const wateringRecords = allRecords.filter((r) => !(r[0] === 0 && typeof r[1] === 'string'));

        if (wateringRecords.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No watering history found for the past ${days} day${days === 1 ? '' : 's'}.`,
              },
            ],
          };
        }

        const sorted = [...wateringRecords].sort((a: number[], b: number[]) => b[3] - a[3]);

        let totalDuration = 0;
        const lines = [
          `=== Watering History — Last ${days} Day${days === 1 ? '' : 's'} ===`,
          `Total runs: ${wateringRecords.length}`,
          '',
          `${'Date/Time'.padEnd(24)} | ${'Station'.padEnd(24)} | ${'Duration'.padEnd(10)} | Source`,
          `${'-'.repeat(24)}-+-${'-'.repeat(24)}-+-${'-'.repeat(10)}-+--------`,
        ];

        for (const record of sorted) {
          const [pid, sid, duration, endTime, flow] = record as [number, number, number, number, number?];
          totalDuration += duration;
          const startTime = endTime - duration;
          const stName = jn.snames?.[sid] ?? `Station ${sid + 1}`;
          const stLabel = `[${sid + 1}] ${stName}`.slice(0, 24);

          let source: string;
          if (pid === 0) source = 'Manual';
          else if (pid === 99 || pid === 254 || pid === 255) source = 'Run-Once';
          else source = `Program ${pid}`;

          const flowStr = flow && flow > 0 ? `  flow:${flow}` : '';
          lines.push(
            `${formatTimestamp(startTime).padEnd(24)} | ${stLabel.padEnd(24)} | ${formatDuration(duration).padEnd(10)} | ${source}${flowStr}`,
          );
        }

        lines.push('');
        lines.push(`Total watering time: ${formatDuration(totalDuration)}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_queue_status',
    {
      description:
        'Get the current watering queue showing all active and queued station runs with remaining times and source programs.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const [jc, jn] = await Promise.all([
          apiGet('/jc') as Promise<AnyRecord>,
          apiGet('/jn') as Promise<AnyRecord>,
        ]);

        const ps = jc.ps as [number, number][];
        const sbits = jc.sbits as number[];
        const activeLines: string[] = [];

        if (ps) {
          for (let i = 0; i < ps.length; i++) {
            const [pid, rem] = ps[i];
            const running = isStationRunning(sbits, i);
            if (running || (pid > 0 && rem > 0)) {
              const stName = jn.snames?.[i] ?? `Station ${i + 1}`;
              let source: string;
              if (pid === 0) source = 'Manual';
              else if (pid === 99 || pid === 255) source = 'Run-Once';
              else source = `Program ${pid}`;
              const state = running ? 'RUNNING' : 'QUEUED';
              activeLines.push(
                `  [${i + 1}] ${stName} — ${state}, ${formatDuration(rem)} remaining [${source}]`,
              );
            }
          }
        }

        const lrun = jc.lrun as [number, number, number, number] | undefined;
        const lastRun =
          lrun && lrun[3] > 0
            ? `Station ${lrun[0] + 1} ran for ${formatDuration(lrun[2])}, ended ${formatTimestamp(lrun[3])}`
            : 'None';

        const lines = ['=== Current Queue ==='];
        lines.push(...(activeLines.length > 0 ? activeLines : ['  No stations currently running or queued.']));
        lines.push('');
        lines.push(`Last completed run: ${lastRun}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_sensor_status',
    {
      description:
        'Get the status of all connected sensors (rain sensor, soil sensor, flow sensor) and current weather data from the controller.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const [jc, jo] = await Promise.all([
          apiGet('/jc') as Promise<AnyRecord>,
          apiGet('/jo') as Promise<AnyRecord>,
        ]);

        const lines = ['=== Sensor & Weather Status ==='];

        if (jo.sn1t > 0 && jo.sn1t !== 240) {
          const sn1Types: Record<number, string> = { 1: 'Rain Sensor', 2: 'Flow Sensor', 3: 'Soil Sensor' };
          const sn1Label = sn1Types[jo.sn1t as number] ?? `Type ${jo.sn1t}`;
          lines.push(`Sensor 1 (${sn1Label}): ${jc.sn1 ? 'ACTIVE' : 'Clear'} (${jo.sn1o ? 'Normally Open' : 'Normally Closed'})`);
        } else {
          lines.push('Sensor 1:          Not configured');
        }

        if (jo.sn2t !== undefined && jo.sn2t > 0) {
          const sn2Types: Record<number, string> = { 1: 'Rain Sensor', 2: 'Flow Sensor', 3: 'Soil Sensor', 240: 'Disabled' };
          lines.push(`Sensor 2:          ${sn2Types[jo.sn2t as number] ?? `Type ${jo.sn2t}`}`);
        }

        if (jc.flcrt !== undefined) {
          lines.push(`Flow Count:        ${jc.flcrt} (window: ${jc.flwrt ?? 0})`);
        }

        lines.push(
          jc.rd > 0
            ? `Rain Delay:        Active — ${jc.rd}h remaining (until ${formatTimestamp(jc.rdst as number)})`
            : 'Rain Delay:        None',
        );

        lines.push('', '--- Weather ---', `Water Level:       ${jo.wl}% (weather adjustment)`);
        if (jc.lswc) lines.push(`Last Weather Sync: ${formatTimestamp(jc.lswc as number)}`);
        if (jc.lwc) lines.push(`Last Weather Call: ${formatTimestamp(jc.lwc as number)}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── WRITE TOOLS (omitted when OS_READ_ONLY=true) ───────────────────────────

  if (WRITE_ENABLED) {
    server.registerTool(
      'run_station',
      {
        description: 'Start a specific irrigation station for a given duration in seconds.',
        inputSchema: {
          station: z.number().int().min(1).describe('Station number (1-based, e.g. 1 for the first station)'),
          duration: z.number().int().min(1).max(64800).describe('Run duration in seconds (1–64800, i.e. up to 18 hours)'),
        },
        annotations: { destructiveHint: false },
      },
      async ({ station, duration }) => {
        try {
          await apiGet('/cm', { sid: station - 1, en: 1, t: duration });
          return { content: [{ type: 'text', text: `Station ${station} started for ${formatDuration(duration)}.` }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'stop_station',
      {
        description: 'Stop a currently running irrigation station.',
        inputSchema: {
          station: z.number().int().min(1).describe('Station number (1-based)'),
        },
        annotations: { idempotentHint: true },
      },
      async ({ station }) => {
        try {
          await apiGet('/cm', { sid: station - 1, en: 0, t: 0 });
          return { content: [{ type: 'text', text: `Station ${station} stopped.` }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'stop_all_stations',
      {
        description: 'Immediately stop all running irrigation stations and clear the run queue.',
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      async () => {
        try {
          await apiGet('/cv', { rsn: 1 });
          return { content: [{ type: 'text', text: 'All stations stopped and queue cleared.' }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'set_rain_delay',
      {
        description:
          'Set a rain delay. While active the controller skips all scheduled watering. Pass 0 to clear an existing delay.',
        inputSchema: {
          hours: z.number().int().min(0).max(32767).describe('Delay duration in hours. Use 0 to clear an existing delay.'),
        },
        annotations: { idempotentHint: true },
      },
      async ({ hours }) => {
        try {
          await apiGet('/cv', { rd: hours });
          const msg =
            hours === 0
              ? 'Rain delay cleared. Scheduled watering will resume normally.'
              : `Rain delay set to ${hours} hour${hours === 1 ? '' : 's'}.`;
          return { content: [{ type: 'text', text: msg }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'set_controller_enabled',
      {
        description:
          'Enable or disable the OpenSprinkler controller. When disabled, no automatic or manual watering will run.',
        inputSchema: {
          enabled: z.boolean().describe('true to enable the controller, false to disable it'),
        },
        annotations: { idempotentHint: true },
      },
      async ({ enabled }) => {
        try {
          await apiGet('/cv', { en: enabled ? 1 : 0 });
          return { content: [{ type: 'text', text: `Controller ${enabled ? 'enabled' : 'disabled'}.` }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'reboot_controller',
      {
        description:
          'Reboot the OpenSprinkler controller. The device will restart and be briefly unavailable (typically 10–30 seconds).',
        annotations: { destructiveHint: true },
      },
      async () => {
        try {
          await apiGet('/cv', { rbt: 1 });
          return {
            content: [{ type: 'text', text: 'Reboot command sent. The controller is restarting — it will be available again in 10–30 seconds.' }],
          };
        } catch (err) {
          // A dropped connection is expected — the device cuts it on reboot
          const msg = (err as Error).message ?? '';
          if (
            msg.includes('ECONNRESET') ||
            msg.includes('ECONNREFUSED') ||
            msg.includes('timed out') ||
            msg.includes('aborted') ||
            msg.includes('fetch')
          ) {
            return {
              content: [{ type: 'text', text: 'Reboot command sent (connection dropped as expected). The controller is restarting.' }],
            };
          }
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'run_program',
      {
        description: 'Immediately run a saved watering program.',
        inputSchema: {
          program: z.number().int().min(1).describe('Program number (1-based)'),
          use_weather_adjustment: z
            .boolean()
            .default(false)
            .describe('Apply weather-based water level adjustment to station durations'),
        },
        annotations: { destructiveHint: false },
      },
      async ({ program, use_weather_adjustment }) => {
        try {
          await apiGet('/mp', { pid: program - 1, uwt: use_weather_adjustment ? 1 : 0 });
          return {
            content: [{
              type: 'text',
              text: `Program ${program} started${use_weather_adjustment ? ' with weather adjustment' : ''}.`,
            }],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'set_queue_paused',
      {
        description:
          'Pause or resume the watering queue. While paused, active stations finish but no new stations from the queue start. Pass duration=0 to resume immediately.',
        inputSchema: {
          duration: z.number().int().min(0).max(86400).describe('Pause duration in seconds. Pass 0 to resume the queue.'),
        },
        annotations: { idempotentHint: true },
      },
      async ({ duration }) => {
        try {
          await apiGet('/pq', { repl: duration });
          const msg = duration === 0 ? 'Queue resumed.' : `Queue paused for ${formatDuration(duration)}.`;
          return { content: [{ type: 'text', text: msg }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'set_water_level',
      {
        description:
          'Manually override the water level percentage used to scale all station durations. 100% = no adjustment, 50% = half duration, 150% = 1.5× duration.',
        inputSchema: {
          level: z.number().int().min(0).max(250).describe('Water level percentage (0–250). 100 = normal duration.'),
        },
        annotations: { idempotentHint: true },
      },
      async ({ level }) => {
        try {
          await apiGet('/co', { wl: level });
          return {
            content: [{ type: 'text', text: `Water level set to ${level}%. All program durations will be scaled accordingly.` }],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'run_once_program',
      {
        description:
          'Run a custom one-off watering sequence with specific durations per station. Useful for ad-hoc watering without creating a permanent program.',
        inputSchema: {
          stations: z
            .array(
              z.object({
                station: z.number().int().min(1).describe('Station number (1-based)'),
                duration: z.number().int().min(0).describe('Duration in seconds (0 to skip this station)'),
              }),
            )
            .min(1)
            .describe('List of stations and their durations for this one-time run'),
          use_weather_adjustment: z
            .boolean()
            .default(false)
            .describe('Apply weather-based water level adjustment to durations'),
        },
        annotations: { destructiveHint: false },
      },
      async ({ stations, use_weather_adjustment }) => {
        try {
          const js = (await apiGet('/js')) as AnyRecord;
          const total = js.nstations as number;

          const durationArray = new Array<number>(total).fill(0);
          for (const { station, duration } of stations) {
            const idx = station - 1;
            if (idx >= 0 && idx < total) durationArray[idx] = duration;
          }

          await apiGet('/cr', { t: JSON.stringify(durationArray), uwt: use_weather_adjustment ? 1 : 0 });

          const summary = stations
            .filter((s) => s.duration > 0)
            .map((s) => `Station ${s.station}: ${formatDuration(s.duration)}`)
            .join(', ');

          return {
            content: [{
              type: 'text',
              text: `Run-once program started: ${summary}${use_weather_adjustment ? ' (weather adjusted)' : ''}.`,
            }],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  } // end if (WRITE_ENABLED)

  return server;
}
