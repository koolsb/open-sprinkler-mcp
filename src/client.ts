import { createHash } from 'crypto';

// Env vars are validated at startup in index.ts. client.ts itself is side-effect-free
// so it can be safely imported in tests without triggering process.exit.
const host = process.env.OS_HOST ?? '';
const password = process.env.OS_PASSWORD ?? '';

export const BASE_URL = host.match(/^https?:\/\//)
  ? host.replace(/\/$/, '')
  : `http://${host}`;

// OpenSprinkler API requires MD5 of the plain-text password
export const HASHED_PASSWORD = createHash('md5').update(password).digest('hex');

const API_TIMEOUT_MS = 10_000;

const ERROR_CODES: Record<number, string> = {
  2: 'Unauthorized — check your OS_PASSWORD',
  3: 'Password confirmation mismatch',
  16: 'Missing required parameters',
  17: 'Value out of range',
  18: 'Data format error',
  32: 'Page not found',
  48: 'Operation not permitted',
  64: 'Upload failed',
};

export async function apiGet(
  endpoint: string,
  params: Record<string, string | number> = {},
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.set('pw', HASHED_PASSWORD);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Arrays (e.g. /jl log response) don't have a result field — skip error check
    if (!Array.isArray(data) && typeof data?.result === 'number' && data.result !== 1) {
      throw new Error(ERROR_CODES[data.result as number] ?? `API error code: ${data.result}`);
    }

    return data;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request timed out after ${API_TIMEOUT_MS / 1000}s — is the device reachable at ${BASE_URL}?`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Decode whether a station is currently running from the sbits array.
// sbits[board] is a bitmask where bit N = station (board*8 + N).
export function isStationRunning(sbits: number[], stationIndex: number): boolean {
  const board = Math.floor(stationIndex / 8);
  const bit = stationIndex % 8;
  if (board >= sbits.length) return false;
  return !!(sbits[board] & (1 << bit));
}

// Decode whether a flag bit is set for a given station across a per-board bitmask array
export function isBitSet(bitmaskPerBoard: number[], stationIndex: number): boolean {
  const board = Math.floor(stationIndex / 8);
  const bit = stationIndex % 8;
  if (board >= bitmaskPerBoard.length) return false;
  return !!(bitmaskPerBoard[board] & (1 << bit));
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  return parts.join(' ');
}

export function formatTimestamp(unix: number): string {
  if (!unix || unix <= 0) return 'Never';
  // OpenSprinkler timestamps are device-local time (not UTC), so display as-is.
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export function minutesToTimeStr(minutes: number): string {
  if (minutes < 0) return 'Disabled';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${hour12}:${m.toString().padStart(2, '0')} ${suffix}`;
}

export function decodeTimezone(rawTz: number): string {
  // OpenSprinkler timezone: (UTC_offset_hours + 12) * 4
  // So rawTz=48 = UTC+0, rawTz=52 = UTC+1, etc.
  const quarterHours = rawTz - 48;
  const totalMins = quarterHours * 15;
  const sign = totalMins >= 0 ? '+' : '-';
  const absMins = Math.abs(totalMins);
  const h = Math.floor(absMins / 60);
  const m = absMins % 60;
  return `UTC${sign}${h}:${m.toString().padStart(2, '0')}`;
}
