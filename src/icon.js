// Tray icon: Clawd drawn into a 32x32 BGRA bitmap, no image files needed.
const { nativeImage } = require('electron');

const GRID = [
  '...############...',
  '...############...',
  '...##.######.##...',
  '...##.######.##...',
  '.################.',
  '.################.',
  '...############...',
  '...############...',
  '....#.#....#.#....',
  '....#.#....#.#....',
];

function trayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const top = 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gy = Math.floor(((y - top) * GRID.length) / 18);
      const gx = Math.floor((x * GRID[0].length) / size);
      if (gy < 0 || gy >= GRID.length || GRID[gy][gx] !== '#') continue;
      const i = (y * size + x) * 4;
      buf[i] = 0x57; buf[i + 1] = 0x77; buf[i + 2] = 0xd9; buf[i + 3] = 0xff; // #D97757 as BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

module.exports = { trayIcon, GRID };
