// Sustituto mínimo de node:test para ejecutar los tests en el navegador (run.html).
export const results = [];
const queue = [];
export function test(name, fn) { queue.push([name, fn]); }
export async function runAll(log) {
  for (const [name, fn] of queue.splice(0)) {
    try { await fn(); results.push([name, true]); log(`ok   ${name}`); } catch (e) { results.push([name, false, e]); log(`FAIL ${name}: ${e.message}`); }
  }
}
