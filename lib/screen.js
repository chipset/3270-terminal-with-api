'use strict';

const { addressToRowCol, rowColToAddress } = require('./addressing');

class ScreenBuffer {
  constructor(rows = 24, cols = 80) {
    this.rows = rows;
    this.cols = cols;
    this.size = rows * cols;
    this.cells = [];
    this.fields = [];
    this.cursor = { row: 0, col: 0 };
    this.insertCursor = { row: 0, col: 0 };
    this.currentFieldAddress = undefined;
    this.currentGraphic = defaultGraphicAttributes();
    this.oia = {
      keyboardLocked: false,
      insertMode: false,
      inputInhibited: false,
      message: ''
    };
    this.clear();
  }

  clear() {
    this.cells = Array.from({ length: this.size }, (_, address) => makeCell(address));
    this.fields = [];
    this.cursor = { row: 0, col: 0 };
    this.insertCursor = { row: 0, col: 0 };
    this.currentFieldAddress = undefined;
    this.currentGraphic = defaultGraphicAttributes();
    this.oia = {
      keyboardLocked: false,
      insertMode: false,
      inputInhibited: false,
      message: ''
    };
  }

  write(text) {
    for (const ch of String(text)) {
      if (ch === '\r') {
        this.cursor.col = 0;
      } else if (ch === '\n') {
        this.setAddress(this.getAddress() + this.cols - this.cursor.col);
      } else if (ch === '\b') {
        this.setAddress(this.getAddress() - 1);
      } else if (ch >= ' ') {
        this.putChar(ch, { fromHost: false });
      }
    }
  }

  putChar(ch, options = {}) {
    const address = this.getAddress();
    const field = this.getFieldForAddress(address);
    if (!options.fromHost && field?.protected) {
      this.tabToNextUnprotectedField();
      const nextField = this.getFieldForAddress(this.getAddress());
      if (!nextField || nextField.protected) {
        this.oia.inputInhibited = true;
        this.oia.message = 'Protected field';
        return;
      }
      return this.putChar(ch, options);
    }

    const cell = this.cells[address];
    const graphic = options.fromHost && this.currentGraphic.explicit ? this.currentGraphic : (field ? field.graphic : this.currentGraphic);
    cell.char = ch[0] ?? ' ';
    cell.fieldAddress = field?.address;
    cell.color = graphic.color;
    cell.highlight = graphic.highlight;
    cell.blink = graphic.blink;
    cell.reverse = graphic.reverse;
    cell.underscore = graphic.underscore;
    cell.intensify = graphic.intensify;
    cell.explicitGraphic = Boolean(options.fromHost && this.currentGraphic.explicit);
    if (!options.fromHost) {
      this.oia.inputInhibited = false;
      this.oia.message = '';
      cell.modified = true;
      if (field) {
        field.modified = true;
      }
    }
    this.setAddress(address + 1);
  }

  startField(attributeByte, extendedAttributes = {}) {
    const address = this.getAddress();
    const field = makeField(address, attributeByte, extendedAttributes);
    const existing = this.fields.findIndex((candidate) => candidate.address === address);
    if (existing >= 0) {
      this.fields.splice(existing, 1, field);
    } else {
      this.fields.push(field);
      this.fields.sort((a, b) => a.address - b.address);
    }
    this.currentFieldAddress = address;
    const cell = this.cells[address];
    Object.assign(cell, {
      char: ' ',
      fieldAddress: address,
      isFieldStart: true,
      protected: field.protected,
      numeric: field.numeric,
      intensified: field.intensified,
      hidden: field.hidden,
      modified: field.modified,
      color: field.graphic.color,
      highlight: field.graphic.highlight,
      blink: field.graphic.blink,
      reverse: field.graphic.reverse,
      underscore: field.graphic.underscore,
      intensify: field.graphic.intensify
    });
    this.setAddress(address + 1);
    this.applyFieldMetadata();
  }

  modifyCurrentField(attributeByte) {
    if (this.currentFieldAddress === undefined) {
      return;
    }
    const field = this.fields.find((candidate) => candidate.address === this.currentFieldAddress);
    if (!field) {
      return;
    }
    Object.assign(field, decodeFieldAttribute(attributeByte));
    field.graphic = decodeExtendedAttributes(field.extendedAttributes, {
      ...decodeFieldAttribute(field.attributeByte),
      ...field.graphic
    });
    this.applyFieldMetadata();
  }

  modifyCurrentFieldAttributes(attributes = {}) {
    if (this.currentFieldAddress === undefined) {
      return;
    }
    const field = this.fields.find((candidate) => candidate.address === this.currentFieldAddress);
    if (!field) {
      return;
    }
    if (attributes[0xc0] !== undefined) {
      Object.assign(field, decodeFieldAttribute(attributes[0xc0]));
      field.attributeByte = attributes[0xc0];
    }
    field.extendedAttributes = { ...field.extendedAttributes, ...attributes };
    field.graphic = decodeExtendedAttributes(field.extendedAttributes, {
      ...decodeFieldAttribute(field.attributeByte),
      ...field.graphic
    });
    this.applyFieldMetadata();
  }

  setGraphicAttribute(type, value) {
    if (type === 0x00) {
      this.currentGraphic = defaultGraphicAttributes();
      return;
    }
    this.currentGraphic = { ...decodeExtendedAttributes({ [type]: value }, this.currentGraphic), explicit: true };
  }

  applyFieldMetadata() {
    for (const cell of this.cells) {
      const field = this.getFieldForAddress(cell.address);
      cell.fieldAddress = field?.address;
      cell.protected = Boolean(field?.protected);
      cell.numeric = Boolean(field?.numeric);
      cell.intensified = Boolean(field?.intensified);
      cell.hidden = Boolean(field?.hidden);
      if (!cell.explicitGraphic) {
        const graphic = field ? field.graphic : this.currentGraphic;
        cell.color = graphic.color;
        cell.highlight = graphic.highlight;
        cell.blink = graphic.blink;
        cell.reverse = graphic.reverse;
        cell.underscore = graphic.underscore;
        cell.intensify = graphic.intensify;
      }
    }
  }

  setCursor(row, col) {
    this.cursor = {
      row: clamp(row, 0, this.rows - 1),
      col: clamp(col, 0, this.cols - 1)
    };
  }

  setAddress(address) {
    const normalized = wrap(address, this.size);
    this.cursor = addressToRowCol(normalized, this.cols);
  }

  getAddress() {
    return rowColToAddress(this.cursor.row, this.cursor.col, this.cols);
  }

  setInsertCursor() {
    this.insertCursor = { ...this.cursor };
  }

  tabToNextUnprotectedField() {
    const current = this.getAddress();
    const sorted = this.fields.slice().sort((a, b) => a.address - b.address);
    const startIndex = sorted.findIndex((field) => field.address > current);
    const rotated = startIndex >= 0 ? sorted.slice(startIndex).concat(sorted.slice(0, startIndex)) : sorted;
    const next = rotated.find((field) => !field.protected);
    if (next) {
      this.setAddress(next.address + 1);
    }
  }

  tabToPreviousUnprotectedField() {
    const current = this.getAddress();
    const currentField = this.getFieldForAddress(current);
    const referenceAddress = currentField ? currentField.address : current;
    const sorted = this.fields.slice().sort((a, b) => b.address - a.address);
    const startIndex = sorted.findIndex((field) => field.address < referenceAddress);
    const rotated = startIndex >= 0 ? sorted.slice(startIndex).concat(sorted.slice(0, startIndex)) : sorted;
    const previous = rotated.find((field) => !field.protected);
    if (previous) {
      this.setAddress(previous.address + 1);
    }
  }

  fieldExit() {
    const field = this.getFieldForAddress(this.getAddress());
    if (!field || field.protected) {
      this.oia.inputInhibited = true;
      this.oia.message = 'Protected field';
      return;
    }
    const nextField = this.fields.find((candidate) => candidate.address > field.address);
    const end = nextField?.address ?? this.size;
    for (let address = this.getAddress(); address < end; address += 1) {
      const cell = this.cells[address];
      if (!cell.isFieldStart) {
        cell.char = ' ';
        cell.modified = true;
      }
    }
    field.modified = true;
    this.setAddress(end);
  }

  repeatToAddress(address, char) {
    let current = this.getAddress();
    const target = wrap(address, this.size);
    do {
      this.cells[current].char = char;
      current = wrap(current + 1, this.size);
    } while (current !== target);
    this.setAddress(target);
  }

  eraseUnprotected() {
    for (const cell of this.cells) {
      if (!cell.protected && !cell.isFieldStart) {
        cell.char = ' ';
        cell.modified = false;
      }
    }
    for (const field of this.fields) {
      if (!field.protected) {
        field.modified = false;
      }
    }
  }

  eraseUnprotectedToAddress(address) {
    let current = this.getAddress();
    const target = wrap(address, this.size);
    do {
      const cell = this.cells[current];
      if (!cell.protected && !cell.isFieldStart) {
        cell.char = ' ';
        cell.modified = false;
      }
      current = wrap(current + 1, this.size);
    } while (current !== target);
    this.setAddress(target);
  }

  getFieldForAddress(address) {
    if (this.fields.length === 0) {
      return undefined;
    }
    const normalized = wrap(address, this.size);
    let selected = this.fields[this.fields.length - 1];
    for (const field of this.fields) {
      if (field.address <= normalized) {
        selected = field;
      }
    }
    return selected;
  }

  getFieldText(field) {
    const start = wrap(field.address + 1, this.size);
    const endField = this.fields.find((candidate) => candidate.address > field.address);
    const end = endField?.address ?? this.size;
    const chars = [];
    for (let address = start; address < end; address += 1) {
      chars.push(this.cells[address].char);
    }
    return chars.join('').replace(/\s+$/u, '');
  }

  getModifiedFields() {
    return this.fields
      .filter((field) => !field.protected && field.modified)
      .map((field) => ({
        address: field.address + 1,
        fieldAddress: field.address,
        text: this.getFieldText(field),
        attributes: { ...field }
      }));
  }

  getUnformattedInput() {
    if (this.fields.length > 0) {
      return undefined;
    }

    const modified = this.cells.filter((cell) => cell.modified);
    if (modified.length === 0) {
      return undefined;
    }

    const start = modified[0].address;
    const end = modified.at(-1).address;
    return {
      address: start,
      text: this.cells.slice(start, end + 1).map((cell) => cell.char).join('').replace(/\s+$/u, '')
    };
  }

  clearModified() {
    for (const cell of this.cells) {
      cell.modified = false;
    }
    for (const field of this.fields) {
      field.modified = false;
    }
  }

  iterCells() {
    return this.cells[Symbol.iterator]();
  }

  getText(trimRight = false) {
    const lines = this.getLines(false);
    return lines.map((line) => trimRight ? line.replace(/\s+$/u, '') : line).join('\n');
  }

  getLines(revealHidden = false) {
    const lines = [];
    for (let row = 0; row < this.rows; row += 1) {
      const chars = [];
      for (let col = 0; col < this.cols; col += 1) {
        const cell = this.cells[rowColToAddress(row, col, this.cols)];
        chars.push(cell.hidden && !revealHidden ? ' ' : cell.char);
      }
      lines.push(chars.join(''));
    }
    return lines;
  }

  getSnapshot() {
    return {
      rows: this.rows,
      cols: this.cols,
      cursor: { ...this.cursor },
      insertCursor: { ...this.insertCursor },
      oia: { ...this.oia },
      text: this.getText(false),
      lines: this.getLines(false),
      fields: this.fields.map((field) => ({ ...field, text: this.getFieldText(field) })),
      cells: this.cells.map((cell) => ({ ...cell }))
    };
  }
}

function makeCell(address) {
  return {
    address,
    char: ' ',
    fieldAddress: undefined,
    isFieldStart: false,
    protected: false,
    numeric: false,
    intensified: false,
    hidden: false,
    modified: false,
    color: 'green',
    highlight: 'normal',
    blink: false,
    reverse: false,
    underscore: false,
    intensify: false,
    explicitGraphic: false
  };
}

function makeField(address, attributeByte, extendedAttributes) {
  return {
    address,
    attributeByte,
    extendedAttributes,
    ...decodeFieldAttribute(attributeByte),
    graphic: decodeExtendedAttributes(extendedAttributes, decodeFieldAttribute(attributeByte))
  };
}

function decodeFieldAttribute(attributeByte) {
  const value = Number(attributeByte) || 0;
  return {
    protected: Boolean(value & 0x20),
    numeric: Boolean(value & 0x10),
    intensified: (value & 0x0c) === 0x08,
    hidden: (value & 0x0c) === 0x0c,
    modified: Boolean(value & 0x01)
  };
}

function decodeExtendedAttributes(attributes = {}, base = {}) {
  const color = decodeColor(attributes[0x42]) ?? base.color ?? (base.intensified ? 'white' : 'green');

  const defaultHighlight = base.highlight ?? (base.hidden ? 'conceal' : 'normal');
  let highlight = defaultHighlight;
  let blink = Boolean(base.blink);
  let reverse = Boolean(base.reverse);
  let underscore = Boolean(base.underscore);
  let intensify = Boolean(base.intensify);

  if (attributes[0x41] !== undefined) {
    highlight = decodeHighlight(attributes[0x41]) ?? defaultHighlight;
    if (highlight === 'default' || highlight === 'normal') {
      blink = false;
      reverse = false;
      underscore = false;
      intensify = false;
    } else {
      blink = highlight === 'blink';
      reverse = highlight === 'reverse';
      underscore = highlight === 'underscore';
      intensify = highlight === 'intensify';
    }
  }

  return {
    color,
    highlight,
    blink,
    reverse,
    underscore,
    intensify
  };
}

function normalizeColorByte(value) {
  const v = Number(value) & 0xff;
  if (v !== 0 && (v & 0xf0) === 0) {
    return v | 0xf0;
  }
  return v;
}

function decodeColor(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const key = normalizeColorByte(value);
  return ({
    0x00: 'default',
    0xf0: 'default',
    0xf1: 'blue',
    0xf2: 'red',
    0xf3: 'pink',
    0xf4: 'green',
    0xf5: 'turquoise',
    0xf6: 'yellow',
    0xf7: 'white',
    0xf8: 'black',
    0xf9: 'deepBlue',
    0xfa: 'orange',
    0xfb: 'purple',
    0xfc: 'paleGreen',
    0xfd: 'paleTurquoise',
    0xfe: 'gray',
    0xff: 'brightWhite'
  })[key];
}

function decodeHighlight(value) {
  return ({
    0x00: 'default',
    0xf0: 'normal',
    0xf1: 'blink',
    0xf2: 'reverse',
    0xf4: 'underscore',
    0xf8: 'intensify'
  })[value];
}

function defaultGraphicAttributes() {
  return {
    color: 'green',
    highlight: 'normal',
    blink: false,
    reverse: false,
    underscore: false,
    intensify: false,
    explicit: false
  };
}

function wrap(value, size) {
  return ((Number(value) || 0) % size + size) % size;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

module.exports = { ScreenBuffer, decodeExtendedAttributes, decodeFieldAttribute };
