import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
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

// Weather adjustment method (jo.uwt). This is NOT a boolean — it selects which
// algorithm the controller uses to compute the watering percentage (wl).
const WEATHER_METHODS: Record<number, string> = {
  0: 'Manual (no automatic adjustment)',
  1: 'Zimmerman',
  2: 'Auto Rain Delay',
  3: 'Evapotranspiration (ETo)',
  4: 'Monthly',
};

// Map the friendly method names accepted by set_weather_method to their uwt value.
const WEATHER_METHOD_VALUES: Record<string, number> = {
  manual: 0,
  zimmerman: 1,
  rain_delay: 2,
  eto: 3,
  monthly: 4,
};

// Friendly labels for known weather-option (wto) keys. Unknown keys are still
// shown raw, so nothing is hidden regardless of method or weather provider.
const WTO_LABELS: Record<string, string> = {
  h: 'Humidity weight (%)',
  t: 'Temperature weight (%)',
  r: 'Rain weight (%)',
  bh: 'Baseline humidity (%)',
  bt: 'Baseline temperature (°F)',
  br: 'Baseline rain (in)',
  elevation: 'Elevation',
  baseETo: 'Base ETo (in/day)',
  key: 'Weather API key',
};

// Queue option (qo) shared by /cm, /mp, /cr on firmware 2.2.1+.
const QUEUE_MODES: Record<string, number> = { append: 0, front: 1, replace: 2 };

const DOW = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Encode a start-time string into OpenSprinkler's 16-bit slot value — the inverse
// of the decoder used by get_programs. Accepts "HH:MM" (24-hour) or a
// sunrise/sunset reference with an optional +/- minute offset (e.g. "sunset-15").
export function encodeStartTimeSlot(input: string): number {
  const s = input.trim().toLowerCase();
  const rel = s.match(/^(sunrise|sunset)\s*([+-]\s*\d+)?$/);
  if (rel) {
    const base = rel[1] === 'sunrise' ? 0x4000 : 0x2000;
    const offset = rel[2] ? parseInt(rel[2].replace(/\s+/g, ''), 10) : 0;
    const sign = offset < 0 ? 0x1000 : 0;
    return base | sign | (Math.abs(offset) & 0x07ff);
  }
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    if (h > 23 || m > 59) {
      throw new Error(`Invalid time "${input}" — hours must be 0-23 and minutes 0-59.`);
    }
    return h * 60 + m;
  }
  throw new Error(`Invalid start time "${input}" — use "HH:MM", "sunrise", "sunset+30", etc.`);
}

export function createMcpServer(): McpServer {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json') as { version: string };

  const server = new McpServer({
    name: 'open-sprinkler-mcp',
    version,
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
        // Device name and location live in /jc (controller vars), not /jo.
        const [jo, jc] = await Promise.all([
          apiGet('/jo') as Promise<AnyRecord>,
          apiGet('/jc') as Promise<AnyRecord>,
        ]);

        const hwTypes: Record<number, string> = {
          172: 'AC (24VAC)',
          220: 'DC (Latching)',
          26: 'OS-Pi',
        };

        const loc = jc.loc ?? jo.loc;
        const lines = [
          '=== Controller Options ===',
          `Firmware Version:    v${jo.fwv}`,
          `Hardware Version:    v${jo.hwv}  ${hwTypes[jo.hwt as number] ?? `(Type ${jo.hwt})`}`,
          `Device Name:         ${jc.dname ?? jo.dname ?? '(not set)'}`,
          `Location:            ${loc ? loc : '(not set)'}`,
          `Timezone:            ${decodeTimezone(jo.tz as number)}`,
          `NTP Sync:            ${jo.ntp ? 'Enabled' : 'Disabled'}`,
          `DHCP:                ${jo.dhcp ? 'Enabled (DHCP)' : 'Disabled (Static IP)'}`,
          `Water Level:         ${jo.wl}%  (current weather-based adjustment)`,
          `Weather Method:      ${WEATHER_METHODS[jo.uwt as number] ?? `Unknown (${jo.uwt})`}`,
          `Station Delay:       ${jo.sdt}s between stations`,
          `Sequential Mode:     ${jo.seq ? 'Yes (one station at a time)' : 'No (parallel)'}`,
          `Master Station:      ${jo.mas > 0 ? `Station ${jo.mas} (on ${jo.mton ?? 0}s / off ${jo.mtof ?? 0}s)` : 'None'}`,
          `Master Station 2:    ${jo.mas2 > 0 ? `Station ${jo.mas2} (on ${jo.mton2 ?? 0}s / off ${jo.mtof2 ?? 0}s)` : 'None'}`,
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

  server.registerTool(
    'get_weather_status',
    {
      description:
        'Explain how the current watering percentage is calculated: the weather adjustment method (algorithm), its tunable parameters, the resulting water level, configured location, recent weather sync times, and any weather-server errors.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const [jc, jo] = await Promise.all([
          apiGet('/jc') as Promise<AnyRecord>,
          apiGet('/jo') as Promise<AnyRecord>,
        ]);

        const method = WEATHER_METHODS[jo.uwt as number] ?? `Unknown (${jo.uwt})`;
        const loc = jc.loc ?? jo.loc; // location lives in /jc
        const lines = [
          '=== Weather Adjustment ===',
          `Method:            ${method}`,
          `Current Water Lvl: ${jo.wl}%  (scales all program durations)`,
          `Location:          ${loc ? loc : '(not set)'}`,
        ];

        // Multi-day average watering levels, when the provider returns them.
        const wls = jc.wls as number[] | undefined;
        if (Array.isArray(wls) && wls.length > 0) {
          lines.push(`Recent Levels:     ${wls.map((v) => `${v}%`).join(', ')} (most recent first)`);
        }

        // Tunable algorithm parameters (wto) are reported in /jc. Decode known
        // keys; always show the rest raw regardless of method or weather provider.
        const wto = (jc.wto ?? jo.wto) as AnyRecord | undefined;
        lines.push('', '--- Algorithm Parameters (wto) ---');
        if (wto && typeof wto === 'object' && Object.keys(wto).length > 0) {
          for (const [key, value] of Object.entries(wto)) {
            const label = WTO_LABELS[key] ?? key;
            const shown = key === 'key' ? '(set)' : String(value);
            lines.push(`  ${label.padEnd(24)} ${shown}`);
          }
        } else if (!jo.uwt) {
          lines.push('  None — manual mode, no automatic adjustment.');
        } else {
          lines.push('  (none set — using method defaults)');
        }

        lines.push('', '--- Weather Sync ---');
        lines.push(`Last Weather Call:    ${formatTimestamp(jc.lwc as number)}`);
        lines.push(`Last Successful Sync: ${formatTimestamp(jc.lswc as number)}`);
        lines.push(
          jc.wterr !== undefined && jc.wterr !== 0
            ? `Last Weather Error:   code ${jc.wterr} (weather server returned an error on the last call)`
            : 'Last Weather Error:   none',
        );
        if (jc.wtdata !== undefined) {
          const raw = typeof jc.wtdata === 'object' ? JSON.stringify(jc.wtdata) : String(jc.wtdata);
          lines.push(`Raw Weather Data:     ${raw}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_diagnostics',
    {
      description:
        'Get low-level device diagnostics from the controller (firmware build info, free memory/heap, and other debug data). Useful for troubleshooting device health.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const db = (await apiGet('/db')) as AnyRecord;
        if (!db || typeof db !== 'object' || Object.keys(db).length === 0) {
          return { content: [{ type: 'text', text: 'No diagnostics data returned by the controller.' }] };
        }
        const lines = ['=== Device Diagnostics ==='];
        for (const [key, value] of Object.entries(db)) {
          if (key === 'result') continue;
          lines.push(`  ${key.padEnd(16)} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
        }
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
          queue_mode: z
            .enum(['append', 'front', 'replace'])
            .optional()
            .describe('How to queue this run: "append" (after existing runs, default), "front" (insert ahead), "replace" (clear the queue first).'),
        },
        annotations: { destructiveHint: false },
      },
      async ({ station, duration, queue_mode }) => {
        try {
          const params: Record<string, number> = { sid: station - 1, en: 1, t: duration };
          if (queue_mode) params.qo = QUEUE_MODES[queue_mode];
          await apiGet('/cm', params);
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
          queue_mode: z
            .enum(['append', 'front', 'replace'])
            .optional()
            .describe('How to queue this program: "append" (after existing runs, default), "front" (insert ahead), "replace" (clear the queue first).'),
        },
        annotations: { destructiveHint: false },
      },
      async ({ program, use_weather_adjustment, queue_mode }) => {
        try {
          const params: Record<string, number> = { pid: program - 1, uwt: use_weather_adjustment ? 1 : 0 };
          if (queue_mode) params.qo = QUEUE_MODES[queue_mode];
          await apiGet('/mp', params);
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
          queue_mode: z
            .enum(['append', 'front', 'replace'])
            .optional()
            .describe('How to queue this run: "append" (after existing runs, default), "front" (insert ahead), "replace" (clear the queue first).'),
        },
        annotations: { destructiveHint: false },
      },
      async ({ stations, use_weather_adjustment, queue_mode }) => {
        try {
          const js = (await apiGet('/js')) as AnyRecord;
          const total = js.nstations as number;

          const durationArray = new Array<number>(total).fill(0);
          for (const { station, duration } of stations) {
            const idx = station - 1;
            if (idx >= 0 && idx < total) durationArray[idx] = duration;
          }

          const params: Record<string, string | number> = {
            t: JSON.stringify(durationArray),
            uwt: use_weather_adjustment ? 1 : 0,
          };
          if (queue_mode) params.qo = QUEUE_MODES[queue_mode];
          await apiGet('/cr', params);

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
    server.registerTool(
      'set_weather_method',
      {
        description:
          'Set the weather adjustment algorithm the controller uses to compute the watering percentage. Options: "manual" (no adjustment), "zimmerman", "rain_delay" (auto rain delay), "eto" (evapotranspiration), "monthly".',
        inputSchema: {
          method: z
            .enum(['manual', 'zimmerman', 'rain_delay', 'eto', 'monthly'])
            .describe('Weather adjustment method'),
        },
        annotations: { idempotentHint: true },
      },
      async ({ method }) => {
        try {
          const uwt = WEATHER_METHOD_VALUES[method];
          await apiGet('/co', { uwt });
          return { content: [{ type: 'text', text: `Weather method set to ${WEATHER_METHODS[uwt]}.` }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'set_weather_options',
      {
        description:
          'Tune the Zimmerman weather algorithm parameters (weights and baselines for humidity, temperature, and rain). Only the values you provide are changed; existing options are preserved. Applies when the weather method is Zimmerman.',
        inputSchema: {
          humidity_weight: z.number().int().min(0).max(500).optional().describe('Humidity factor weight, % (Zimmerman "h")'),
          temperature_weight: z.number().int().min(0).max(500).optional().describe('Temperature factor weight, % (Zimmerman "t")'),
          rain_weight: z.number().int().min(0).max(500).optional().describe('Rain factor weight, % (Zimmerman "r")'),
          baseline_humidity: z.number().int().min(0).max(100).optional().describe('Baseline humidity, % (Zimmerman "bh")'),
          baseline_temperature: z.number().int().min(0).max(150).optional().describe('Baseline temperature, °F (Zimmerman "bt")'),
          baseline_rain: z.number().min(0).max(100).optional().describe('Baseline rainfall, inches (Zimmerman "br")'),
        },
        annotations: { idempotentHint: true },
      },
      async (args) => {
        try {
          const keyMap: Record<string, string> = {
            humidity_weight: 'h',
            temperature_weight: 't',
            rain_weight: 'r',
            baseline_humidity: 'bh',
            baseline_temperature: 'bt',
            baseline_rain: 'br',
          };

          const changed: string[] = [];
          const patch: AnyRecord = {};
          for (const [argKey, wtoKey] of Object.entries(keyMap)) {
            const v = (args as AnyRecord)[argKey];
            if (v !== undefined) {
              patch[wtoKey] = v;
              changed.push(`${argKey}=${v}`);
            }
          }
          if (changed.length === 0) {
            return { content: [{ type: 'text', text: 'No options provided — nothing changed.' }] };
          }

          // Read current options and merge so unrelated keys (other weights, the
          // weather API key, etc.) are preserved. wto is reported in /jc, not /jo.
          const jc = (await apiGet('/jc')) as AnyRecord;
          const merged =
            jc.wto && typeof jc.wto === 'object' ? { ...(jc.wto as AnyRecord), ...patch } : patch;

          // OpenSprinkler stores wto as JSON *without* the outer braces; it re-wraps
          // them when reporting the value back via /jo and /jc.
          const inner = JSON.stringify(merged).slice(1, -1);
          await apiGet('/co', { wto: inner });
          return { content: [{ type: 'text', text: `Weather options updated: ${changed.join(', ')}.` }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    // Shared schedule + station schema for creating and editing programs.
    const programShape = {
      name: z.string().min(1).max(32).describe('Program name'),
      enabled: z.boolean().default(true).describe('Whether the program is enabled'),
      use_weather: z
        .boolean()
        .default(false)
        .describe('Apply the weather-based water level adjustment to this program'),
      schedule_type: z
        .enum(['weekly', 'interval'])
        .describe('"weekly" runs on chosen days of the week; "interval" runs every N days'),
      days_of_week: z
        .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
        .optional()
        .describe('Days to run (required for "weekly")'),
      interval_days: z
        .number()
        .int()
        .min(1)
        .max(255)
        .optional()
        .describe('Run every N days (required for "interval")'),
      interval_offset: z
        .number()
        .int()
        .min(0)
        .max(254)
        .default(0)
        .describe('Days from today before the first interval run (for "interval")'),
      start_times: z
        .array(z.string())
        .min(1)
        .max(4)
        .describe('Up to 4 start times as "HH:MM" (24h) or sunrise/sunset offsets like "sunrise+15", "sunset-30"'),
      stations: z
        .array(
          z.object({
            station: z.number().int().min(1).describe('Station number (1-based)'),
            duration: z.number().int().min(0).max(64800).describe('Run duration in seconds (0 to skip)'),
          }),
        )
        .min(1)
        .describe('Per-station run durations'),
    };

    type ProgramArgs = {
      name: string;
      enabled: boolean;
      use_weather: boolean;
      schedule_type: 'weekly' | 'interval';
      days_of_week?: string[];
      interval_days?: number;
      interval_offset: number;
      start_times: string[];
      stations: { station: number; duration: number }[];
    };

    // Build the /cp `v` program-definition array: [flag, days0, days1, starts[4], durations[]].
    async function buildProgramV(opts: ProgramArgs): Promise<(number | number[])[]> {
      let days0 = 0;
      let days1 = 0;
      let schedType: number;
      if (opts.schedule_type === 'weekly') {
        schedType = 0;
        if (!opts.days_of_week || opts.days_of_week.length === 0) {
          throw new Error('A weekly program needs at least one day in days_of_week.');
        }
        for (const d of opts.days_of_week) {
          const idx = DOW.indexOf(d);
          if (idx >= 0) days0 |= 1 << idx;
        }
      } else {
        schedType = 3; // interval
        if (!opts.interval_days) {
          throw new Error('An interval program needs interval_days.');
        }
        days1 = opts.interval_days;
        days0 = opts.interval_offset;
      }

      // flag: bit0 enable, bit1 weather, bits4-5 schedule type, bit6=0 (fixed start times).
      const flag =
        (opts.enabled ? 1 : 0) | (opts.use_weather ? 2 : 0) | (schedType << 4);

      const starts = [-1, -1, -1, -1];
      opts.start_times.forEach((t, i) => {
        if (i < 4) starts[i] = encodeStartTimeSlot(t);
      });

      const js = (await apiGet('/js')) as AnyRecord;
      const total = js.nstations as number;
      const durations = new Array<number>(total).fill(0);
      for (const { station, duration } of opts.stations) {
        const idx = station - 1;
        if (idx >= 0 && idx < total) durations[idx] = duration;
      }

      return [flag, days0, days1, starts, durations];
    }

    server.registerTool(
      'create_program',
      {
        description:
          'Create a new watering program with a weekly or interval schedule, start times, and per-station durations.',
        inputSchema: programShape,
        annotations: { destructiveHint: false },
      },
      async (args) => {
        try {
          const v = await buildProgramV(args as ProgramArgs);
          await apiGet('/cp', { pid: -1, name: (args as ProgramArgs).name, v: JSON.stringify(v) });
          return { content: [{ type: 'text', text: `Program "${(args as ProgramArgs).name}" created.` }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'update_program',
      {
        description:
          'Replace an existing program with a new definition. All fields are required — supply the full program, not just the changed parts (use get_programs to see the current settings first).',
        inputSchema: {
          program: z.number().int().min(1).describe('Program number to edit (1-based)'),
          ...programShape,
        },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async (args) => {
        try {
          const { program } = args as ProgramArgs & { program: number };
          const v = await buildProgramV(args as ProgramArgs);
          await apiGet('/cp', {
            pid: program - 1,
            name: (args as ProgramArgs).name,
            v: JSON.stringify(v),
          });
          return { content: [{ type: 'text', text: `Program ${program} updated.` }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'set_program_enabled',
      {
        description: 'Enable or disable an existing watering program without changing its schedule.',
        inputSchema: {
          program: z.number().int().min(1).describe('Program number (1-based)'),
          enabled: z.boolean().describe('true to enable, false to disable'),
        },
        annotations: { idempotentHint: true },
      },
      async ({ program, enabled }) => {
        try {
          await apiGet('/cp', { pid: program - 1, en: enabled ? 1 : 0 });
          return {
            content: [{ type: 'text', text: `Program ${program} ${enabled ? 'enabled' : 'disabled'}.` }],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'delete_program',
      {
        description: 'Delete a watering program. This permanently removes the program from the controller.',
        inputSchema: {
          program: z.number().int().min(1).describe('Program number to delete (1-based)'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ program }) => {
        try {
          await apiGet('/dp', { pid: program - 1 });
          return { content: [{ type: 'text', text: `Program ${program} deleted.` }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      'move_program_up',
      {
        description:
          'Move a program one position higher in the execution/priority order. The first program cannot be moved up.',
        inputSchema: {
          program: z.number().int().min(2).describe('Program number to move up (1-based; must be 2 or higher)'),
        },
        annotations: { idempotentHint: false },
      },
      async ({ program }) => {
        try {
          await apiGet('/up', { pid: program - 1 });
          return {
            content: [{ type: 'text', text: `Program ${program} moved up to position ${program - 1}.` }],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  } // end if (WRITE_ENABLED)

  return server;
}
