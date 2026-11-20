// Sustituto mínimo de node:assert/strict para el navegador.
const fail = (msg) => { throw new Error(msg); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const assert = {
  equal: (a, b, m) => Object.is(a, b) || fail(m || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`),
  deepEqual: (a, b, m) => same(a, b) || fail(m || `${JSON.stringify(a)} != ${JSON.stringify(b)}`),
  notEqual: (a, b, m) => !Object.is(a, b) || fail(m || `${JSON.stringify(a)} === ${JSON.stringify(b)}`),
  ok: (v, m) => v || fail(m || `no es verdadero: ${v}`),
  match: (s, re, m) => re.test(s) || fail(m || `${JSON.stringify(s)} no casa con ${re}`),
  throws: (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(e.message)) fail(`mensaje inesperado: ${e.message}`); return; } fail('no lanzó'); },
  rejects: async (p, re) => { try { await p; } catch (e) { if (re && !re.test(e.message)) fail(`mensaje inesperado: ${e.message}`); return; } fail('no rechazó'); },
};
export default assert;
