// Packages the Electron app into build/app/ (ClawdPet.exe + resources) and adds clawd-hook.exe.
// Run: node tools/pack.mjs   (needs hook/target/release/clawd-hook.exe and build/icon.ico)
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.join(ROOT, 'build', 'app');
const HOOK = path.join(ROOT, 'hook', 'target', 'release', 'clawd-hook.exe');
const KEEP_LOCALES = new Set(['en-US.pak', 'ru.pak']);

for (const f of [HOOK, path.join(ROOT, 'build', 'icon.ico')]) {
  if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
}

const [dir] = await packager({
  dir: ROOT,
  name: 'Clawd Pet',
  executableName: 'ClawdPet',
  platform: 'win32',
  arch: 'x64',
  out: path.join(ROOT, 'build', 'tmp'),
  overwrite: true,
  asar: true,
  prune: true,
  icon: path.join(ROOT, 'build', 'icon.ico'),
  appVersion: pkg.version,
  appCopyright: 'KotikVanil',
  win32metadata: {
    CompanyName: 'KotikVanil',
    FileDescription: 'Clawd Pet',
    ProductName: 'Clawd Pet',
    InternalName: 'ClawdPet',
    OriginalFilename: 'ClawdPet.exe',
  },
  ignore: [
    /^\/(installer|hook|tools|build|dist|\.git|\.github)(\/|$)/,
    /^\/src\/probe\.js$/,
    /^\/Clawd\.cmd$/,
    /^\/[^/]+\.md$/,
    /^\/\.gitignore$/,
  ],
});

// keep only the locales we need (saves ~40 MB)
const locales = path.join(dir, 'locales');
for (const f of fs.readdirSync(locales)) if (!KEEP_LOCALES.has(f)) fs.rmSync(path.join(locales, f));
fs.copyFileSync(HOOK, path.join(dir, 'clawd-hook.exe'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(dir, OUT);
fs.rmSync(path.join(ROOT, 'build', 'tmp'), { recursive: true, force: true });

let total = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
walk(OUT);
console.log(`packed ${OUT} (${(total / 1048576).toFixed(1)} MB)`);
