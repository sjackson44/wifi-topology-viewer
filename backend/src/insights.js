function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function normalizeBand(band, channel) {
  const text = String(band || '').toLowerCase();
  if (text.includes('2.4')) {
    return '2.4GHz';
  }
  if (text.includes('5')) {
    return '5GHz';
  }

  const channelNumber = Number.parseInt(channel, 10);
  if (!Number.isFinite(channelNumber)) {
    return null;
  }

  if (channelNumber >= 1 && channelNumber <= 14) {
    return '2.4GHz';
  }
  if (channelNumber >= 32) {
    return '5GHz';
  }

  return null;
}

function normalizeAp(ap) {
  return {
    ssid: ap.ssid || '<hidden>',
    bssid: ap.bssid,
    band: ap.band || 'unknown',
    channel: ap.channel || '?',
    security: ap.security || 'UNKNOWN',
    latestRssi: Number.isFinite(ap.rssi)
      ? ap.rssi
      : Number.isFinite(ap.latestRssi)
        ? ap.latestRssi
        : null,
    meanRssi: Number.isFinite(ap.meanRssi) ? ap.meanRssi : null,
    variance: Number.isFinite(ap.variance) ? ap.variance : 0,
    sampleCount: Number.isFinite(ap.sampleCount) ? ap.sampleCount : 0,
    stability: Number.isFinite(ap.stability) ? ap.stability : 0,
    clusterId: Number.isFinite(ap.clusterId) ? ap.clusterId : 0,
    clusterSize: Number.isFinite(ap.clusterSize) ? ap.clusterSize : 1,
  };
}

function sortChannelsAscending(entries) {
  return [...entries].sort((a, b) => a.channel - b.channel);
}

function extractClusterSizes(meta, aps) {
  if (Array.isArray(meta?.clusterSizes) && meta.clusterSizes.length) {
    return [...meta.clusterSizes]
      .filter((value) => Number.isFinite(value) && value > 1)
      .sort((a, b) => b - a);
  }

  const byClusterId = new Map();
  for (const ap of aps) {
    if (!ap.clusterId || ap.clusterId < 1) {
      continue;
    }

    const existing = byClusterId.get(ap.clusterId) || 0;
    byClusterId.set(ap.clusterId, Math.max(existing, ap.clusterSize || 1));
  }

  return [...byClusterId.values()].sort((a, b) => b - a);
}

export function computeStabilityScore({ varianceValue, sampleCount, varRef = 100, countRef = 30 }) {
  const variance = Number.isFinite(varianceValue) ? Math.max(0, varianceValue) : varRef;
  const count = Number.isFinite(sampleCount) ? Math.max(0, sampleCount) : 0;

  const varNorm = clamp(variance / Math.max(1, varRef), 0, 1);
  const countBoost = clamp(count / Math.max(1, countRef), 0, 1);

  return round(clamp((1 - varNorm) * countBoost, 0, 1), 2);
}

export function buildChannelDensity(aps = []) {
  const band24 = new Map();
  const band5 = new Map();

  for (const apRaw of aps) {
    const ap = normalizeAp(apRaw);
    const channelNumber = Number.parseInt(ap.channel, 10);
    if (!Number.isFinite(channelNumber) || channelNumber <= 0) {
      continue;
    }

    const band = normalizeBand(ap.band, channelNumber);
    if (!band) {
      continue;
    }

    const target = band === '2.4GHz' ? band24 : band5;
    target.set(channelNumber, (target.get(channelNumber) || 0) + 1);
  }

  const toRows = (map) => [...map.entries()].map(([channel, count]) => ({ channel, count }));

  return {
    band24: sortChannelsAscending(toRows(band24)),
    band5: sortChannelsAscending(toRows(band5)),
  };
}

export function recommendChannels(channelDensity, limit = 2) {
  const pickLowest = (rows) =>
    [...rows]
      .sort((a, b) => {
        if (a.count !== b.count) {
          return a.count - b.count;
        }
        return a.channel - b.channel;
      })
      .slice(0, limit);

  return {
    band24: pickLowest(channelDensity.band24 || []),
    band5: pickLowest(channelDensity.band5 || []),
  };
}

export function selectStrongestAps(aps = [], limit = 5) {
  return aps
    .map(normalizeAp)
    .sort((a, b) => {
      const aSignal = Number.isFinite(a.meanRssi) ? a.meanRssi : a.latestRssi;
      const bSignal = Number.isFinite(b.meanRssi) ? b.meanRssi : b.latestRssi;
      return (bSignal ?? -200) - (aSignal ?? -200);
    })
    .slice(0, limit);
}

export function selectMostVolatileAps(aps = [], limit = 5) {
  return aps
    .map(normalizeAp)
    .sort((a, b) => {
      if (b.variance !== a.variance) {
        return b.variance - a.variance;
      }
      return b.sampleCount - a.sampleCount;
    })
    .slice(0, limit);
}

export function buildAnalysisSummary({
  aps = [],
  meta = {},
  mode = 'live',
  durationSec = null,
  observedApCount = null,
  generatedAt = Date.now(),
}) {
  const normalizedAps = aps.map(normalizeAp);
  const channelDensity = buildChannelDensity(normalizedAps);
  const recommendations = recommendChannels(channelDensity, 2);
  const clusterSizes = extractClusterSizes(meta, normalizedAps);

  return {
    generatedAt,
    timestampIso: new Date(generatedAt).toISOString(),
    mode,
    os: meta.scanPlatform || process.platform,
    scanSource: meta.scanSource || 'unknown',
    scanIntervalMs: Number.isFinite(meta.scanIntervalMs) ? meta.scanIntervalMs : null,
    windowSize: Number.isFinite(meta.windowSize) ? meta.windowSize : null,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    scanCount: Number.isFinite(meta.scanCount) ? meta.scanCount : null,
    apsObserved: Number.isFinite(observedApCount) ? observedApCount : normalizedAps.length,
    apsTracked: normalizedAps.length,
    clustersDetected: clusterSizes.length,
    topClusterSizes: clusterSizes.slice(0, 5),
    channelDensity,
    recommendations,
    strongestAps: selectStrongestAps(normalizedAps, 5),
    mostVolatileAps: selectMostVolatileAps(normalizedAps, 5),
  };
}

export function buildAsciiBar(count, maxCount, width = 10) {
  const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
  const safeMax = Number.isFinite(maxCount) ? Math.max(1, maxCount) : 1;
  const filled = clamp(Math.round((safeCount / safeMax) * width), 0, width);
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`;
}

function renderChannelDensitySection(channelRows) {
  if (!channelRows.length) {
    return ['- (no data)'];
  }

  const maxCount = Math.max(...channelRows.map((row) => row.count), 1);
  return channelRows.map((row) => `- ch ${row.channel} ${buildAsciiBar(row.count, maxCount)} (${row.count})`);
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/gu, '\\|');
}

function formatRssi(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${round(value, 2)}`;
}

function renderApTableRows(aps) {
  if (!aps.length) {
    return ['| - | - | - | - | - | - | - | - | - |'];
  }

  return aps.map((ap) => {
    const name = ap.ssid || '<hidden>';
    return `| ${escapeCell(name)} | ${ap.bssid} | ${ap.band} | ${ap.channel} | ${escapeCell(ap.security)} | ${formatRssi(ap.meanRssi)} | ${formatRssi(ap.latestRssi)} | ${round(ap.variance, 2)} | ${round(ap.stability, 2)} |`;
  });
}

export function buildMarkdownReport({ summary }) {
  const lines = [];

  lines.push('# Wi-Fi Topology Report');
  lines.push('');
  lines.push(`- Timestamp: ${summary.timestampIso}`);
  lines.push(`- OS: ${summary.os}`);
  lines.push(`- Scan source: ${summary.scanSource}`);
  lines.push(`- Mode: ${summary.mode}`);

  if (summary.durationSec != null) {
    lines.push(`- Duration: ${summary.durationSec}s`);
  } else if (summary.windowSize != null || summary.scanIntervalMs != null) {
    lines.push(
      `- Rolling window: ${summary.windowSize ?? 'n/a'} samples @ ${summary.scanIntervalMs ?? 'n/a'}ms`,
    );
  }

  lines.push(`- APs observed: ${summary.apsObserved}`);
  lines.push(`- APs tracked: ${summary.apsTracked}`);

  lines.push('');
  lines.push('## Channel Density');
  lines.push('');
  lines.push('### 2.4GHz');
  lines.push(...renderChannelDensitySection(summary.channelDensity.band24 || []));
  lines.push('');
  lines.push('### 5GHz');
  lines.push(...renderChannelDensitySection(summary.channelDensity.band5 || []));

  lines.push('');
  lines.push('## Channel Recommendations (Heuristic)');
  lines.push('');

  if ((summary.recommendations.band24 || []).length) {
    lines.push(`- 2.4GHz: ${summary.recommendations.band24.map((item) => `ch ${item.channel}`).join(', ')}`);
  }
  if ((summary.recommendations.band5 || []).length) {
    lines.push(`- 5GHz: ${summary.recommendations.band5.map((item) => `ch ${item.channel}`).join(', ')}`);
  }
  if (!(summary.recommendations.band24 || []).length && !(summary.recommendations.band5 || []).length) {
    lines.push('- No recommendation data available');
  }

  lines.push('');
  lines.push('## Clusters');
  lines.push('');
  lines.push(`- Clusters detected: ${summary.clustersDetected}`);
  if (summary.topClusterSizes.length) {
    lines.push(`- Top cluster sizes: ${summary.topClusterSizes.join(', ')}`);
  } else {
    lines.push('- Top cluster sizes: none');
  }

  lines.push('');
  lines.push('## Top 5 Strongest APs');
  lines.push('');
  lines.push('| SSID | BSSID | Band | Channel | Security | Mean RSSI | Latest RSSI | Variance | Stability |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  lines.push(...renderApTableRows(summary.strongestAps || []));

  lines.push('');
  lines.push('## Top 5 Most Volatile APs');
  lines.push('');
  lines.push('| SSID | BSSID | Band | Channel | Security | Mean RSSI | Latest RSSI | Variance | Stability |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  lines.push(...renderApTableRows(summary.mostVolatileAps || []));

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Topology is correlation space, not floorplan.');
  lines.push('- Distance estimates are approximate.');

  lines.push('');
  return lines.join('\n');
}

export function formatAnalyzeSummary(summary) {
  const lines = [];

  lines.push('Wi-Fi topology analyze summary');
  lines.push(`Timestamp: ${summary.timestampIso}`);
  lines.push(`Mode: ${summary.mode}`);
  lines.push(`OS: ${summary.os}`);
  lines.push(`Scan source: ${summary.scanSource}`);
  lines.push(`Duration: ${summary.durationSec ?? 'n/a'}s`);
  if (summary.scanCount != null) {
    lines.push(`Scans: ${summary.scanCount}`);
  }
  lines.push(`APs observed: ${summary.apsObserved}`);
  lines.push(`APs tracked: ${summary.apsTracked}`);
  lines.push(`Clusters detected: ${summary.clustersDetected}`);

  lines.push('');
  lines.push('Channel density 2.4GHz:');
  lines.push(...renderChannelDensitySection(summary.channelDensity.band24 || []));
  lines.push('');
  lines.push('Channel density 5GHz:');
  lines.push(...renderChannelDensitySection(summary.channelDensity.band5 || []));

  if ((summary.recommendations.band24 || []).length || (summary.recommendations.band5 || []).length) {
    lines.push('');
    lines.push('Recommended low-congestion channels (heuristic):');
    if ((summary.recommendations.band24 || []).length) {
      lines.push(`- 2.4GHz: ${summary.recommendations.band24.map((item) => `ch ${item.channel}`).join(', ')}`);
    }
    if ((summary.recommendations.band5 || []).length) {
      lines.push(`- 5GHz: ${summary.recommendations.band5.map((item) => `ch ${item.channel}`).join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Strongest APs:');
  for (const ap of summary.strongestAps || []) {
    lines.push(`- ${ap.ssid || '<hidden>'} (${ap.bssid}) mean ${formatRssi(ap.meanRssi)} dBm, latest ${formatRssi(ap.latestRssi)} dBm, stability ${round(ap.stability, 2)}`);
  }

  lines.push('');
  lines.push('Most volatile APs:');
  for (const ap of summary.mostVolatileAps || []) {
    lines.push(`- ${ap.ssid || '<hidden>'} (${ap.bssid}) variance ${round(ap.variance, 2)}, stability ${round(ap.stability, 2)}`);
  }

  return lines.join('\n');
}
