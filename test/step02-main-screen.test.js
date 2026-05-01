'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const validatorPath = path.join(
  __dirname,
  '../../vscode-3270-emulator/instrktr-endevor-quick-edit/steps/02-main-screen/validate'
);
const hasExternalValidator = fs.existsSync(`${validatorPath}.js`) || fs.existsSync(validatorPath);
const validate = hasExternalValidator ? require(validatorPath) : undefined;
const validationTest = hasExternalValidator ? test : test.skip;

function makeSnapshot(screenText, connected = true) {
  return JSON.stringify({
    updatedAt: new Date().toISOString(),
    connection: {
      connected,
      host: 'mf.example.com',
      port: 23,
      systemName: 'SYSA',
      lastError: connected ? '' : 'Not connected'
    },
    screenText
  });
}

const ENDEVOR_OPTION_PANEL =
  'Quick-Edit Option\n' +
  'Dialog Commands\n' +
  'Enter option number: ';

const QUICK_EDIT_SCREEN =
  'Endevor Quick Edit\n' +
  'Type or browse an element\n';

function makeCtx({ snapshotExists = true, snapshotJson = makeSnapshot(ENDEVOR_OPTION_PANEL), commandResult = undefined } = {}) {
  const executed = [];
  return {
    _executed: executed,
    files: {
      exists: async () => snapshotExists,
      read: async () => snapshotJson,
    },
    terminal: {
      runShell: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    },
    commands: {
      execute: async (cmd, ...args) => { executed.push({ cmd, args }); return commandResult; },
    },
  };
}

validationTest('returns fail when no snapshot file exists and shell fallback also fails', async () => {
  const ctx = makeCtx({ snapshotExists: false });
  const result = await validate(ctx);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /snapshot/iu);
  assert.deepEqual(ctx._executed, [], 'should not press PF3 if not connected');
});

validationTest('returns fail when snapshot shows session is not connected', async () => {
  const ctx = makeCtx({ snapshotJson: makeSnapshot('', false) });
  const result = await validate(ctx);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /not connected/iu);
  assert.deepEqual(ctx._executed, [], 'should not press PF3 if not connected');
});

validationTest('sends PF3 and returns pass when screen shows the Endevor option panel', async () => {
  const ctx = makeCtx({ snapshotJson: makeSnapshot(ENDEVOR_OPTION_PANEL) });
  const result = await validate(ctx);
  assert.equal(result.status, 'pass');
  assert.equal(ctx._executed.length, 1);
  assert.equal(ctx._executed[0].cmd, 'm3270.pf3');
  assert.match(result.message, /PF3/iu);
});

validationTest('sends PF3 and returns fail when screen still shows Endevor Quick Edit', async () => {
  const ctx = makeCtx({ snapshotJson: makeSnapshot(QUICK_EDIT_SCREEN) });
  const result = await validate(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(ctx._executed[0].cmd, 'm3270.pf3');
  assert.match(result.message, /not found/iu);
});

validationTest('sends PF3 and returns fail when screen shows unrecognised content', async () => {
  const ctx = makeCtx({ snapshotJson: makeSnapshot('WELCOME TO THE SYSTEM') });
  const result = await validate(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(ctx._executed[0].cmd, 'm3270.pf3');
});

validationTest('falls back to shell snapshot when workspace file does not exist', async () => {
  const shellSnapshot = makeSnapshot(ENDEVOR_OPTION_PANEL);
  const ctx = {
    _executed: [],
    files: {
      exists: async () => false,
      read: async () => { throw new Error('should not be called'); },
    },
    terminal: {
      runShell: async () => ({ exitCode: 0, stdout: shellSnapshot }),
    },
    commands: {
      execute: async (cmd) => { ctx._executed.push(cmd); },
    },
  };
  const result = await validate(ctx);
  assert.equal(result.status, 'pass');
  assert.equal(ctx._executed[0], 'm3270.pf3');
});
