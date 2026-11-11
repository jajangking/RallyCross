import math, sys
sys.path.insert(0, '/home/user/RallyCross/design')
from route import build, vertices
from loop import fillet_path

def make(turns, radii, straights):
    """Cari rotasi yang membuat (radius, sudut) tiap tikungan berpasangan benar."""
    n = len(turns)
    for shift in range(n):
        t = [turns[(i + shift) % n] for i in range(n)]
        r = [radii[(i + shift) % n] for i in range(n)]
        try:
            route = build(t, r, straights)
        except Exception:
            continue
        if not route:
            continue
        V = vertices(route, n)
        corners, pts, bad = fillet_path(V, r)
        got = [round(math.degrees(c['turn']), 1) for c in corners]
        if any(abs(got[i] - turns[i]) > 0.6 for i in range(n)):
            continue
        return dict(route=route, verts=V, corners=corners, pts=pts, bad=bad, radii=r, turns=t)
    raise SystemExit('tidak ada rotasi yang cocok')

def path_length(pts):
    return sum(math.dist(pts[i], pts[i-1]) for i in range(1, len(pts)))
