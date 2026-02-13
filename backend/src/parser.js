const BSSID_PATTERN = /(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/;
const LINE_PATTERN = /^(?<ssid>.*?)\s+(?<bssid>(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\s+(?<rssi>-?\d+)\s+(?<channel>\S+)\s*(?<rest>.*)$/;

export function parseAirportOutput(rawOutput) {
  if (!rawOutput || !rawOutput.trim()) {
    return [];
  }

  const lines = rawOutput
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (!lines.length) {
    return [];
  }

  const headerIndex = lines.findIndex(
    (line) => line.includes('BSSID') && line.includes('RSSI'),
  );

  const columnStarts = headerIndex >= 0 ? inferColumnStarts(lines[headerIndex]) : null;
  const dataLines = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines;

  const byBssid = new Map();

  for (const line of dataLines) {
    const parsed = parseLine(line, columnStarts);
    if (!parsed) {
      continue;
    }

    const existing = byBssid.get(parsed.bssid);
    if (!existing || parsed.rssi > existing.rssi) {
      byBssid.set(parsed.bssid, parsed);
    }
  }

  return Array.from(byBssid.values());
}

export function parseSystemProfilerOutput(rawOutput) {
  if (!rawOutput || !rawOutput.trim()) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return [];
  }

  const sections = parsed?.SPAirPortDataType;
  if (!Array.isArray(sections)) {
    return [];
  }

  const interfaces = sections.flatMap((section) =>
    Array.isArray(section?.spairport_airport_interfaces)
      ? section.spairport_airport_interfaces
      : [],
  );

  const wifiInterface =
    interfaces.find((item) => item?._name === 'en0') ||
    interfaces.find((item) =>
      Array.isArray(item?.spairport_airport_other_local_wireless_networks),
    ) ||
    interfaces[0];

  if (!wifiInterface) {
    return [];
  }

  const seenByKey = new Map();
  const parsedNetworks = [];

  if (wifiInterface.spairport_current_network_information) {
    const current = parseSystemProfilerNetwork(
      wifiInterface.spairport_current_network_information,
      seenByKey,
    );
    if (current) {
      parsedNetworks.push(current);
    }
  }

  const others = wifiInterface.spairport_airport_other_local_wireless_networks;
  if (Array.isArray(others)) {
    for (const network of others) {
      const parsedNetwork = parseSystemProfilerNetwork(network, seenByKey);
      if (parsedNetwork) {
        parsedNetworks.push(parsedNetwork);
      }
    }
  }

  const byBssid = new Map();
  for (const network of parsedNetworks) {
    const existing = byBssid.get(network.bssid);
    if (!existing) {
      byBssid.set(network.bssid, network);
      continue;
    }

    if (existing.rssi == null && network.rssi != null) {
      byBssid.set(network.bssid, network);
    }
  }

  return Array.from(byBssid.values());
}

function parseLine(line, columnStarts) {
  const fromRegex = parseWithRegex(line);
  if (fromRegex) {
    return fromRegex;
  }
  return parseWithColumns(line, columnStarts);
}

function parseWithColumns(line, columnStarts) {
  if (!columnStarts || columnStarts.BSSID === undefined || columnStarts.RSSI === undefined) {
    return null;
  }

  const bssidStart = columnStarts.BSSID;
  const rssiStart = columnStarts.RSSI;

  if (line.length < rssiStart) {
    return null;
  }

  const channelStart = columnStarts.CHANNEL ?? findNextStart(columnStarts, rssiStart);
  const securityStart = columnStarts.SECURITY;

  const ssid = line.slice(0, bssidStart).trim();
  const bssidSliceEnd = rssiStart;
  const bssid = line.slice(bssidStart, bssidSliceEnd).trim().split(/\s+/u)[0];

  if (!BSSID_PATTERN.test(bssid)) {
    return null;
  }

  const rssiToken = line
    .slice(rssiStart, channelStart ?? line.length)
    .trim()
    .split(/\s+/u)[0];
  const rssi = Number.parseInt(rssiToken, 10);
  if (!Number.isFinite(rssi)) {
    return null;
  }

  let channel = '';
  if (channelStart !== undefined) {
    const channelEnd = findNextStart(columnStarts, channelStart);
    channel = line
      .slice(channelStart, channelEnd ?? line.length)
      .trim()
      .split(/\s+/u)[0] ?? '';
  }

  const rest = securityStart !== undefined ? line.slice(securityStart).trim() : '';

  return normalizeNetwork({
    ssid,
    bssid,
    rssi,
    channel,
    security: inferSecurity(rest),
  });
}

function parseWithRegex(line) {
  const match = line.match(LINE_PATTERN);
  if (!match || !match.groups) {
    return null;
  }

  const rssi = Number.parseInt(match.groups.rssi, 10);
  if (!Number.isFinite(rssi)) {
    return null;
  }

  return normalizeNetwork({
    bssid: match.groups.bssid,
    ssid: match.groups.ssid,
    rssi,
    channel: match.groups.channel,
    security: inferSecurity(match.groups.rest),
  });
}

function normalizeNetwork({ bssid, ssid, rssi, channel, security }) {
  const normalizedBssid = String(bssid).toLowerCase();
  if (!BSSID_PATTERN.test(normalizedBssid)) {
    return null;
  }

  const normalizedSsid = String(ssid || '').trim() || '<hidden>';
  const normalizedChannel = String(channel || '').trim();

  return {
    bssid: normalizedBssid,
    ssid: normalizedSsid,
    rssi,
    channel: normalizedChannel,
    band: inferBand(normalizedChannel),
    security: security || 'UNKNOWN',
  };
}

function parseSystemProfilerNetwork(network, seenByKey) {
  if (!network || typeof network !== 'object') {
    return null;
  }

  const ssid = String(network._name || '').trim() || '<hidden>';
  const channelText = String(network.spairport_network_channel || '').trim();
  const channel = parseChannel(channelText);
  const security = normalizeSystemProfilerSecurity(network.spairport_security_mode);

  const key = `${ssid}::${channel || '?'}::${security}`;
  const nextIndex = (seenByKey.get(key) ?? 0) + 1;
  seenByKey.set(key, nextIndex);

  return {
    bssid: syntheticBssid(`${key}::${nextIndex}`),
    ssid,
    rssi: parseSignalNoise(network.spairport_signal_noise),
    channel,
    band: inferBand(channelText || channel),
    security,
    scanSource: 'system_profiler',
    rssiEstimated: !network.spairport_signal_noise,
  };
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

function inferSecurity(securityText) {
  const cleaned = String(securityText || '').trim();
  if (!cleaned) {
    return 'UNKNOWN';
  }

  const tokens = cleaned.split(/\s+/u);
  if (tokens.length >= 3) {
    return tokens.slice(2).join(' ') || 'UNKNOWN';
  }

  if (/wpa|wep|none|open|802\.1x|psk|sae/i.test(cleaned)) {
    return cleaned;
  }

  return 'UNKNOWN';
}

function parseChannel(channelText) {
  const match = String(channelText || '').match(/\d+/u);
  return match ? match[0] : '';
}

function parseSignalNoise(signalNoiseText) {
  const match = String(signalNoiseText || '').match(/(-?\d+)\s*dBm/i);
  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function normalizeSystemProfilerSecurity(mode) {
  const cleaned = String(mode || '')
    .trim()
    .replace(/^spairport_security_mode_/u, '')
    .replace(/^pairport_security_mode_/u, '')
    .replace(/_/gu, ' ')
    .trim();

  return cleaned ? cleaned.toUpperCase() : 'UNKNOWN';
}

function syntheticBssid(seed) {
  const hashA = hashCode(seed);
  const hashB = hashCode(`${seed}::wifi-space`);

  const bytes = [
    hashA & 0xff,
    (hashA >>> 8) & 0xff,
    (hashA >>> 16) & 0xff,
    (hashA >>> 24) & 0xff,
    hashB & 0xff,
    (hashB >>> 8) & 0xff,
  ];

  // Mark as locally administered unicast address.
  bytes[0] = (bytes[0] | 0x02) & 0xfe;

  return bytes.map((value) => value.toString(16).padStart(2, '0')).join(':');
}

function hashCode(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function inferColumnStarts(headerLine) {
  const columns = ['SSID', 'BSSID', 'RSSI', 'CHANNEL', 'HT', 'CC', 'SECURITY'];
  const starts = {};

  for (const column of columns) {
    const index = headerLine.indexOf(column);
    if (index >= 0) {
      starts[column] = index;
    }
  }

  return starts;
}

function findNextStart(columnStarts, currentStart) {
  const nextValues = Object.values(columnStarts).filter((value) => value > currentStart);
  if (!nextValues.length) {
    return undefined;
  }
  return Math.min(...nextValues);
}
