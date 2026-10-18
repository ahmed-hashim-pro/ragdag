/** Minimal input for the layout: a task id and the ids it points to. */
export interface DagInputNode {
  task_id: string;
  downstream: readonly string[];
}

export interface DagNodeLayout<T extends DagInputNode> {
  id: string;
  task: T;
  /** Column, 0 = sources; equals the longest path from any source. */
  layer: number;
  /** Row inside the column. */
  order: number;
  x: number;
  y: number;
}

export interface DagEdgeLayout {
  from: string;
  to: string;
  /** SVG path data (cubic curve from the source's right edge to the target's left edge). */
  path: string;
}

export interface DagLayout<T extends DagInputNode> {
  nodes: DagNodeLayout<T>[];
  edges: DagEdgeLayout[];
  width: number;
  height: number;
  layers: number;
}

export interface DagLayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  gapX: number;
  gapY: number;
  padding: number;
}

export const DEFAULT_DAG_LAYOUT: DagLayoutOptions = {
  nodeWidth: 184,
  nodeHeight: 58,
  gapX: 56,
  gapY: 18,
  padding: 12,
};

/**
 * Layered left-to-right layout: each task's column is the length of the longest path that
 * reaches it, rows are ordered by the average row of their parents (barycentre) to reduce
 * crossings, and each column is centred vertically. Unknown downstream ids and self-loops
 * are ignored; nodes stuck in a cycle are placed after everything else rather than looping.
 */
export function layoutDag<T extends DagInputNode>(
  tasks: readonly T[],
  options: Partial<DagLayoutOptions> = {},
): DagLayout<T> {
  const o = { ...DEFAULT_DAG_LAYOUT, ...options };

  const byId = new Map<string, T>();
  const index = new Map<string, number>();
  for (const t of tasks) {
    if (!byId.has(t.task_id)) {
      index.set(t.task_id, byId.size);
      byId.set(t.task_id, t);
    }
  }
  const ids = [...byId.keys()];

  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  const pred = new Map<string, string[]>(ids.map((id) => [id, []]));
  const edgeKeys = new Set<string>();
  for (const id of ids) {
    for (const to of byId.get(id)!.downstream ?? []) {
      const key = `${id}\u0000${to}`;
      if (to === id || !byId.has(to) || edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      succ.get(id)!.push(to);
      pred.get(to)!.push(id);
    }
  }

  // Longest-path layering via Kahn's topological order.
  const layer = new Map<string, number>();
  const indeg = new Map(ids.map((id) => [id, pred.get(id)!.length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (const id of queue) layer.set(id, 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of succ.get(u)!) {
      layer.set(v, Math.max(layer.get(v) ?? 0, layer.get(u)! + 1));
      const d = indeg.get(v)! - 1;
      indeg.set(v, d);
      if (d === 0) queue.push(v);
    }
  }
  // Anything left is part of a cycle: put it after the deepest placed predecessor.
  let maxLayer = Math.max(-1, ...[...layer.values()]);
  for (const id of ids) {
    if (queue.includes(id)) continue;
    const placed = pred.get(id)!.filter((p) => queue.includes(p)).map((p) => layer.get(p)!);
    const l = placed.length ? Math.max(...placed) + 1 : maxLayer + 1;
    layer.set(id, l);
    queue.push(id);
    maxLayer = Math.max(maxLayer, l);
  }

  const layerCount = ids.length ? Math.max(...ids.map((id) => layer.get(id)!)) + 1 : 0;
  const columns: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) columns[layer.get(id)!].push(id);

  // Order rows by the barycentre of parents already placed in earlier columns.
  const order = new Map<string, number>();
  columns.forEach((col, li) => {
    if (li > 0) {
      const bary = (id: string) => {
        const ps = pred.get(id)!.filter((p) => order.has(p));
        return ps.length ? ps.reduce((s, p) => s + order.get(p)!, 0) / ps.length : Number.POSITIVE_INFINITY;
      };
      col.sort((a, b) => bary(a) - bary(b) || index.get(a)! - index.get(b)!);
    }
    col.forEach((id, i) => order.set(id, i));
  });

  const rowsMax = Math.max(0, ...columns.map((c) => c.length));
  const columnHeight = (n: number) => (n > 0 ? n * o.nodeHeight + (n - 1) * o.gapY : 0);
  const innerHeight = columnHeight(rowsMax);

  const nodes: DagNodeLayout<T>[] = [];
  const pos = new Map<string, DagNodeLayout<T>>();
  columns.forEach((col, li) => {
    const offset = (innerHeight - columnHeight(col.length)) / 2;
    col.forEach((id, row) => {
      const n: DagNodeLayout<T> = {
        id,
        task: byId.get(id)!,
        layer: li,
        order: row,
        x: o.padding + li * (o.nodeWidth + o.gapX),
        y: o.padding + offset + row * (o.nodeHeight + o.gapY),
      };
      nodes.push(n);
      pos.set(id, n);
    });
  });

  const edges: DagEdgeLayout[] = [];
  for (const id of ids) {
    const a = pos.get(id)!;
    for (const to of succ.get(id)!) {
      const b = pos.get(to)!;
      const x1 = a.x + o.nodeWidth;
      const y1 = a.y + o.nodeHeight / 2;
      const x2 = b.x;
      const y2 = b.y + o.nodeHeight / 2;
      const mx = (x1 + x2) / 2;
      edges.push({ from: id, to, path: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` });
    }
  }

  const width = layerCount ? o.padding * 2 + layerCount * o.nodeWidth + (layerCount - 1) * o.gapX : 0;
  const height = layerCount ? o.padding * 2 + innerHeight : 0;
  return { nodes, edges, width, height, layers: layerCount };
}
