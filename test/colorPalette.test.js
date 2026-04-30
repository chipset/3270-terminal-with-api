'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_TERMINAL_COLORS, TERMINAL_COLOR_ROWS } = require('../lib/colorPalette');

test('color palette has one row per default key', () => {
  const keys = new Set(Object.keys(DEFAULT_TERMINAL_COLORS));
  for (const row of TERMINAL_COLOR_ROWS) {
    assert.ok(keys.has(row.key), row.key);
  }
  assert.equal(TERMINAL_COLOR_ROWS.length, keys.size);
});
