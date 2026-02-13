import { EigenvalueDecomposition, Matrix } from 'ml-matrix';

export function classicalMDS(distanceMatrix, dimensions = 3) {
  const n = distanceMatrix.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [[0, 0, 0]];
  }

  const dSquared = Matrix.zeros(n, n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const value = Number.isFinite(distanceMatrix[i][j]) ? distanceMatrix[i][j] : 0;
      dSquared.set(i, j, Math.max(0, value) ** 2);
    }
  }

  const identity = Matrix.eye(n, n);
  const ones = Matrix.ones(n, n).mul(1 / n);
  const centering = identity.sub(ones);
  const b = centering.mmul(dSquared).mmul(centering).mul(-0.5);

  const evd = new EigenvalueDecomposition(b, { assumeSymmetric: true });
  const eigenvalues = Array.from(evd.realEigenvalues);
  const eigenvectors = evd.eigenvectorMatrix;

  const ranked = eigenvalues
    .map((value, index) => ({ value, index }))
    .sort((a, bSort) => bSort.value - a.value)
    .slice(0, dimensions);

  const coords = Array.from({ length: n }, () => [0, 0, 0]);

  for (let d = 0; d < ranked.length; d += 1) {
    const { value, index } = ranked[d];
    if (value <= 1e-9) {
      continue;
    }
    const scale = Math.sqrt(value);
    for (let i = 0; i < n; i += 1) {
      coords[i][d] = eigenvectors.get(i, index) * scale;
    }
  }

  return coords;
}

export function embedPositions({
  ids,
  distanceMatrix,
  previousPositions = new Map(),
  radius = 50,
  smoothing = 0.2,
}) {
  if (!ids.length) {
    return new Map();
  }

  let coords;
  try {
    coords = classicalMDS(distanceMatrix, 3);
  } catch {
    coords = [];
  }

  if (!coords.length || isDegenerate(coords)) {
    coords = ids.map((id) => fallbackPositionFromId(id, radius * 0.65));
  }

  stabilizeAxisSign(ids, coords, previousPositions);
  centerAndScale(coords, radius);

  const result = new Map();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const target = coords[i];
    const prev = previousPositions.get(id);
    if (!prev) {
      result.set(id, target);
      continue;
    }

    result.set(id, [
      lerp(prev[0], target[0], smoothing),
      lerp(prev[1], target[1], smoothing),
      lerp(prev[2], target[2], smoothing),
    ]);
  }

  return result;
}

function stabilizeAxisSign(ids, coords, previousPositions) {
  const sharedIndices = [];
  for (let i = 0; i < ids.length; i += 1) {
    if (previousPositions.has(ids[i])) {
      sharedIndices.push(i);
    }
  }

  if (sharedIndices.length < 2) {
    return;
  }

  for (let axis = 0; axis < 3; axis += 1) {
    let dot = 0;
    for (const index of sharedIndices) {
      const prev = previousPositions.get(ids[index]);
      dot += prev[axis] * coords[index][axis];
    }
    if (dot < 0) {
      for (const coordinate of coords) {
        coordinate[axis] *= -1;
      }
    }
  }
}

function centerAndScale(coords, radius) {
  const centroid = [0, 0, 0];
  for (const point of coords) {
    centroid[0] += point[0];
    centroid[1] += point[1];
    centroid[2] += point[2];
  }
  centroid[0] /= coords.length;
  centroid[1] /= coords.length;
  centroid[2] /= coords.length;

  let maxDistance = 0;
  for (const point of coords) {
    point[0] -= centroid[0];
    point[1] -= centroid[1];
    point[2] -= centroid[2];

    const distance = Math.hypot(point[0], point[1], point[2]);
    if (distance > maxDistance) {
      maxDistance = distance;
    }
  }

  const scale = maxDistance > 1e-6 ? radius / maxDistance : 1;
  for (const point of coords) {
    point[0] *= scale;
    point[1] *= scale;
    point[2] *= scale;
  }
}

function isDegenerate(coords) {
  let total = 0;
  for (const point of coords) {
    total += Math.abs(point[0]) + Math.abs(point[1]) + Math.abs(point[2]);
  }
  return total < 1e-6;
}

function fallbackPositionFromId(id, radius) {
  const seed = hashCode(id);
  const rand = mulberry32(seed);
  const theta = rand() * Math.PI * 2;
  const phi = Math.acos(2 * rand() - 1);
  const r = radius * (0.4 + rand() * 0.6);

  return [
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  ];
}

function hashCode(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed;
  return function next() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, alpha) {
  return a + (b - a) * alpha;
}
