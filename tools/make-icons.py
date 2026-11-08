"""Иконки PWA для «Круга»: тот же рисунок, что в favicon.svg.

Запуск: python tools/make-icons.py
Кладёт public/icons/icon-180.png, icon-192.png, icon-512.png, icon-maskable-512.png.
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'public', 'icons')

C1 = (79, 70, 229)    # #4f46e5
C2 = (124, 58, 237)   # #7c3aed
DOT = (109, 92, 245)  # #6d5cf5


def gradient(size: int) -> Image.Image:
    img = Image.new('RGB', (size, size))
    px = img.load()
    denom = 2 * (size - 1)
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            px[x, y] = (
                round(C1[0] + (C2[0] - C1[0]) * t),
                round(C1[1] + (C2[1] - C1[1]) * t),
                round(C1[2] + (C2[2] - C1[2]) * t),
            )
    return img


def glyph(draw: ImageDraw.ImageDraw, ox: float, oy: float, scale: float) -> None:
    """Рисует облачко в координатах исходного SVG (viewBox 64x64)."""
    def p(x, y):
        return (ox + x * scale, oy + y * scale)

    x0, y0, x1, y1, r = 18, 18, 46, 42, 4.5
    draw.rounded_rectangle([p(x0, y0), p(x1, y1)], radius=r * scale, fill=(255, 255, 255))
    draw.polygon([p(31, 41.5), p(22.8, 49.3), p(22.8, 41.5)], fill=(255, 255, 255))
    for cx in (26, 32, 38):
        rr = 2.6 * scale
        cx_px, cy_px = p(cx, 30)
        draw.ellipse([cx_px - rr, cy_px - rr, cx_px + rr, cy_px + rr], fill=DOT)


def build(size: int, rounded: bool) -> Image.Image:
    ss = 4                              # суперсэмплинг для сглаживания
    big = size * ss
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))

    bg = gradient(big).convert('RGBA')
    mask = Image.new('L', (big, big), 0)
    md = ImageDraw.Draw(mask)
    if rounded:
        md.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 16 / 64), fill=255)
    else:
        md.rectangle([0, 0, big - 1, big - 1], fill=255)
    canvas.paste(bg, (0, 0), mask)

    layer = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    # глиф крупнее и отцентрован по самому облачку (с хвостиком), а не по тайлу
    k = 1.12 if rounded else 0.74
    scale = (big / 64) * k
    cx = off_x = big / 2 - 32 * scale
    cy = big / 2 - 33.7 * scale
    glyph(ld, cx, cy, scale)
    canvas = Image.alpha_composite(canvas, layer)

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ('icon-180.png', 180, True),
        ('icon-192.png', 192, True),
        ('icon-512.png', 512, True),
        ('icon-maskable-512.png', 512, False),
    ]
    for name, size, rounded in jobs:
        img = build(size, rounded)
        path = os.path.join(OUT, name)
        img.save(path, 'PNG', optimize=True)
        print(f'{name}: {size}x{size}, {os.path.getsize(path)} bytes')


if __name__ == '__main__':
    main()
