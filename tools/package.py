"""Package Clawd Pet into dist/:

  dist/ClawdPet-Setup.exe       custom installer with the app appended as a zip payload
  dist/ClawdPet-portable.zip    the packed app folder, unzip anywhere and run ClawdPet.exe

Needs build/app (node tools/pack.mjs) and the installer release build
(cargo build --release in installer/src-tauri). build.ps1 runs everything.
"""
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
APP = ROOT / "build" / "app"
SETUP_EXE = ROOT / "installer" / "src-tauri" / "target" / "release" / "clawd-pet-setup.exe"
MAGIC = b"CPPAYLD1"


def mb(n):
    return f"{n / 1048576:.1f} MB"


def zip_dir(src, dest, prefix=""):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                z.write(f, prefix + f.relative_to(src).as_posix())


def main():
    for p in (APP / "ClawdPet.exe", APP / "clawd-hook.exe", SETUP_EXE):
        if not p.exists():
            raise SystemExit(f"missing: {p}")
    DIST.mkdir(exist_ok=True)

    portable = DIST / "ClawdPet-portable.zip"
    zip_dir(APP, portable, "ClawdPet/")
    print("portable", portable.name, mb(portable.stat().st_size))

    payload = DIST / "_payload.zip"
    zip_dir(APP, payload)
    setup = DIST / "ClawdPet-Setup.exe"
    data = payload.read_bytes()
    with open(setup, "wb") as out:
        out.write(SETUP_EXE.read_bytes())
        out.write(data)
        out.write(struct.pack("<Q", len(data)))
        out.write(MAGIC)
    payload.unlink()
    print("setup", setup.name, mb(setup.stat().st_size))


if __name__ == "__main__":
    main()
