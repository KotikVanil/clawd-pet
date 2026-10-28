// `npm run demo`: cycles through every state with a fake session, no Claude needed.
const { EventEmitter } = require('events');

const REPLY = `Готово! Вот что я сделал:

- **watcher.js** читает транскрипт сессии
- **clawd.js** рисует Clawd пиксель-артом
- пузырь показывает мой ответ и статус

\`\`\`bash
npm start
\`\`\`

Кликни по пузырю, чтобы развернуть ответ целиком. Правый клик по Clawd открывает чат.`;

const STEPS = [
  { status: 'thinking', detail: 'думаю…', ms: 3500 },
  { status: 'working', detail: 'читаю watcher.js', ms: 3000 },
  { status: 'working', detail: '› npm install', ms: 3000 },
  { status: 'working', detail: 'пишу ответ…', ms: 2500, reply: true },
  { status: 'done', detail: 'готово!', ms: 5000 },
  { status: 'waiting', detail: 'можно PowerShell?', ms: 5000 },
  { status: 'error', detail: 'ошибка API', ms: 4000 },
  { status: 'idle', detail: '', ms: 6000 },
];

class DemoWatcher extends EventEmitter {
  constructor() {
    super();
    this.i = -1;
    this.state = {
      status: 'idle', detail: '', since: Date.now(), reply: '', replyId: '', replyAt: 0,
      cliId: 'demo', desktopId: '', title: 'Демо: питомец Clawd', project: 'clawd-pet',
    };
  }
  start() { this.next(); }
  stop() { clearTimeout(this.t); }
  snapshot() { return { ...this.state }; }
  lookup() { return null; }
  get follow() { return ''; }
  setFollow() {}
  recentSessions() { return []; }
  next() {
    this.i = (this.i + 1) % STEPS.length;
    const s = STEPS[this.i];
    Object.assign(this.state, { status: s.status, detail: s.detail, since: Date.now() });
    if (s.reply) Object.assign(this.state, { reply: REPLY, replyId: 'r' + Date.now(), replyAt: Date.now() });
    this.emit('update', this.snapshot());
    this.t = setTimeout(() => this.next(), s.ms);
  }
}

module.exports = { DemoWatcher };
