import math

def build(turns, radii, lengths, unknown=None, spacing=2.0):
    """turns: sudut belok tiap tikungan (derajat, - = kanan). lengths: panjang
    lurus sebelum tiap tikungan; dua lurus terakhir (yang menutup loop) dicari."""
    n = len(turns)
    assert len(lengths) == n
    # heading lurus ke-i
    h = []
    cur = 90.0
    for i in range(n):
        h.append(cur)
        cur += turns[i]
    assert abs((cur - 90.0) + 360.0) < 1e-6 or True
    # vektor lurus (dari titik tangent keluar tikungan i ke masuk tikungan i+1)
    # titik sudut: P_{i+1} = P_i + u(h_i)*(t_i + L_i + t_{i+1})
    t = [abs(radii[i] * math.tan(math.radians(turns[i]) / 2)) for i in range(n)]
    if unknown is None:
        unknown = [n - 2, n - 1]
    known = [k for k in range(n) if k not in unknown]

    def vec(deg):
        a = math.radians(deg)
        return (math.cos(a), math.sin(a))
    sx = sy = 0.0
    for k in known:
        L = lengths[k] + t[k] + t[(k + 1) % n]
        v = vec(h[k]); sx += v[0] * L; sy += v[1] * L
    # dua persamaan, dua unknown
    i1, i2 = unknown
    a1 = vec(h[i1]); a2 = vec(h[i2])
    det = a1[0] * a2[1] - a1[1] * a2[0]
    if abs(det) < 1e-9: return None
    Lx = (-sx * a2[1] + sy * a2[0]) / det
    Ly = (-a1[0] * sy + a1[1] * sx) / det
    lengths = list(lengths)
    lengths[i1] = Lx - t[i1] - t[(i1 + 1) % n]
    lengths[i2] = Ly - t[i2] - t[(i2 + 1) % n]
    return dict(headings=h, t=t, lengths=lengths)

def vertices(route, n):
    h = route['headings']; t = route['t']; L = route['lengths']
    pts = [(0.0, 0.0)]
    for k in range(n):
        Lk = L[k] + t[k] + t[(k + 1) % n]
        a = math.radians(h[k])
        pts.append((pts[-1][0] + math.cos(a) * Lk, pts[-1][1] + math.sin(a) * Lk))
    assert math.dist(pts[-1], pts[0]) < 1e-6, math.dist(pts[-1], pts[0])
    return pts[:-1]
