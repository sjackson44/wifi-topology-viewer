export const SNAPSHOT_TYPE = 'snapshot';

export function buildSnapshotPacket({ t, aps, positions, edges, meta }) {
  return {
    type: SNAPSHOT_TYPE,
    t,
    aps,
    positions,
    edges,
    meta,
  };
}

export function positionMapToObject(positionMap) {
  const out = {};
  for (const [bssid, position] of positionMap.entries()) {
    out[bssid] = {
      x: round(position[0], 3),
      y: round(position[1], 3),
      z: round(position[2], 3),
    };
  }
  return out;
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
