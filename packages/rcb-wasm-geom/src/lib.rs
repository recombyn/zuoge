//! RCB vector geometry kernel for WebAssembly.
//! Flat f32 buffers (xy interleaved): densify, tessellate, boolean, stroke offset, RDP, contour.

mod boolean;
mod contour;
mod offset;
mod simplify;

use wasm_bindgen::prelude::*;

fn clean_ring(xy: &[f32]) -> Vec<f32> {
    let mut out: Vec<f32> = Vec::with_capacity(xy.len());
    let n = xy.len() / 2;
    for i in 0..n {
        let x = xy[i * 2];
        let y = xy[i * 2 + 1];
        if let Some(last) = out.len().checked_sub(2) {
            if (out[last] - x).abs() < 1e-6 && (out[last + 1] - y).abs() < 1e-6 {
                continue;
            }
        }
        out.push(x);
        out.push(y);
    }
    let m = out.len() / 2;
    if m > 2 {
        let ax = out[0];
        let ay = out[1];
        let bx = out[(m - 1) * 2];
        let by = out[(m - 1) * 2 + 1];
        if (ax - bx).abs() < 1e-6 && (ay - by).abs() < 1e-6 {
            out.pop();
            out.pop();
        }
    }
    out
}

fn ring_area(xy: &[f32]) -> f32 {
    let n = xy.len() / 2;
    let mut a = 0.0f32;
    let mut j = n - 1;
    for i in 0..n {
        a += xy[j * 2] * xy[i * 2 + 1] - xy[i * 2] * xy[j * 2 + 1];
        j = i;
    }
    a * 0.5
}

fn is_convex(ax: f32, ay: f32, bx: f32, by: f32, cx: f32, cy: f32, ccw: bool) -> bool {
    let cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if ccw {
        cross > 1e-12
    } else {
        cross < -1e-12
    }
}

fn point_in_tri(
    px: f32,
    py: f32,
    ax: f32,
    ay: f32,
    bx: f32,
    by: f32,
    cx: f32,
    cy: f32,
) -> bool {
    let v0x = cx - ax;
    let v0y = cy - ay;
    let v1x = bx - ax;
    let v1y = by - ay;
    let v2x = px - ax;
    let v2y = py - ay;
    let dot00 = v0x * v0x + v0y * v0y;
    let dot01 = v0x * v1x + v0y * v1y;
    let dot02 = v0x * v2x + v0y * v2y;
    let dot11 = v1x * v1x + v1y * v1y;
    let dot12 = v1x * v2x + v1y * v2y;
    let inv = 1.0 / (dot00 * dot11 - dot01 * dot01 + 1e-20);
    let u = (dot11 * dot02 - dot01 * dot12) * inv;
    let v = (dot00 * dot12 - dot01 * dot02) * inv;
    u >= 0.0 && v >= 0.0 && u + v <= 1.0
}

fn get_xy(xy: &[f32], i: usize) -> (f32, f32) {
    (xy[i * 2], xy[i * 2 + 1])
}

fn tessellate_fill_inner(ring: &[f32]) -> Vec<f32> {
    let n = ring.len() / 2;
    if n < 3 {
        return Vec::new();
    }
    let a = ring_area(ring);
    if a.abs() < 1e-10 {
        return Vec::new();
    }
    let ccw = a > 0.0;
    let mut convex = true;
    for i in 0..n {
        let (px, py) = get_xy(ring, (i + n - 1) % n);
        let (cx, cy) = get_xy(ring, i);
        let (nx, ny) = get_xy(ring, (i + 1) % n);
        if !is_convex(px, py, cx, cy, nx, ny, ccw) {
            convex = false;
            break;
        }
    }
    let mut tris: Vec<f32> = Vec::new();
    if convex {
        let (ox, oy) = get_xy(ring, 0);
        for i in 1..n - 1 {
            let (ax, ay) = get_xy(ring, i);
            let (bx, by) = get_xy(ring, i + 1);
            tris.extend_from_slice(&[ox, oy, ax, ay, bx, by]);
        }
        return tris;
    }
    let mut idx: Vec<usize> = (0..n).collect();
    let mut guard = n * n + 8;
    while idx.len() > 3 && guard > 0 {
        guard -= 1;
        let mut clipped = false;
        for i in 0..idx.len() {
            let i0 = idx[(i + idx.len() - 1) % idx.len()];
            let i1 = idx[i];
            let i2 = idx[(i + 1) % idx.len()];
            let (a0x, a0y) = get_xy(ring, i0);
            let (a1x, a1y) = get_xy(ring, i1);
            let (a2x, a2y) = get_xy(ring, i2);
            if !is_convex(a0x, a0y, a1x, a1y, a2x, a2y, ccw) {
                continue;
            }
            let mut ear = true;
            for &k in &idx {
                if k == i0 || k == i1 || k == i2 {
                    continue;
                }
                let (px, py) = get_xy(ring, k);
                if point_in_tri(px, py, a0x, a0y, a1x, a1y, a2x, a2y) {
                    ear = false;
                    break;
                }
            }
            if !ear {
                continue;
            }
            tris.extend_from_slice(&[a0x, a0y, a1x, a1y, a2x, a2y]);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break;
        }
    }
    if idx.len() == 3 {
        let (a0x, a0y) = get_xy(ring, idx[0]);
        let (a1x, a1y) = get_xy(ring, idx[1]);
        let (a2x, a2y) = get_xy(ring, idx[2]);
        tris.extend_from_slice(&[a0x, a0y, a1x, a1y, a2x, a2y]);
    }
    tris
}

fn left_normal(dx: f32, dy: f32) -> (f32, f32) {
    let len = (dx * dx + dy * dy).sqrt().max(1e-12);
    let nx = dx / len;
    let ny = dy / len;
    (-ny, nx)
}

#[derive(Clone, Copy)]
struct SegOff {
    n0x: f32,
    n0y: f32,
    l0x: f32,
    l0y: f32,
    r0x: f32,
    r0y: f32,
    l1x: f32,
    l1y: f32,
    r1x: f32,
    r1y: f32,
}

/// Emit one triangle as interleaved x,y,edge triples (fragment AA rims ±1, center 0).
fn push_tri_e(
    out: &mut Vec<f32>,
    ax: f32,
    ay: f32,
    ea: f32,
    bx: f32,
    by: f32,
    eb: f32,
    cx: f32,
    cy: f32,
    ec: f32,
) {
    out.extend_from_slice(&[ax, ay, ea, bx, by, eb, cx, cy, ec]);
}

fn push_quad_e(out: &mut Vec<f32>, s: &SegOff) {
    // Four tris sharing the centerline (edge=0) — matches TS tessellateStroke.
    let c0x = (s.l0x + s.r0x) * 0.5;
    let c0y = (s.l0y + s.r0y) * 0.5;
    let c1x = (s.l1x + s.r1x) * 0.5;
    let c1y = (s.l1y + s.r1y) * 0.5;
    push_tri_e(out, s.l0x, s.l0y, -1.0, c0x, c0y, 0.0, s.l1x, s.l1y, -1.0);
    push_tri_e(out, s.l1x, s.l1y, -1.0, c0x, c0y, 0.0, c1x, c1y, 0.0);
    push_tri_e(out, c0x, c0y, 0.0, s.r0x, s.r0y, 1.0, c1x, c1y, 0.0);
    push_tri_e(out, c1x, c1y, 0.0, s.r0x, s.r0y, 1.0, s.r1x, s.r1y, 1.0);
}

fn push_bevel_wedges_e(out: &mut Vec<f32>, cx: f32, cy: f32, a: &SegOff, b: &SegOff) {
    push_tri_e(out, cx, cy, 0.0, a.l1x, a.l1y, -1.0, b.l0x, b.l0y, -1.0);
    push_tri_e(out, cx, cy, 0.0, a.r1x, a.r1y, 1.0, b.r0x, b.r0y, 1.0);
}

fn fan_outer_arc_e(
    out: &mut Vec<f32>,
    cx: f32,
    cy: f32,
    from_x: f32,
    from_y: f32,
    to_x: f32,
    to_y: f32,
    radius: f32,
    rim_edge: f32,
) {
    let a0 = (from_y - cy).atan2(from_x - cx);
    let a1 = (to_y - cy).atan2(to_x - cx);
    let mut d = a1 - a0;
    while d > std::f32::consts::PI {
        d -= std::f32::consts::PI * 2.0;
    }
    while d < -std::f32::consts::PI {
        d += std::f32::consts::PI * 2.0;
    }
    let chord = (radius * 0.35).max(0.5);
    let mut steps = ((d.abs() * radius) / chord).ceil() as i32;
    if steps < 2 {
        steps = 2;
    }
    if steps > 24 {
        steps = 24;
    }
    let mut prev_x = from_x;
    let mut prev_y = from_y;
    for s in 1..=steps {
        let t = s as f32 / steps as f32;
        let ang = a0 + d * t;
        let mut px = cx + ang.cos() * radius;
        let mut py = cy + ang.sin() * radius;
        if s == steps {
            px = to_x;
            py = to_y;
        }
        push_tri_e(out, cx, cy, 0.0, prev_x, prev_y, rim_edge, px, py, rim_edge);
        prev_x = px;
        prev_y = py;
    }
}

fn push_round_join_e(out: &mut Vec<f32>, cx: f32, cy: f32, a: &SegOff, b: &SegOff, hl: f32, hr: f32) {
    let cross = a.n0x * b.n0y - a.n0y * b.n0x;
    // Prefer the side with stroke extent (inside/outside align), else geometric outer.
    let round_left = if hl > hr + 1e-6 {
        true
    } else if hr > hl + 1e-6 {
        false
    } else {
        cross < 0.0
    };
    if round_left {
        push_tri_e(out, cx, cy, 0.0, a.r1x, a.r1y, 1.0, b.r0x, b.r0y, 1.0);
        fan_outer_arc_e(out, cx, cy, a.l1x, a.l1y, b.l0x, b.l0y, hl.max(1e-4), -1.0);
    } else {
        push_tri_e(out, cx, cy, 0.0, a.l1x, a.l1y, -1.0, b.l0x, b.l0y, -1.0);
        fan_outer_arc_e(out, cx, cy, a.r1x, a.r1y, b.r0x, b.r0y, hr.max(1e-4), 1.0);
    }
}

fn try_miter_tips(
    cx: f32,
    cy: f32,
    n0x: f32,
    n0y: f32,
    n1x: f32,
    n1y: f32,
    hl: f32,
    hr: f32,
    miter_limit: f32,
) -> Option<(f32, f32, f32, f32)> {
    let mut mx = n0x + n1x;
    let mut my = n0y + n1y;
    let mlen = (mx * mx + my * my).sqrt();
    if mlen < 1e-8 {
        return None;
    }
    mx /= mlen;
    my /= mlen;
    let den = mx * n0x + my * n0y;
    if den.abs() < 1e-6 {
        return None;
    }
    let scale_l = hl / den;
    let scale_r = hr / den;
    if scale_l.abs() > hl * miter_limit + 1e-6 {
        return None;
    }
    if scale_r.abs() > hr * miter_limit + 1e-6 {
        return None;
    }
    Some((
        cx + mx * scale_l,
        cy + my * scale_l,
        cx - mx * scale_r,
        cy - my * scale_r,
    ))
}

/// Miter joins by default (matches TS / Canvas attrs). Bevel only past miterLimit.
/// Returns interleaved x,y,edge floats (3 per vertex) for mesh fragment AA.
fn tessellate_stroke_inner(
    xy: &[f32],
    width: f32,
    closed: bool,
    align: &str,
    linejoin: &str,
    miter_limit: f32,
) -> Vec<f32> {
    if !(width > 0.0) || xy.len() < 4 {
        return Vec::new();
    }
    let half = width * 0.5;
    // Full shift: inside/outside put the entire ribbon on one side (matches TS).
    let mut bias = 0.0f32;
    let a = align.to_ascii_lowercase();
    if a == "inside" {
        bias = -half;
    } else if a == "outside" {
        bias = half;
    }
    let hl = half + bias;
    let hr = half - bias;
    let join = linejoin.to_ascii_lowercase();
    let want_miter = join == "miter" || join.is_empty();
    let want_round = join == "round";
    let limit = miter_limit.max(1.0);

    let mut pts: Vec<f32> = xy.to_vec();
    let n0 = pts.len() / 2;
    if closed && n0 > 2 {
        let ax = pts[0];
        let ay = pts[1];
        let bx = pts[(n0 - 1) * 2];
        let by = pts[(n0 - 1) * 2 + 1];
        if (ax - bx).abs() > 1e-5 || (ay - by).abs() > 1e-5 {
            pts.push(ax);
            pts.push(ay);
        }
    }
    let n = pts.len() / 2;
    if n < 2 {
        return Vec::new();
    }

    let mut segs: Vec<SegOff> = Vec::new();
    for i in 0..n.saturating_sub(1) {
        let (ax, ay) = get_xy(&pts, i);
        let (bx, by) = get_xy(&pts, i + 1);
        let (nx, ny) = left_normal(bx - ax, by - ay);
        segs.push(SegOff {
            n0x: nx,
            n0y: ny,
            l0x: ax + nx * hl,
            l0y: ay + ny * hl,
            r0x: ax - nx * hr,
            r0y: ay - ny * hr,
            l1x: bx + nx * hl,
            l1y: by + ny * hl,
            r1x: bx - nx * hr,
            r1y: by - ny * hr,
        });
    }
    if segs.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<f32> = Vec::new();
    let join_count = if closed {
        segs.len()
    } else {
        segs.len().saturating_sub(1)
    };
    for j in 0..join_count {
        let a_idx = j;
        let b_idx = if closed {
            (j + 1) % segs.len()
        } else {
            j + 1
        };
        if b_idx >= segs.len() {
            break;
        }
        let cur_i = if closed && b_idx == 0 { 0 } else { a_idx + 1 };
        let (cx, cy) = get_xy(&pts, cur_i);
        let (n0x, n0y) = (segs[a_idx].n0x, segs[a_idx].n0y);
        let (n1x, n1y) = (segs[b_idx].n0x, segs[b_idx].n0y);
        if want_miter {
            if let Some((lx, ly, rx, ry)) =
                try_miter_tips(cx, cy, n0x, n0y, n1x, n1y, hl, hr, limit)
            {
                segs[a_idx].l1x = lx;
                segs[a_idx].l1y = ly;
                segs[a_idx].r1x = rx;
                segs[a_idx].r1y = ry;
                segs[b_idx].l0x = lx;
                segs[b_idx].l0y = ly;
                segs[b_idx].r0x = rx;
                segs[b_idx].r0y = ry;
                continue;
            }
        }
        let a_seg = segs[a_idx];
        let b_seg = segs[b_idx];
        if want_round {
            push_round_join_e(&mut out, cx, cy, &a_seg, &b_seg, hl, hr);
            continue;
        }
        push_bevel_wedges_e(&mut out, cx, cy, &a_seg, &b_seg);
    }
    for s in &segs {
        push_quad_e(&mut out, s);
    }
    out
}

/// SVG elliptical arc → polyline samples (matches densifyPathDJs).
fn densify_elliptical_arc(
    x1: f32,
    y1: f32,
    rx_in: f32,
    ry_in: f32,
    phi_deg: f32,
    large_arc: i32,
    sweep: i32,
    x2: f32,
    y2: f32,
    flatness: f32,
    pts: &mut Vec<f32>,
) {
    let push = |pts: &mut Vec<f32>, x: f32, y: f32| {
        if let Some(last) = pts.len().checked_sub(2) {
            if (pts[last] - x).abs() < 1e-6 && (pts[last + 1] - y).abs() < 1e-6 {
                return;
            }
        }
        pts.push(x);
        pts.push(y);
    };
    let mut rx = rx_in.abs();
    let mut ry = ry_in.abs();
    if rx < 1e-6 || ry < 1e-6 {
        push(pts, x2, y2);
        return;
    }
    if (x1 - x2).abs() < 1e-9 && (y1 - y2).abs() < 1e-9 {
        return;
    }

    let phi = phi_deg.to_radians();
    let cos_phi = phi.cos();
    let sin_phi = phi.sin();
    let dx = (x1 - x2) * 0.5;
    let dy = (y1 - y2) * 0.5;
    let x1p = cos_phi * dx + sin_phi * dy;
    let y1p = -sin_phi * dx + cos_phi * dy;

    let mut rx2 = rx * rx;
    let mut ry2 = ry * ry;
    let x1p2 = x1p * x1p;
    let y1p2 = y1p * y1p;
    let lam = x1p2 / rx2 + y1p2 / ry2;
    if lam > 1.0 {
        let s = lam.sqrt();
        rx *= s;
        ry *= s;
        rx2 = rx * rx;
        ry2 = ry * ry;
    }

    let denom = rx2 * y1p2 + ry2 * x1p2;
    let mut sq = if denom > 1e-12 {
        (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / denom
    } else {
        0.0
    };
    if sq < 0.0 {
        sq = 0.0;
    }
    let coef = if large_arc == sweep { -1.0 } else { 1.0 } * sq.sqrt();
    let cxp = (coef * (rx * y1p)) / ry;
    let cyp = (coef * -(ry * x1p)) / rx;
    let cx = cos_phi * cxp - sin_phi * cyp + (x1 + x2) * 0.5;
    let cy = sin_phi * cxp + cos_phi * cyp + (y1 + y2) * 0.5;

    let angle_between = |ux: f32, uy: f32, vx: f32, vy: f32| -> f32 {
        let n = (ux.hypot(uy) * vx.hypot(vy)).max(1e-12);
        let mut c = (ux * vx + uy * vy) / n;
        c = c.clamp(-1.0, 1.0);
        let mut a = c.acos();
        if ux * vy - uy * vx < 0.0 {
            a = -a;
        }
        a
    };

    let theta1 = angle_between(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dtheta = angle_between(
        (x1p - cxp) / rx,
        (y1p - cyp) / ry,
        (-x1p - cxp) / rx,
        (-y1p - cyp) / ry,
    );
    if sweep == 0 && dtheta > 0.0 {
        dtheta -= std::f32::consts::PI * 2.0;
    }
    if sweep != 0 && dtheta < 0.0 {
        dtheta += std::f32::consts::PI * 2.0;
    }

    let r_max = rx.max(ry);
    let flat = flatness.max(0.25);
    let approx_len = dtheta.abs() * r_max;
    let mut steps = (approx_len / flat).ceil() as i32;
    if steps < 8 {
        steps = 8;
    }
    if steps > 128 {
        steps = 128;
    }
    for s in 1..=steps {
        let t = theta1 + (dtheta * s as f32) / steps as f32;
        let cos_t = t.cos();
        let sin_t = t.sin();
        push(
            pts,
            cos_phi * rx * cos_t - sin_phi * ry * sin_t + cx,
            sin_phi * rx * cos_t + cos_phi * ry * sin_t + cy,
        );
    }
}

fn densify_path_inner(d: &str, flatness: f32) -> Vec<f32> {
    let src = d.trim();
    if src.is_empty() {
        return Vec::new();
    }
    let mut pts: Vec<f32> = Vec::new();
    let push = |pts: &mut Vec<f32>, x: f32, y: f32| {
        if let Some(last) = pts.len().checked_sub(2) {
            if (pts[last] - x).abs() < 1e-6 && (pts[last + 1] - y).abs() < 1e-6 {
                return;
            }
        }
        pts.push(x);
        pts.push(y);
    };
    let mut cx = 0.0f32;
    let mut cy = 0.0f32;
    let mut start_x = 0.0f32;
    let mut start_y = 0.0f32;
    // Simple command scanner matching TS densifyPathD subset.
    let bytes = src.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let cmd = bytes[i] as char;
        if !cmd.is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        i += 1;
        let rel = cmd.is_ascii_lowercase();
        let c = cmd.to_ascii_uppercase();
        let mut args: Vec<f32> = Vec::new();
        while i < bytes.len() {
            while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
                i += 1;
            }
            if i >= bytes.len() {
                break;
            }
            if (bytes[i] as char).is_ascii_alphabetic() {
                break;
            }
            let start = i;
            if bytes[i] == b'-' || bytes[i] == b'+' {
                i += 1;
            }
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.' || bytes[i] == b'e' || bytes[i] == b'E') {
                if bytes[i] == b'e' || bytes[i] == b'E' {
                    i += 1;
                    if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
                        i += 1;
                    }
                    continue;
                }
                i += 1;
            }
            if let Ok(n) = std::str::from_utf8(&bytes[start..i]).unwrap_or("").parse::<f32>() {
                args.push(n);
            } else {
                break;
            }
        }
        let mut ai = 0usize;
        match c {
            'M' => {
                let mut subpath_start = true;
                while ai + 1 < args.len() {
                    let mut x = args[ai];
                    let mut y = args[ai + 1];
                    ai += 2;
                    if rel {
                        x += cx;
                        y += cy;
                    }
                    cx = x;
                    cy = y;
                    start_x = x;
                    start_y = y;
                    // NaN break between subpaths (arrow shaft + V must not bridge).
                    if subpath_start && !pts.is_empty() {
                        pts.push(f32::NAN);
                        pts.push(f32::NAN);
                    }
                    subpath_start = false;
                    push(&mut pts, x, y);
                    while ai + 1 < args.len() {
                        let mut x2 = args[ai];
                        let mut y2 = args[ai + 1];
                        ai += 2;
                        if rel {
                            x2 += cx;
                            y2 += cy;
                        }
                        cx = x2;
                        cy = y2;
                        push(&mut pts, x2, y2);
                    }
                }
            }
            'L' => {
                while ai + 1 < args.len() {
                    let mut x = args[ai];
                    let mut y = args[ai + 1];
                    ai += 2;
                    if rel {
                        x += cx;
                        y += cy;
                    }
                    cx = x;
                    cy = y;
                    push(&mut pts, x, y);
                }
            }
            'H' => {
                while ai < args.len() {
                    let mut x = args[ai];
                    ai += 1;
                    if rel {
                        x += cx;
                    }
                    cx = x;
                    push(&mut pts, cx, cy);
                }
            }
            'V' => {
                while ai < args.len() {
                    let mut y = args[ai];
                    ai += 1;
                    if rel {
                        y += cy;
                    }
                    cy = y;
                    push(&mut pts, cx, cy);
                }
            }
            'C' => {
                while ai + 5 < args.len() {
                    let mut x1 = args[ai];
                    let mut y1 = args[ai + 1];
                    let mut x2 = args[ai + 2];
                    let mut y2 = args[ai + 3];
                    let mut x = args[ai + 4];
                    let mut y = args[ai + 5];
                    ai += 6;
                    if rel {
                        x1 += cx;
                        y1 += cy;
                        x2 += cx;
                        y2 += cy;
                        x += cx;
                        y += cy;
                    }
                    let x0 = cx;
                    let y0 = cy;
                    let len = ((x1 - x0).hypot(y1 - y0)
                        + (x2 - x1).hypot(y2 - y1)
                        + (x - x2).hypot(y - y2))
                        .max(1e-3);
                    let flat = flatness.max(0.25);
                    let mut steps = (len / flat).ceil() as i32;
                    if steps < 8 {
                        steps = 8;
                    }
                    if steps > 96 {
                        steps = 96;
                    }
                    for s in 1..=steps {
                        let t = s as f32 / steps as f32;
                        let u = 1.0 - t;
                        let bx = u * u * u * x0
                            + 3.0 * u * u * t * x1
                            + 3.0 * u * t * t * x2
                            + t * t * t * x;
                        let by = u * u * u * y0
                            + 3.0 * u * u * t * y1
                            + 3.0 * u * t * t * y2
                            + t * t * t * y;
                        push(&mut pts, bx, by);
                    }
                    cx = x;
                    cy = y;
                }
            }
            'Q' => {
                while ai + 3 < args.len() {
                    let mut x1 = args[ai];
                    let mut y1 = args[ai + 1];
                    let mut x = args[ai + 2];
                    let mut y = args[ai + 3];
                    ai += 4;
                    if rel {
                        x1 += cx;
                        y1 += cy;
                        x += cx;
                        y += cy;
                    }
                    let x0 = cx;
                    let y0 = cy;
                    let len = ((x1 - x0).hypot(y1 - y0) + (x - x1).hypot(y - y1)).max(1e-3);
                    let flat = flatness.max(0.25);
                    let mut steps = (len / flat).ceil() as i32;
                    if steps < 6 {
                        steps = 6;
                    }
                    if steps > 64 {
                        steps = 64;
                    }
                    for s in 1..=steps {
                        let t = s as f32 / steps as f32;
                        let u = 1.0 - t;
                        let bx = u * u * x0 + 2.0 * u * t * x1 + t * t * x;
                        let by = u * u * y0 + 2.0 * u * t * y1 + t * t * y;
                        push(&mut pts, bx, by);
                    }
                    cx = x;
                    cy = y;
                }
            }
            'A' => {
                while ai + 6 < args.len() {
                    let rx = args[ai];
                    let ry = args[ai + 1];
                    let phi = args[ai + 2];
                    let large = if args[ai + 3] != 0.0 { 1i32 } else { 0 };
                    let sweep = if args[ai + 4] != 0.0 { 1i32 } else { 0 };
                    let mut x = args[ai + 5];
                    let mut y = args[ai + 6];
                    ai += 7;
                    if rel {
                        x += cx;
                        y += cy;
                    }
                    densify_elliptical_arc(
                        cx, cy, rx, ry, phi, large, sweep, x, y, flatness, &mut pts,
                    );
                    cx = x;
                    cy = y;
                }
            }
            'Z' => {
                push(&mut pts, start_x, start_y);
                cx = start_x;
                cy = start_y;
            }
            _ => {}
        }
    }
    pts
}

#[wasm_bindgen]
pub fn densify_path_d(d: &str, flatness: f32) -> Vec<f32> {
    densify_path_inner(d, flatness)
}

#[wasm_bindgen]
pub fn tessellate_fill(xy: &[f32]) -> Vec<f32> {
    let ring = clean_ring(xy);
    tessellate_fill_inner(&ring)
}

/// `holes_flat`: concatenated hole rings; `hole_counts`: vertex count per hole.
/// Uses i_overlay difference + slit (not keyhole bridge) so donuts stay hollow.
#[wasm_bindgen]
pub fn tessellate_fill_with_holes(outer: &[f32], holes_flat: &[f32], hole_counts: &[u32]) -> Vec<f32> {
    let outer_c = clean_ring(outer);
    if outer_c.len() < 6 {
        return Vec::new();
    }
    let mut holes: Vec<Vec<f32>> = Vec::new();
    let mut off = 0usize;
    for &c in hole_counts {
        let n = c as usize;
        let end = off + n * 2;
        if end <= holes_flat.len() && n >= 3 {
            holes.push(clean_ring(&holes_flat[off..end]));
        }
        off = end;
    }
    if holes.is_empty() {
        return tessellate_fill_inner(&outer_c);
    }
    let rings = boolean::punch_holes_to_simple_xy(&outer_c, &holes);
    if rings.is_empty() {
        return Vec::new();
    }
    let mut tris: Vec<f32> = Vec::new();
    for ring in rings {
        tris.extend(tessellate_fill_inner(&ring));
    }
    tris
}

#[wasm_bindgen]
pub fn tessellate_stroke(
    xy: &[f32],
    width: f32,
    closed: bool,
    align: &str,
    linejoin: &str,
    miter_limit: f32,
) -> Vec<f32> {
    let limit = if miter_limit > 0.0 { miter_limit } else { 100.0 };
    tessellate_stroke_inner(xy, width, closed, align, linejoin, limit)
}

/// Batch: each job is [pointCount, widthBits, flags, ...xy]
/// flags: bit0 closed, bit1 want_fill, bit2 want_stroke; align encoded in high bits unused — align passed as parallel string not feasible.
/// Simpler batch API: process one mesh request encoded as floats.
#[wasm_bindgen]
pub fn tessellate_batch_fill(xy_all: &[f32], counts: &[u32]) -> Vec<f32> {
    // Output: [triFloatCount0, ...tris0, triFloatCount1, ...tris1, ...]
    let mut out: Vec<f32> = Vec::new();
    let mut off = 0usize;
    for &c in counts {
        let n = c as usize;
        let end = off + n * 2;
        if end > xy_all.len() {
            out.push(0.0);
            break;
        }
        let tris = tessellate_fill(&xy_all[off..end]);
        out.push(tris.len() as f32);
        out.extend_from_slice(&tris);
        off = end;
    }
    out
}

/// Polygon boolean fold. `op`: 0=union 1=difference 2=intersection 3=xor.
/// `packed` / return: see `boolean` module packing layout.
#[wasm_bindgen]
pub fn boolean_polygons(op: u8, packed: &[f32]) -> Vec<f32> {
    boolean::boolean_fold(op, packed)
}

/// Stroke centerline offset → packed MultiPolygon (same layout as boolean).
/// `join`: 0=bevel 1=miter 2=round · `cap`: 0=butt 1=round 2=square
/// Empty return = hard failure (TS falls back to JS outline).
#[wasm_bindgen]
pub fn offset_polyline(
    xy: &[f32],
    width: f32,
    closed: bool,
    join: u8,
    cap: u8,
    miter_limit: f32,
    round_approx: f32,
) -> Vec<f32> {
    offset::offset_polyline(xy, width, closed, join, cap, miter_limit, round_approx)
}

/// Open RDP simplify. Empty = failure.
#[wasm_bindgen]
pub fn simplify_rdp(xy: &[f32], epsilon: f32) -> Vec<f32> {
    simplify::simplify_rdp(xy, epsilon)
}

/// Closed-ring RDP (drops closing duplicate). Empty = failure.
#[wasm_bindgen]
pub fn simplify_rdp_closed(xy: &[f32], epsilon: f32) -> Vec<f32> {
    simplify::simplify_rdp_closed(xy, epsilon)
}

/// Trace solid + holes from RGBA ImageData. Packed contours; `[]` fail, `[0]` empty.
#[wasm_bindgen]
pub fn trace_rgba_contours(rgba: &[u8], width: u32, height: u32, alpha_threshold: u8) -> Vec<f32> {
    contour::trace_rgba_contours(rgba, width, height, alpha_threshold)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_unit_square() {
        let xy = [0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0];
        let t = tessellate_fill(&xy);
        assert!(t.len() >= 12);
    }

    #[test]
    fn stroke_line() {
        let xy = [0.0, 0.0, 40.0, 0.0, 40.0, 20.0];
        let t = tessellate_stroke(&xy, 4.0, false, "center", "miter", 100.0);
        assert!(t.len() >= 12);
    }
}

#[cfg(test)]
mod hole_fill_tests {
    use super::*;

    fn sample_circle(cx: f32, cy: f32, r: f32, n: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(n * 2);
        for i in 0..n {
            let t = (i as f32 / n as f32) * std::f32::consts::PI * 2.0;
            out.push(cx + t.cos() * r);
            out.push(cy + t.sin() * r);
        }
        out
    }

    fn point_in_any_tri(tris: &[f32], hx: f32, hy: f32) -> bool {
        let mut i = 0usize;
        while i + 5 < tris.len() {
            let ax = tris[i];
            let ay = tris[i + 1];
            let bx = tris[i + 2];
            let by = tris[i + 3];
            let cx = tris[i + 4];
            let cy = tris[i + 5];
            let v0x = cx - ax;
            let v0y = cy - ay;
            let v1x = bx - ax;
            let v1y = by - ay;
            let v2x = hx - ax;
            let v2y = hy - ay;
            let dot00 = v0x * v0x + v0y * v0y;
            let dot01 = v0x * v1x + v0y * v1y;
            let dot02 = v0x * v2x + v0y * v2y;
            let dot11 = v1x * v1x + v1y * v1y;
            let dot12 = v1x * v2x + v1y * v2y;
            let inv = 1.0 / (dot00 * dot11 - dot01 * dot01 + 1e-20);
            let u = (dot11 * dot02 - dot01 * dot12) * inv;
            let v = (dot00 * dot12 - dot01 * dot02) * inv;
            if u >= 0.0 && v >= 0.0 && u + v <= 1.0 {
                return true;
            }
            i += 6;
        }
        false
    }

    #[test]
    fn donut_fill_hollow_and_covers_ring() {
        let outer = sample_circle(100.0, 100.0, 100.0, 64);
        let hole = sample_circle(100.0, 100.0, 42.0, 48);
        let tris = tessellate_fill_with_holes(&outer, &hole, &[48]);
        assert!(tris.len() >= 6 * 8, "tris floats {}", tris.len());
        assert!(!point_in_any_tri(&tris, 100.0, 100.0), "hole center must be empty");
        assert!(point_in_any_tri(&tris, 100.0, 20.0), "outer band must be filled");
    }
}
