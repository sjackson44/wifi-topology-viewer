import { buildAnalysisSummary, computeStabilityScore } from './insights.js';
import {
  buildCorrelationMatrix,
  buildTopCorrelationEdges,
  mean,
  variance,
} from './stats.js';
import { buildClusters } from './topology.js';
import {
  DEFAULT_AIRPORT_PATH,
  getLastScanSource,
  scanWifiNetworks,
} from './wifiScanner.js';

const HIDDEN_SSID = '<hidden>';

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function shouldReplaceSsid(existingSsid, incomingSsid) {
  if (existingSsid === incomingSsid) {
    return false;
  }

  return !(isHiddenSsid(incomingSsid) && !isHiddenSsid(existingSsid));
}

function isHiddenSsid(value) {
  return String(value || '').trim() === HIDDEN_SSID;
}

function deriveSampleWeight(ap) {
  if (ap.rssiEstimated) {
    return 0.12;
  }
  if (ap.scanSource === 'system_profiler') {
    return 0.45;
  }
  if (ap.bssidSynthetic) {
    return 0.35;
  }
  return 1;
}

function delay(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function applyScanResults(apState, results, now, windowSize, evictAfterMs) {
  for (const ap of results) {
    if (!Number.isFinite(ap.rssi)) {
      continue;
    }

    let record = apState.get(ap.bssid);

    if (!record) {
      record = {
        bssid: ap.bssid,
        ssid: ap.ssid,
        ssidHistory: [ap.ssid],
        samples: [],
        sampleWeights: [],
        sampleEstimated: [],
        lastSeen: now,
        latestRssi: ap.rssi,
        latestWeight: deriveSampleWeight(ap),
        rssiEstimated: Boolean(ap.rssiEstimated),
        scanSource: ap.scanSource || 'airport',
        channel: ap.channel,
        band: ap.band,
        security: ap.security,
      };
      apState.set(ap.bssid, record);
    }

    record.lastSeen = now;
    record.latestRssi = ap.rssi;
    record.latestWeight = deriveSampleWeight(ap);
    record.rssiEstimated = Boolean(ap.rssiEstimated);
    record.scanSource = ap.scanSource || 'airport';
    record.channel = ap.channel;
    record.band = ap.band;
    record.security = ap.security;

    if (shouldReplaceSsid(record.ssid, ap.ssid)) {
      record.ssid = ap.ssid;
      if (!record.ssidHistory.includes(ap.ssid)) {
        record.ssidHistory.push(ap.ssid);
        if (record.ssidHistory.length > 5) {
          record.ssidHistory.shift();
        }
      }
    }

    record.samples.push(ap.rssi);
    record.sampleWeights.push(record.latestWeight);
    record.sampleEstimated.push(Boolean(ap.rssiEstimated));

    if (record.samples.length > windowSize) {
      record.samples.shift();
      record.sampleWeights.shift();
      record.sampleEstimated.shift();
    }
  }

  for (const [bssid, record] of apState.entries()) {
    if (now - record.lastSeen > evictAfterMs) {
      apState.delete(bssid);
    }
  }
}

function buildAnalyzeSnapshot({ now, apState, config, scanCount }) {
  const activeRecords = Array.from(apState.values())
    .filter((record) => now - record.lastSeen <= config.evictAfterMs)
    .sort((a, b) => b.latestRssi - a.latestRssi)
    .slice(0, config.maxAps);

  const ids = activeRecords.map((record) => record.bssid);
  const sampleSeries = activeRecords.map((record) => record.samples);
  const sampleWeightSeries = activeRecords.map((record) => record.sampleWeights);

  const corrMatrix = buildCorrelationMatrix(
    sampleSeries,
    sampleWeightSeries,
    config.minOverlap,
  );

  const edges = buildTopCorrelationEdges(
    ids,
    corrMatrix,
    2,
    config.edgeThreshold,
    config.maxEdges,
  );

  const clusters = buildClusters(ids, edges, config.edgeThreshold);

  const aps = activeRecords.map((record) => {
    const sampleVariance = variance(record.samples);
    return {
      bssid: record.bssid,
      ssid: record.ssid,
      rssi: record.latestRssi,
      channel: record.channel,
      band: record.band,
      security: record.security,
      scanSource: record.scanSource,
      rssiEstimated: record.rssiEstimated,
      sampleQuality: round(mean(record.sampleWeights), 2),
      sampleCount: record.samples.length,
      meanRssi: round(mean(record.samples), 2),
      variance: round(sampleVariance, 2),
      stability: computeStabilityScore({
        varianceValue: sampleVariance,
        sampleCount: record.samples.length,
        varRef: 100,
        countRef: config.windowSize,
      }),
      clusterId: clusters.clusterById.get(record.bssid) || 0,
      clusterSize: clusters.clusterSizeById.get(record.bssid) || 1,
      lastSeen: record.lastSeen,
    };
  });

  return {
    type: 'snapshot',
    t: now,
    aps,
    positions: {},
    edges,
    meta: {
      mode: 'analyze',
      scanPlatform: process.platform,
      scanSource: getLastScanSource(),
      scanIntervalMs: config.scanIntervalMs,
      windowSize: config.windowSize,
      edgeThreshold: config.edgeThreshold,
      minOverlap: config.minOverlap,
      maxAps: config.maxAps,
      activeApCount: activeRecords.length,
      clusterCount: clusters.summary.length,
      clusterSizes: clusters.summary,
      scanCount,
    },
  };
}

export async function runAnalyzeSession({
  durationSec,
  scanIntervalMs,
  scanTimeoutMs,
  windowSize,
  evictAfterMs,
  maxAps,
  minOverlap,
  edgeThreshold,
  maxEdges,
  airportPath = DEFAULT_AIRPORT_PATH,
}) {
  const config = {
    durationSec,
    scanIntervalMs,
    scanTimeoutMs,
    windowSize,
    evictAfterMs,
    maxAps,
    minOverlap,
    edgeThreshold,
    maxEdges,
  };

  const apState = new Map();
  const observedBssids = new Set();

  const startedAt = Date.now();
  const endAt = startedAt + config.durationSec * 1000;

  let scanCount = 0;

  while (Date.now() < endAt) {
    const scanStartedAt = Date.now();

    const results = await scanWifiNetworks({
      airportPath,
      timeoutMs: config.scanTimeoutMs,
      enableSystemProfilerFallback: true,
    });

    scanCount += 1;
    const now = Date.now();

    for (const ap of results) {
      if (ap?.bssid) {
        observedBssids.add(ap.bssid);
      }
    }

    applyScanResults(
      apState,
      results,
      now,
      config.windowSize,
      config.evictAfterMs,
    );

    const elapsedMs = Date.now() - scanStartedAt;
    const remainingMs = endAt - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    const sleepMs = Math.max(0, Math.min(config.scanIntervalMs - elapsedMs, remainingMs));
    await delay(sleepMs);
  }

  const endedAt = Date.now();
  const snapshot = buildAnalyzeSnapshot({
    now: endedAt,
    apState,
    config,
    scanCount,
  });

  const summary = buildAnalysisSummary({
    aps: snapshot.aps,
    meta: snapshot.meta,
    mode: 'analyze',
    durationSec: config.durationSec,
    observedApCount: observedBssids.size,
    generatedAt: endedAt,
  });

  if (!summary.apsObserved || !summary.apsTracked) {
    const error = new Error('Analyze run completed with 0 networks observed');
    error.exitCode = 2;
    throw error;
  }

  return {
    snapshot,
    summary,
  };
}
