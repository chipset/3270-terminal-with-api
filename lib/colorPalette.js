'use strict';

/** Built-in TN3279-style mapping (host color name → hex). */
const DEFAULT_TERMINAL_COLORS = {
  default: '#95ff86',
  green: '#95ff86',
  blue: '#65a9ff',
  red: '#ff6b6b',
  pink: '#ff8bd1',
  turquoise: '#6ff7e8',
  yellow: '#ffe66d',
  white: '#f2fff0',
  black: '#050806',
  deepBlue: '#3d6cff',
  orange: '#ff9f43',
  purple: '#c678ff',
  paleGreen: '#b8f5b0',
  paleTurquoise: '#aee9e6',
  gray: '#9aa7a0',
  brightWhite: '#ffffff'
};

/** Stable table order for settings UI (key + short label). */
const TERMINAL_COLOR_ROWS = [
  { key: 'default', label: 'Default / neutral' },
  { key: 'green', label: 'Green' },
  { key: 'blue', label: 'Blue' },
  { key: 'red', label: 'Red' },
  { key: 'pink', label: 'Pink / magenta' },
  { key: 'turquoise', label: 'Turquoise / cyan' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'white', label: 'White' },
  { key: 'black', label: 'Black' },
  { key: 'deepBlue', label: 'Deep blue' },
  { key: 'orange', label: 'Orange' },
  { key: 'purple', label: 'Purple' },
  { key: 'paleGreen', label: 'Pale green' },
  { key: 'paleTurquoise', label: 'Pale turquoise' },
  { key: 'gray', label: 'Gray' },
  { key: 'brightWhite', label: 'Bright white' }
];

module.exports = { DEFAULT_TERMINAL_COLORS, TERMINAL_COLOR_ROWS };
