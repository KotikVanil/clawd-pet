// Prints what the pet currently sees, then exits. `npm run probe`
const { Watcher } = require('./watcher');

const w = new Watcher();
w.tick();
w.scanTranscripts();
w.tick();
const s = w.snapshot();
console.log(JSON.stringify({ ...s, reply: s.reply.slice(0, 200) + (s.reply.length > 200 ? '…' : ''), file: w.file }, null, 2));
