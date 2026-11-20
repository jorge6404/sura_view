// Piezas de interfaz compartidas: avisos, iconos y grupos de botones.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const icons = () => window.lucide && window.lucide.createIcons();

let toastTimer;
export function toast(msg, kind = 'ok', icon) {
  const t = $('#toast');
  const ic = icon || (kind === 'ok' ? 'check-circle-2' : kind === 'err' ? 'x-circle' : 'alert-triangle');
  t.className = 'toast ' + kind;
  t.innerHTML = '';
  const i = document.createElement('i');
  i.dataset.lucide = ic;
  const s = document.createElement('span');
  s.textContent = msg;
  t.append(i, s);
  icons();
  requestAnimationFrame(() => t.classList.add('on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), kind === 'err' ? 5000 : 2800);
}

// Botones con aria-pressed exclusivos. onPick(button) decide; si devuelve false no se marca.
export function segGroup(container, onPick) {
  container.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !container.contains(b)) return;
    if (onPick && (await onPick(b)) === false) return;
    for (const x of container.querySelectorAll('button')) x.setAttribute('aria-pressed', x === b);
  });
}

export function setPressed(container, pred) {
  for (const b of container.querySelectorAll('button')) b.setAttribute('aria-pressed', !!pred(b));
}

// Reinicia una animación CSS (para el feedback repetible)
export function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export function errMsg(e) { return e && e.message ? e.message : String(e); }
