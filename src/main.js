const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Watcher } = require('./watcher');
const { DemoWatcher } = require('./demo');
const { trayIcon } = require('./icon');
const { PermissionServer } = require('./permissions');
const { syncHook } = require('./hooksync');

const W = 380;
const H = 520;
const DEMO = process.argv.includes('--demo');
const REPO = 'KotikVanil/clawd-pet';
const LOGIN_NAME = 'ClawdPet';
const UPDATE_EVERY_MS = 6 * 3600 * 1000;
// Outside the MSIX-virtualised %APPDATA%, so the hook started by Claude always finds it.
const ENDPOINT = path.join(os.homedir(), '.clawd-pet', 'endpoint.json');

// Same data folder for the dev run and the installed app.
app.setPath('userData', path.join(app.getPath('appData'), 'clawd-pet'));

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

let win = null;
let tray = null;
let watcher = null;
let perms = null;
let settings = {};
let dragOrigin = null;
let update = null; // { version, url } of a newer release

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch { /* ignore */ }
}

// ---------- window placement ----------
function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - W + 8, y: wa.y + wa.height - H + 6 };
}

// Keep Clawd and its bubble on the screen it is on: a few px may hang over the
// edges, but the bubble (340 px wide, up to ~400 px tall) stays readable.
function clampPos(p) {
  const wa = screen.getDisplayNearestPoint({ x: Math.round(p.x + W / 2), y: Math.round(p.y + H - 40) }).workArea;
  return {
    x: Math.round(Math.min(Math.max(p.x, wa.x - 20), wa.x + wa.width - W + 20)),
    y: Math.round(Math.min(Math.max(p.y, wa.y - 40), wa.y + wa.height - H + 8)),
  };
}

function moveTo(p) {
  if (!win) return;
  win.setBounds({ x: p.x, y: p.y, width: W, height: H });
}

function createWindow() {
  const pos = clampPos(settings.pos || defaultPos());
  win = new BrowserWindow({
    width: W,
    height: H,
    x: pos.x,
    y: pos.y,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    title: 'Clawd',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(settings.onTop !== false, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (settings.hidden !== true) win.showInactive(); });
  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// claude://resume?session=<id> opens that exact Code session in the desktop app.
function openChat(desktopId) {
  const id = typeof desktopId === 'string' && desktopId ? desktopId : watcher.snapshot().desktopId;
  const url = id ? `claude://resume?session=${encodeURIComponent(id)}` : 'claude://';
  shell.openExternal(url).catch(() => shell.openExternal('claude://').catch(() => {}));
}

// Pending permission prompts, enriched with the chat they come from.
function permList() {
  return perms.list().map((p) => {
    const meta = watcher.lookup(p.cliId);
    return { ...p, desktopId: meta?.desktopId || '', title: meta?.title || '', project: path.basename(p.cwd || '') };
  });
}

function toggleVisible() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide(); else win.showInactive();
  settings.hidden = !win.isVisible();
  saveSettings();
}

function resetPosition() {
  const p = clampPos(defaultPos());
  moveTo(p);
  settings.pos = p;
  saveSettings();
}

// ---------- autostart ----------
function loginOpts() {
  return app.isPackaged
    ? { name: LOGIN_NAME, path: process.execPath, args: [] }
    : { name: LOGIN_NAME, path: process.execPath, args: [app.getAppPath()] };
}
function setAutostart(on) {
  app.setLoginItemSettings({ ...loginOpts(), openAtLogin: on });
  settings.autostart = on;
  saveSettings();
}

// ---------- permissions hook ----------
function applyPermsSetting() {
  const on = settings.perms !== false;
  perms.setEnabled(on);
  if (DEMO) return;
  const r = syncHook(on, app.isPackaged);
  if (r !== 'ok') console.log('[hook]', r);
}

// ---------- updates from GitHub releases ----------
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function checkUpdate() {
  if (!app.isPackaged) return;
  try {
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'user-agent': 'clawd-pet' } });
    if (!r.ok) return;
    const rel = await r.json();
    const asset = (rel.assets || []).find((a) => /Setup\.exe$/i.test(a.name));
    if (asset && newer(rel.tag_name, app.getVersion())) update = { version: String(rel.tag_name).replace(/^v/, ''), url: asset.browser_download_url, page: rel.html_url };
  } catch { /* offline */ }
}

async function installUpdate() {
  if (!update) return;
  try {
    const r = await net.fetch(update.url);
    if (!r.ok) throw new Error(String(r.status));
    const file = path.join(app.getPath('temp'), `ClawdPet-Setup-${update.version}.exe`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    require('child_process').spawn(file, ['--update'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  } catch {
    shell.openExternal(update.page);
  }
}

// ---------- tray ----------
function buildMenu() {
  const login = app.getLoginItemSettings(loginOpts());
  const follow = watcher.follow || '';
  const recent = watcher.recentSessions ? watcher.recentSessions(8) : [];
  if (follow && !recent.some((s) => s.cliId === follow)) recent.unshift({ cliId: follow, title: watcher.snapshot().title || 'выбранный чат' });
  const short = (s) => (s.length > 42 ? s.slice(0, 41) + '…' : s);

  return Menu.buildFromTemplate([
    ...(update ? [{ label: `Обновить до ${update.version}`, click: installUpdate }, { type: 'separator' }] : []),
    { label: win?.isVisible() ? 'Спрятать Clawd' : 'Показать Clawd', click: toggleVisible },
    { label: 'Открыть чат Claude', click: () => openChat() },
    {
      label: 'Следить за чатом',
      submenu: [
        { label: 'Самый активный', type: 'radio', checked: !follow, click: () => watcher.setFollow('') },
        ...(recent.length ? [{ type: 'separator' }] : []),
        ...recent.map((s) => ({ label: short(s.title || s.cliId), type: 'radio', checked: follow === s.cliId, click: () => watcher.setFollow(s.cliId) })),
      ],
    },
    { type: 'separator' },
    {
      label: 'Поверх всех окон', type: 'checkbox', checked: settings.onTop !== false,
      click: (item) => { settings.onTop = item.checked; win?.setAlwaysOnTop(item.checked, 'screen-saver'); saveSettings(); },
    },
    { label: 'Запускать вместе с Windows', type: 'checkbox', checked: login.openAtLogin, click: (item) => setAutostart(item.checked) },
    {
      label: 'Разрешения через Clawd', type: 'checkbox', checked: settings.perms !== false,
      click: (item) => { settings.perms = item.checked; saveSettings(); applyPermsSetting(); },
    },
    { label: 'Вернуть в угол экрана', click: resetPosition },
    { type: 'separator' },
    { label: `Clawd Pet ${app.getVersion()}`, enabled: false },
    { label: 'Выход', click: () => app.quit() },
  ]);
}

if (primary) app.whenReady().then(() => {
  settings = loadSettings();
  watcher = DEMO ? new DemoWatcher() : new Watcher();
  watcher.on('update', (s) => send('state', s));
  watcher.start();

  perms = new PermissionServer(ENDPOINT);
  perms.on('change', () => send('perms', permList()));
  perms.start();
  applyPermsSetting();
  // the installer stores the choice; apply it once the app runs
  if (typeof settings.autostart === 'boolean' && app.getLoginItemSettings(loginOpts()).openAtLogin !== settings.autostart) {
    setAutostart(settings.autostart);
  }

  createWindow();

  tray = new Tray(trayIcon());
  tray.setToolTip('Clawd');
  tray.on('click', toggleVisible);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));

  checkUpdate();
  setInterval(checkUpdate, UPDATE_EVERY_MS);

  screen.on('display-removed', () => { if (win) moveTo(clampPos(win.getBounds())); });
  screen.on('display-metrics-changed', () => { if (win) moveTo(clampPos(win.getBounds())); });

  ipcMain.on('ready', () => { send('state', watcher.snapshot()); send('perms', permList()); });
  ipcMain.on('set-ignore', (_e, ignore) => {
    if (!win) return;
    if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });
  ipcMain.on('drag-start', () => { if (win) dragOrigin = win.getBounds(); });
  ipcMain.on('drag-move', (_e, dx, dy) => {
    if (!win || !dragOrigin) return;
    moveTo({ x: Math.round(dragOrigin.x + dx), y: Math.round(dragOrigin.y + dy) });
  });
  ipcMain.on('drag-end', () => {
    if (!win || !dragOrigin) return;
    dragOrigin = null;
    const p = clampPos(win.getBounds());
    moveTo(p);
    settings.pos = p;
    saveSettings();
  });
  ipcMain.on('open-chat', (_e, desktopId) => openChat(desktopId));
  ipcMain.on('perm-answer', (_e, id, choice) => {
    const p = permList().find((x) => x.id === id);
    perms.answer(id, choice);
    if (choice === null && p) openChat(p.desktopId); // hand over to the app's own dialog
  });
});

app.on('second-instance', () => { if (win) { win.showInactive(); settings.hidden = false; saveSettings(); } });
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { watcher?.stop(); perms?.stop(); });
