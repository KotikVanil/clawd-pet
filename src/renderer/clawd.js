// Clawd: pixel-art Claude mascot drawn procedurally on a canvas.
// Grid is 18x10 "pixels" (the terminal logo, with square pixels):
//   body 12x8 at x3..14, arms 2x2 at mid height, four 1x2 legs, 1x2 eyes.
(function () {
  const S = 6;                  // one Clawd pixel in CSS px
  const GW = 18, GH = 10;
  const CW = 200, CH = 160;     // canvas CSS size
  const OX = (CW - GW * S) / 2; // grid origin
  const OY = CH - GH * S - 8;
  const ORANGE = '#D97757';
  const EYE = '#141413';
  const AMBER = '#ffc145';
  const LILAC = '#c9b5ff';
  const CONFETTI = ['#D97757', '#ffc145', '#5fd38a', '#6cb2ff', '#b69cff', '#ff8fb1'];
  const LEGS = [4, 6, 11, 13];
  const EYES = [5, 12];
  const HEART = ['.#.#.', '#####', '.###.', '..#..'];
  const BLUSH = '#f4a0a0';
  const HOVER_REACTIONS = ['notice', 'hop', 'wave', 'spin', 'surprise', 'love'];
  const DUR = { hop: 650, spin: 700, squish: 650, surprise: 900, love: 1100, wave: 1000, land: 320, dizzy: 1700, notice: 520, boop: 260, purr: 1400 };
  const HOVER_COOLDOWN_MS = 2500;
  const PET_STROKES = 3;          // direction flips within PET_WINDOW_MS that start petting
  const PET_WINDOW_MS = 1500;
  const PET_LINGER_MS = 700;

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class Clawd {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = 0;
      this.mode = 'idle';
      this.detail = '';
      this.modeAt = performance.now();
      this.reaction = null;
      this.lastReaction = '';
      this.hover = false;
      this.cursor = { x: 0, y: 0 };
      this.lastHoverReact = 0;
      this.strokes = [];
      this.strokeDir = 1;
      this.lastStroke = 0;
      this.pettingSince = 0;
      this.dragging = false;
      this.dragVx = 0;
      this.particles = [];
      this.timers = {};
      this.nextBlink = performance.now() + 2000;
      this.pose = null;
      this.last = performance.now();
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    // ---------- control ----------
    setMode(mode, detail = '') {
      this.detail = detail;
      if (mode === this.mode) return;
      this.mode = mode;
      this.modeAt = performance.now();
      if (mode === 'done') this.burst('confetti', 28);
      if (mode === 'waiting') this.burst('spark', 6);
    }

    react(kind) {
      this.reaction = { kind, at: performance.now(), dur: DUR[kind] || 700 };
      if (kind === 'hop') this.burst('heart', 2);
      if (kind === 'love') this.burst('heart', 5);
      if (kind === 'purr') this.burst('heart', 7);
      if (kind === 'surprise') this.burst('spark', 5);
    }

    // Cursor over Clawd: a random greeting when it arrives, then eyes follow it.
    setHover(on, x = 0, y = 0) {
      const now = performance.now();
      if (on) this.cursor = { x, y };
      if (on && !this.hover && !this.dragging && !this.reaction && !this.pettingSince && now - this.lastHoverReact > HOVER_COOLDOWN_MS) {
        this.lastHoverReact = now;
        let kind;
        do { kind = HOVER_REACTIONS[Math.floor(Math.random() * HOVER_REACTIONS.length)]; } while (kind === this.lastReaction);
        this.lastReaction = kind;
        this.react(kind);
      }
      this.hover = on;
    }

    // One back-and-forth stroke of the cursor; a few in a row = petting.
    stroke(dir) {
      const now = performance.now();
      this.strokes = this.strokes.filter((t) => now - t < PET_WINDOW_MS);
      this.strokes.push(now);
      this.strokeDir = dir;
      this.lastStroke = now;
      if (!this.pettingSince && this.strokes.length >= PET_STROKES) {
        this.pettingSince = now;
        this.reaction = null;
      }
    }

    setDrag(on, vx = 0) {
      this.dragging = on;
      this.dragVx = vx;
    }

    hit(x, y) {
      const p = this.pose || { dx: 0, dy: 0 };
      return x >= OX + p.dx - 4 && x <= OX + p.dx + GW * S + 4 && y >= OY + p.dy - 2 * S && y <= OY + GH * S + 6;
    }

    // ---------- animation ----------
    every(key, ms, t) {
      if (!this.timers[key] || t - this.timers[key] >= ms) { this.timers[key] = t; return true; }
      return false;
    }

    computePose(t) {
      const p = { dx: 0, dy: 0, sx: 1, sy: 1, eyes: 'open', lx: 0, ly: 0, armL: 0, armR: 0, legs: [0, 0, 0, 0], legLen: 2, over: null };
      const tm = t - this.modeAt;

      if (this.dragging) {
        this.dragVx *= 0.92;
        p.legLen = 3;
        const sw = Math.sin(t / 110);
        p.legs = [sw > 0 ? 1 : 0, sw > 0 ? 0 : 1, sw > 0 ? 1 : 0, sw > 0 ? 0 : 1];
        p.armL = p.armR = 'up';
        p.eyes = 'wide';
        p.dx = clamp(-this.dragVx * 0.8, -9, 9);
        p.sy = 1.05; p.sx = 0.96;
        return p;
      }

      if (this.pettingSince) {
        if (t - this.lastStroke > PET_LINGER_MS) {
          const long = this.lastStroke - this.pettingSince > 2000;
          this.pettingSince = 0;
          this.strokes = [];
          this.react(long ? 'purr' : 'love');
        } else {
          this.pettingPose(p, t);
          return p;
        }
      }

      if (this.reaction) {
        const r = this.reaction;
        const ms = t - r.at;
        const u = ms / r.dur;
        if (u >= 1) this.reaction = null;
        else { this.reactionPose(p, r.kind, u, ms, t); return this.blink(p, t); }
      }

      switch (this.mode) {
        case 'thinking': {
          p.ly = -1;
          p.lx = Math.floor(t / 1100) % 2 ? 1 : -1;
          p.armR = -2;
          p.dx = Math.round(Math.sin(t / 700) * 2);
          p.sy = 1 + 0.02 * Math.sin(t / 500);
          p.over = 'dots';
          break;
        }
        case 'working': {
          const writing = this.detail.startsWith('пишу ответ');
          const st = Math.floor(t / (writing ? 95 : 120)) % 2;
          p.armL = st ? -1 : 0;
          p.armR = st ? 0 : -1;
          if (writing) {
            p.ly = 1;
            p.sy = 1 + 0.015 * Math.sin(t / 300);
          } else {
            p.legs = st ? [1, 0, 1, 0] : [0, 1, 0, 1];
            p.dy = st ? -2 : 0;
            p.ly = 1;
            if (this.every('spark', 380, t)) this.spawn('spark', OX + p.dx + (Math.random() < 0.5 ? 1 : 16) * S, OY + 4 * S);
          }
          break;
        }
        case 'waiting': {
          const c = tm % 1400;
          if (c < 360) { const u = c / 360; p.dy = -Math.sin(Math.PI * u) * 14; p.sy = 1.05; p.sx = 0.96; }
          else if (c < 450) { p.sy = 0.9; p.sx = 1.08; }
          p.eyes = 'wide';
          p.armL = Math.floor(t / 220) % 2 ? 'up' : -2;
          p.over = '!';
          break;
        }
        case 'done': {
          p.eyes = 'happy';
          if (tm < 760) {
            if (tm < 130) { const u = tm / 130; p.sy = 1 - 0.15 * u; p.sx = 1 + 0.12 * u; }
            else if (tm < 580) { const u = (tm - 130) / 450; p.dy = -Math.sin(Math.PI * u) * 28; p.sy = 1.08; p.sx = 0.94; p.legs = [1, 1, 1, 1]; }
            else { const u = (tm - 580) / 180; p.sy = 0.86 + 0.14 * u; p.sx = 1.12 - 0.12 * u; }
            p.armL = p.armR = 'up';
          } else {
            const c = (tm - 760) % 1100;
            if (c < 280) p.dy = -Math.sin((Math.PI * c) / 280) * 6;
            const side = Math.floor(tm / 450) % 2;
            p.armL = side ? 'up' : 0;
            p.armR = side ? 0 : 'up';
            if (this.every('star', 700, t)) this.spawn('star', OX + rand(0, GW) * S, OY + rand(-2, 3) * S);
          }
          break;
        }
        case 'error': {
          p.eyes = tm < 1600 ? 'x' : 'sad';
          if (tm < 600) p.dx = Math.sin(tm / 28) * 4 * (1 - tm / 600);
          p.sy = 0.95; p.sx = 1.03;
          p.armL = p.armR = 1;
          if (this.every('drop', 2200, t)) this.spawn('drop', OX + 15 * S, OY + 1 * S);
          break;
        }
        default: { // idle
          const asleep = tm > 120000;
          const br = Math.sin(t / 650);
          p.sy = 1 + 0.02 * br;
          p.sx = 1 - 0.01 * br;
          if (asleep) {
            p.eyes = 'closed';
            p.sy = 1 + 0.04 * Math.sin(t / 900);
            if (this.every('z', 1500, t)) this.spawn('z', OX + 15 * S, OY - S);
          } else {
            const ph = Math.floor(t / 2600) % 7;
            p.lx = ph === 2 ? -1 : ph === 4 ? 1 : 0;
            if (ph === 6) { // little foot tap
              const st = Math.floor(t / 160) % 2;
              p.legs = st ? [0, 0, 1, 0] : [0, 0, 0, 0];
            }
          }
        }
      }
      this.followCursor(p);
      return this.blink(p, t);
    }

    followCursor(p) {
      if (!this.hover || (p.eyes !== 'open' && p.eyes !== 'wide')) return;
      const cx = OX + 9 * S + p.dx;
      const cy = OY + 3 * S + p.dy;
      p.lx = clamp(Math.round((this.cursor.x - cx) / 30), -1, 1);
      p.ly = clamp(Math.round((this.cursor.y - cy) / 30), -1, 1);
    }

    pettingPose(p, t) {
      const pt = t - this.pettingSince;
      const k = clamp((t - this.lastStroke) / 260, 0, 1); // 0 right after a stroke
      p.eyes = pt > 2200 ? 'happy' : 'closed';
      p.blush = true;
      p.sy = 0.9 + 0.1 * k;
      p.sx = 1.08 - 0.08 * k;
      p.dx = this.strokeDir * 3 * (1 - k);
      p.armL = p.armR = -1;
      p.legs = Math.floor(t / 180) % 2 ? [0, 1, 0, 0] : [0, 0, 1, 0];
      if (this.every('pet-heart', pt > 2200 ? 200 : 380, t)) this.spawn('heart', OX + rand(3, 15) * S, OY - rand(0, 1) * S);
    }

    reactionPose(p, kind, u, ms, t) {
      switch (kind) {
        case 'notice':
          p.eyes = 'wide';
          p.armL = p.armR = -2;
          if (u < 0.6) p.dy = -Math.sin((Math.PI * u) / 0.6) * 7;
          break;
        case 'boop':
          p.sy = 1 - 0.14 * Math.sin(Math.PI * u);
          p.sx = 1 + 0.1 * Math.sin(Math.PI * u);
          p.eyes = 'closed';
          break;
        case 'purr':
          p.eyes = 'happy';
          p.blush = true;
          p.sy = 1 + 0.04 * Math.sin(ms / 60);
          p.armL = p.armR = 'up';
          if (u < 0.3) p.dy = -Math.sin((Math.PI * u) / 0.3) * 16;
          break;
        case 'hop':
          p.dy = -Math.sin(Math.PI * u) * 24;
          p.eyes = 'happy';
          p.armL = p.armR = 'up';
          if (u > 0.85) { p.sy = 0.92; p.sx = 1.06; }
          break;
        case 'spin':
          p.sx = Math.cos(u * Math.PI * 2);
          if (Math.abs(p.sx) < 0.15) p.sx = 0.15 * Math.sign(p.sx || 1);
          p.dy = -Math.sin(Math.PI * u) * 10;
          break;
        case 'squish':
          if (u < 0.45) { const k = Math.sin((Math.PI / 2) * (u / 0.45)); p.sy = 1 - 0.32 * k; p.sx = 1 + 0.22 * k; p.eyes = 'closed'; }
          else { const v = (u - 0.45) / 0.55; p.sy = 1 + 0.12 * Math.sin(v * Math.PI * 3) * (1 - v); p.sx = 2 - p.sy; p.eyes = 'happy'; }
          break;
        case 'surprise':
          p.eyes = 'wide';
          p.over = '!';
          p.armL = p.armR = 'up';
          if (u < 0.25) p.dy = -Math.sin((Math.PI * u) / 0.25) * 12;
          break;
        case 'love':
          p.eyes = 'happy';
          p.sy = 1 + 0.05 * Math.sin(ms / 70);
          p.armL = p.armR = -2;
          if (this.every('heart', 260, t)) this.spawn('heart', OX + rand(4, 14) * S, OY - S);
          break;
        case 'wave':
          p.eyes = 'happy';
          p.armR = Math.floor(ms / 150) % 2 ? 'up' : -2;
          p.dy = u < 0.3 ? -Math.sin((Math.PI * u) / 0.3) * 8 : 0;
          break;
        case 'land':
          p.sy = 0.8 + 0.2 * u;
          p.sx = 1.14 - 0.14 * u;
          p.eyes = 'closed';
          break;
        case 'dizzy':
          p.eyes = 'x';
          p.dx = Math.sin(ms / 90) * 5;
          p.sx = u < 0.4 ? Math.cos((u / 0.4) * Math.PI * 4) : 1;
          if (Math.abs(p.sx) < 0.15) p.sx = 0.15;
          p.over = 'stars';
          break;
      }
    }

    blink(p, t) {
      if (p.eyes === 'open' || p.eyes === 'wide') {
        if (t >= this.nextBlink) {
          if (t < this.nextBlink + 120) p.eyes = 'blink';
          else this.nextBlink = t + rand(2200, 5500);
        }
      }
      return p;
    }

    // ---------- particles ----------
    burst(type, n) {
      for (let i = 0; i < n; i++) this.spawn(type, OX + rand(5, 13) * S, OY + rand(-1, 2) * S);
    }

    spawn(type, x, y) {
      const p = { type, x, y, vx: 0, vy: 0, g: 0, life: 1, age: 0, color: '#fff', size: 3, rot: 0 };
      switch (type) {
        case 'confetti':
          Object.assign(p, { vx: rand(-140, 140), vy: rand(-300, -140), g: 620, life: rand(1.1, 1.6), color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)], size: Math.random() < 0.5 ? 3 : 4 });
          break;
        case 'heart':
          Object.assign(p, { vx: rand(-20, 20), vy: rand(-70, -45), life: 1.3, color: '#ff6b8b', rot: rand(0, 6) });
          break;
        case 'z':
          Object.assign(p, { vx: 14, vy: -20, life: 2.6, color: '#d6d9ff' });
          break;
        case 'spark':
          Object.assign(p, { vx: rand(-40, 40), vy: rand(-80, -30), g: 120, life: rand(0.3, 0.5), color: Math.random() < 0.5 ? '#ffffff' : AMBER, size: 2 });
          break;
        case 'star':
          Object.assign(p, { vy: -10, life: 0.8, color: AMBER });
          break;
        case 'drop':
          Object.assign(p, { vx: 12, vy: -30, g: 360, life: 0.9, color: '#7cc4ff' });
          break;
      }
      this.particles.push(p);
    }

    // ---------- drawing ----------
    // Backing-store scale: device pixels per CSS px, times how much the canvas
    // is stretched by CSS (the installer shows Clawd bigger than the pet window).
    resize() {
      const k = (window.devicePixelRatio || 1) * ((this.cv.clientWidth || CW) / CW);
      if (k === this.dpr) return;
      this.dpr = k;
      this.cv.width = Math.round(CW * k);
      this.cv.height = Math.round(CH * k);
    }

    fill(x1, y1, x2, y2, color) {
      const d = this.dpr;
      if (x1 > x2) [x1, x2] = [x2, x1];
      if (y1 > y2) [y1, y2] = [y2, y1];
      const X1 = Math.round(x1 * d), X2 = Math.round(x2 * d), Y1 = Math.round(y1 * d), Y2 = Math.round(y2 * d);
      this.ctx.fillStyle = color;
      this.ctx.fillRect(X1, Y1, Math.max(1, X2 - X1), Math.max(1, Y2 - Y1));
    }

    // Grid rect, squashed/stretched around Clawd's bottom center.
    rect(p, gx, gy, gw, gh, color) {
      const cx = OX + 9 * S + p.dx;
      const cy = OY + GH * S + p.dy;
      this.fill(cx + (gx - 9) * S * p.sx, cy + (gy - GH) * S * p.sy, cx + (gx + gw - 9) * S * p.sx, cy + (gy + gh - GH) * S * p.sy, color);
    }

    // Grid rect that follows Clawd but ignores squash (overlays above the head).
    flat(p, gx, gy, gw, gh, color) {
      const x = OX + p.dx + gx * S;
      const y = OY + p.dy + (GH * S) * (1 - p.sy) + gy * S;
      this.fill(x, y, x + gw * S, y + gh * S, color);
    }

    drawArm(p, side, a) {
      const L = side === 'L';
      if (a === 'up') {
        this.rect(p, L ? 0 : 16, -1, 2, 2, ORANGE);
        this.rect(p, L ? 1 : 15, 1, 2, 2, ORANGE);
      } else {
        this.rect(p, L ? 1 : 15, 4 + a, 2, 2, ORANGE);
      }
    }

    drawEyes(p, t) {
      for (const x of EYES) {
        const ex = x + p.lx, ey = p.ly;
        switch (p.eyes) {
          case 'open': this.rect(p, ex, 2 + ey, 1, 2, EYE); break;
          case 'wide': this.rect(p, ex, 1 + ey, 1, 3, EYE); break;
          case 'blink': this.rect(p, ex - 0.5, 3.2 + ey, 2, 0.5, EYE); break;
          case 'closed': this.rect(p, x - 0.5, 3, 2, 0.5, EYE); break;
          case 'happy':
            this.rect(p, x - 1, 3, 1, 1, EYE);
            this.rect(p, x, 2, 1, 1, EYE);
            this.rect(p, x + 1, 3, 1, 1, EYE);
            break;
          case 'sad':
            this.rect(p, x, 3, 1, 1, EYE);
            this.rect(p, x === 5 ? x - 1 : x, 1.5, 2, 0.5, EYE);
            if (x === 12 && Math.floor(t / 400) % 3 !== 0) this.rect(p, x, 4.2, 1, 1, '#7cc4ff');
            break;
          case 'x':
            for (const [dx, dy] of [[-1, 1], [1, 1], [0, 2], [-1, 3], [1, 3]]) this.rect(p, x + dx, dy, 1, 1, EYE);
            break;
        }
      }
    }

    drawOverlay(p, t) {
      if (p.over === '!') {
        if (Math.floor(t / 280) % 4 === 3) return;
        this.flat(p, 8.5, -6.5, 1, 2.8, AMBER);
        this.flat(p, 8.5, -3.2, 1, 1, AMBER);
      } else if (p.over === 'dots') {
        const active = Math.floor(t / 320) % 4;
        for (let i = 0; i < 3; i++) this.flat(p, 6.5 + i * 2, i === active ? -3.5 : -2.8, 1, 1, LILAC);
      } else if (p.over === 'stars') {
        for (let i = 0; i < 3; i++) {
          const a = t / 160 + (i * Math.PI * 2) / 3;
          this.flat(p, 8.5 + Math.cos(a) * 6, -2 + Math.sin(a) * 1.4, 1, 1, AMBER);
        }
      }
    }

    drawShadow(p) {
      const lift = clamp(-p.dy / 40, 0, 0.6);
      const w = GW * S * 0.62 * (1 - lift) * Math.abs(p.sx);
      const cx = OX + 9 * S + p.dx;
      const y = OY + GH * S + 2;
      this.ctx.fillStyle = `rgba(0,0,0,${0.22 * (1 - lift)})`;
      const d = this.dpr;
      this.ctx.beginPath();
      this.ctx.ellipse(cx * d, y * d, (w / 2) * d, 3 * d, 0, 0, Math.PI * 2);
      this.ctx.fill();
    }

    drawParticles(dt) {
      const ctx = this.ctx;
      const d = this.dpr;
      this.particles = this.particles.filter((q) => (q.age += dt) < q.life);
      for (const q of this.particles) {
        q.vy += q.g * dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        const a = 1 - q.age / q.life;
        ctx.globalAlpha = Math.min(1, a * 1.6);
        if (q.type === 'heart') {
          const sway = Math.sin(q.age * 6 + q.rot) * 3;
          HEART.forEach((row, ry) => [...row].forEach((c, rx) => {
            if (c === '#') this.fill(q.x + sway + rx * 2, q.y + ry * 2, q.x + sway + rx * 2 + 2, q.y + ry * 2 + 2, q.color);
          }));
        } else if (q.type === 'z') {
          ctx.fillStyle = q.color;
          ctx.font = `bold ${Math.round((9 + q.age * 4) * d)}px Consolas, monospace`;
          ctx.fillText('z', q.x * d, q.y * d);
        } else if (q.type === 'star') {
          const s = 2;
          this.fill(q.x - s / 2, q.y - s * 1.5, q.x + s / 2, q.y + s * 1.5, q.color);
          this.fill(q.x - s * 1.5, q.y - s / 2, q.x + s * 1.5, q.y + s / 2, q.color);
        } else if (q.type === 'drop') {
          this.fill(q.x, q.y, q.x + 2, q.y + 3, q.color);
          this.fill(q.x - 1, q.y + 1, q.x + 3, q.y + 3, q.color);
        } else {
          this.fill(q.x, q.y, q.x + q.size, q.y + q.size, q.color);
        }
      }
      ctx.globalAlpha = 1;
    }

    loop(t) {
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.resize();
      const p = this.computePose(t);
      this.pose = p;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.cv.width, this.cv.height);
      this.drawShadow(p);
      LEGS.forEach((x, i) => this.rect(p, x, 8, 1, p.legLen - p.legs[i], ORANGE));
      this.rect(p, 3, 0, 12, 8, ORANGE);
      this.drawArm(p, 'L', p.armL);
      this.drawArm(p, 'R', p.armR);
      this.drawEyes(p, t);
      if (p.blush) { this.rect(p, 3.5, 4, 1.5, 1, BLUSH); this.rect(p, 13, 4, 1.5, 1, BLUSH); }
      this.drawOverlay(p, t);
      this.drawParticles(dt);
      requestAnimationFrame(this.loop);
    }
  }

  Clawd.WIDTH = CW;
  Clawd.HEIGHT = CH;
  window.Clawd = Clawd;
})();
