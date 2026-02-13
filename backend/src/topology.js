export function buildClusters(ids, edges, minCorr) {
  const graph = new Map(ids.map((id) => [id, new Set()]));

  for (const edge of edges) {
    if (edge.corr < minCorr) {
      continue;
    }
    graph.get(edge.a)?.add(edge.b);
    graph.get(edge.b)?.add(edge.a);
  }

  const visited = new Set();
  const clusterById = new Map(ids.map((id) => [id, 0]));
  const clusterSizeById = new Map(ids.map((id) => [id, 1]));
  const summary = [];

  let clusterId = 1;

  for (const id of ids) {
    if (visited.has(id)) {
      continue;
    }

    const stack = [id];
    const members = [];
    visited.add(id);

    while (stack.length) {
      const node = stack.pop();
      members.push(node);
      for (const neighbor of graph.get(node) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }

    if (members.length > 1) {
      for (const member of members) {
        clusterById.set(member, clusterId);
        clusterSizeById.set(member, members.length);
      }
      summary.push(members.length);
      clusterId += 1;
    }
  }

  summary.sort((a, b) => b - a);

  return {
    clusterById,
    clusterSizeById,
    summary,
  };
}
