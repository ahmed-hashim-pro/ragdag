import { DagInputNode, layoutDag } from './dag-layout';

const t = (task_id: string, ...downstream: string[]): DagInputNode => ({ task_id, downstream });
const opts = { nodeWidth: 100, nodeHeight: 40, gapX: 20, gapY: 10, padding: 5 };

describe('layoutDag', () => {
  it('lays out an ingest chain left to right, one task per column', () => {
    const l = layoutDag(
      [t('prepare', 'extract'), t('extract', 'chunk'), t('chunk', 'embed_and_index'), t('embed_and_index', 'finalize'), t('finalize')],
      opts,
    );
    expect(l.layers).toBe(5);
    expect(l.nodes.map((n) => [n.id, n.layer])).toEqual([
      ['prepare', 0],
      ['extract', 1],
      ['chunk', 2],
      ['embed_and_index', 3],
      ['finalize', 4],
    ]);
    expect(l.nodes.map((n) => n.x)).toEqual([5, 125, 245, 365, 485]);
    expect(new Set(l.nodes.map((n) => n.y)).size).toBe(1);
    expect(l.width).toBe(5 * 2 + 5 * 100 + 4 * 20);
    expect(l.height).toBe(5 * 2 + 40);
    expect(l.edges.length).toBe(4);
  });

  it('places a node by its LONGEST path from a source', () => {
    // a → b → c → d, and a shortcut a → d: d must still be in column 3.
    const l = layoutDag([t('a', 'b', 'd'), t('b', 'c'), t('c', 'd'), t('d')], opts);
    const layer = Object.fromEntries(l.nodes.map((n) => [n.id, n.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  it('is independent of input order', () => {
    const l = layoutDag([t('d'), t('c', 'd'), t('b', 'c'), t('a', 'b')], opts);
    const layer = Object.fromEntries(l.nodes.map((n) => [n.id, n.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  it('stacks parallel branches in one column and centres smaller columns', () => {
    const l = layoutDag([t('start', 'x', 'y', 'z'), t('x', 'end'), t('y', 'end'), t('z', 'end'), t('end')], opts);
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect([byId['x'].layer, byId['y'].layer, byId['z'].layer]).toEqual([1, 1, 1]);
    expect([byId['x'].order, byId['y'].order, byId['z'].order]).toEqual([0, 1, 2]);
    expect(l.height).toBe(5 * 2 + 3 * 40 + 2 * 10);
    // start/end are vertically centred against the 3-node column.
    expect(byId['start'].y).toBe(byId['y'].y);
    expect(byId['end'].y).toBe(byId['y'].y);
  });

  it('orders rows by parent position (barycentre) to avoid crossings', () => {
    // p1 (row 0) → c1, p2 (row 1) → c2; listing c2 first must not put it on top.
    const l = layoutDag([t('p1', 'c1'), t('p2', 'c2'), t('c2'), t('c1')], opts);
    const order = Object.fromEntries(l.nodes.map((n) => [n.id, n.order]));
    expect(order['c1']).toBe(0);
    expect(order['c2']).toBe(1);
  });

  it('draws edges from the right edge of the source to the left edge of the target', () => {
    const l = layoutDag([t('a', 'b'), t('b')], opts);
    expect(l.edges).toEqual([{ from: 'a', to: 'b', path: 'M105,25 C115,25 115,25 125,25' }]);
  });

  it('ignores unknown downstream ids, self-loops and duplicate edges', () => {
    const l = layoutDag([t('a', 'a', 'ghost', 'b', 'b'), t('b'), t('a')], opts);
    expect(l.nodes.length).toBe(2);
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['a>b']);
  });

  it('terminates on cycles and still places every node', () => {
    const l = layoutDag([t('s', 'a'), t('a', 'b'), t('b', 'a')], opts);
    expect(l.nodes.length).toBe(3);
    const layer = Object.fromEntries(l.nodes.map((n) => [n.id, n.layer]));
    expect(layer['s']).toBe(0);
    expect(layer['a']).toBeGreaterThan(0);
    expect(layer['b']).toBeGreaterThan(layer['a']);
  });

  it('handles the mapped sync DAG shape and an empty task list', () => {
    const l = layoutDag([
      t('list_due_sources', 'fetch_source'),
      t('fetch_source', 'collect_changes'),
      t('collect_changes', 'trigger_ingest'),
      t('trigger_ingest'),
    ]);
    expect(l.layers).toBe(4);
    expect(layoutDag([])).toEqual({ nodes: [], edges: [], width: 0, height: 0, layers: 0 });
  });
});
