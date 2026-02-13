export const DISTANCE_MODEL = {
  referenceRssiAt1m: -41,
  pathLossExponent: 2.6,
  minDistanceM: 0.5,
  maxDistanceM: 80,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function estimateDistanceMetersFromRssi(rssi, model = DISTANCE_MODEL) {
  const numericRssi = Number(rssi);
  if (!Number.isFinite(numericRssi)) {
    return null;
  }

  const exponent = (model.referenceRssiAt1m - numericRssi) / (10 * model.pathLossExponent);
  const distance = 10 ** exponent;
  return clamp(distance, model.minDistanceM, model.maxDistanceM);
}

export function estimatePairDistanceRangeMeters(distanceA, distanceB) {
  if (!Number.isFinite(distanceA) || !Number.isFinite(distanceB)) {
    return null;
  }

  return {
    min: Math.abs(distanceA - distanceB),
    max: distanceA + distanceB,
  };
}

export function formatDistanceMeters(distance) {
  if (!Number.isFinite(distance)) {
    return '~?m';
  }

  if (distance < 10) {
    return `~${distance.toFixed(1)}m`;
  }

  return `~${Math.round(distance)}m`;
}

export function formatDistanceRangeMeters(range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    return '~?m to ~?m';
  }

  const low = range.min < 10 ? range.min.toFixed(1) : Math.round(range.min);
  const high = range.max < 10 ? range.max.toFixed(1) : Math.round(range.max);
  return `~${low}m to ~${high}m`;
}
