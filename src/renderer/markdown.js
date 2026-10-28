// Tiny markdown -> HTML for reply previews. Escapes everything first.
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inline(s) {
    s = esc(s);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span class="link">$1</span>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  function blocks(text) {
    let html = '';
    let para = [];
    let list = [];
    const flushPara = () => { if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; };
    const flushList = () => { if (list.length) html += `<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`; list = []; };
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushPara(); flushList(); html += `<div class="h">${inline(m[1])}</div>`; continue; }
      if ((m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/))) { flushPara(); list.push(m[1]); continue; }
      if (/^\s*\|/.test(line)) {
        flushPara(); flushList();
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // table separator
        const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        html += `<div class="row">${inline(cells.join('  ·  '))}</div>`;
        continue;
      }
      if (/^\s*>/.test(line)) { para.push(line.replace(/^\s*>\s?/, '')); continue; }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
    return html;
  }

  window.renderMarkdown = function (src) {
    const parts = src.split('```');
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2) {
        const nl = part.indexOf('\n');
        const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '');
        html += `<pre><code>${esc(code)}</code></pre>`;
      } else {
        html += blocks(part);
      }
    });
    return html;
  };
})();
