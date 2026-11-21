// Builds web/changelog.html from CHANGELOG.md: one card per day (newest first), each split into the app's sections,
// with buttons to show one section across all days. Run: node tools/changelog-page.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
  .replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1">$1</a>');

const days = []; let day = null, sec = null;
for (const line of md.split('\n')) {
  let m;
  if ((m = line.match(/^## (\d{4}-\d{2}-\d{2})/))) { day = { date: m[1], sections: [] }; days.push(day); sec = null; continue; }
  if (!day) continue;
  if ((m = line.match(/^### (.+)/))) { sec = { name: m[1].trim(), items: [] }; day.sections.push(sec); continue; }
  if ((m = line.match(/^- (.+)/)) && sec) { sec.items.push(m[1]); continue; }
  if (/^\s{2,}\S/.test(line) && sec && sec.items.length) sec.items[sec.items.length - 1] += ' ' + line.trim();
}
days.sort((a, b) => b.date.localeCompare(a.date));
const PREF = ['Editor', 'Downloads & exports', 'PDF tools', 'OCR & fonts', 'Handwriting & signatures', 'Forms & signing', 'Site & layout', 'Fixes'];
const rank = (n) => { const i = PREF.indexOf(n); return i < 0 ? 99 : i; };
days.forEach((d) => d.sections.sort((x, y) => rank(x.name) - rank(y.name)));
const order = [];
days.forEach((d) => d.sections.forEach((s) => { if (!order.includes(s.name)) order.push(s.name); }));
order.sort((x, y) => rank(x) - rank(y));
const nice = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const total = days.reduce((n, d) => n + d.sections.reduce((k, s) => k + s.items.length, 0), 0);
const body = days.map((d) => `
  <section class="day" id="d${d.date}">
    <h2><a href="#d${d.date}">${nice(d.date)}</a><small>${d.sections.reduce((k, s) => k + s.items.length, 0)} changes</small></h2>
    ${d.sections.map((s) => `<div class="sec" data-sec="${slug(s.name)}"><h3>${esc(s.name)}</h3><ul>${s.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul></div>`).join('')}
  </section>`).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230a1a3f'/%3E%3Cpath d='M7 23 C 12 10, 20 10, 25 9' stroke='white' stroke-width='2.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E" />
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What's new - Ghost Calligrapher</title>
<meta name="description" content="Every change to Ghost Calligrapher, day by day and by section.">
<style>
  :root{--bg:#f5f6f8;--card:#fff;--text:#1d2330;--muted:#5d6678;--line:#e1e5ec;--accent:#6d4aff;--chip:#eef0f5;--tint:#f2efff}
  @media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14161c;--card:#1d2029;--text:#e8eaf0;--muted:#9aa3b5;--line:#2c313d;--accent:#9d86ff;--chip:#262a35;--tint:#272240}}
  :root[data-theme=dark]{--bg:#14161c;--card:#1d2029;--text:#e8eaf0;--muted:#9aa3b5;--line:#2c313d;--accent:#9d86ff;--chip:#262a35;--tint:#272240}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 "Source Sans 3",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line)}
  .bar{max-width:920px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .bar a.home{font-weight:700;color:var(--text);text-decoration:none;font-size:18px}
  .bar .sp{flex:1}
  .bar a.repo{color:var(--muted);font-size:13px}
  .chips{max-width:920px;margin:0 auto;padding:0 16px 12px;display:flex;gap:6px;flex-wrap:wrap}
  .chips button{border:1px solid var(--line);background:var(--chip);color:var(--text);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
  .chips button.on{background:var(--accent);border-color:var(--accent);color:#fff}
  main{max-width:920px;margin:0 auto;padding:18px 16px 60px}
  h1{font-size:26px;margin:4px 0 2px}
  .lead{color:var(--muted);margin:0 0 18px}
  .days{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px}
  .days a{font-size:13px;color:var(--accent);text-decoration:none;background:var(--tint);border-radius:6px;padding:3px 8px}
  .day{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 20px 14px;margin:0 0 16px}
  .day h2{font-size:19px;margin:12px 0 4px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .day h2 a{color:var(--text);text-decoration:none}
  .day h2 small{font-size:12.5px;color:var(--muted);font-weight:400}
  .sec h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:14px 0 4px}
  .sec ul{margin:0;padding-left:20px}
  .sec li{margin:4px 0}
  code{background:var(--chip);border-radius:4px;padding:0 4px;font-size:.92em}
  a{color:var(--accent)}
  .hidden{display:none}
  @view-transition{navigation:auto}
  ::view-transition-old(root){animation:gc-out .14s ease-out both}
  ::view-transition-new(root){animation:gc-in .2s ease-out both}
  @keyframes gc-out{to{opacity:0}}
  @keyframes gc-in{from{opacity:0}}
  @media (prefers-reduced-motion:reduce){::view-transition-old(root),::view-transition-new(root){animation:none}}
</style>
</head>
<body>
<header>
  <div class="bar"><a class="home" href="./">Ghost Calligrapher</a><span class="sp"></span><a class="repo" href="https://github.com/Jcodomo/calligrapher2/blob/main/CHANGELOG.md">CHANGELOG.md on GitHub</a></div>
  <div class="chips" id="chips"><button class="on" data-f="">All sections</button>${order.map((s) => `<button data-f="${slug(s)}">${esc(s)}</button>`).join('')}</div>
</header>
<main>
  <h1>What's new</h1>
  <p class="lead">${total} changes over ${days.length} days, newest first, grouped by section. Pick a section to see only its changes.</p>
  <nav class="days">${days.map((d) => `<a href="#d${d.date}">${d.date}</a>`).join('')}</nav>
  ${body}
</main>
<script>
  (function () {
    try { var t = localStorage.getItem('cal2_theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
    var chips = document.getElementById('chips');
    function show(f) {
      chips.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.f === f); });
      document.querySelectorAll('.sec').forEach(function (s) { s.classList.toggle('hidden', !!f && s.dataset.sec !== f); });
      document.querySelectorAll('.day').forEach(function (d) { d.classList.toggle('hidden', !d.querySelector('.sec:not(.hidden)')); });
      try { history.replaceState(null, '', f ? '#section=' + f : location.pathname); } catch (e) {}
    }
    chips.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) show(b.dataset.f); });
    var m = location.hash.match(/section=([\\w-]+)/); if (m) show(m[1]);
  })();
</script>
</body>
</html>
`;
writeFileSync(path.join(root, 'web', 'changelog.html'), html);
console.log(`web/changelog.html: ${days.length} days, ${total} changes, sections: ${order.join(', ')}`);
