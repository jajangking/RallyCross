import math


def fillet_path(verts, radii, spacing=2.0):
    """Polyline tertutup + radius per titik sudut -> path yang sudah tersampel
    (busur + lurus), plus info tiap tikungan."""
    n = len(verts)
    corners = []
    for i in range(n):
        p0 = verts[i - 1]; p1 = verts[i]; p2 = verts[(i + 1) % n]
        v1 = (p1[0] - p0[0], p1[1] - p0[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1 = math.hypot(*v1); l2 = math.hypot(*v2)
        u1 = (v1[0] / l1, v1[1] / l1); u2 = (v2[0] / l2, v2[1] / l2)
        cross = u1[0] * u2[1] - u1[1] * u2[0]
        dot = max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1]))
        turn = math.atan2(cross, dot)  # + = kiri (CCW), - = kanan
        r = radii[i]
        if abs(turn) < 1e-6 or r <= 0:
            corners.append(dict(i=i, turn=0.0, r=0.0, t=0.0, tan1=p1, tan2=p1, c=p1))
            continue
        t = r * math.tan(abs(turn) / 2)
        a = (p1[0] - u1[0] * t, p1[1] - u1[1] * t)
        b = (p1[0] + u2[0] * t, p1[1] + u2[1] * t)
        sgn = 1 if turn > 0 else -1
        nrm = (-u1[1] * sgn, u1[0] * sgn)
        c = (a[0] + nrm[0] * r, a[1] + nrm[1] * r)
        corners.append(dict(i=i, turn=turn, r=r, t=t, tan1=a, tan2=b, c=c))

    bad = []
    for i in range(n):
        j = (i + 1) % n
        p1 = verts[i]; p2 = verts[j]
        L = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        need = corners[i]['t'] + corners[j]['t']
        if need > L - 0.5:
            bad.append((i, j, round(L, 1), round(need, 1)))

    pts = []
    for i in range(n):
        c = corners[i]
        if c['r'] > 0:
            a = math.atan2(c['tan1'][1] - c['c'][1], c['tan1'][0] - c['c'][0])
            b = math.atan2(c['tan2'][1] - c['c'][1], c['tan2'][0] - c['c'][0])
            d = b - a
            while d > math.pi: d -= 2 * math.pi
            while d < -math.pi: d += 2 * math.pi
            steps = max(2, int(abs(d) * c['r'] / spacing))
            for k in range(steps + 1):
                ang = a + d * k / steps
                pts.append((c['c'][0] + c['r'] * math.cos(ang), c['c'][1] + c['r'] * math.sin(ang)))
        else:
            pts.append(tuple(c['tan1']))
        nxt = corners[(i + 1) % n]
        a = pts[-1]
        b = nxt['tan1'] if nxt['r'] > 0 else tuple(nxt['tan1'])
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L > 1e-6:
            steps = max(1, int(round(L / spacing)))
            for k in range(1, steps + 1):
                t = k / steps
                pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    # buang duplikat
    out = [pts[0]]
    for p in pts[1:]:
        if math.dist(p, out[-1]) > 0.05:
            out.append(p)
    if math.dist(out[0], out[-1]) < 0.05:
        out.pop()
    return corners, out, bad


def stats(corners, pts):
    L = sum(math.dist(pts[i], pts[i - 1]) for i in range(1, len(pts))) + math.dist(pts[-1], pts[0])
    return L
