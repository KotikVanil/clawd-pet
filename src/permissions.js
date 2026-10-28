// Local HTTP endpoint for the clawd-hook.exe PermissionRequest hook. The hook POSTs a Claude Code
// PermissionRequest and waits; we answer when you click a button on the bubble.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// While the hook waits, the desktop app doesn't show its own dialog, so after
// this long we answer "no decision" and the app asks instead.
const HOLD_MS = 120 * 1000;

class PermissionServer extends EventEmitter {
  constructor(endpointFile) {
    super();
    this.endpointFile = endpointFile;
    this.token = crypto.randomBytes(24).toString('hex');
    this.pending = new Map(); // id -> { req: {...}, res, timer }
    this.seq = 0;
    this.enabled = true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) for (const id of [...this.pending.keys()]) this.answer(id, null);
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(0, '127.0.0.1', () => {
      const { port } = this.server.address();
      fs.mkdirSync(path.dirname(this.endpointFile), { recursive: true });
      fs.writeFileSync(this.endpointFile, JSON.stringify({ port, token: this.token, pid: process.pid }));
    });
  }

  stop() {
    for (const id of [...this.pending.keys()]) this.answer(id, null);
    try {
      const cur = JSON.parse(fs.readFileSync(this.endpointFile, 'utf8'));
      if (cur.token === this.token) fs.unlinkSync(this.endpointFile);
    } catch { /* already gone */ }
    this.server?.close();
  }

  list() {
    return [...this.pending.entries()].map(([id, p]) => ({ id, ...p.info }));
  }

  handle(req, res) {
    if (req.method !== 'POST' || req.url !== '/permission' || req.headers['x-clawd-token'] !== this.token) {
      send(res, 403, {});
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(body); } catch { send(res, 400, {}); return; }
      if (!this.enabled) { send(res, 200, {}); return; }
      const id = `p${++this.seq}`;
      const info = {
        tool: String(input.tool_name || 'инструмент'),
        input: input.tool_input || {},
        cliId: String(input.session_id || ''),
        cwd: String(input.cwd || ''),
        canAlways: Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0,
        at: Date.now(),
      };
      const timer = setTimeout(() => this.answer(id, null), HOLD_MS);
      this.pending.set(id, { info, res, timer, suggestions: input.permission_suggestions || [] });
      // Hook process died (Claude stopped, user answered elsewhere...): drop it.
      res.on('close', () => { if (this.pending.has(id)) this.drop(id); });
      this.emit('change', this.list());
    });
  }

  // choice: 'allow' | 'always' | 'deny' | null (let the app ask instead)
  answer(id, choice) {
    const p = this.pending.get(id);
    if (!p) return;
    let out = {};
    if (choice === 'allow') out = { behavior: 'allow' };
    if (choice === 'always') out = { behavior: 'allow', updatedPermissions: p.suggestions };
    if (choice === 'deny') out = { behavior: 'deny' };
    send(p.res, 200, out);
    this.drop(id);
  }

  drop(id) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.emit('change', this.list());
  }
}

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  try {
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length, connection: 'close' });
    res.end(body);
  } catch { /* socket gone */ }
}

module.exports = { PermissionServer };
