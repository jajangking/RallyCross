"""Generator tata letak sirkuit (dipakai sekali, hasilnya disalin ke
`LAYOUT` di `src/world/circuit.ts`).

Poligon 12 sudut dicari dengan menyelesaikan panjang lurus terakhir supaya
lingkarannya menutup (`layout.make`), lalu dirotasi supaya lurus terpanjang
menghadap +Z dan garis start/finish jatuh tepat di (0, 0).

    python3 design/final.py
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from loop import fillet_path  # noqa: E402

# arah belok tiap sudut (negatif = kanan) dan radius fillet-nya
TURNS = [-88, 38, -72, 42, -78, -50, 45, -95, 40, -96, 30, -76]
RADII = [26, 30, 18, 32, 72, 80, 22, 15, 35, 30, 40, 40]
# panjang lurus bebas (yang terakhir diselesaikan solver supaya menutup)
STRAIGHTS = [68, 20, 19, 22, 31, 25, 17, 17, 20, 22, 20, 22]
LINE_AT = 95.0   # meter dari awal lurus start ke garis start/finish


def rot(p, ang):
    c, s = math.cos(ang), math.sin(ang)
    return (p[0] * c + p[1] * s, -p[0] * s + p[1] * c)


def base():
    from layout import make
    res = make(TURNS, RADII, STRAIGHTS)
    return res['verts'], res['radii']


def align(V, radii):
    n = len(V)
    best = (-1, -1, 0)
    for i in range(n):
        j = (i + 1) % n
        L = math.dist(V[i], V[j])
        if L > best[2]:
            best = (i, j, L)
    i, j, L = best
    d = (V[j][0] - V[i][0], V[j][1] - V[i][1])
    phi = math.atan2(d[0], d[1])
    Vr = [rot(v, -phi) for v in V]
    a, b = Vr[i], Vr[j]
    dx = -(a[0] + b[0]) / 2
    dz = -a[1] - LINE_AT
    Vr = [(x + dx, z + dz) for x, z in Vr]
    order = [(i + 1 + k) % len(V) for k in range(len(V))]
    return [(Vr[k], radii[k]) for k in order], i, j


if __name__ == '__main__':
    V, radii = base()
    pts_v, i, j = align(V, radii)
    layout = pts_v  # urut mulai dari ujung lurus start
    print('lurus start dari', [round(c, 2) for c in layout[-1][0]], 'ke', [round(c, 2) for c in layout[0][0]])
    # titik start (0,0) disisipkan di antara ujung lurus start dan vertex pertama
    ring = [(0.0, 0.0, 0.0)] + [(x, z, r) for (x, z), r in layout]
    corners, pts, bad = fillet_path([(x, z) for x, z, _ in ring], [r for _, _, r in ring])
    L = sum(math.dist(pts[k], pts[k - 1]) for k in range(1, len(pts))) + math.dist(pts[-1], pts[0])
    print('panjang', round(L, 1), '· bbox x', round(min(p[0] for p in pts)), round(max(p[0] for p in pts)),
          'z', round(min(p[1] for p in pts)), round(max(p[1] for p in pts)))
    if bad:
        print('KONFLIK', bad)
    # hitung jarak tiap tikungan dengan menelusuri path
    dists = []
    acc = 0.0
    for k in range(1, len(pts)):
        acc += math.dist(pts[k], pts[k - 1])
        for ci, c in enumerate(corners):
            if c['r'] > 0 and math.dist(pts[k], c['tan1']) < 0.35:
                dists.append((ci, round(acc, 1), round(c['r'], 0), round(math.degrees(c['turn']), 0)))
    print('tikungan (index, jarak masuk, radius, sudut):')
    for t in dists:
        print('  ', t)
