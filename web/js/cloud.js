// sensor_msgs/PointCloud2 (data en base64, como lo manda rosbridge) -> Float32Array xyz.
// Sin DOM. Salta los puntos no finitos y submuestrea hasta `maxPoints`.

const SIZES = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4, 8: 8 };

export function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function decodePointCloud2(msg, maxPoints = Infinity) {
  const f = Object.fromEntries(msg.fields.map((x) => [x.name, x]));
  if (!f.x || !f.y || !f.z) return new Float32Array(0);
  for (const k of ['x', 'y', 'z']) if (f[k].datatype !== 7 || SIZES[f[k].datatype] !== 4) return new Float32Array(0);
  const bytes = typeof msg.data === 'string' ? base64ToBytes(msg.data) : Uint8Array.from(msg.data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = msg.width * msg.height;
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const le = !msg.is_bigendian;
  const out = [];
  for (let i = 0; i < n; i += step) {
    const row = Math.floor(i / msg.width), col = i % msg.width;
    const base = row * msg.row_step + col * msg.point_step;
    if (base + msg.point_step > bytes.length) break;
    const x = view.getFloat32(base + f.x.offset, le), y = view.getFloat32(base + f.y.offset, le), z = view.getFloat32(base + f.z.offset, le);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) out.push(x, y, z);
  }
  return Float32Array.from(out);
}
