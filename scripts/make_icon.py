"""Draws Hangar's icon (a hangar arch with an open door) into scripts/icon-1024.png and
public/hangar-mark.png. Then run `npx tauri icon scripts/icon-1024.png` for the app icons.
Needs Pillow. Writes plain PNGs with no metadata."""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NIGHT = (22, 26, 46, 255)
GOLD = (242, 198, 109, 255)
S = 4  # supersampling for smooth edges


def draw(size: int, background: bool) -> Image.Image:
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if background:
        pad = int(n * 0.04)
        d.rounded_rectangle([pad, pad, n - pad, n - pad], radius=int(n * 0.22), fill=NIGHT)
    # The arch: a half disc sitting on a ground line.
    cx, ground = n / 2, n * 0.67
    r = n * 0.33
    d.pieslice([cx - r, ground - r, cx + r, ground + r], 180, 360, fill=GOLD)
    d.rectangle([cx - r, ground - n * 0.004, cx + r, ground + n * 0.03], fill=GOLD)
    # The open door: a dark rectangle cut into the arch, with three slats.
    dw, dh = r * 0.95, r * 0.62
    d.rectangle([cx - dw / 2, ground - dh, cx + dw / 2, ground + n * 0.03], fill=NIGHT if background else (0, 0, 0, 0))
    slat = n * 0.018
    for i in range(1, 4):
        y = ground - dh + i * dh / 4
        d.rectangle([cx - dw / 2, y - slat / 2, cx + dw / 2, y + slat / 2], fill=GOLD)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    draw(1024, True).save(os.path.join(HERE, "scripts", "icon-1024.png"), optimize=True)
    draw(64, False).save(os.path.join(HERE, "public", "hangar-mark.png"), optimize=True)
    print("ok")
