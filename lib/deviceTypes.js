'use strict';

const MODEL_SIZES = {
  '2': { rows: 24, cols: 80 },
  '3': { rows: 32, cols: 80 },
  '4': { rows: 43, cols: 80 },
  '5': { rows: 27, cols: 132 }
};

const DEVICE_FAMILIES = new Set(['3278', '3279']);

function parseTerminalType(value = 'IBM-3279-2-E') {
  const terminalType = String(value || 'IBM-3279-2-E').trim().toUpperCase();
  const match = /^IBM-(3278|3279)-([2-5])(-E)?(?:@(.+))?$/u.exec(terminalType);
  if (!match) {
    return {
      terminalType,
      family: '3279',
      model: '2',
      extended: true,
      rows: 24,
      cols: 80,
      valid: false
    };
  }
  const [, family, model, extendedSuffix, deviceName] = match;
  const size = MODEL_SIZES[model];
  return {
    terminalType: `IBM-${family}-${model}${extendedSuffix ? '-E' : ''}`,
    family,
    model,
    extended: Boolean(extendedSuffix),
    rows: size.rows,
    cols: size.cols,
    deviceName: deviceName || '',
    valid: true
  };
}

function buildTerminalType({ family = '3279', model = '2', extended = true } = {}) {
  const normalizedFamily = DEVICE_FAMILIES.has(String(family)) ? String(family) : '3279';
  const normalizedModel = MODEL_SIZES[String(model)] ? String(model) : '2';
  return `IBM-${normalizedFamily}-${normalizedModel}${extended ? '-E' : ''}`;
}

function terminalSize(terminalType) {
  const parsed = parseTerminalType(terminalType);
  return { rows: parsed.rows, cols: parsed.cols };
}

function supportedTerminalTypes() {
  const types = [];
  for (const family of DEVICE_FAMILIES) {
    for (const model of Object.keys(MODEL_SIZES)) {
      types.push(buildTerminalType({ family, model, extended: false }));
      types.push(buildTerminalType({ family, model, extended: true }));
    }
  }
  return types;
}

module.exports = {
  MODEL_SIZES,
  buildTerminalType,
  parseTerminalType,
  supportedTerminalTypes,
  terminalSize
};
