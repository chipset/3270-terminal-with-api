'use strict';

async function validate(ctx) {
  const snapshot = await readSnapshot(ctx);
  if (!snapshot) {
    return { status: 'fail', message: 'm3270 snapshot was not found. Open and connect the emulator first.' };
  }

  if (!snapshot.connection || snapshot.connection.connected !== true) {
    return { status: 'fail', message: `m3270 session is not connected${snapshot.connection?.lastError ? `: ${snapshot.connection.lastError}` : ''}.` };
  }

  await ctx.commands.execute('m3270.pf3');

  const screenText = String(snapshot.screenText || snapshot.screen?.text || '').toLowerCase();
  if (screenText.includes('quick-edit option') || screenText.includes('dialog commands') || screenText.includes('enter option number')) {
    return { status: 'pass', message: 'Found the Endevor option panel and sent PF3.' };
  }
  if (screenText.includes('endevor quick edit')) {
    return { status: 'fail', message: 'PF3 was sent, but the Endevor option panel was not found yet.' };
  }
  return { status: 'fail', message: 'PF3 was sent, but the current m3270 screen content was not recognised.' };
}

async function readSnapshot(ctx) {
  const path = '.m3270/snapshot.json';
  if (await ctx.files.exists(path)) {
    return JSON.parse(await ctx.files.read(path));
  }
  const result = await ctx.terminal.runShell('cat ~/.m3270/snapshot.json 2>/dev/null || cat /tmp/m3270-snapshot.json 2>/dev/null');
  if (result.exitCode === 0 && String(result.stdout || '').trim()) {
    return JSON.parse(result.stdout);
  }
  return undefined;
}

module.exports = validate;
