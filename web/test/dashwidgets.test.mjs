import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, WIDGETS, WIDGET_TYPES, robotTopic, widgetDef } from '../js/dashwidgets.js';
import { collides, sanitize } from '../js/dashgrid.js';

test('widgets: tipos únicos y tamaños por defecto dentro de sus mínimos', () => {
  assert.equal(WIDGET_TYPES.size, WIDGETS.length);
  for (const w of WIDGETS) {
    assert.ok(w.size.w >= w.size.minW && w.size.h >= w.size.minH && w.size.w <= 12, w.type);
    assert.equal(typeof w.mount, 'function', w.type);
  }
});

test('widgets: las plantillas caben en 12 × 12, sin solapes y respetando mínimos', () => {
  for (const [key, tpl] of Object.entries(TEMPLATES)) {
    const l = tpl.items;
    assert.equal(sanitize(l, WIDGET_TYPES).dropped, 0, key);
    assert.equal(new Set(l.map((i) => i.id)).size, l.length, `${key}: ids repetidos`);
    for (const i of l) {
      const d = widgetDef(i.type).size;
      assert.ok(i.x + i.w <= 12 && i.y + i.h <= 12, `${key}/${i.id} se sale`);
      assert.ok(i.w >= d.minW && i.h >= d.minH, `${key}/${i.id} por debajo del mínimo`);
    }
    assert.ok(l.every((a, n) => l.every((b, m) => n === m || !collides(a, b))), `${key}: solapes`);
  }
});

test('widgets: una cámara elegida para otro robot no se usa', () => {
  assert.equal(robotTopic('/bluerov/front/compressed', 'bluerov'), '/bluerov/front/compressed');
  assert.equal(robotTopic('/bluerov/front/compressed', 'cirtesub'), null);
  assert.equal(robotTopic('', 'bluerov'), null);
  assert.equal(robotTopic('/bluerov/x', null), null);
});
