// Disposición de un árbol: hojas en fila, cada padre centrado sobre sus hijos. Sin DOM.

export function layoutTree(root, { w = 160, h = 48, gx = 16, gy = 60 } = {}) {
  const nodes = [], edges = [];
  let cursor = 0;
  let maxDepth = 0;
  function place(node, depth) {
    maxDepth = Math.max(maxDepth, depth);
    const kids = node.children || [];
    let x;
    if (!kids.length) {
      x = cursor + w / 2;
      cursor += w + gx;
    } else {
      const placed = kids.map((k) => place(k, depth + 1));
      x = (placed[0].x + placed[placed.length - 1].x) / 2;
      for (const p of placed) edges.push([null, p]);
      const me = { node, x, y: depth * (h + gy) + h / 2 };
      for (const e of edges) if (e[0] === null) e[0] = me;
      nodes.push(me);
      return me;
    }
    const me = { node, x, y: depth * (h + gy) + h / 2 };
    nodes.push(me);
    return me;
  }
  place(root, 0);
  return { nodes, edges, width: Math.max(w, cursor - gx), height: (maxDepth + 1) * (h + gy) - gy };
}
