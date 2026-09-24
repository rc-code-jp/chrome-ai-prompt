#!/usr/bin/env python3
"""拡張機能アイコン（PNG）を生成する。標準ライブラリのみ: python3 scripts/generate-icons.py"""

import struct
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4
OUT_DIR = Path(__file__).resolve().parent.parent / "icons"

# 左上 → 右下のグラデーション（violet → indigo → cyan）
STOPS = ((0.0, (139, 92, 246)), (0.55, (99, 102, 241)), (1.0, (34, 211, 238)))
WHITE = (255, 255, 255)


def gradient(t):
    t = min(max(t, 0.0), 1.0)
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return tuple(a + (b - a) * k for a, b in zip(c0, c1))
    return STOPS[-1][1]


def in_rounded_rect(x, y, size, radius):
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def in_sparkle(x, y, cx, cy, r, p=0.55):
    """|x|^p + |y|^p <= r^p で、辺がくぼんだ 4 点スターになる。"""
    dx, dy = abs(x - cx) / r, abs(y - cy) / r
    return dx**p + dy**p <= 1.0


def render(size):
    radius = size * 0.26
    main = (size * 0.45, size * 0.55, size * (0.38 if size <= 16 else 0.34))
    small = (size * 0.74, size * 0.26, size * 0.13)
    raw = bytearray()
    n = SUPERSAMPLE * SUPERSAMPLE
    for py in range(size):
        raw.append(0)  # filter: none
        for px in range(size):
            r = g = b = covered = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = px + (sx + 0.5) / SUPERSAMPLE
                    y = py + (sy + 0.5) / SUPERSAMPLE
                    if not in_rounded_rect(x, y, size, radius):
                        continue
                    if in_sparkle(x, y, *main) or (size >= 32 and in_sparkle(x, y, *small)):
                        color = WHITE
                    else:
                        base = gradient((x + y) / (2 * size))
                        gloss = 0.16 * max(0.0, 1 - y / (size * 0.55))  # 上部をわずかに明るく
                        color = tuple(c + (255 - c) * gloss for c in base)
                    r += color[0]
                    g += color[1]
                    b += color[2]
                    covered += 1
            if covered:
                raw += bytes((round(r / covered), round(g / covered), round(b / covered), round(255 * covered / n)))
            else:
                raw += b"\0\0\0\0"
    return png(size, size, bytes(raw))


def png(width, height, raw):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    OUT_DIR.mkdir(exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        path.write_bytes(render(size))
        print(f"wrote {path.relative_to(OUT_DIR.parent)}")


if __name__ == "__main__":
    main()
