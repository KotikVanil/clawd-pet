"""Draws the Clawd icon (same 18x10 grid as src/icon.js) for the app and the installer.

Writes:
  build/icon.ico                          app exe icon (16..256)
  installer/src-tauri/icons/icon.ico      installer icon
  installer/src-tauri/icons/32x32.png, 128x128.png, 128x128@2x.png
Run: python tools/make_icon.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ORANGE = (217, 119, 87, 255)
EYE = (20, 20, 19, 255)
GRID = [
    "...############...",
    "...############...",
    "...##E######E##...",
    "...##E######E##...",
    ".################.",
    ".################.",
    "...############...",
    "...############...",
    "....#.#....#.#....",
    "....#.#....#.#....",
]


def clawd(size):
    """Clawd centered on a transparent square, integer pixel scale where possible."""
    gw, gh = len(GRID[0]), len(GRID)
    scale = max(1, (size - max(2, size // 16)) // gw)
    img = Image.new("RGBA", (gw * scale, gh * scale), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(GRID):
        for x, c in enumerate(row):
            if c == ".":
                continue
            color = EYE if c == "E" else ORANGE
            for dy in range(scale):
                for dx in range(scale):
                    px[x * scale + dx, y * scale + dy] = color
    if img.width > size:  # 16 px: no integer scale fits, shrink with nearest
        img = img.resize((size, round(size * gh / gw)), Image.NEAREST)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, ((size - img.width) // 2, (size - img.height) // 2 + size // 16))
    return out


def save_ico(path, sizes=(16, 24, 32, 48, 64, 128, 256)):
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = [clawd(s) for s in sizes]
    frames[-1].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])


def main():
    save_ico(ROOT / "build" / "icon.ico")
    icons = ROOT / "installer" / "src-tauri" / "icons"
    save_ico(icons / "icon.ico")
    clawd(32).save(icons / "32x32.png")
    clawd(128).save(icons / "128x128.png")
    clawd(256).save(icons / "128x128@2x.png")
    clawd(512).save(ROOT / "build" / "icon.png")
    print("icons written")


if __name__ == "__main__":
    main()
