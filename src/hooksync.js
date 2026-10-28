// Keeps the Clawd PermissionRequest hook in ~/.claude/settings.json in sync:
// present and pointing at the current clawd-hook.exe while "permissions through
// Clawd" is on, removed when it's off. Fixes stale paths after the app moves.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARKS = ['clawd-hook', 'permission-hook.js']; // permission-hook.js = the old Node hook

function hookExe(packaged) {
  const p = packaged
    ? path.join(path.dirname(process.execPath), 'clawd-hook.exe')
    : path.join(__dirname, '..', 'hook', 'target', 'release', 'clawd-hook.exe');
  return fs.existsSync(p) ? p : null;
}

const isOurs = (h) => MARKS.some((m) => String(h?.command || '').includes(m));

// Returns 'added' | 'updated' | 'removed' | 'ok' | 'no-hook' | 'error: ...'
function syncHook(enabled, packaged) {
  const exe = hookExe(packaged);
  let raw = '';
  let settings = {};
  try {
    if (fs.existsSync(SETTINGS)) {
      raw = fs.readFileSync(SETTINGS, 'utf8');
      settings = raw.trim() ? JSON.parse(raw.replace(/^﻿/, '')) : {};
    }
  } catch (e) {
    return `error: ${SETTINGS} is not valid JSON, not touching it`;
  }
  if (typeof settings !== 'object' || Array.isArray(settings) || !settings) return 'error: unexpected settings.json';

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
  const had = groups.some((g) => (g.hooks || []).some(isOurs));
  const current = groups.flatMap((g) => g.hooks || []).find(isOurs);
  const wantCmd = exe ? `"${exe.replace(/\\/g, '/')}"` : null;

  if (enabled && !exe) return 'no-hook';
  if (enabled && current && current.command === wantCmd && groups.filter((g) => (g.hooks || []).some(isOurs)).length === 1) return 'ok';
  if (!enabled && !had) return 'ok';

  const kept = groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length);
  if (enabled) kept.push({ matcher: '*', hooks: [{ type: 'command', command: wantCmd, timeout: 300 }] });

  if (kept.length) hooks.PermissionRequest = kept;
  else delete hooks.PermissionRequest;
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;

  try {
    const backup = SETTINGS + '.clawd-backup';
    if (raw && !fs.existsSync(backup)) fs.writeFileSync(backup, raw);
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  } catch (e) {
    return `error: ${e.message}`;
  }
  return !enabled ? 'removed' : had ? 'updated' : 'added';
}

module.exports = { syncHook, hookExe, SETTINGS };
