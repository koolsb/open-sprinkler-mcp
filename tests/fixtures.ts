// Realistic OpenSprinkler API response fixtures for use across test files.

/** /jc — controller variables, all stations idle */
export const JC_IDLE = {
  devt: 1747123200, // 2025-05-13 12:00:00 UTC
  nbrd: 1,
  en: 1,
  rd: 0,
  rs: 0,
  rdst: 0,
  sunrise: 360,  // 6:00 AM
  sunset: 1200,  // 8:00 PM
  eip: 0,
  lwc: 1747120000,
  lswc: 1747120000,
  wto: {},
  sbits: [0],
  ps: Array(8).fill([0, 0]) as [number, number][],
  lrun: [0, 0, 0, 0],
  curr: 120,
  flcrt: 0,
  flwrt: 0,
};

/** /jc — station 0 running for 5m via program 1, 4m 30s remaining */
export const JC_RUNNING = {
  ...JC_IDLE,
  sbits: [0b00000001],
  ps: [[1, 270], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]] as [number, number][],
  lrun: [0, 1, 300, 1747122880],
};

/** /jc — controller disabled, rain delay active for 12h */
export const JC_DISABLED_RAIN = {
  ...JC_IDLE,
  en: 0,
  rd: 12,
  rdst: 1747123200 + 12 * 3600,
};

/** /jo — controller options */
export const JO = {
  fwv: 221,
  tz: 48,   // UTC+0
  hwv: 30,
  hwt: 172, // AC 24VAC
  ext: 0,
  sdt: 5,
  mas: 0,
  mas2: 0,
  mton: 0,
  mtof: 0,
  urs: 1,
  rso: 0,   // normally closed
  wl: 100,
  den: 0,
  ipas: 0,
  devid: 0,
  con: 100,
  lit: 100,
  dim: 5,
  bst: 0,
  uwt: 1,
  ntp: 1,
  dhcp: 1,
  seq: 1,
  lg: 1,
  dname: 'Test Sprinklers',
};

/** /jn — 4 named stations (8 slots, rest blank) */
export const JN = {
  snames: ['Front Lawn', 'Back Patio', 'Side Yard', 'Drip Zone', '', '', '', ''],
  maxlen: 24,
  masop:  [0],
  masop2: [0],
  ignore_rain: [0],
  ignore_sn1:  [0],
  ignore_sn2:  [0],
  stn_dis:     [0],
  stn_spe:     [0],
};

/** /jn — station 3 disabled, station 0 is master */
export const JN_WITH_FLAGS = {
  ...JN,
  masop:   [0b00000001], // station 0 = master
  stn_dis: [0b00001000], // station 3 = disabled
};

/** /js — all stations idle */
export const JS = {
  sn: [0, 0, 0, 0, 0, 0, 0, 0],
  nstations: 8,
};

/** /jp — 2 programs */
export const JP = {
  nprogs: 2,
  nbrd: 1,
  mnp: 40,
  pd: [
    // Program 1: Weekly Mon/Wed/Fri, 6:00 AM, enabled, weather adj
    // flag: enabled(1) | weatherAdj(2) | schedType_weekly(0<<4) = 0b00000011 = 3
    // days0: Mon=bit0, Wed=bit2, Fri=bit4 = 0b0010101 = 21
    [3, 21, 0, [360, -1, -1, -1], [300, 600, 480, 1200, 0, 0, 0, 0], 'Morning Cycle'],
    // Program 2: Interval every 3 days, disabled, no weather adj
    // flag: !enabled | schedType_interval(3<<4) = 0b00110000 = 48
    [48, 3, 0, [1080, -1, -1, -1], [0, 0, 0, 720, 0, 0, 0, 0], 'Drip Evening'],
  ],
};

/** /jl — 3 watering runs */
export const JL = [
  [1, 0, 300,  1747100000],  // Program 1, Station 0 (Front Lawn), 5m
  [1, 1, 600,  1747100305],  // Program 1, Station 1 (Back Patio), 10m
  [0, 2, 120,  1747050000],  // Manual,    Station 2 (Side Yard), 2m
];

/** /cv — success response */
export const CV_OK = { result: 1 };

/** /cm — success response */
export const CM_OK = { result: 1 };

/** /mp — success response */
export const MP_OK = { result: 1 };

/** /pq — success response */
export const PQ_OK = { result: 1 };

/** /co — success response */
export const CO_OK = { result: 1 };

/** /cr — success response */
export const CR_OK = { result: 1 };
