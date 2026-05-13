import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDuration,
  formatTimestamp,
  minutesToTimeStr,
  decodeTimezone,
  isStationRunning,
  isBitSet,
  apiGet,
  BASE_URL,
} from '../src/client.js';

// ── formatDuration ────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('returns 0s for zero', () => expect(formatDuration(0)).toBe('0s'));
  it('returns 0s for negative', () => expect(formatDuration(-1)).toBe('0s'));
  it('formats seconds only', () => expect(formatDuration(45)).toBe('45s'));
  it('formats minutes only', () => expect(formatDuration(120)).toBe('2m'));
  it('formats minutes and seconds', () => expect(formatDuration(125)).toBe('2m 5s'));
  it('formats hours only', () => expect(formatDuration(3600)).toBe('1h'));
  it('formats hours and minutes', () => expect(formatDuration(3660)).toBe('1h 1m'));
  it('formats hours, minutes and seconds', () => expect(formatDuration(3661)).toBe('1h 1m 1s'));
  it('formats large values', () => expect(formatDuration(7322)).toBe('2h 2m 2s'));
});

// ── minutesToTimeStr ──────────────────────────────────────────────────────────

describe('minutesToTimeStr', () => {
  it('returns Disabled for negative values', () => expect(minutesToTimeStr(-1)).toBe('Disabled'));
  it('formats midnight as 12:00 AM', () => expect(minutesToTimeStr(0)).toBe('12:00 AM'));
  it('formats 6:00 AM', () => expect(minutesToTimeStr(360)).toBe('6:00 AM'));
  it('formats noon as 12:00 PM', () => expect(minutesToTimeStr(720)).toBe('12:00 PM'));
  it('formats 1:00 PM', () => expect(minutesToTimeStr(780)).toBe('1:00 PM'));
  it('formats 5:30 PM', () => expect(minutesToTimeStr(1050)).toBe('5:30 PM'));
  it('formats 11:59 PM', () => expect(minutesToTimeStr(1439)).toBe('11:59 PM'));
  it('pads single-digit minutes', () => expect(minutesToTimeStr(601)).toBe('10:01 AM'));
});

// ── decodeTimezone ────────────────────────────────────────────────────────────

describe('decodeTimezone', () => {
  it('decodes UTC (rawTz=48)', () => expect(decodeTimezone(48)).toBe('UTC+0:00'));
  it('decodes UTC+1 (rawTz=52)', () => expect(decodeTimezone(52)).toBe('UTC+1:00'));
  it('decodes UTC+5:30 (rawTz=70)', () => expect(decodeTimezone(70)).toBe('UTC+5:30'));
  it('decodes UTC-5 (rawTz=28)', () => expect(decodeTimezone(28)).toBe('UTC-5:00'));
  it('decodes UTC-1 (rawTz=44)', () => expect(decodeTimezone(44)).toBe('UTC-1:00'));
  it('decodes UTC+12 (rawTz=96)', () => expect(decodeTimezone(96)).toBe('UTC+12:00'));
});

// ── formatTimestamp ───────────────────────────────────────────────────────────

describe('formatTimestamp', () => {
  it('returns Never for 0', () => expect(formatTimestamp(0)).toBe('Never'));
  it('returns Never for negative', () => expect(formatTimestamp(-1)).toBe('Never'));
  it('returns ISO-like UTC string', () => {
    const result = formatTimestamp(1747123200);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  });
  it('produces consistent output for known timestamp', () => {
    // 2025-05-13 12:00:00 UTC
    expect(formatTimestamp(1747137600)).toBe('2025-05-13 12:00:00 UTC');
  });
});

// ── isStationRunning ──────────────────────────────────────────────────────────

describe('isStationRunning', () => {
  it('returns true when the station bit is set', () => {
    expect(isStationRunning([0b00000001], 0)).toBe(true); // station 0
    expect(isStationRunning([0b00000010], 1)).toBe(true); // station 1
    expect(isStationRunning([0b10000000], 7)).toBe(true); // station 7 (last on board 0)
  });
  it('returns false when the station bit is clear', () => {
    expect(isStationRunning([0b00000001], 1)).toBe(false);
    expect(isStationRunning([0b00000000], 0)).toBe(false);
  });
  it('handles multi-board correctly', () => {
    // Station 8 is board 1, bit 0
    expect(isStationRunning([0, 0b00000001], 8)).toBe(true);
    expect(isStationRunning([0b11111111, 0], 8)).toBe(false);
    // Station 15 is board 1, bit 7
    expect(isStationRunning([0, 0b10000000], 15)).toBe(true);
  });
  it('returns false if board index is out of range', () => {
    expect(isStationRunning([0b11111111], 8)).toBe(false); // only 1 board
  });
});

// ── isBitSet ─────────────────────────────────────────────────────────────────

describe('isBitSet', () => {
  it('returns true when bit is set', () => {
    expect(isBitSet([0b00001000], 3)).toBe(true); // station 3 disabled
    expect(isBitSet([0b00000001], 0)).toBe(true);
  });
  it('returns false when bit is clear', () => {
    expect(isBitSet([0b00001000], 0)).toBe(false);
    expect(isBitSet([0], 3)).toBe(false);
  });
  it('handles cross-board stations', () => {
    expect(isBitSet([0, 0b00000100], 10)).toBe(true); // station 10 = board 1, bit 2
  });
  it('returns false for out-of-range board', () => {
    expect(isBitSet([0b11111111], 8)).toBe(false);
  });
});

// ── apiGet ────────────────────────────────────────────────────────────────────

describe('apiGet', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs the correct URL with pw and params', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: 1 }), { status: 200 }),
    );

    await apiGet('/jc', { foo: 'bar' });

    const calledUrl = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(calledUrl.hostname).toBe('opensprinkler.test');
    expect(calledUrl.pathname).toBe('/jc');
    expect(calledUrl.searchParams.get('pw')).toBeTruthy();
    expect(calledUrl.searchParams.get('foo')).toBe('bar');
  });

  it('returns parsed JSON on success', async () => {
    const payload = { result: 1, nbrd: 2, en: 1 };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 200 }),
    );

    const data = await apiGet('/jc');
    expect(data).toEqual(payload);
  });

  it('returns an array response without error (e.g. /jl)', async () => {
    const payload = [[1, 0, 300, 1747100000], [0, 1, 120, 1747050000]];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 200 }),
    );

    const data = await apiGet('/jl', { hist: 7 });
    expect(data).toEqual(payload);
  });

  it('throws on HTTP error status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    await expect(apiGet('/jc')).rejects.toThrow('HTTP 404');
  });

  it('throws a human-readable error for API result code 2 (unauthorized)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: 2 }), { status: 200 }),
    );

    await expect(apiGet('/jc')).rejects.toThrow('Unauthorized');
  });

  it('throws a human-readable error for API result code 16 (missing params)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: 16 }), { status: 200 }),
    );

    await expect(apiGet('/cm')).rejects.toThrow('Missing required parameters');
  });

  it('throws a generic error for unknown result codes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: 99 }), { status: 200 }),
    );

    await expect(apiGet('/jc')).rejects.toThrow('API error code: 99');
  });

  it('includes the device host in the BASE_URL', () => {
    expect(BASE_URL).toBe('http://opensprinkler.test');
  });
});
