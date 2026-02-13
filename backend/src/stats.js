export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function mean(values) {
  if (!values.length) {
    return 0;
  }
  const total = values.reduce((acc, value) => acc + value, 0);
  return total / values.length;
}

export function variance(values) {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  let accum = 0;
  for (const value of values) {
    const delta = value - avg;
    accum += delta * delta;
  }
  return accum / (values.length - 1);
}

export function weightedMean(values, weights) {
  if (!values.length) {
    return 0;
  }

  let sumWeight = 0;
  let weightedTotal = 0;

  for (let i = 0; i < values.length; i += 1) {
    const weight = Number.isFinite(weights?.[i]) ? Math.max(0, weights[i]) : 1;
    if (weight <= 0) {
      continue;
    }

    sumWeight += weight;
    weightedTotal += values[i] * weight;
  }

  if (sumWeight <= 0) {
    return 0;
  }

  return weightedTotal / sumWeight;
}

export function weightedPearsonCorrelation(xs, ys, weightsX, weightsY, minOverlap = 8) {
  const overlap = Math.min(xs.length, ys.length);
  if (overlap < minOverlap) {
    return 0;
  }

  const x = xs.slice(xs.length - overlap);
  const y = ys.slice(ys.length - overlap);
  const wx = normalizeWeights(weightsX, overlap);
  const wy = normalizeWeights(weightsY, overlap);

  const mergedWeights = [];
  const filteredX = [];
  const filteredY = [];

  for (let i = 0; i < overlap; i += 1) {
    const weight = Math.sqrt(wx[i] * wy[i]);
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }

    filteredX.push(x[i]);
    filteredY.push(y[i]);
    mergedWeights.push(weight);
  }

  if (filteredX.length < minOverlap) {
    return 0;
  }

  const meanX = weightedMean(filteredX, mergedWeights);
  const meanY = weightedMean(filteredY, mergedWeights);

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let i = 0; i < filteredX.length; i += 1) {
    const weight = mergedWeights[i];
    const dx = filteredX[i] - meanX;
    const dy = filteredY[i] - meanY;

    covariance += weight * dx * dy;
    varianceX += weight * dx * dx;
    varianceY += weight * dy * dy;
  }

  if (varianceX <= 0 || varianceY <= 0) {
    return 0;
  }

  return clamp(covariance / Math.sqrt(varianceX * varianceY), -1, 1);
}

export function buildCorrelationMatrix(sampleSeries, weightSeries = [], minOverlap = 8) {
  const size = sampleSeries.length;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));

  for (let i = 0; i < size; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < size; j += 1) {
      const corr = weightedPearsonCorrelation(
        sampleSeries[i],
        sampleSeries[j],
        weightSeries[i],
        weightSeries[j],
        minOverlap,
      );

      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }

  return matrix;
}

export function correlationToDistance(corr) {
  return 1 - clamp(corr, -1, 1);
}

export function buildTopCorrelationEdges(
  ids,
  corrMatrix,
  maxPerNode = 2,
  minCorr = 0,
  maxEdges = 80,
) {
  const edgeByKey = new Map();

  for (let i = 0; i < ids.length; i += 1) {
    const candidates = [];
    for (let j = 0; j < ids.length; j += 1) {
      if (i === j) {
        continue;
      }

      const corr = corrMatrix[i][j];
      if (corr > minCorr) {
        candidates.push({ j, corr });
      }
    }

    candidates.sort((a, b) => b.corr - a.corr);

    for (const candidate of candidates.slice(0, maxPerNode)) {
      const j = candidate.j;
      const [a, b] = i < j ? [i, j] : [j, i];
      const key = `${a}:${b}`;
      const existing = edgeByKey.get(key);
      if (!existing || candidate.corr > existing.corr) {
        edgeByKey.set(key, {
          a: ids[a],
          b: ids[b],
          corr: candidate.corr,
        });
      }
    }
  }

  return Array.from(edgeByKey.values())
    .sort((a, b) => b.corr - a.corr)
    .slice(0, maxEdges);
}

function normalizeWeights(weights, overlap) {
  if (!Array.isArray(weights) || !weights.length) {
    return Array(overlap).fill(1);
  }

  const sliced = weights.slice(weights.length - overlap);
  if (sliced.length < overlap) {
    const padded = Array(overlap - sliced.length).fill(1);
    return [...padded, ...sliced.map(normalizeWeight)];
  }

  return sliced.map(normalizeWeight);
}

function normalizeWeight(value) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return clamp(value, 0, 1);
}
