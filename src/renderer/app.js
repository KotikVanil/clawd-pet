(function () {
  const api = window.pet;
  const canvas = document.getElementById('pet');
  const clawd = new window.Clawd(canvas);
  const bubble = document.getElementById('bubble');
  const q = (s) => bubble.querySelector(s);
  const el = {
    dot: q('.dot'), status: q('.status'), time: q('.time'), close: q('.close'), thought: q('.thought'),
    meta: q('.meta'), body: q('.body'), text: q('.text'), more: q('.more'), perm: q('.perm'),
  };

  const COLORS = { idle: '--c-idle', thinking: '--c-thinking', working: '--c-working', waiting: '--c-waiting', done: '--c-done', error: '--c-error' };
  const LABELS = { idle: 'последний ответ', thinking: 'думаю…', working: 'работаю', waiting: 'жду тебя', done: 'готово!', error: 'ошибка' };
  const DONE_MINI_MS = 12 * 1000;    // "готово!" mini bubble stays this long
  const THOUGHT_MS = 90 * 1000;      // show a thought this long after it was written
  const STROKE_PX = 10;              // cursor travel between direction flips that counts as a stroke

  let st = null;
  let typing = null;
  let open = false;       // full bubble, toggled by left click on Clawd
  let expanded = false;   // full reply inside the open bubble
  let ignoring = true;
  let drag = null;
  let perms = [];
  let permKey = '';
  let hoverPet = false;
  const strokeTrack = { lastX: null, dir: 0, travel: 0 };

  // ---------- state from main ----------
  api.onState((s) => {
    const prev = st;
    st = s;
    clawd.setMode(perms.length ? 'waiting' : s.status, s.detail);
    if (!prev || s.replyId !== prev.replyId || s.cliId !== prev.cliId) {
      expanded = false;
      showReply(s.reply || '', open && !!prev && !!s.reply && s.cliId === prev.cliId);
    }
    if (prev && prev.status !== s.status && (s.status === 'waiting' || s.status === 'done' || s.status === 'error')) pop();
    render();
  });
  api.onPerms((list) => {
    const had = perms.length;
    perms = list || [];
    if (perms.length && !had) pop();
    if (st) clawd.setMode(perms.length ? 'waiting' : st.status, st.detail);
    render();
  });
  api.ready();
  setInterval(render, 1000);

  // ---------- reply text with typewriter ----------
  function showReply(text, animate) {
    if (typing) cancelAnimationFrame(typing);
    typing = null;
    if (!animate) {
      el.text.innerHTML = text ? window.renderMarkdown(text) : '<p class="empty">пока нет ответа</p>';
      return;
    }
    const step = Math.max(2, Math.ceil(text.length / 75));
    let n = 0;
    const tick = () => {
      n = Math.min(text.length, n + step);
      el.text.innerHTML = window.renderMarkdown(text.slice(0, n)) + (n < text.length ? '<span class="caret"></span>' : '');
      if (n < text.length) typing = requestAnimationFrame(tick);
      else { typing = null; updateMore(); }
    };
    tick();
  }

  function pop() {
    bubble.classList.remove('pop');
    void bubble.offsetWidth;
    bubble.classList.add('pop');
  }

  function fmtAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} с`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} мин`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} ч` : `${Math.round(h / 24)} д`;
  }

  function updateMore() {
    const overflow = el.body.scrollHeight > el.body.clientHeight + 2;
    el.body.classList.toggle('short', !overflow && !expanded);
    el.more.classList.toggle('gone', !overflow && !expanded);
  }

  // ---------- permission card ----------
  const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const VERBS = {
    Bash: 'запустить команду', PowerShell: 'запустить команду', Edit: 'изменить файл', MultiEdit: 'изменить файл',
    Write: 'создать файл', Read: 'прочитать файл', WebFetch: 'открыть страницу', WebSearch: 'поискать в интернете',
  };

  function diffLines(oldS, newS) {
    const take = (s, sign, cls) => cut(s, 400).split('\n').slice(0, 6)
      .map((l) => `<span class="${cls}">${sign} ${escHtml(l)}</span>`).join('\n');
    return [oldS ? take(oldS, '-', 'del') : '', newS ? take(newS, '+', 'add') : ''].filter(Boolean).join('\n');
  }

  function permDetails(p) {
    const i = p.input || {};
    switch (p.tool) {
      case 'Bash': case 'PowerShell': return { desc: i.description, code: escHtml(cut(i.command, 600)) };
      case 'Edit': return { desc: baseName(i.file_path), code: diffLines(i.old_string, i.new_string) };
      case 'MultiEdit': return { desc: baseName(i.file_path), code: diffLines(i.edits?.[0]?.old_string, i.edits?.[0]?.new_string) };
      case 'Write': return { desc: i.file_path, code: escHtml(cut(i.content, 400)) };
      case 'Read': case 'NotebookEdit': return { desc: i.file_path || i.notebook_path };
      case 'WebFetch': return { desc: i.url };
      case 'WebSearch': return { desc: i.query };
      default: return { code: escHtml(cut(JSON.stringify(i, null, 1), 500)) };
    }
  }

  function renderPerm() {
    const p = perms[0];
    const key = p ? `${p.id}:${perms.length}` : '';
    if (key === permKey) return;
    permKey = key;
    if (!p) { el.perm.innerHTML = ''; return; }
    const d = permDetails(p);
    const verb = VERBS[p.tool] ? escHtml(VERBS[p.tool]) + ' ' : '';
    el.perm.innerHTML =
      `<div class="perm-title">Claude хочет ${verb}<b>(${escHtml(p.tool)})</b></div>` +
      (d.desc ? `<div class="perm-desc">${escHtml(cut(d.desc, 140))}</div>` : '') +
      (d.code ? `<pre>${d.code}</pre>` : '') +
      '<div class="perm-btns"><button class="ok" data-c="allow">Разрешить</button>' +
      (p.canAlways ? '<button data-c="always">Всегда</button>' : '') +
      '<button class="no" data-c="deny">Отклонить</button></div>' +
      '<div class="perm-foot"><span class="app" data-c="app">ответить в приложении</span>' +
      (perms.length > 1 ? ` · ещё ${perms.length - 1}` : '') + '</div>';
  }

  el.perm.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = e.target.closest('[data-c]')?.dataset.c;
    const p = perms[0];
    if (!c || !p) return;
    api.answerPerm(p.id, c === 'app' ? null : c);
    if (c === 'allow' || c === 'always') clawd.react('hop');
    if (c === 'deny') clawd.react('squish');
  });

  // ---------- render bubble ----------
  // Three looks: hidden, mini (status pill while Claude works), open (full reply, left click).
  function render() {
    if (!st) return;
    renderPerm();
    const now = Date.now();
    const s = st;

    if (perms.length) {
      const p = perms[0];
      setDot('waiting', true);
      el.status.textContent = 'нужно твоё разрешение';
      el.time.textContent = fmtAge(now - p.at);
      el.meta.textContent = [p.title, p.project].filter(Boolean).join(' · ');
      el.thought.textContent = '';
      setLook({ hidden: false, mini: false, asking: true, waiting: true });
      return;
    }

    const busy = s.status === 'thinking' || s.status === 'working' || s.status === 'waiting' || s.status === 'error';
    const justDone = s.status === 'done' && now - s.since < DONE_MINI_MS;
    const mini = !open && (busy || justDone);
    const thoughtFresh = s.thought && now - (s.thoughtAt || 0) < THOUGHT_MS && (s.status === 'thinking' || s.status === 'working');

    setDot(s.status, s.status === 'thinking' || s.status === 'working' || s.status === 'waiting');
    el.status.textContent = (s.status === 'done' && mini ? 'готово! нажми на меня' : s.detail) || LABELS[s.status] || '';
    el.time.textContent = s.status === 'idle'
      ? (s.replyAt ? fmtAge(now - s.replyAt) + ' назад' : '')
      : fmtAge(now - s.since);
    el.meta.textContent = [s.title, s.project].filter(Boolean).join(' · ');
    el.thought.textContent = thoughtFresh ? s.thought : '';

    setLook({ hidden: !open && !mini, mini, asking: false, waiting: s.status === 'waiting' });
    if (open) updateMore();
  }

  function setDot(status, live) {
    const c = `var(${COLORS[status] || COLORS.idle})`;
    el.dot.style.background = c;
    el.dot.style.color = c;
    el.dot.classList.toggle('live', live);
  }

  function setLook({ hidden, mini, asking, waiting }) {
    bubble.classList.toggle('hidden', hidden);
    bubble.classList.toggle('compact', mini);
    bubble.classList.toggle('asking', asking);
    bubble.classList.toggle('expanded', expanded && !mini && !asking);
    bubble.classList.toggle('waiting', waiting);
  }

  function toggleOpen(force) {
    open = typeof force === 'boolean' ? force : !open;
    if (!open) { expanded = false; el.body.scrollTop = 0; }
    if (open) pop();
    render();
  }

  // ---------- bubble interactions ----------
  el.close.addEventListener('click', (e) => {
    e.stopPropagation();
    if (perms.length) { api.answerPerm(perms[0].id, null); return; } // × on a permission = answer in the app
    toggleOpen(false);
  });

  bubble.addEventListener('click', () => {
    if (window.getSelection().toString()) return; // user is selecting text
    if (perms.length) return;
    if (!open) return toggleOpen(true);           // mini -> full
    if (!st || !st.reply) return;
    expanded = !expanded;
    if (!expanded) el.body.scrollTop = 0;
    render();
  });

  // Right click on the bubble: open the chat this bubble is about.
  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    clawd.react('wave');
    if (perms[0]) api.answerPerm(perms[0].id, null); // hand the question to the app, main opens that chat
    else api.openChat(st?.desktopId);
  });

  // ---------- click-through: only Clawd and the bubble catch the mouse ----------
  function setIgnore(v) {
    if (v === ignoring) return;
    ignoring = v;
    api.setIgnore(v);
  }

  function petPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Moving the cursor back and forth over Clawd = petting.
  function trackStroke(x) {
    const t = strokeTrack;
    if (t.lastX === null) { t.lastX = x; return; }
    const dx = x - t.lastX;
    t.lastX = x;
    if (!dx) return;
    const dir = Math.sign(dx);
    if (dir === t.dir) { t.travel += Math.abs(dx); return; }
    if (t.travel >= STROKE_PX) clawd.stroke(t.dir);
    t.dir = dir;
    t.travel = Math.abs(dx);
  }

  document.addEventListener('mousemove', (e) => {
    if (drag) return;
    const p = petPoint(e);
    const onPet = clawd.hit(p.x, p.y);
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const onBubble = !!target && bubble.contains(target) && !bubble.classList.contains('hidden');
    setIgnore(!(onPet || onBubble));
    canvas.style.cursor = onPet ? 'pointer' : 'default';
    if (onPet) trackStroke(e.screenX);
    if (onPet !== hoverPet) {
      hoverPet = onPet;
      strokeTrack.lastX = null;
      strokeTrack.dir = 0;
    }
    clawd.setHover(onPet, p.x, p.y);
  });

  document.addEventListener('mouseleave', () => {
    if (drag) return;
    setIgnore(true);
    hoverPet = false;
    clawd.setHover(false);
  });

  // ---------- drag / click / right click ----------
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = petPoint(e);
    if (!clawd.hit(p.x, p.y)) return;
    drag = { sx: e.screenX, sy: e.screenY, moved: false, lastX: e.screenX, lastT: performance.now(), vx: 0 };
    canvas.setPointerCapture(e.pointerId);
    api.dragStart();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.sx;
    const dy = e.screenY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      canvas.classList.add('dragging');
    }
    if (!drag.moved) return;
    const now = performance.now();
    const v = ((e.screenX - drag.lastX) / Math.max(1, now - drag.lastT)) * 16;
    drag.vx = drag.vx * 0.6 + v * 0.4;
    drag.lastX = e.screenX;
    drag.lastT = now;
    clawd.setDrag(true, drag.vx);
    api.dragMove(dx, dy);
  });

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove('dragging');
    api.dragEnd();
    if (d.moved) {
      clawd.setDrag(false);
      clawd.react('land');
    } else {
      clawd.react('boop');
      toggleOpen();
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = petPoint(e);
    if (!clawd.hit(p.x, p.y)) return;
    clawd.react('wave');
    api.openChat(perms[0] ? perms[0].desktopId : st?.desktopId);
  });
})();
