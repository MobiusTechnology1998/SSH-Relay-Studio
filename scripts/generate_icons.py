#!/usr/bin/env python3
"""
Generates crisp antialiased PNG and Windows ICO app/tray icons for SSH Relay Studio
using only Python's standard library (struct + zlib).
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources")
os.makedirs(OUT_DIR, exist_ok=True)


def make_png(width: int, height: int, rgba_bytes: bytes) -> bytes:
    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        return struct.pack("!I", len(data)) + c + struct.pack("!I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(rgba_bytes[y * stride : (y + 1) * stride])

    ihdr = struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def make_ico(png_entries: list[tuple[int, bytes]]) -> bytes:
    count = len(png_entries)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    directory = bytearray()
    payload = bytearray()
    for size, png_data in png_entries:
        dim = 0 if size >= 256 else size
        directory.extend(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png_data), offset))
        payload.extend(png_data)
        offset += len(png_data)
    return header + bytes(directory) + bytes(payload)


def draw_rounded_shield_icon(size: int, bg_rgb: tuple[int, int, int], ring_rgb: tuple[int, int, int]) -> bytes:
    buf = bytearray(size * size * 4)
    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0
    radius = size * 0.44
    corner = size * 0.22
    half_box = size * 0.44

    for y in range(size):
        for x in range(size):
            dx = abs(x - cx)
            dy = abs(y - cy)
            # Signed distance to rounded square
            qx = max(dx - (half_box - corner), 0.0)
            qy = max(dy - (half_box - corner), 0.0)
            dist = math.hypot(qx, qy) - corner

            idx = (y * size + x) * 4
            if dist <= 0.5:
                alpha = max(0.0, min(1.0, 0.5 - dist))
                r, g, b = bg_rgb

                # Draw clean twin-node tunnel motif inside (two circles linked by a bar)
                nx = (x - cx) / radius
                ny = (y - cy) / radius
                d_left = math.hypot(nx + 0.34, ny) - 0.19
                d_right = math.hypot(nx - 0.34, ny) - 0.19
                in_bar = abs(ny) <= 0.075 and abs(nx) <= 0.34
                if d_left <= 0 or d_right <= 0 or in_bar:
                    r, g, b = ring_rgb

                buf[idx] = r
                buf[idx + 1] = g
                buf[idx + 2] = b
                buf[idx + 3] = int(alpha * 255)
            else:
                buf[idx + 3] = 0
    return make_png(size, size, bytes(buf))


def draw_tray_dot(size: int, fill_rgb: tuple[int, int, int]) -> bytes:
    buf = bytearray(size * size * 4)
    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0
    outer_r = size * 0.42
    inner_r = size * 0.22

    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            idx = (y * size + x) * 4
            if d <= outer_r + 0.7:
                alpha = max(0.0, min(1.0, outer_r + 0.7 - d))
                if d <= inner_r:
                    r, g, b = (255, 255, 255)
                else:
                    r, g, b = fill_rgb
                buf[idx] = r
                buf[idx + 1] = g
                buf[idx + 2] = b
                buf[idx + 3] = int(alpha * 255)
            else:
                buf[idx + 3] = 0
    return make_png(size, size, bytes(buf))


if __name__ == "__main__":
    # Main app icon (cobalt blue rounded square with crisp white tunnel link)
    icon_256 = draw_rounded_shield_icon(256, (29, 78, 216), (255, 255, 255))
    icon_64 = draw_rounded_shield_icon(64, (29, 78, 216), (255, 255, 255))
    icon_32 = draw_rounded_shield_icon(32, (29, 78, 216), (255, 255, 255))

    with open(os.path.join(OUT_DIR, "icon.png"), "wb") as f:
        f.write(icon_256)
    with open(os.path.join(OUT_DIR, "icon.ico"), "wb") as f:
        f.write(make_ico([(256, icon_256), (64, icon_64), (32, icon_32)]))

    # Tray status icons (32x32 crisp HiDPI)
    tray_variants = {
        "tray-idle.png": (100, 116, 139),        # Slate
        "tray-connected.png": (21, 128, 61),     # Emerald Green
        "tray-reconnecting.png": (217, 119, 6),  # Amber
        "tray-error.png": (185, 28, 28),         # Crimson
        "tray-server.png": (15, 118, 110),       # Server Teal
    }
    for filename, color in tray_variants.items():
        with open(os.path.join(OUT_DIR, filename), "wb") as f:
            f.write(draw_tray_dot(32, color))

    print("Generated icons successfully in", OUT_DIR)
