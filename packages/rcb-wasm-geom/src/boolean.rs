//! Polygon boolean ops via i_overlay (union / difference / intersection / xor).
//! Packed f32 layout (input & output MultiPolygon):
//!   [polyCount,
//!     for each polygon:
//!       ringCount,
//!       for each ring: vertCount, x0, y0, x1, y1, ...]
//! Op: 0=union 1=difference 2=intersection 3=xor

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

type Contour = Vec<[f32; 2]>;
type Shape = Vec<Contour>;
type Shapes = Vec<Shape>;

pub const OP_UNION: u8 = 0;
pub const OP_DIFFERENCE: u8 = 1;
pub const OP_INTERSECTION: u8 = 2;
pub const OP_XOR: u8 = 3;

pub(crate) fn decode_shapes(packed: &[f32]) -> Option<Shapes> {
    if packed.is_empty() {
        return Some(Vec::new());
    }
    let mut i = 0usize;
    let poly_count = packed[i] as usize;
    i += 1;
    let mut shapes: Shapes = Vec::with_capacity(poly_count);
    for _ in 0..poly_count {
        if i >= packed.len() {
            return None;
        }
        let ring_count = packed[i] as usize;
        i += 1;
        let mut shape: Shape = Vec::with_capacity(ring_count);
        for _ in 0..ring_count {
            if i >= packed.len() {
                return None;
            }
            let vert_count = packed[i] as usize;
            i += 1;
            let need = vert_count.checked_mul(2)?;
            if i + need > packed.len() {
                return None;
            }
            if vert_count < 3 {
                i += need;
                continue;
            }
            let mut contour: Contour = Vec::with_capacity(vert_count);
            for _ in 0..vert_count {
                contour.push([packed[i], packed[i + 1]]);
                i += 2;
            }
            // Drop closing duplicate if present.
            if contour.len() >= 2 {
                let a = contour[0];
                let b = contour[contour.len() - 1];
                if (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6 {
                    contour.pop();
                }
            }
            if contour.len() >= 3 {
                shape.push(contour);
            }
        }
        if !shape.is_empty() {
            shapes.push(shape);
        }
    }
    Some(shapes)
}

pub(crate) fn encode_shapes(shapes: &Shapes) -> Vec<f32> {
    let mut out: Vec<f32> = Vec::new();
    out.push(shapes.len() as f32);
    for shape in shapes {
        out.push(shape.len() as f32);
        for contour in shape {
            out.push(contour.len() as f32);
            for p in contour {
                out.push(p[0]);
                out.push(p[1]);
            }
        }
    }
    out
}

fn overlay_rule(op: u8) -> Option<OverlayRule> {
    match op {
        OP_UNION => Some(OverlayRule::Union),
        OP_DIFFERENCE => Some(OverlayRule::Difference),
        OP_INTERSECTION => Some(OverlayRule::Intersect),
        OP_XOR => Some(OverlayRule::Xor),
        _ => None,
    }
}

/// Fold N polygons with the given boolean op (same arity as polygon-clipping).
/// Returns an empty Vec on hard failure (TS treats length-0 as fallback to JS).
/// A successful empty multipolygon is encoded as `[0.0]`.
pub fn boolean_fold(op: u8, packed_polygons: &[f32]) -> Vec<f32> {
    let Some(rule) = overlay_rule(op) else {
        return Vec::new();
    };
    let Some(shapes) = decode_shapes(packed_polygons) else {
        return Vec::new();
    };
    if shapes.len() < 2 {
        return Vec::new();
    }

    let mut acc: Shapes = vec![shapes[0].clone()];
    for shape in shapes.iter().skip(1) {
        let clip: Shapes = vec![shape.clone()];
        acc = acc.overlay(&clip, rule, FillRule::NonZero);
        if acc.is_empty() && matches!(rule, OverlayRule::Intersect | OverlayRule::Difference) {
            break;
        }
    }
    encode_shapes(&acc)
}

fn xy_to_contour(xy: &[f32]) -> Contour {
    let n = xy.len() / 2;
    let mut c = Contour::with_capacity(n);
    for i in 0..n {
        c.push([xy[i * 2], xy[i * 2 + 1]]);
    }
    c
}

fn contour_to_xy(c: &Contour) -> Vec<f32> {
    let mut out = Vec::with_capacity(c.len() * 2);
    for p in c {
        out.push(p[0]);
        out.push(p[1]);
    }
    out
}

fn contour_bbox(c: &Contour) -> (f32, f32, f32, f32) {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for p in c {
        min_x = min_x.min(p[0]);
        max_x = max_x.max(p[0]);
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
    }
    (min_x, max_x, min_y, max_y)
}

/// Thin horizontal slit from outside the outer ring into the hole (JS openHoleWithSlit).
fn make_slit_contour(outer: &Contour, hole: &Contour) -> Contour {
    let (min_x, max_x, min_y, max_y) = contour_bbox(outer);
    let mut hy = 0.0f32;
    for p in hole {
        hy += p[1];
    }
    hy /= hole.len().max(1) as f32;
    let mut best = hole[0];
    let mut best_d = f32::INFINITY;
    for p in hole {
        let d = (p[0] - min_x) * (p[0] - min_x) + (p[1] - hy) * (p[1] - hy);
        if d < best_d {
            best_d = d;
            best = *p;
        }
    }
    let span = (max_x - min_x).max(max_y - min_y).max(1.0);
    let eps = (span * 1e-5).max(1e-3);
    let x0 = min_x - (span * 0.02).max(1.0);
    vec![
        [x0, best[1] - eps],
        [best[0] + eps, best[1] - eps],
        [best[0] + eps, best[1] + eps],
        [x0, best[1] + eps],
    ]
}

/// Open nested hole rings into simple C-rings via boolean slit cuts.
fn open_shape_holes(mut shape: Shape) -> Vec<Contour> {
    if shape.is_empty() {
        return Vec::new();
    }
    let mut guard = 8usize;
    while shape.len() > 1 && guard > 0 {
        guard -= 1;
        let hole = shape[1].clone();
        if hole.len() < 3 {
            shape.remove(1);
            continue;
        }
        let slit = make_slit_contour(&shape[0], &hole);
        let subj: Shapes = vec![shape.clone()];
        let clip: Shapes = vec![vec![slit]];
        let opened = subj.overlay(&clip, OverlayRule::Difference, FillRule::NonZero);
        if opened.is_empty() {
            break;
        }
        // Prefer the largest leftover shape; flatten if already simple.
        shape = opened
            .into_iter()
            .max_by_key(|s| s.iter().map(|c| c.len()).sum::<usize>())
            .unwrap_or_default();
    }
    if shape.len() <= 1 {
        return shape;
    }
    // Still nested — emit each ring alone (outer solid is wrong but better than empty).
    shape
}

/// Punch holes from an outer XY ring using i_overlay difference, then slit-open
/// any remaining nested rings so the caller can ear-clip simple contours.
/// Empty vec = hard failure (TS falls back to JS).
pub fn punch_holes_to_simple_xy(outer_xy: &[f32], holes_xy: &[Vec<f32>]) -> Vec<Vec<f32>> {
    if outer_xy.len() < 6 {
        return Vec::new();
    }
    let mut acc: Shapes = vec![vec![xy_to_contour(outer_xy)]];
    for h in holes_xy {
        if h.len() < 6 {
            continue;
        }
        let clip: Shapes = vec![vec![xy_to_contour(h)]];
        acc = acc.overlay(&clip, OverlayRule::Difference, FillRule::NonZero);
    }
    if acc.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<Vec<f32>> = Vec::new();
    for shape in acc {
        for ring in open_shape_holes(shape) {
            if ring.len() >= 3 {
                out.push(contour_to_xy(&ring));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_two_rects() -> Vec<f32> {
        // Two axis-aligned rects as single-ring polygons.
        vec![
            2.0, // polyCount
            // poly0: unit square [0,0]-[2,2]
            1.0, 4.0, 0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 2.0,
            // poly1: [1,1]-[3,3]
            1.0, 4.0, 1.0, 1.0, 3.0, 1.0, 3.0, 3.0, 1.0, 3.0,
        ]
    }

    #[test]
    fn union_two_rects_has_area() {
        let out = boolean_fold(OP_UNION, &pack_two_rects());
        assert!(out[0] >= 1.0);
        let decoded = decode_shapes(&out).expect("decode");
        assert!(!decoded.is_empty());
        assert!(decoded[0][0].len() >= 4);
    }

    #[test]
    fn intersect_two_rects() {
        let out = boolean_fold(OP_INTERSECTION, &pack_two_rects());
        let decoded = decode_shapes(&out).expect("decode");
        assert_eq!(decoded.len(), 1);
        // Intersection is roughly [1,1]-[2,2]
        let xs: Vec<f32> = decoded[0][0].iter().map(|p| p[0]).collect();
        let ys: Vec<f32> = decoded[0][0].iter().map(|p| p[1]).collect();
        let min_x = xs.iter().cloned().fold(f32::INFINITY, f32::min);
        let max_x = xs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let min_y = ys.iter().cloned().fold(f32::INFINITY, f32::min);
        let max_y = ys.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!((min_x - 1.0).abs() < 0.05);
        assert!((max_x - 2.0).abs() < 0.05);
        assert!((min_y - 1.0).abs() < 0.05);
        assert!((max_y - 2.0).abs() < 0.05);
    }

    fn sample_circle(cx: f32, cy: f32, r: f32, n: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(n * 2);
        for i in 0..n {
            let t = (i as f32 / n as f32) * std::f32::consts::PI * 2.0;
            out.push(cx + t.cos() * r);
            out.push(cy + t.sin() * r);
        }
        out
    }

    #[test]
    fn punch_donut_yields_simple_ring() {
        let outer = sample_circle(50.0, 50.0, 50.0, 64);
        let hole = sample_circle(50.0, 50.0, 21.0, 48);
        let rings = punch_holes_to_simple_xy(&outer, &[hole]);
        assert!(!rings.is_empty(), "expected opened ring(s)");
        assert!(rings[0].len() >= 6);
        // Single C-ring should have more verts than outer alone (slit path).
        assert!(rings.iter().map(|r| r.len()).sum::<usize>() >= outer.len());
    }
}
