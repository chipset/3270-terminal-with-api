'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { EmulatorSession } = require('./lib/emulator');
const { DEFAULT_TERMINAL_COLORS, TERMINAL_COLOR_ROWS } = require('./lib/colorPalette');

let activePanel;
let settingsPanel;
let colorPanel;
let activeSession;
let outputChannel;
let extensionContext;

function activate(context) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('m3270');
  activeSession = createSession(getConfiguredConnection());

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand('m3270.open', () => openEmulator(context)),
    vscode.commands.registerCommand('m3270.settings', () => openSettingsPanel(context)),
    vscode.commands.registerCommand('m3270.colorSettings', () => openColorSettingsPanel(context)),
    vscode.commands.registerCommand('m3270.connect', () => connectFromStoredSettings()),
    vscode.commands.registerCommand('m3270.showLog', () => outputChannel.show()),
    vscode.commands.registerCommand('m3270.disconnect', () => activeSession.disconnect()),
    vscode.commands.registerCommand('m3270.enter', () => activeSession.sendAidAsync('enter')),
    vscode.commands.registerCommand('m3270.clear', () => activeSession.sendAidAsync('clear')),
    vscode.commands.registerCommand('m3270.fieldExit', () => activeSession.perform({ type: 'fieldExit' })),
    vscode.commands.registerCommand('m3270.tab', () => activeSession.perform({ type: 'tab' })),
    vscode.commands.registerCommand('m3270.backtab', () => activeSession.perform({ type: 'backtab' })),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('m3270.colors')) {
        postColorPanelInit();
        if (activePanel) {
          postSnapshot(activeSession.getSnapshot());
        }
      }
    })
  );

  for (let i = 1; i <= 24; i += 1) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`m3270.pf${i}`, () => activeSession.sendAidAsync(`pf${i}`))
    );
  }
  for (let i = 1; i <= 3; i += 1) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`m3270.pa${i}`, () => activeSession.sendAidAsync(`pa${i}`))
    );
  }

  activeSession.on('update', (snapshot) => postSnapshot(snapshot));
  activeSession.on('trace', (message) => logConnection(message));
  activeSession.on('aid', (event) => {
    const aid = typeof event === 'string' ? event : event.aid;
    const detail = typeof event === 'string' ? '' : ` (${event.bytes} bytes)`;
    vscode.window.setStatusBarMessage(`m3270 sent ${String(aid).toUpperCase()}${detail}`, 1800);
  });

  return {
    createSession,
    getActiveSession: () => activeSession,
    connect: (options) => activeSession.connect(options),
    disconnect: () => activeSession.disconnect(),
    sendText: (text) => activeSession.sendText(text),
    sendAid: (aid) => activeSession.sendAidAsync(aid),
    pressPf: (number) => activeSession.sendAidAsync(`pf${number}`),
    pressPa: (number) => activeSession.sendAidAsync(`pa${number}`),
    enter: () => activeSession.sendAidAsync('enter'),
    clear: () => activeSession.clear(),
    navigate: (actions) => activeSession.navigate(actions),
    getConnectionStatus: () => activeSession.getConnectionStatus(),
    getFields: () => activeSession.getFields(),
    getReadBuffer: () => activeSession.getReadBuffer(),
    getScreenText: (options) => activeSession.getScreenText(options),
    getScreenshot: (options) => activeSession.getScreenshot(options),
    getSnapshot: () => activeSession.getSnapshot(),
    open: () => openEmulator(context),
    openSettings: () => openSettingsPanel(context),
    openColorSettings: () => openColorSettingsPanel(context)
  };
}

function deactivate() {
  if (activeSession) {
    activeSession.disconnect();
  }
}

function createSession(options = {}) {
  return new EmulatorSession(options);
}

function openEmulator(context) {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Active);
    postSnapshot(activeSession.getSnapshot());
    return activePanel;
  }

  activePanel = vscode.window.createWebviewPanel(
    'm3270.emulator',
    'm3270',
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  activePanel.webview.html = getWebviewHtml();
  activePanel.onDidDispose(() => {
    activePanel = undefined;
  }, undefined, context.subscriptions);
  activePanel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === 'input') {
      activeSession.sendText(message.value ?? '');
    } else if (message.command === 'aid') {
      activeSession.sendAid(message.value);
    } else if (message.command === 'cursor') {
      activeSession.perform({ type: 'cursor', row: message.row, col: message.col });
    } else if (message.command === 'connect') {
      await connectFromStoredSettings();
    } else if (message.command === 'settings') {
      openSettingsPanel(context);
    } else if (message.command === 'colors') {
      openColorSettingsPanel(context);
    } else if (message.command === 'disconnect') {
      activeSession.disconnect();
    } else if (message.command === 'tab') {
      activeSession.perform({ type: 'tab' });
    } else if (message.command === 'backtab') {
      activeSession.perform({ type: 'backtab' });
    } else if (message.command === 'fieldExit') {
      activeSession.perform({ type: 'fieldExit' });
    } else if (message.command === 'noop') {
      return;
    }
  }, undefined, context.subscriptions);

  postSnapshot(activeSession.getSnapshot());
  return activePanel;
}

function openSettingsPanel(context) {
  if (settingsPanel) {
    settingsPanel.reveal(vscode.ViewColumn.Active);
    postSettings();
    return settingsPanel;
  }

  settingsPanel = vscode.window.createWebviewPanel(
    'm3270.settings',
    'm3270 Connection Settings',
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  settingsPanel.webview.html = getSettingsHtml();
  settingsPanel.onDidDispose(() => {
    settingsPanel = undefined;
  }, undefined, context.subscriptions);
  settingsPanel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === 'ready') {
      postSettings();
    } else if (message.command === 'openColors') {
      openColorSettingsPanel(context);
    } else if (message.command === 'save') {
      await saveSettings(message.value ?? {});
      vscode.window.setStatusBarMessage('m3270 connection settings saved', 1800);
      postSettings();
    } else if (message.command === 'connect') {
      await saveSettings(message.value ?? {});
      await connectFromSettings(message.value ?? {});
    } else if (message.command === 'showLog') {
      outputChannel.show();
    }
  }, undefined, context.subscriptions);

  return settingsPanel;
}

function openColorSettingsPanel(context) {
  if (colorPanel) {
    colorPanel.reveal(vscode.ViewColumn.Active);
    postColorPanelInit();
    return colorPanel;
  }

  colorPanel = vscode.window.createWebviewPanel(
    'm3270.colors',
    'm3270 Colors & appearance',
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  colorPanel.webview.html = getColorSettingsHtml();
  colorPanel.onDidDispose(() => {
    colorPanel = undefined;
  }, undefined, context.subscriptions);
  colorPanel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === 'ready') {
      postColorPanelInit();
    } else if (message.command === 'save') {
      await saveColorSettings(message.values ?? {});
      vscode.window.setStatusBarMessage('m3270 colors saved', 1800);
      postColorPanelInit();
      postSnapshot(activeSession.getSnapshot());
    } else if (message.command === 'resetColors') {
      const config = vscode.workspace.getConfiguration('m3270');
      await config.update('colors', {}, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage('m3270 colors reset to built-in defaults', 1800);
      postColorPanelInit();
      postSnapshot(activeSession.getSnapshot());
    } else if (message.command === 'openConnection') {
      openSettingsPanel(context);
    }
  }, undefined, context.subscriptions);

  postColorPanelInit();
  return colorPanel;
}

function postColorPanelInit() {
  if (!colorPanel) {
    return;
  }
  colorPanel.webview.postMessage({
    command: 'init',
    defaults: DEFAULT_TERMINAL_COLORS,
    values: getResolvedTerminalColors(),
    terminalType: getConfiguredConnection().terminalType
  });
}

async function saveColorSettings(values) {
  const config = vscode.workspace.getConfiguration('m3270');
  const next = {};
  for (const { key } of TERMINAL_COLOR_ROWS) {
    const v = String(values[key] ?? '').trim();
    if (!/^#[0-9a-fA-F]{6}$/u.test(v)) {
      continue;
    }
    const def = DEFAULT_TERMINAL_COLORS[key];
    if (def && v.toLowerCase() !== String(def).toLowerCase()) {
      next[key] = v;
    }
  }
  await config.update('colors', next, vscode.ConfigurationTarget.Global);
}

async function connectFromStoredSettings() {
  await connectFromSettings(toSettingsForm(getConfiguredConnection()));
}

async function connectFromSettings(settings) {
  if (!String(settings.hostname || '').trim()) {
    vscode.window.showWarningMessage('m3270 needs a host name before it can connect. Open m3270: Connection Settings.');
    openSettingsPanel(extensionContext);
    return;
  }

  const connection = normalizeConnectionSettings(settings);
  logConnection(`connect requested ${connection.secure ? 'tls' : 'telnet'} ${connection.hostname}:${connection.port}`);
  try {
    await activeSession.connect({
      host: connection.hostname,
      port: connection.port,
      secure: connection.secure,
      rejectUnauthorized: connection.rejectUnauthorized,
      terminalType: connection.terminalType,
      deviceName: connection.deviceName,
      timeoutMs: connection.connectionTimeoutMs
    });
    openEmulator(extensionContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logConnection(`connect failed ${message}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(`m3270 connection failed: ${message}`);
  }
}

async function saveSettings(settings) {
  const connection = normalizeConnectionSettings(settings);
  const config = vscode.workspace.getConfiguration('m3270');
  await config.update('hostname', connection.hostname, vscode.ConfigurationTarget.Global);
  await config.update('port', connection.port, vscode.ConfigurationTarget.Global);
  await config.update('secure', connection.secure, vscode.ConfigurationTarget.Global);
  await config.update('rejectUnauthorized', connection.rejectUnauthorized, vscode.ConfigurationTarget.Global);
  await config.update('terminalType', connection.terminalType, vscode.ConfigurationTarget.Global);
  await config.update('deviceName', connection.deviceName, vscode.ConfigurationTarget.Global);
  await config.update('connectionTimeoutMs', connection.connectionTimeoutMs, vscode.ConfigurationTarget.Global);
}

function normalizePort(value) {
  const port = Number.parseInt(String(value || '23'), 10);
  return Number.isFinite(port) && port > 0 ? port : 23;
}

function normalizeConnectionSettings(settings) {
  return {
    hostname: String(settings.hostname ?? settings.host ?? '').trim(),
    port: normalizePort(settings.port),
    secure: Boolean(settings.secure),
    rejectUnauthorized: settings.rejectUnauthorized !== false,
    terminalType: String(settings.terminalType || 'IBM-3279-2-E').trim(),
    deviceName: String(settings.deviceName ?? '').trim(),
    connectionTimeoutMs: normalizeTimeout(settings.connectionTimeoutMs)
  };
}

function normalizeTimeout(value) {
  const timeout = Number.parseInt(String(value || '10000'), 10);
  return Number.isFinite(timeout) && timeout >= 1000 ? timeout : 10000;
}

function toSettingsForm(connection) {
  return {
    hostname: connection.host ?? connection.hostname ?? '',
    port: connection.port,
    secure: connection.secure,
    rejectUnauthorized: connection.rejectUnauthorized,
    terminalType: connection.terminalType,
    deviceName: connection.deviceName,
    connectionTimeoutMs: connection.connectionTimeoutMs
  };
}

function getConfiguredConnection() {
  const config = vscode.workspace.getConfiguration('m3270');
  return {
    host: config.get('hostname', ''),
    port: config.get('port', 23),
    secure: config.get('secure', false),
    rejectUnauthorized: config.get('rejectUnauthorized', true),
    terminalType: config.get('terminalType', 'IBM-3279-2-E'),
    deviceName: config.get('deviceName', ''),
    connectionTimeoutMs: config.get('connectionTimeoutMs', 10000)
  };
}

function logConnection(message) {
  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function getUserColorOverrides() {
  const raw = vscode.workspace.getConfiguration('m3270').get('colors');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const hex = /^#[0-9a-fA-F]{6}$/;
  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => typeof v === 'string' && hex.test(v.trim())).map(([k, v]) => [k, v.trim()])
  );
}

function getResolvedTerminalColors() {
  return { ...DEFAULT_TERMINAL_COLORS, ...getUserColorOverrides() };
}

function postSnapshot(snapshot) {
  mirrorSnapshotToWorkspaces(snapshot);
  if (activePanel) {
    activePanel.webview.postMessage({
      command: 'snapshot',
      snapshot,
      colors: getResolvedTerminalColors()
    });
  }
}

async function mirrorSnapshotToWorkspaces(snapshot) {
  const payload = {
    updatedAt: new Date().toISOString(),
    connection: snapshot.connection,
    screenText: snapshot.screen.lines.join('\n'),
    screen: {
      rows: snapshot.screen.rows,
      cols: snapshot.screen.cols,
      cursor: snapshot.screen.cursor,
      lines: snapshot.screen.lines,
      fields: snapshot.screen.fields
    }
  };
  const serialized = JSON.stringify(payload, null, 2);
  const homeTargets = [process.env.HOME, process.env.USERPROFILE, os.homedir()].filter(Boolean);
  const targets = new Set((vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.join(folder.uri.fsPath, '.m3270', 'snapshot.json')
  ));

  for (const home of homeTargets) {
    targets.add(path.join(home, '.m3270', 'snapshot.json'));
  }
  targets.add(path.join(os.tmpdir(), 'm3270-snapshot.json'));

  const files = Array.from(targets);
  const results = await Promise.allSettled(files.map(async (file) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serialized);
  }));
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed > 0) {
    logConnection(`snapshot mirror failed for ${failed} target(s)`);
  } else {
    logConnection(`snapshot mirrored to ${files.length} target(s)`);
  }
}

function postSettings() {
  if (settingsPanel) {
    settingsPanel.webview.postMessage({ command: 'settings', value: getConfiguredConnection() });
  }
}

function getSettingsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>m3270 Connection Settings</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101413;
      --panel: #161d1b;
      --text: #d8f8d2;
      --muted: #8fb58e;
      --accent: #67c26f;
      --border: #2b3a35;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
    }
    main {
      max-width: 720px;
      padding: 18px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 18px;
    }
    label {
      display: grid;
      gap: 6px;
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    input, select {
      box-sizing: border-box;
      width: 100%;
      height: 32px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--panel);
      color: var(--text);
      padding: 0 9px;
      font: inherit;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 160px;
      gap: 12px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      font-size: 13px;
      text-transform: none;
    }
    .check input {
      width: 16px;
      height: 16px;
      margin: 0;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 18px;
    }
    button {
      height: 32px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: #202a27;
      color: var(--text);
      padding: 0 12px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      border-color: var(--accent);
    }
    .lead {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      margin: 0 0 10px;
    }
    .lead code {
      color: var(--text);
    }
    .link-row {
      margin: 0 0 18px;
    }
  </style>
</head>
<body>
  <main>
    <h1>m3270 Connection Settings</h1>
    <p class="lead">Use a <strong>3279</strong> terminal type (for example <code>IBM-3279-2-E</code>) so the host sends extended colors. Map those colors in <strong>Colors &amp; appearance</strong>.</p>
    <p class="link-row"><button type="button" id="openColors">Colors &amp; appearance…</button></p>
    <label>Host name
      <input id="hostname" autocomplete="off" placeholder="mainframe.example.com">
    </label>
    <div class="row">
      <label>Port
        <input id="port" type="number" min="1" max="65535" step="1">
      </label>
      <label>Mode
        <select id="mode">
          <option value="plain">Non-secure telnet</option>
          <option value="tls">Secure TLS</option>
        </select>
      </label>
    </div>
    <label class="check">
      <input id="rejectUnauthorized" type="checkbox">
      Validate TLS certificates
    </label>
    <label>Terminal type
      <input id="terminalType" autocomplete="off" placeholder="IBM-3279-2-E">
    </label>
    <label>Device or LU name
      <input id="deviceName" autocomplete="off" placeholder="Optional">
    </label>
    <label>Connection timeout (ms)
      <input id="connectionTimeoutMs" type="number" min="1000" step="500">
    </label>
    <div class="actions">
      <button class="primary" id="save">Save</button>
      <button id="saveConnect">Save and Connect</button>
      <button id="showLog">Show Log</button>
    </div>
    <div class="status" id="status"></div>
  </main>
  <script>
    const vscode = acquireVsCodeApi();
    const fields = {
      hostname: document.getElementById('hostname'),
      port: document.getElementById('port'),
      mode: document.getElementById('mode'),
      rejectUnauthorized: document.getElementById('rejectUnauthorized'),
      terminalType: document.getElementById('terminalType'),
      deviceName: document.getElementById('deviceName'),
      connectionTimeoutMs: document.getElementById('connectionTimeoutMs')
    };
    const status = document.getElementById('status');
    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({ command: 'save', value: readForm() });
      status.textContent = 'Saved.';
    });
    document.getElementById('saveConnect').addEventListener('click', () => {
      vscode.postMessage({ command: 'connect', value: readForm() });
      status.textContent = 'Connecting...';
    });
    document.getElementById('showLog').addEventListener('click', () => {
      vscode.postMessage({ command: 'showLog' });
    });
    window.addEventListener('message', (event) => {
      if (event.data.command === 'settings') {
        writeForm(event.data.value);
      }
    });
    function readForm() {
      return {
        hostname: fields.hostname.value.trim(),
        port: Number.parseInt(fields.port.value || '23', 10),
        secure: fields.mode.value === 'tls',
        rejectUnauthorized: fields.rejectUnauthorized.checked,
        terminalType: fields.terminalType.value.trim() || 'IBM-3279-2-E',
        deviceName: fields.deviceName.value.trim(),
        connectionTimeoutMs: Number.parseInt(fields.connectionTimeoutMs.value || '10000', 10)
      };
    }
    function writeForm(value) {
      fields.hostname.value = value.host || '';
      fields.port.value = value.port || 23;
      fields.mode.value = value.secure ? 'tls' : 'plain';
      fields.rejectUnauthorized.checked = value.rejectUnauthorized !== false;
      fields.terminalType.value = value.terminalType || 'IBM-3279-2-E';
      fields.deviceName.value = value.deviceName || '';
      fields.connectionTimeoutMs.value = value.connectionTimeoutMs || 10000;
    }
    vscode.postMessage({ command: 'ready' });
    document.getElementById('openColors').addEventListener('click', () => {
      vscode.postMessage({ command: 'openColors' });
    });
  </script>
</body>
</html>`;
}

function buildColorSettingsRowsHtml() {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return TERMINAL_COLOR_ROWS.map(({ key, label }) =>
    `<div class="color-row" data-key="${key}">
      <div class="meta"><span>${esc(label)}</span><code>${key}</code></div>
      <div class="inputs">
        <input type="color" class="picker" aria-label="${key}">
        <input type="text" class="hex" spellcheck="false" maxlength="7">
        <button type="button" class="row-reset">Default</button>
      </div>
    </div>`
  ).join('');
}

function getColorSettingsHtml() {
  const colorRowsHtml = buildColorSettingsRowsHtml();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>m3270 Colors</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101413;
      --panel: #161d1b;
      --text: #d8f8d2;
      --muted: #8fb58e;
      --accent: #67c26f;
      --border: #2b3a35;
    }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--vscode-font-family, system-ui, sans-serif); }
    main { max-width: 640px; padding: 18px; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
    .sub { color: var(--muted); font-size: 13px; margin: 0 0 16px; line-height: 1.45; }
    .term { font-size: 13px; margin: 0 0 18px; padding: 10px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
    .term code { color: var(--accent); }
    .color-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px 16px;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .meta span { display: block; font-size: 13px; margin-bottom: 2px; }
    .meta code { font-size: 11px; color: var(--muted); }
    .inputs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .picker { width: 44px; height: 32px; padding: 0; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; background: var(--panel); }
    .hex { width: 92px; height: 32px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text); font: 13px/1 Menlo, monospace; padding: 0 8px; }
    button {
      height: 32px; border: 1px solid var(--border); border-radius: 4px; background: #202a27; color: var(--text); padding: 0 12px; font: inherit; cursor: pointer;
    }
    button.primary { border-color: var(--accent); }
    button.row-reset { padding: 0 8px; font-size: 12px; height: 28px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 20px; }
  </style>
</head>
<body>
  <main>
    <h1>m3270 Colors &amp; appearance</h1>
    <p class="sub">Maps host TN3279-style color names to hex for the emulator screen. Values are stored in <code>m3270.colors</code> in your settings.</p>
    <p class="term">Current <strong>terminal type</strong> (change under Connection Settings): <code id="termType">—</code></p>
    <div id="rows">${colorRowsHtml}</div>
    <div class="actions">
      <button class="primary" id="saveColors">Save colors</button>
      <button type="button" id="resetAllColors">Reset all to built-in</button>
      <button type="button" id="openConn">Connection settings…</button>
    </div>
  </main>
  <script>
    const vscode = acquireVsCodeApi();
    let defaults = {};
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    function readValues() {
      const o = {};
      document.querySelectorAll('.color-row').forEach((row) => {
        const key = row.dataset.key;
        o[key] = row.querySelector('.hex').value.trim();
      });
      return o;
    }
    function wireRow(row) {
      const picker = row.querySelector('.picker');
      const hex = row.querySelector('.hex');
      const key = row.dataset.key;
      picker.addEventListener('input', () => {
        hex.value = picker.value;
      });
      hex.addEventListener('input', () => {
        if (hexRe.test(hex.value.trim())) {
          picker.value = hex.value.trim();
        }
      });
      row.querySelector('.row-reset').addEventListener('click', () => {
        const d = defaults[key] || '#000000';
        hex.value = d;
        picker.value = d;
      });
    }
    document.querySelectorAll('.color-row').forEach(wireRow);
    document.getElementById('saveColors').addEventListener('click', () => {
      vscode.postMessage({ command: 'save', values: readValues() });
    });
    document.getElementById('resetAllColors').addEventListener('click', () => {
      vscode.postMessage({ command: 'resetColors' });
    });
    document.getElementById('openConn').addEventListener('click', () => {
      vscode.postMessage({ command: 'openConnection' });
    });
    window.addEventListener('message', (event) => {
      if (event.data.command !== 'init') {
        return;
      }
      defaults = event.data.defaults || {};
      const values = event.data.values || {};
      document.getElementById('termType').textContent = event.data.terminalType || '—';
      document.querySelectorAll('.color-row').forEach((row) => {
        const key = row.dataset.key;
        const v = values[key] || defaults[key] || '#000000';
        row.querySelector('.hex').value = v;
        row.querySelector('.picker').value = hexRe.test(v) ? v : '#000000';
      });
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function getWebviewHtml() {
  const pfButtons = Array.from({ length: 24 }, (_, index) => {
    const n = index + 1;
    return `<button data-aid="pf${n}" title="PF${n}">PF${n}</button>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>m3270</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101413;
      --panel: #161d1b;
      --text: #d8f8d2;
      --muted: #8fb58e;
      --accent: #67c26f;
      --border: #2b3a35;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-editor-font-family, Menlo, Consolas, monospace);
    }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      padding: 10px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    button {
      min-width: 42px;
      height: 28px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: #202a27;
      color: var(--text);
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      border-color: var(--accent);
    }
    .status {
      color: var(--muted);
      margin-left: auto;
      white-space: nowrap;
    }
    .screen {
      box-sizing: border-box;
      width: min(100vw, 980px);
      margin: 14px auto;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #050806;
      font-size: 14px;
      line-height: 1.25;
      overflow: auto;
      outline: none;
      white-space: pre;
    }
    .cell {
      display: inline-block;
      min-width: 1ch;
      vertical-align: top;
      box-sizing: border-box;
    }
    .cell.underscore {
      text-decoration: underline;
      text-underline-offset: 2px;
      text-decoration-thickness: 1px;
    }
    .cursor {
      outline: 1px solid #ffe66d;
      background: #ffe66d !important;
      color: #050806 !important;
    }
    .editable {
      cursor: text;
    }
    .protected {
      cursor: not-allowed;
    }
    .focus-sentinel {
      position: fixed;
      left: -10000px;
      top: 0;
      width: 1px;
      height: 1px;
      opacity: 0;
    }
    .blink {
      animation: blink 1.2s steps(2, start) infinite;
    }
    @keyframes blink {
      to { visibility: hidden; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="connect" title="Connect to host">Connect</button>
    <button id="settings" title="Connection settings">Settings</button>
    <button id="colors" title="Screen colors and appearance">Colors</button>
    <button id="disconnect" title="Disconnect">Disconnect</button>
    <button data-aid="enter" title="Enter">Enter</button>
    <button data-aid="clear" title="Clear">Clear</button>
    <button data-action="backtab" title="Previous unprotected field">Backtab</button>
    <button data-action="tab" title="Next unprotected field">Tab</button>
    <button data-action="fieldExit" title="Field exit">FExit</button>
    <button data-aid="pa1" title="PA1">PA1</button>
    <button data-aid="pa2" title="PA2">PA2</button>
    <button data-aid="pa3" title="PA3">PA3</button>
    ${pfButtons}
    <span class="status" id="status">Offline</span>
  </div>
  <button id="beforeScreen" class="focus-sentinel" tabindex="0" aria-hidden="true"></button>
  <pre id="screen" class="screen" tabindex="0"></pre>
  <button id="afterScreen" class="focus-sentinel" tabindex="0" aria-hidden="true"></button>
  <script>
    const vscode = acquireVsCodeApi();
    const screen = document.getElementById('screen');
    const status = document.getElementById('status');
    let terminalColors = {};

    document.getElementById('connect').addEventListener('click', () => vscode.postMessage({ command: 'connect' }));
    document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ command: 'settings' }));
    document.getElementById('colors').addEventListener('click', () => vscode.postMessage({ command: 'colors' }));
    document.getElementById('disconnect').addEventListener('click', () => vscode.postMessage({ command: 'disconnect' }));
    document.querySelectorAll('[data-aid]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: 'aid', value: button.dataset.aid }));
    });
    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.action }));
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Tab' && event.shiftKey && isScreenActive()) {
        vscode.postMessage({ command: 'backtab' });
        screen.focus();
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    document.getElementById('beforeScreen').addEventListener('focus', () => {
      vscode.postMessage({ command: 'backtab' });
      screen.focus();
    });
    document.getElementById('afterScreen').addEventListener('focus', () => {
      vscode.postMessage({ command: 'tab' });
      screen.focus();
    });
    screen.addEventListener('keydown', (event) => {
      const mapped = mapKey(event);
      if (mapped) {
        vscode.postMessage(mapped);
        event.preventDefault();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        vscode.postMessage({ command: 'input', value: event.key });
        event.preventDefault();
      }
    });
    screen.addEventListener('keyup', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
      }
    });
    function mapKey(event) {
      if (event.key === 'Enter') {
        return { command: 'aid', value: 'enter' };
      }
      if (event.key === 'Tab') {
        return { command: event.shiftKey ? 'backtab' : 'tab' };
      }
      if (event.key === 'PageUp') {
        return { command: 'aid', value: 'pf7' };
      }
      if (event.key === 'PageDown') {
        return { command: 'aid', value: 'pf8' };
      }
      if (event.key === 'Escape') {
        return { command: 'aid', value: 'clear' };
      }
      if (event.key === 'Backspace') {
        return { command: 'input', value: '\\b' };
      }
      if (event.key === 'Home') {
        return { command: 'aid', value: 'pa1' };
      }
      if (event.key === 'End') {
        return { command: 'fieldExit' };
      }
      if (event.key === 'Insert') {
        return { command: 'aid', value: 'pa2' };
      }
      if (event.key === 'Delete') {
        return { command: 'aid', value: 'pa3' };
      }
      if (/^F\\d+$/.test(event.key)) {
        return { command: 'aid', value: 'pf' + event.key.slice(1) };
      }
      const modifiedPf = modifiedNumberToPf(event);
      if (modifiedPf) {
        return { command: 'aid', value: 'pf' + modifiedPf };
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        moveCursor(event.key);
        return { command: 'noop' };
      }
      return undefined;
    }
    function isScreenActive() {
      return document.activeElement === screen || Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('#screen'));
    }
    function modifiedNumberToPf(event) {
      if (!event.ctrlKey && !event.altKey) {
        return undefined;
      }
      if (!/^[0-9]$/.test(event.key)) {
        return undefined;
      }
      const number = event.key === '0' ? 10 : Number.parseInt(event.key, 10);
      if (event.shiftKey) {
        return number + 10;
      }
      return number;
    }
    screen.addEventListener('mousedown', (event) => {
      const cell = event.target.closest('[data-row][data-col]');
      if (!cell) {
        return;
      }
      vscode.postMessage({
        command: 'cursor',
        row: Number.parseInt(cell.dataset.row, 10),
        col: Number.parseInt(cell.dataset.col, 10)
      });
      screen.focus();
      event.preventDefault();
    });
    window.addEventListener('message', (event) => {
      if (event.data.command !== 'snapshot') {
        return;
      }
      const snapshot = event.data.snapshot;
      terminalColors = event.data.colors && typeof event.data.colors === 'object' && !Array.isArray(event.data.colors)
        ? event.data.colors
        : {};
      screen.dataset.rows = String(snapshot.screen.rows);
      screen.dataset.cols = String(snapshot.screen.cols);
      screen.innerHTML = renderScreen(snapshot.screen);
      const connection = snapshot.connection;
      status.textContent = connection.connecting
        ? 'Connecting to ' + connection.host + ':' + connection.port
        : connection.connected
        ? 'Connected to ' + connection.host + ':' + connection.port + receiveDetail(connection)
        : (connection.lastError || 'Offline');
    });
    function renderScreen(screenSnapshot) {
      return screenSnapshot.cells.map((cell, index) => {
        const newline = index > 0 && index % screenSnapshot.cols === 0 ? '\\n' : '';
        const style = cellStyle(cell);
        const row = Math.floor(index / screenSnapshot.cols);
        const col = index % screenSnapshot.cols;
        const isCursor = screenSnapshot.cursor && screenSnapshot.cursor.row === row && screenSnapshot.cursor.col === col;
        const classes = [
          'cell',
          cell.protected ? 'protected' : 'editable',
          isCursor ? 'cursor' : '',
          cell.blink ? 'blink' : '',
          cell.underscore ? 'underscore' : ''
        ].filter(Boolean).join(' ');
        const classAttr = classes ? ' class="' + classes + '"' : '';
        return newline + '<span' + classAttr + ' data-row="' + row + '" data-col="' + col + '" style="' + style + '">' + escapeHtml(cell.hidden ? ' ' : cell.char) + '</span>';
      }).join('');
    }
    function moveCursor(key) {
      const cursor = currentCursor();
      const maxRow = currentScreenRows();
      const maxCol = currentScreenCols();
      let row = cursor.row;
      let col = cursor.col;
      if (key === 'ArrowLeft') col -= 1;
      if (key === 'ArrowRight') col += 1;
      if (key === 'ArrowUp') row -= 1;
      if (key === 'ArrowDown') row += 1;
      if (col < 0) { col = maxCol - 1; row -= 1; }
      if (col >= maxCol) { col = 0; row += 1; }
      if (row < 0) row = maxRow - 1;
      if (row >= maxRow) row = 0;
      vscode.postMessage({ command: 'cursor', row, col });
    }
    function currentCursor() {
      const cursor = screen.querySelector('.cursor');
      return {
        row: cursor ? Number.parseInt(cursor.dataset.row, 10) : 0,
        col: cursor ? Number.parseInt(cursor.dataset.col, 10) : 0
      };
    }
    function currentScreenRows() {
      return Number.parseInt(screen.dataset.rows || '24', 10);
    }
    function currentScreenCols() {
      return Number.parseInt(screen.dataset.cols || '80', 10);
    }
    function cellStyle(cell) {
      // True 3270 reverse swaps fg/bg per cell; painting the host "bg" color on every
      // character (including spaces) with inline-block reads as solid bars in HTML.
      // Render reverse as high-contrast text in the field color on the screen background.
      let name = cell.color;
      if (cell.reverse && name === 'black') {
        name = 'white';
      }
      const color = colorValue(name);
      const intensify = cell.intensify ? 'font-weight:700;filter:saturate(1.15) brightness(1.08);' : '';
      return 'color:' + color + ';background:transparent;' + intensify;
    }
    function colorValue(color) {
      if (terminalColors && Object.prototype.hasOwnProperty.call(terminalColors, color)) {
        return terminalColors[color];
      }
      return '#95ff86';
    }
    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function receiveDetail(connection) {
      if (!connection.lastReceive) {
        return '';
      }
      return ' | received ' + connection.lastReceive.bytes + ' bytes as ' + connection.lastReceive.mode;
    }
    screen.focus();
  </script>
</body>
</html>`;
}

module.exports = { activate, deactivate, createSession };
