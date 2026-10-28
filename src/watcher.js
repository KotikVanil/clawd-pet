// Watches Claude Code transcripts (~/.claude/projects/*/*.jsonl) and the Claude
// desktop app log to figure out what Claude is doing right now. Read-only: it
// never changes any Claude files.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

const INIT_TAIL_BYTES = 768 * 1024;  // how much of a transcript to replay on attach
const LOG_TAIL_BYTES = 64 * 1024;
const TICK_MS = 600;
const SCAN_MS = 1500;
const INDEX_MS = 5000;
const DIRS_MS = 30 * 1000;
const DONE_TO_IDLE_MS = 25 * 1000;
const STALE_MS = 15 * 60 * 1000;     // working with no transcript writes this long -> idle
const SILENT_DONE_MS = 45 * 1000;    // reply written, no tools pending, nothing new -> done
const STICKY_MS = 45 * 1000;         // a busy chat keeps the pet this long after its last message
const PERM_MAX_AGE_MS = 60 * 60 * 1000;
const RECENT_MS = 24 * 3600 * 1000;

const short = (s, n = 48) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const base = (p) => (p ? path.basename(String(p)) : '');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return short(u, 30); } };

function toolLabel(name, input = {}) {
  switch (name) {
    case 'Read': return `читаю ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `правлю ${base(input.file_path)}`;
    case 'Write': return `пишу ${base(input.file_path)}`;
    case 'NotebookEdit': return `правлю ${base(input.notebook_path)}`;
    case 'Bash': case 'PowerShell':
      return input.description ? `› ${short(input.description)}` : `› ${short(input.command, 40)}`;
    case 'Grep': return `ищу «${short(input.pattern, 28)}»`;
    case 'Glob': return `ищу файлы ${short(input.pattern, 28)}`;
    case 'WebSearch': return `ищу в сети: ${short(input.query, 32)}`;
    case 'WebFetch': return `читаю ${host(input.url)}`;
    case 'Agent': case 'Task': return `агент: ${short(input.description, 36)}`;
    case 'AskUserQuestion': return 'у меня к тебе вопрос';
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return 'составляю план';
    case 'Skill': return `скилл ${short(input.skill, 30)}`;
    case 'ToolSearch': return 'достаю инструменты';
    case 'Artifact': return 'собираю страницу';
    default:
      if (String(name).startsWith('mcp__')) {
        const parts = name.split('__');
        const server = parts[1].replace(/^plugin_/, '').split('_').pop();
        return `${server}: ${parts.slice(2).join(' ').replace(/_/g, ' ')}`;
      }
      return String(name || 'инструмент');
  }
}

// The Claude desktop app has moved its data more than once
// (%APPDATA%\Claude, the MSIX package cache, %LOCALAPPDATA%\Claude-Data\<pkg>,
// logs in %LOCALAPPDATA%\Claude\logs). Look everywhere and use what exists.
function claudeDirs() {
  const out = [];
  const add = (p) => { try { if (fs.statSync(p).isDirectory()) out.push(p); } catch { /* missing */ } };
  add(path.join(LOCALAPPDATA, 'Claude'));
  for (const d of safeDir(path.join(LOCALAPPDATA, 'Claude-Data'))) add(path.join(LOCALAPPDATA, 'Claude-Data', d));
  add(path.join(APPDATA, 'Claude'));
  for (const d of safeDir(path.join(LOCALAPPDATA, 'Packages'))) {
    if (/^Claude_/i.test(d)) add(path.join(LOCALAPPDATA, 'Packages', d, 'LocalCache', 'Roaming', 'Claude'));
  }
  return out;
}

function freshState() {
  return {
    status: 'idle',      // idle | thinking | working | waiting | done | error
    detail: '',
    since: Date.now(),
    reply: '',
    replyId: '',
    replyAt: 0,
    thought: '',
    thoughtAt: 0,
    cliId: '',
    desktopId: '',
    title: '',
    project: '',
  };
}

class Watcher extends EventEmitter {
  constructor() {
    super();
    this.file = null;
    this.fileMtime = 0;
    this.offset = 0;
    this.partial = '';
    this.state = freshState();
    this.pendingTools = new Map();   // tool_use id -> name
    this.lastEntryKind = '';
    this.lastWriteAt = 0;
    this.index = new Map();          // cliSessionId -> { desktopId, title, cwd }
    this.indexMtimes = new Map();    // session json -> mtime (re-read only changed ones)
    this.titlesByDesktop = new Map();
    this.perms = new Map();          // requestId -> { tool, desktopId, at }
    this.sessionRoots = [];
    this.logFile = null;
    this.logOffset = 0;
    this.logPartial = '';
    this.lastScan = 0;
    this.lastIndex = 0;
    this.lastDirs = 0;
    this.activityAt = 0;
    this.activityCache = new Map();  // file -> { mtime, at }
    this.replaying = false;
    this.lastEmitted = '';
    this.follow = '';                // cliId to stick to; '' = automatic
  }

  start() {
    this.findDirs();
    this.scanIndex();
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() { clearInterval(this.timer); }

  // Desktop session info for a CLI session id (from a hook payload).
  lookup(cliId) {
    return this.index.get(cliId) || null;
  }

  // '' = follow the most active chat; otherwise stick to this CLI session id.
  setFollow(cliId) {
    this.follow = cliId || '';
    this.lastScan = 0;
    this.tick();
  }

  // Chats with a real message in the last 24 hours, newest first (for the tray menu).
  recentSessions(limit = 8) {
    const now = Date.now();
    const list = [];
    for (const file of transcriptFiles()) {
      let m;
      try { m = fs.statSync(file).mtimeMs; } catch { continue; }
      if (now - m > RECENT_MS) continue;
      const at = file === this.file ? this.activityAt : this.activityOf(file, m);
      if (!at || now - at > RECENT_MS) continue;
      const cliId = path.basename(file, '.jsonl');
      const meta = this.index.get(cliId);
      list.push({ cliId, at, title: meta?.title || base(meta?.cwd) || base(path.dirname(file)) });
    }
    return list.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  // ---------- public snapshot ----------
  snapshot() {
    const s = { ...this.state, follow: this.follow };
    // A pending permission / question in the desktop app wins over everything.
    const now = Date.now();
    let perm = null;
    for (const [id, p] of this.perms) {
      if (now - p.at > PERM_MAX_AGE_MS) { this.perms.delete(id); continue; }
      if (!perm || p.desktopId === s.desktopId) perm = p;
    }
    if (perm) {
      s.status = 'waiting';
      s.since = perm.at;
      const other = perm.desktopId && perm.desktopId !== s.desktopId;
      const what = perm.tool === 'AskUserQuestion' ? 'у меня к тебе вопрос' : `можно ${perm.tool}?`;
      s.detail = other ? `${what} (${short(this.titlesByDesktop.get(perm.desktopId) || 'другой чат', 24)})` : what;
    } else if ([...this.pendingTools.values()].includes('AskUserQuestion')) {
      s.status = 'waiting';
      s.detail = 'у меня к тебе вопрос';
    }
    return s;
  }

  // ---------- main loop ----------
  tick() {
    const now = Date.now();
    try {
      if (now - this.lastDirs > DIRS_MS) this.findDirs();
      if (now - this.lastIndex > INDEX_MS) this.scanIndex();
      if (now - this.lastScan > SCAN_MS) this.scanTranscripts();
      this.readTranscript();
      this.readLog();
      this.timeouts(now);
    } catch (err) {
      console.error('[watcher]', err);
    }
    this.emitIfChanged();
  }

  emitIfChanged() {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key !== this.lastEmitted) {
      this.lastEmitted = key;
      this.emit('update', snap);
    }
  }

  setStatus(status, detail = '', at = Date.now()) {
    const st = this.state;
    if (st.status !== status) st.since = at;
    st.status = status;
    st.detail = detail;
  }

  timeouts(now) {
    const st = this.state;
    const quiet = now - this.lastWriteAt;
    if (st.status === 'done' && now - st.since > DONE_TO_IDLE_MS) this.setStatus('idle', '', now);
    if (st.status === 'error' && now - st.since > DONE_TO_IDLE_MS * 2) this.setStatus('idle', '', now);
    if ((st.status === 'working' || st.status === 'thinking') && quiet > STALE_MS) this.setStatus('idle', '', now);
    if (st.status === 'working' && this.lastEntryKind === 'text' && this.pendingTools.size === 0 && quiet > SILENT_DONE_MS) {
      this.setStatus('done', 'готово!', now);
    }
  }

  // ---------- where the desktop app keeps its files ----------
  findDirs() {
    this.lastDirs = Date.now();
    const dirs = claudeDirs();
    this.sessionRoots = dirs.map((d) => path.join(d, 'claude-code-sessions')).filter(isDir);
    // the live log is the most recently written main.log
    let best = null, bestM = 0;
    for (const d of dirs) {
      const f = path.join(d, 'logs', 'main.log');
      try { const m = fs.statSync(f).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch { /* none */ }
    }
    if (best !== this.logFile) {
      this.logFile = best;
      this.logDecoder = null;
      this.logPartial = '';
      let size = 0;
      try { size = fs.statSync(best).size; } catch { /* gone */ }
      this.logOffset = Math.max(0, size - LOG_TAIL_BYTES);
      this.readLog(true);
    }
  }

  // ---------- desktop session index ----------
  scanIndex() {
    this.lastIndex = Date.now();
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    for (const root of this.sessionRoots) {
      for (const acc of safeDir(root)) {
        for (const org of safeDir(path.join(root, acc))) {
          const dir = path.join(root, acc, org);
          for (const f of safeDir(dir)) {
            if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
            const full = path.join(dir, f);
            try {
              const m = fs.statSync(full).mtimeMs;
              if (m < cutoff || this.indexMtimes.get(full) === m) continue;
              const j = JSON.parse(fs.readFileSync(full, 'utf8'));
              this.indexMtimes.set(full, m);
              const desktopId = String(j.sessionId || f.slice(0, -5)).replace(/^local_/, '');
              this.titlesByDesktop.set(desktopId, j.title || '');
              if (j.cliSessionId) this.index.set(j.cliSessionId, { desktopId, title: j.title || '', cwd: j.cwd || '' });
            } catch { /* file being written */ }
          }
        }
      }
    }
    const meta = this.index.get(this.state.cliId);
    if (meta) {
      this.state.desktopId = meta.desktopId;
      this.state.title = meta.title;
    }
  }

  // ---------- transcripts ----------
  // The desktop app appends metadata lines (title, agent name...) to old
  // transcripts when you open them, which bumps their mtime. So we pick the
  // chat by the timestamp of its last real message, not by file mtime.
  scanTranscripts() {
    this.lastScan = Date.now();
    const files = transcriptFiles();

    if (this.follow) {
      const want = files.find((f) => path.basename(f, '.jsonl') === this.follow);
      if (want && want !== this.file) this.attach(want);
      return;
    }

    // While the current chat is busy, don't jump to another one that is also talking.
    const st = this.state.status;
    const busy = this.file && (st === 'thinking' || st === 'working' || st === 'waiting') && Date.now() - this.lastWriteAt < STICKY_MS;
    if (busy) return;

    let best = null, bestAt = this.file ? this.activityAt : 0;
    for (const full of files) {
      if (full === this.file) continue;
      let m;
      try { m = fs.statSync(full).mtimeMs; } catch { continue; }
      if (m <= bestAt) continue; // can't contain anything newer
      const at = this.activityOf(full, m);
      if (at > bestAt + 1000) { bestAt = at; best = full; }
    }
    if (best) this.attach(best);
  }

  // Long tool outputs can push the last reply out of the replayed tail:
  // walk backwards in 1 MB steps (up to 24 MB) looking for assistant text.
  findOlderReply(file, end) {
    const STEP = 1024 * 1024;
    let carry = '';
    for (let hi = end; hi > 0 && end - hi < 24 * STEP; hi -= STEP) {
      const lo = Math.max(0, hi - STEP);
      const lines = (readRange(file, lo, hi).toString('utf8') + carry).split('\n');
      carry = lo > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l.includes('"type":"assistant"') || !l.includes('"type":"text"')) continue;
        try {
          const e = JSON.parse(l);
          if (e.isSidechain) continue;
          const text = (e.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
          if (!text) continue;
          const at = Date.parse(e.timestamp) || 0;
          Object.assign(this.state, { reply: text, replyId: e.uuid || String(at), replyAt: at });
          return;
        } catch { /* cut line */ }
      }
    }
  }

  // Timestamp of the last user/assistant/system entry, cached per mtime.
  // Looks at the last 4 MB at most (big tool outputs can fill the tail).
  activityOf(file, mtime) {
    const c = this.activityCache.get(file);
    if (c && c.mtime === mtime) return c.at;
    let at = 0;
    try {
      const size = fs.statSync(file).size;
      const STEP = 512 * 1024;
      let carry = '';
      for (let hi = size; hi > 0 && size - hi < 4 * 1024 * 1024 && !at; hi -= STEP) {
        const lo = Math.max(0, hi - STEP);
        const lines = (readRange(file, lo, hi).toString('utf8') + carry).split('\n');
        carry = lo > 0 ? lines.shift() : '';
        for (let i = lines.length - 1; i >= 0 && !at; i--) {
          const l = lines[i];
          if (!/"type":"(user|assistant|system)"/.test(l)) continue;
          try {
            const e = JSON.parse(l);
            if (!e.isSidechain && e.timestamp) at = Date.parse(e.timestamp) || 0;
          } catch { /* cut line */ }
        }
      }
    } catch { /* unreadable */ }
    this.activityCache.set(file, { mtime, at });
    return at;
  }

  attach(file) {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    this.file = file;
    this.partial = '';
    this.pendingTools.clear();
    this.lastEntryKind = '';
    this.state = freshState();
    this.state.cliId = path.basename(file, '.jsonl');
    const meta = this.index.get(this.state.cliId);
    if (meta) { this.state.desktopId = meta.desktopId; this.state.title = meta.title; }

    const start = Math.max(0, size - INIT_TAIL_BYTES);
    this.decoder = new StringDecoder('utf8');
    const text = this.decoder.write(readRange(file, start, size));
    this.offset = size;
    let lines = text.split('\n');
    if (start > 0) lines = lines.slice(1);              // first line is probably cut
    this.partial = text.endsWith('\n') ? '' : lines.pop() || '';
    this.activityAt = 0;
    this.replaying = true;
    for (const l of lines) this.processLine(l);
    this.replaying = false;
    if (!this.state.reply && start > 0) this.findOlderReply(file, start);
    if (!this.activityAt) this.activityAt = this.activityOf(file, fs.statSync(file).mtimeMs);

    // Replay of an old transcript: don't pretend it is still running.
    this.fileMtime = fs.statSync(file).mtimeMs;
    this.lastWriteAt = this.activityAt || this.fileMtime;
    const age = Date.now() - this.lastWriteAt;
    if (this.state.status === 'done' && age > DONE_TO_IDLE_MS) this.setStatus('idle');
    if ((this.state.status === 'working' || this.state.status === 'thinking') && age > STALE_MS) this.setStatus('idle');
  }

  readTranscript() {
    if (!this.file) return;
    let st;
    try { st = fs.statSync(this.file); } catch { this.file = null; return; }
    this.fileMtime = st.mtimeMs;
    if (st.size < this.offset) { this.attach(this.file); return; }
    if (st.size === this.offset) return;
    const chunk = this.decoder.write(readRange(this.file, this.offset, st.size));
    this.offset = st.size;
    const lines = (this.partial + chunk).split('\n');
    this.partial = lines.pop() || '';
    for (const l of lines) this.processLine(l);
  }

  processLine(line) {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.isSidechain) return;
    const at = Date.parse(e.timestamp) || Date.now();
    if (e.timestamp && (e.type === 'user' || e.type === 'assistant' || e.type === 'system')) {
      this.activityAt = Math.max(this.activityAt, at);
      if (!this.replaying) this.lastWriteAt = Date.now();
    }
    if (e.cwd) this.state.project = base(e.cwd);
    const content = e.message?.content;

    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary) return;
      const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      const results = items.filter((i) => i.type === 'tool_result');
      if (results.length) {
        for (const r of results) this.pendingTools.delete(r.tool_use_id);
        if (this.state.status !== 'done') this.setStatus('thinking', 'думаю…', at);
        this.lastEntryKind = 'result';
        return;
      }
      const text = items.filter((i) => i.type === 'text').map((i) => i.text).join(' ').trim();
      if (!text && !items.some((i) => i.type === 'image')) return;
      if (/^\[Request interrupted/.test(text)) { this.pendingTools.clear(); this.setStatus('idle', 'остановлено', at); return; }
      if (text.startsWith('<') && !items.some((i) => i.type === 'image')) return; // command / system wrappers
      this.pendingTools.clear();
      this.state.thought = '';
      this.setStatus('thinking', 'думаю…', at);
      this.lastEntryKind = 'prompt';
      return;
    }

    if (e.type === 'assistant') {
      if (e.isApiErrorMessage || e.error) {
        const msg = Array.isArray(content) ? content.map((i) => i.text || '').join(' ') : '';
        this.setStatus('error', short(msg || 'ошибка API', 60), at);
        this.lastEntryKind = 'error';
        return;
      }
      for (const item of Array.isArray(content) ? content : []) {
        if (item.type === 'thinking' || item.type === 'redacted_thinking') {
          // Thinking text is only sometimes present (often it's redacted to a signature).
          const thought = cleanThought(item.thinking);
          if (thought) { this.state.thought = thought; this.state.thoughtAt = at; }
          this.setStatus('thinking', 'думаю…', at);
          this.lastEntryKind = 'thinking';
        } else if (item.type === 'text' && item.text?.trim()) {
          this.state.reply = item.text.trim();
          this.state.replyId = e.uuid || String(at);
          this.state.replyAt = at;
          this.setStatus('working', 'пишу ответ…', at);
          this.lastEntryKind = 'text';
        } else if (item.type === 'tool_use') {
          this.pendingTools.set(item.id, item.name);
          this.setStatus(item.name === 'AskUserQuestion' ? 'waiting' : 'working', toolLabel(item.name, item.input), at);
          this.lastEntryKind = 'tool';
        }
      }
      if (e.message?.stop_reason === 'end_turn' && this.pendingTools.size === 0) this.setStatus('done', 'готово!', at);
      return;
    }

    if (e.type === 'system') {
      if (e.subtype === 'stop_hook_summary' || e.subtype === 'turn_duration') {
        this.pendingTools.clear();
        if (this.state.status !== 'error') this.setStatus('done', 'готово!', at);
      } else if (e.subtype === 'api_error') {
        this.setStatus('error', 'ошибка API, пробую ещё раз', at);
      } else if (e.subtype === 'compact_boundary') {
        this.setStatus('working', 'сжимаю контекст', at);
      }
    }
  }

  // ---------- desktop app log: permission prompts + sent messages ----------
  readLog(initial = false) {
    const file = this.logFile;
    if (!file) return;
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (!this.logDecoder || size < this.logOffset) { this.logDecoder = new StringDecoder('utf8'); this.logPartial = ''; }
    if (size < this.logOffset) this.logOffset = 0;
    if (size === this.logOffset) return;
    const chunk = this.logDecoder.write(readRange(file, this.logOffset, size));
    const wasStart = this.logOffset;
    this.logOffset = size;
    const lines = (this.logPartial + chunk).split('\n');
    this.logPartial = lines.pop() || '';
    if (initial && wasStart > 0) lines.shift(); // first line of the tail is cut
    for (const l of lines) {
      let m = l.match(/Emitted tool permission request (\S+) for (.+?) in session local_([\w-]+)/);
      if (m) { this.perms.set(m[1], { tool: m[2], desktopId: m[3], at: logTime(l) }); continue; }
      m = l.match(/Received permission response for (\S+?):/) || l.match(/respondToToolPermission: requestId=([^,\s]+)/);
      if (m) { this.perms.delete(m[1]); continue; }
      // a stopped or interrupted turn drops its prompts (but not stopShellPty: that's the terminal pane)
      m = l.match(/LocalSessions\.(?:stop|interrupt)(?:Session|Query|Turn)?: sessionId=local_([\w-]+)/);
      if (m) { for (const [id, p] of this.perms) if (p.desktopId === m[1]) this.perms.delete(id); continue; }
      if (initial) continue;
      m = l.match(/LocalSessions\.sendMessage: sessionId=local_([\w-]+)/);
      if (m && m[1] === this.state.desktopId) this.setStatus('thinking', 'думаю…');
    }
  }
}

function transcriptFiles() {
  const out = [];
  for (const d of safeDir(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, d);
    for (const f of safeDir(dir)) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
  }
  return out;
}

// First couple of sentences of a thinking block, without markdown.
function cleanThought(text) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 220 ? s.slice(0, 219) + '…' : s;
}

function logTime(line) {
  const m = line.match(/^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  const t = m ? Date.parse(`${m[1]}T${m[2]}`) : NaN;
  return Number.isFinite(t) && Math.abs(Date.now() - t) < 48 * 3600 * 1000 ? t : Date.now();
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function safeDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function readRange(file, start, end) {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { Watcher, toolLabel, claudeDirs };
