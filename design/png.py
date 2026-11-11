import zlib, struct

def write_png(path, w, h, pixels):
    """pixels: list of rows, each row list of (r,g,b)."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for (r, g, b) in row:
            raw += bytes((r, g, b))
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)

class Canvas:
    def __init__(self, w, h, bg=(240, 240, 240)):
        self.w, self.h = w, h
        self.px = [[bg] * w for _ in range(h)]
    def dot(self, x, y, col=(0, 0, 0), r=1):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                px, py = int(x) + dx, int(y) + dy
                if 0 <= px < self.w and 0 <= py < self.h:
                    self.px[py][px] = col
    def save(self, path):
        write_png(path, self.w, self.h, self.px)
