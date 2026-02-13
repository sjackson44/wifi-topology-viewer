import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseAirportOutput, parseSystemProfilerOutput } from './parser.js';

const execFileAsync = promisify(execFile);
const BSSID_PATTERN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/u;
const HIDDEN_SSID = '<hidden>';
const MIN_COREWLAN_IDENTIFIED_APS = 3;
const MIN_COREWLAN_IDENTIFIED_RATIO = 0.18;

export const DEFAULT_AIRPORT_PATH =
  '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';

const SYSTEM_PROFILER_PATH = '/usr/sbin/system_profiler';
const CLANG_PATH = '/usr/bin/clang';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendRoot = join(__dirname, '..');
const nativeSourcePath = join(backendRoot, 'native', 'wifi_scan.m');
const nativeBinaryDir = join(backendRoot, 'bin');
const nativeBinaryPath = join(nativeBinaryDir, 'corewlan_scan');

const inferredRssiCache = new Map();
let nativeBuildPromise = null;
let nativeBuildAttempted = false;
let lastScanSource = 'airport';

export function getLastScanSource() {
  return lastScanSource;
}

export async function scanWifiNetworks({
  airportPath = DEFAULT_AIRPORT_PATH,
  timeoutMs = 5000,
  enableSystemProfilerFallback = true,
} = {}) {
  const airportNetworks = await tryAirportScan(airportPath, timeoutMs);
  if (airportNetworks.length) {
    lastScanSource = 'airport';
    return airportNetworks;
  }

  const coreWlanNetworks = await tryCoreWlanScan(timeoutMs);
  const coreWlanUsable = isCoreWlanScanUsable(coreWlanNetworks);
  if (coreWlanNetworks.length && (!enableSystemProfilerFallback || coreWlanUsable)) {
    lastScanSource = 'corewlan';
    return coreWlanNetworks;
  }

  if (enableSystemProfilerFallback) {
    const profilerNetworks = await trySystemProfilerScan(timeoutMs);
    if (profilerNetworks.length) {
      lastScanSource = 'system_profiler';
      return profilerNetworks;
    }
  }

  if (coreWlanNetworks.length) {
    lastScanSource = 'corewlan';
    return coreWlanNetworks;
  }

  lastScanSource = 'none';
  return [];
}

async function tryAirportScan(airportPath, timeoutMs) {
  try {
    const { stdout } = await execFileAsync(airportPath, ['-s'], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });

    return parseAirportOutput(stdout).map((network) => ({
      ...network,
      scanSource: 'airport',
      rssiEstimated: false,
    }));
  } catch {
    return [];
  }
}

async function tryCoreWlanScan(timeoutMs) {
  try {
    await ensureNativeScannerBinary();

    const { stdout } = await execFileAsync(nativeBinaryPath, [], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });

    return parseCoreWlanOutput(stdout);
  } catch {
    return [];
  }
}

async function trySystemProfilerScan(timeoutMs) {
  try {
    const profilerTimeout = Math.max(timeoutMs * 3, 12_000);
    const { stdout } = await execFileAsync(
      SYSTEM_PROFILER_PATH,
      ['SPAirPortDataType', '-json'],
      {
        timeout: profilerTimeout,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    const networks = parseSystemProfilerOutput(stdout);
    return applyEstimatedRssi(networks);
  } catch {
    return [];
  }
}

function parseCoreWlanOutput(rawOutput) {
  if (!rawOutput || !rawOutput.trim()) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const seen = new Set();
  const occurrenceByFingerprint = new Map();
  const deduped = [];

  for (const network of parsed) {
    const ssid = String(network?.ssid || '').trim() || HIDDEN_SSID;
    const channel = String(network?.channel ?? '').trim();
    const security = String(network?.security || 'UNKNOWN').trim() || 'UNKNOWN';
    const rssi = Number.parseInt(String(network?.rssi ?? ''), 10);

    if (!Number.isFinite(rssi)) {
      continue;
    }

    const bssidRaw = String(network?.bssid || '').trim().toLowerCase();
    const fingerprint = `${ssid}::${channel}::${security}`;
    const occurrence = (occurrenceByFingerprint.get(fingerprint) ?? 0) + 1;
    occurrenceByFingerprint.set(fingerprint, occurrence);

    const bssid = BSSID_PATTERN.test(bssidRaw)
      ? bssidRaw
      : syntheticBssid(`${fingerprint}::${occurrence}`);

    if (seen.has(bssid)) {
      continue;
    }
    seen.add(bssid);

    deduped.push({
      bssid,
      ssid,
      rssi,
      channel,
      band: inferBand(channel),
      security,
      scanSource: 'corewlan',
      rssiEstimated: false,
      bssidSynthetic: !BSSID_PATTERN.test(bssidRaw),
    });
  }

  return deduped;
}

function applyEstimatedRssi(networks) {
  const now = Date.now();
  const seenThisScan = new Set();

  const normalized = networks.map((network) => {
    seenThisScan.add(network.bssid);

    let rssi = network.rssi;
    let rssiEstimated = Boolean(network.rssiEstimated);

    if (!Number.isFinite(rssi)) {
      rssiEstimated = true;
      const cached = inferredRssiCache.get(network.bssid);
      const base = cached?.value ?? estimateBaselineRssi(network);
      const drift = Math.round(Math.sin(now / 3000 + phaseFromId(network.bssid)) * 2);
      rssi = clamp(Math.round(base + drift), -92, -45);
    } else {
      rssi = clamp(Math.round(rssi), -95, -20);
    }

    inferredRssiCache.set(network.bssid, { value: rssi, updatedAt: now });

    return {
      ...network,
      rssi,
      rssiEstimated,
      scanSource: 'system_profiler',
    };
  });

  for (const [bssid, entry] of inferredRssiCache.entries()) {
    if (seenThisScan.has(bssid)) {
      continue;
    }
    if (now - entry.updatedAt > 5 * 60_000) {
      inferredRssiCache.delete(bssid);
    }
  }

  return normalized;
}

function estimateBaselineRssi(network) {
  const baseByBand = {
    '2.4ghz': -74,
    '5ghz': -68,
    '6ghz': -64,
  };
  const base = baseByBand[network.band] ?? -72;
  const variance = (hashCode(network.bssid) % 10) - 5;
  return base + variance;
}

function phaseFromId(id) {
  return (hashCode(id) % 360) * (Math.PI / 180);
}

function inferBand(channelText) {
  const match = String(channelText || '').match(/\d+/u);
  if (!match) {
    return 'unknown';
  }

  const channel = Number.parseInt(match[0], 10);
  if (channel >= 1 && channel <= 14) {
    return '2.4ghz';
  }
  if (channel >= 32 && channel <= 177) {
    return '5ghz';
  }
  return '6ghz';
}

function syntheticBssid(seed) {
  const hashA = hashCode(seed);
  const hashB = hashCode(`${seed}::corewlan`);
  const bytes = [
    hashA & 0xff,
    (hashA >>> 8) & 0xff,
    (hashA >>> 16) & 0xff,
    (hashA >>> 24) & 0xff,
    hashB & 0xff,
    (hashB >>> 8) & 0xff,
  ];

  bytes[0] = (bytes[0] | 0x02) & 0xfe;
  return bytes.map((value) => value.toString(16).padStart(2, '0')).join(':');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashCode(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isCoreWlanScanUsable(networks) {
  if (!networks.length) {
    return false;
  }

  const identified = networks.filter(
    (network) => (!network.bssidSynthetic || network.ssid !== HIDDEN_SSID),
  ).length;

  if (identified >= MIN_COREWLAN_IDENTIFIED_APS) {
    return true;
  }

  return identified / networks.length >= MIN_COREWLAN_IDENTIFIED_RATIO;
}

async function ensureNativeScannerBinary() {
  if (!nativeBuildPromise) {
    nativeBuildPromise = buildNativeScannerIfNeeded();
  }

  try {
    await nativeBuildPromise;
    nativeBuildAttempted = true;
  } finally {
    nativeBuildPromise = null;
  }

  if (!nativeBuildAttempted) {
    throw new Error('corewlan-native-build-failed');
  }
}

async function buildNativeScannerIfNeeded() {
  const needsBuild = await shouldBuildNativeScanner();
  if (!needsBuild) {
    nativeBuildAttempted = true;
    return;
  }

  await mkdir(nativeBinaryDir, { recursive: true });
  await execFileAsync(CLANG_PATH, [
    '-fobjc-arc',
    '-framework',
    'Foundation',
    '-framework',
    'CoreWLAN',
    nativeSourcePath,
    '-o',
    nativeBinaryPath,
  ]);

  await access(nativeBinaryPath, fsConstants.X_OK);
  nativeBuildAttempted = true;
}

async function shouldBuildNativeScanner() {
  try {
    await access(nativeSourcePath, fsConstants.R_OK);
  } catch {
    return false;
  }

  try {
    await access(nativeBinaryPath, fsConstants.X_OK);
  } catch {
    return true;
  }

  try {
    const [sourceStat, binaryStat] = await Promise.all([
      stat(nativeSourcePath),
      stat(nativeBinaryPath),
    ]);
    return sourceStat.mtimeMs > binaryStat.mtimeMs;
  } catch {
    return true;
  }
}
