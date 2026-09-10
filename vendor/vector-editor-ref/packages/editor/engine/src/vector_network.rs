use glam::Vec2;
use ordered_float::OrderedFloat;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::{Color, Engine, Geometry, Paint, PathPoint, Subpath};

/// Compute the centroid of a face's boundary polygon.
pub fn face_centroid(face: &PlanarFace) -> Vec2 {
    polygon_centroid(&face.boundary_polygon)
}

/// Sentinel `source_node` for synthetic gap-bridge edges — not a real scene
/// node. Excluded from rendering, painting, and face signatures.
pub const SYNTHETIC_SOURCE: u32 = u32::MAX;

/// Max centroid distance (world units) for the fallback fill re-map, used only
/// when no signature match exists (topology changed). Signature matches are
/// distance-independent, so a filled region survives arbitrary moves as long as
/// the same set of paths still bounds it.
const FILL_REMAP_THRESHOLD: f32 = 50.0;

/// A face fill awaiting re-attachment on the next rebuild (from file load,
/// undo/redo, or a snapshot taken before the graph was recomputed).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PendingFill {
    /// Centroid of the originally-painted face (fallback matching).
    pub centroid: Vec2,
    /// Sorted set of source-node ids that bounded the face (primary matching).
    #[serde(default)]
    pub signature: Vec<u32>,
    pub color: Paint,
}

// ─── Data Structures ───────────────────────────────────────────────────────────

/// A vertex in the planar graph.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanarVertex {
    pub id: u32,
    pub position: Vec2,
    /// Outgoing edge IDs, sorted radially (CCW).
    pub outgoing_edges: Vec<u32>,
    /// Live Paint group this vertex belongs to — coincident points from
    /// different groups are NOT merged (groups are independent).
    #[serde(default)]
    pub group: u32,
}

/// A directed half-edge in the planar graph.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanarEdge {
    pub id: u32,
    pub from_vertex: u32,
    pub to_vertex: u32,
    /// Polyline approximation of this edge segment (for rendering).
    pub polyline: Vec<Vec2>,
    /// Source node this edge was derived from.
    pub source_node: u32,
    /// Twin/opposite half-edge ID.
    pub twin: u32,
    /// Which face this directed half-edge borders (left side).
    pub face: Option<u32>,
    /// Synthetic gap-bridge edge — participates in face detection but is not a
    /// real path segment (not rendered, not paintable, excluded from signatures).
    #[serde(default)]
    pub synthetic: bool,
    /// The Live Paint group this edge belongs to (groups are independent).
    #[serde(default)]
    pub group: u32,
    /// Which source curve this half-edge is a fragment of, and the t-range it
    /// covers oriented `from`→`to`. Lets faces/edges be reconstructed as EXACT
    /// béziers instead of the flattened polyline. Derived at rebuild; not saved.
    #[serde(skip)]
    pub frag: Option<Frag>,
}

/// A half-edge's slice of a source curve: covers parameter `ta`→`tb` of
/// `VectorNetwork::curves[curve]`, oriented in the half-edge's direction.
#[derive(Clone, Copy, Debug)]
pub struct Frag {
    pub curve: u32,
    pub ta: f32,
    pub tb: f32,
}

/// A source curve in world space — the exact geometry a face/edge fragment is
/// carved from. Built fresh each rebuild (indexed by `Frag::curve`); not saved.
#[derive(Clone, Copy, Debug)]
pub enum CurveSeg {
    /// Straight segment `a`→`b`, parametrised linearly.
    Line { node: u32, seg: u32, a: Vec2, b: Vec2, free: (bool, bool) },
    /// Cubic bézier with control points `p0,p1,p2,p3`.
    Cubic { node: u32, seg: u32, p: [Vec2; 4], free: (bool, bool) },
}

impl CurveSeg {
    /// Whether this curve's `t=0` / `t=1` end is a FREE end of an open path —
    /// a pen stroke's terminal point, which continues into nothing.
    ///
    /// It matters because a free end is the one thing in a drawing whose exact
    /// position carries no information: it was put down near what it meets, and
    /// "near" is the whole reason gap tolerance exists. Everything else — a
    /// crossing, the joint where a corner arc meets a side — is a point the
    /// artwork actually defines. When two of those land within tolerance of each
    /// other, the free one is what should move.
    fn free_ends(&self) -> (bool, bool) {
        match self { CurveSeg::Line { free, .. } | CurveSeg::Cubic { free, .. } => *free }
    }
    /// Ordinal of this curve within its source node's geometry — stable across
    /// moves/topology changes, so painted edges can re-attach by (node, seg, t).
    fn seg(&self) -> u32 {
        match self { CurveSeg::Line { seg, .. } | CurveSeg::Cubic { seg, .. } => *seg }
    }
    pub(crate) fn point_at(&self, t: f32) -> Vec2 {
        match self {
            CurveSeg::Line { a, b, .. } => *a + (*b - *a) * t,
            CurveSeg::Cubic { p, .. } => cubic_point(p, t),
        }
    }
    /// dP/dt. Zero-length only for a degenerate curve, which the callers check.
    fn tangent_at(&self, t: f32) -> Vec2 {
        match self {
            CurveSeg::Line { a, b, .. } => *b - *a,
            CurveSeg::Cubic { p, .. } => {
                let mt = 1.0 - t;
                (p[1] - p[0]) * (3.0 * mt * mt)
                    + (p[2] - p[1]) * (6.0 * mt * t)
                    + (p[3] - p[2]) * (3.0 * t * t)
            }
        }
    }

    /// d²P/dt², needed to Newton-solve for the closest point on the curve.
    fn curvature_vector_at(&self, t: f32) -> Vec2 {
        match self {
            CurveSeg::Line { .. } => Vec2::ZERO,
            CurveSeg::Cubic { p, .. } => {
                (p[2] - p[1] * 2.0 + p[0]) * (6.0 * (1.0 - t)) + (p[3] - p[2] * 2.0 + p[1]) * (6.0 * t)
            }
        }
    }

    /// Control points of the sub-arc over [t0,t1], oriented t0→t1. For a line the
    /// handles are coincident with the endpoints (renders/exports as a line).
    fn subsegment(&self, t0: f32, t1: f32) -> [Vec2; 4] {
        match self {
            CurveSeg::Line { .. } => {
                let (a, b) = (self.point_at(t0), self.point_at(t1));
                [a, a, b, b]
            }
            CurveSeg::Cubic { p, .. } => cubic_subsegment(p, t0, t1),
        }
    }
}

/// Evaluate a cubic bézier at parameter `t`.
pub(crate) fn cubic_point(p: &[Vec2; 4], t: f32) -> Vec2 {
    let mt = 1.0 - t;
    p[0] * (mt * mt * mt)
        + p[1] * (3.0 * mt * mt * t)
        + p[2] * (3.0 * mt * t * t)
        + p[3] * (t * t * t)
}

/// de Casteljau split of a cubic at `t`; returns the [0,t] (left) and [t,1]
/// (right) control-point quads.
fn cubic_split(p: &[Vec2; 4], t: f32) -> ([Vec2; 4], [Vec2; 4]) {
    let a = p[0].lerp(p[1], t);
    let b = p[1].lerp(p[2], t);
    let c = p[2].lerp(p[3], t);
    let d = a.lerp(b, t);
    let e = b.lerp(c, t);
    let f = d.lerp(e, t);
    ([p[0], a, d, f], [f, e, c, p[3]])
}

/// Control points of the cubic restricted to [t0,t1], oriented t0→t1
/// (reversed if t0 > t1). Exact — this is what makes faces true béziers.
fn cubic_subsegment(p: &[Vec2; 4], t0: f32, t1: f32) -> [Vec2; 4] {
    let (mut lo, mut hi) = (t0, t1);
    let reversed = lo > hi;
    if reversed {
        std::mem::swap(&mut lo, &mut hi);
    }
    // Restrict to [0, hi], then take the [lo/hi, 1] tail of that.
    let (left, _) = cubic_split(p, hi.clamp(0.0, 1.0));
    let u = if hi > 1e-9 { (lo / hi).clamp(0.0, 1.0) } else { 0.0 };
    let (_, seg) = cubic_split(&left, u);
    if reversed { [seg[3], seg[2], seg[1], seg[0]] } else { seg }
}

/// Convert an ordered list of cubic control quads (each `[c0,c1,c2,c3]`, head to
/// tail) into a CLOSED subpath's `PathPoint`s (anchor + cp1/cp2 per point). The
/// final anchor coincides with the first, so it's folded into the first point's
/// incoming handle (the engine's closed-subpath convention).
fn quads_to_closed_pathpoints(quads: &[[Vec2; 4]]) -> Vec<PathPoint> {
    if quads.is_empty() {
        return Vec::new();
    }
    let mut pts: Vec<PathPoint> = Vec::new();
    let first = quads[0][0];
    pts.push(PathPoint { x: first.x, y: first.y, cp1: first, cp2: first, corner_radius: 0.0 });
    for q in quads {
        if let Some(last) = pts.last_mut() {
            last.cp2 = q[1]; // outgoing handle of the current anchor
        }
        pts.push(PathPoint { x: q[3].x, y: q[3].y, cp1: q[2], cp2: q[3], corner_radius: 0.0 });
    }
    if pts.len() > 1 {
        let last = pts.pop().unwrap();
        pts[0].cp1 = last.cp1;
    }
    pts
}

/// Whether a cubic is a straight line drawn with handles — which is how pen
/// segments and a rounded rect's flat sides are stored.
fn is_straight(q: &[Vec2; 4]) -> bool {
    let span = q[3] - q[0];
    if span.length() < 1e-6 {
        return false;
    }
    [q[1], q[2]].iter().all(|c| {
        let (proj, _) = project_point_to_segment(*c, q[0], q[3]);
        (proj - *c).length() < 1e-3
    })
}

/// Pull a crossing found between two flattened chords onto the curves themselves.
///
/// ## Why this is the difference between "close" and right
///
/// Two curves are crossed by intersecting their FLATTENED chords, because that
/// is the only representation they share. The answer is a point on the chords —
/// which is *inside* the curve it approximates, by the flattening error. Every
/// consequence of that crossing then inherits the displacement: the region
/// boundary is forced through a vertex the shape's own outline never passes
/// through, so a painted region's curved edge cuts across the shape that bounds
/// it, and — less obviously — a straight edge running between two such points
/// comes out parallel to the line it should lie on but offset from it, because
/// both of its ends were pushed off that line.
///
/// Refining fixes it at the source instead of compensating downstream. Starting
/// from the chord answer, Gauss-Newton on |A(u) − B(v)|² walks both parameters
/// to where the true curves actually meet; the residual falls to ~1e-4 in a few
/// iterations because the seed is already within a flattening error of the root.
/// The vertex then lies ON both curves, so the sub-arcs reconstructed from
/// either side pass exactly through it and the fill hugs the artwork.
///
/// Returns `None` — leaving the chord answer in place — when the curves are
/// locally parallel (no isolated root to converge on), when a parameter leaves
/// its curve, or when the two points do not actually meet. A crossing that
/// cannot be refined is still a crossing; it just keeps the answer it had.
fn refine_crossing(a: &CurveSeg, b: &CurveSeg, u0: f32, v0: f32) -> Option<(f32, f32, Vec2)> {
    let (mut u, mut v) = (u0, v0);
    for _ in 0..16 {
        let r = a.point_at(u) - b.point_at(v);
        if r.length() < 1e-5 {
            break;
        }
        let (da, db) = (a.tangent_at(u), b.tangent_at(v));
        // Solve [da  -db] · [du dv]ᵀ = -r for the step.
        let det = db.x * da.y - da.x * db.y;
        if det.abs() < 1e-9 {
            return None; // parallel here — Newton has nothing to aim at
        }
        u += (r.x * db.y - db.x * r.y) / det;
        v += (r.x * da.y - da.x * r.y) / det;
        if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
            return None;
        }
    }
    let (pa, pb) = (a.point_at(u), b.point_at(v));
    ((pa - pb).length() < 1e-3).then(|| (u, v, (pa + pb) * 0.5))
}

/// The point on `c` genuinely closest to `p`, refined from a chord projection.
///
/// The T-junction counterpart of {@link refine_crossing}: an open end landing on
/// a curve is attached where it meets the curve, not where it meets the chord.
/// Newton on d/dt |C(t) − p|² = 0, i.e. driving (C(t) − p)·C′(t) to zero.
fn refine_closest_point(c: &CurveSeg, p: Vec2, t0: f32) -> Option<(f32, Vec2)> {
    // Seed from a coarse scan, keeping the caller's estimate as one candidate.
    // Newton alone is only as good as where it starts, and a cubic can be
    // parametrised unevenly enough that a position-derived guess lands in the
    // basin of the wrong stationary point — or on a vanishing derivative, where
    // it cannot step at all.
    let mut t = t0;
    let mut best = (c.point_at(t0) - p).length_squared();
    for k in 0..=32 {
        let s = k as f32 / 32.0;
        let d = (c.point_at(s) - p).length_squared();
        if d < best {
            best = d;
            t = s;
        }
    }
    for _ in 0..16 {
        let d = c.point_at(t) - p;
        let d1 = c.tangent_at(t);
        let f = d.dot(d1);
        if f.abs() < 1e-6 {
            break;
        }
        let df = d1.length_squared() + d.dot(c.curvature_vector_at(t));
        if df.abs() < 1e-9 {
            break; // flat here — the scan's answer is what there is
        }
        t = (t - f / df).clamp(0.0, 1.0);
    }
    Some((t, c.point_at(t)))
}

/// A flattened segment that remembers the source curve + t-range it came from,
/// and which Live Paint group it belongs to (segments of different groups never
/// interact, so the planar graph is partitioned per group).
#[derive(Clone, Copy)]
pub(crate) struct FlatSeg {
    pub(crate) a: Vec2,
    pub(crate) b: Vec2,
    pub(crate) node: u32,
    group: u32,
    curve: u32,
    pub(crate) ta: f32,
    pub(crate) tb: f32,
}

/// `FlatSeg` after endpoints are resolved to vertex ids (post `build_vertices`).
#[derive(Clone, Copy)]
struct RemFlat {
    from: u32,
    to: u32,
    node: u32,
    group: u32,
    curve: u32,
    ta: f32,
    tb: f32,
}

/// An enclosed region (face) in the planar graph.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanarFace {
    pub id: u32,
    /// Ordered list of half-edge IDs forming this face's boundary.
    pub boundary_edges: Vec<u32>,
    /// Paint assigned by the user. A full `Paint`, not a colour: a face can be
    /// filled with a gradient, and an UNPAINTED face inherits the paint of the
    /// shape showing through — which for a gradient-filled shape has to stay a
    /// gradient (it used to collapse to the first stop).
    pub fill: Option<Paint>,
    /// Cached boundary polygon vertices for hit-testing and rendering.
    pub boundary_polygon: Vec<[f32; 2]>,
    /// Signed area (negative = clockwise = outer face).
    pub signed_area: f64,
    /// Is this the unbounded outer face?
    pub is_outer: bool,
    /// The Live Paint group this face belongs to.
    #[serde(default)]
    pub group: u32,
    /// Boundary rings that bound this face from INSIDE it — islands.
    ///
    /// A planar face is not always simply connected. Draw a shape entirely
    /// within another and the region between them is one face with two boundary
    /// components: the outer shape, and the inner one seen from outside. The
    /// walk only ever produces one cycle per face, so the inner component came
    /// out as a separate clockwise "outer" face and was discarded — leaving the
    /// enclosing region as a plain closed path that paints straight over the
    /// island. What that looks like is an inner area that cannot be painted: it
    /// is a real region, and clicking picks it, but the region around it is
    /// drawn on top of it.
    ///
    /// Each entry is an ordered half-edge ring, like `boundary_edges`.
    #[serde(default)]
    pub holes: Vec<Vec<u32>>,
    /// Hole polygons, for hit-testing: a point inside one of these is NOT in
    /// this face, it is in whatever the island contains.
    #[serde(default)]
    pub hole_polygons: Vec<Vec<[f32; 2]>>,
    /// Containment signature: sorted ids of the closed source shapes that
    /// contain this face's interior. This is a topological invariant — it stays
    /// the same when shapes move as long as the inside/outside relationship
    /// holds — so a fill re-attaches to the same region across edits. Two
    /// overlapping circles yield three faces with signatures {a}, {a,b}, {b}.
    #[serde(default)]
    pub signature: Vec<u32>,
}

/// A user-painted edge stroke, stored by identity so it survives graph
/// rebuilds. The anchor is kept in the SOURCE NODE's local space, so moving or
/// transforming that path carries the paint along (the Engine converts to/from
/// world using the node's global transform).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PaintedEdge {
    pub source_node: u32,
    pub local: Vec2,
    pub color: Color,
    pub width: f32,
    /// Structural identity: source-segment ordinal + parameter of the click.
    /// Survives topology changes (a moving crossing) far better than `local`,
    /// which is kept as a fallback for legacy files. -1 = no structural id.
    #[serde(default = "neg_one")]
    pub seg: i32,
    #[serde(default)]
    pub t: f32,
}

fn neg_one() -> i32 { -1 }

/// A logical edge: a maximal chain of same-source planar edges running between
/// graph nodes (vertices where paths cross or a path ends). This is the unit the
/// Live Paint bucket recolors — "the line between two intersections", matching
/// how Illustrator treats a Live Paint edge. Rebuilt with the graph; not saved.
#[derive(Clone, Debug, Default)]
pub struct LogicalEdge {
    pub id: u32,
    pub source_node: u32,
    /// The Live Paint group this edge belongs to.
    pub group: u32,
    /// World-space polyline of the whole chain (hit tests / midpoint identity).
    pub polyline: Vec<Vec2>,
    /// Exact-bézier outline (anchor + handles) of the chain — for rendering.
    pub outline: Vec<PathPoint>,
    /// Source segments this chain covers: `(seg ordinal, t_lo, t_hi)` normalised.
    /// Used to re-attach painted edges by structural identity.
    pub segs: Vec<(u32, f32, f32)>,
    /// Representative identity for painting this edge (middle fragment).
    pub anchor_seg: i32,
    pub anchor_t: f32,
    /// Applied stroke, resolved from the scene's painted-edge list each rebuild.
    pub paint: Option<Color>,
    pub width: f32,
}

/// The planar graph computed from overlapping scene paths.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VectorNetwork {
    pub vertices: HashMap<u32, PlanarVertex>,
    pub edges: HashMap<u32, PlanarEdge>,
    pub faces: HashMap<u32, PlanarFace>,
    pub next_id: u32,
    /// Gap tolerance in world units.
    pub gap_tolerance: f32,
    /// Whether the graph needs recomputation.
    pub dirty: bool,
    /// Gap-closing distance in world units. Open path ends within this distance
    /// of another vertex/edge are bridged by synthetic edges so the enclosed
    /// region becomes fillable. 0 = off (only coincident endpoints merge).
    #[serde(default)]
    pub gap_bridge_distance: f32,
    /// Per-group override of `gap_bridge_distance`, keyed by Live Paint group
    /// node id. The value lives on the group node (`Node::gap_bridge_distance`);
    /// this is the copy the graph rebuild reads, so it is derived, not saved.
    #[serde(skip)]
    pub group_gap: HashMap<u32, f32>,
    /// Pending face fills from file load/undo — applied on first rebuild.
    #[serde(default)]
    pub pending_fills: Vec<PendingFill>,
    /// User-painted edge strokes, by local-space identity (persisted).
    #[serde(default)]
    pub painted_edges: Vec<PaintedEdge>,
    /// Logical edges for painting/hit-testing. Derived from the graph each
    /// rebuild, so it is not serialized.
    #[serde(skip)]
    pub logical_edges: HashMap<u32, LogicalEdge>,
    /// The world transform each Live Paint group was last arranged under.
    ///
    /// A fill is re-attached to its region partly by where it was — and "where"
    /// is in world space, so moving the group moved every stored point away from
    /// the region it belonged to and the colours landed on their neighbours.
    /// Keeping the transform means the next rebuild can ask what the group DID
    /// since, and carry the old points along with it. Not saved: it describes the
    /// arrangement in memory, and a freshly loaded document has no previous one.
    #[serde(skip)]
    pub(crate) group_built_transform: HashMap<u32, [f32; 9]>,
    /// Source curves (world space) that fragments reference for exact-bézier
    /// reconstruction. Rebuilt each pass; not serialized.
    #[serde(skip)]
    pub curves: Vec<CurveSeg>,
}

impl Default for VectorNetwork {
    fn default() -> Self {
        Self {
            vertices: HashMap::new(),
            edges: HashMap::new(),
            faces: HashMap::new(),
            next_id: 1,
            // How far apart two points may be and still be treated as one.
            //
            // It has to reach the imprecision in a hand-drawn junction — pen ends
            // in a real drawing sit a few tenths of a unit off the line they meet
            // — and it must not reach across a thin region, because anything
            // narrower than this collapses into nothing and stops being
            // paintable. Both halves measured on that drawing: at 0.25 junctions
            // stayed open and it yielded 17 regions; at 1.0, 24; at 2.0 it fell
            // back to 23, the missing one a sliver of area 6.7 that the tolerance
            // had swallowed. Wider is not safer — it is regions deleted.
            gap_tolerance: 1.0,
            dirty: true,
            gap_bridge_distance: 0.0,
            group_gap: HashMap::new(),
            pending_fills: Vec::new(),
            painted_edges: Vec::new(),
            logical_edges: HashMap::new(),
            curves: Vec::new(),
            group_built_transform: HashMap::new(),
        }
    }
}

impl VectorNetwork {
    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn clear(&mut self) {
        // Preserve face fills for re-mapping after rebuild
        self.vertices.clear();
        self.edges.clear();
        self.logical_edges.clear();
        self.curves.clear();
        // faces cleared separately after centroid matching
        self.next_id = 1;
    }
}

// ─── Bezier Flattening ─────────────────────────────────────────────────────────

/// Flatten a cubic bezier (p0→p1→p2→p3) into a polyline via adaptive de Casteljau.
/// Pushes interior and end points into `out` (caller seeds `out` with p0).
pub(crate) fn flatten_cubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tolerance: f32, out: &mut Vec<Vec2>) {
    // Check if the curve is flat enough
    let d1 = (p1 - p0).length() + (p2 - p1).length() + (p3 - p2).length();
    let d2 = (p3 - p0).length();
    if (d1 - d2) < tolerance {
        out.push(p3);
        return;
    }
    // Subdivide
    let m01 = (p0 + p1) * 0.5;
    let m12 = (p1 + p2) * 0.5;
    let m23 = (p2 + p3) * 0.5;
    let m012 = (m01 + m12) * 0.5;
    let m123 = (m12 + m23) * 0.5;
    let mid = (m012 + m123) * 0.5;
    flatten_cubic(p0, m01, m012, mid, tolerance, out);
    flatten_cubic(mid, m123, m23, p3, tolerance, out);
}

/// Like `flatten_cubic` but records the curve parameter `t` at each emitted
/// point. Caller seeds `out` with `(p0, t0)`; this appends up to `(p3, t1)`.
fn flatten_cubic_t(
    p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2,
    t0: f32, t1: f32, tolerance: f32, out: &mut Vec<(Vec2, f32)>,
) {
    let d1 = (p1 - p0).length() + (p2 - p1).length() + (p3 - p2).length();
    let d2 = (p3 - p0).length();
    if (d1 - d2) < tolerance {
        out.push((p3, t1));
        return;
    }
    let m01 = (p0 + p1) * 0.5;
    let m12 = (p1 + p2) * 0.5;
    let m23 = (p2 + p3) * 0.5;
    let m012 = (m01 + m12) * 0.5;
    let m123 = (m12 + m23) * 0.5;
    let mid = (m012 + m123) * 0.5;
    let tmid = 0.5 * (t0 + t1);
    flatten_cubic_t(p0, m01, m012, mid, t0, tmid, tolerance, out);
    flatten_cubic_t(mid, m123, m23, p3, tmid, t1, tolerance, out);
}

/// Flattening tolerance (world units) for building the planar graph. Curves are
/// reconstructed exactly from `curves` for rendering/export, so this only needs
/// to be fine enough for topology (intersections/containment).
/// How finely a curve is flattened on its way into the arrangement.
///
/// This is now the ONLY place curvature is decided. Faces and painted lines are
/// the arrangement itself (see `face_outline`), so a corner arc is as smooth as
/// it is flattened here and no smoother — which is why this is well under a
/// pixel at ordinary zoom rather than the half unit it used to be, when a
/// separate exact-bézier reconstruction was expected to make it pretty later.
/// That reconstruction is what put curves through drawings that had none.
///
/// The cost is linear: more, shorter segments through intersection finding,
/// which is bucketed by a spatial hash and does not care.
const FLATTEN_TOL: f32 = 0.08;

/// How close two points the ARTWORK defines must be to count as one.
///
/// Not the gap tolerance — that one is about hand-drawn ends missing their mark,
/// and is deliberately generous. This is about geometry that is supposed to
/// coincide: a corner where two segments of a path meet, two crossings computed
/// at the same place from either side. Those agree to within flattening error or
/// they are genuinely different points, and treating "genuinely different" as
/// "the same" is how thin regions disappear.
const STRUCTURAL_MERGE_EPS: f32 = 0.1;

/// Emit one Cubic curve per path segment, plus its flattened `FlatSeg`s.
fn push_path_curves(
    points: &[PathPoint], node: u32, group: u32, closed: bool,
    curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>,
) {
    if points.len() < 2 {
        return;
    }
    let last = points.len() - 2;
    for i in 0..points.len() - 1 {
        let p = [
            Vec2::new(points[i].x, points[i].y),
            points[i].cp2,
            points[i + 1].cp1,
            Vec2::new(points[i + 1].x, points[i + 1].y),
        ];
        let free = (!closed && i == 0, !closed && i == last);
        // A segment drawn with no handles is a LINE, and it has to be recorded as
        // one. Stored as the cubic [p0,p0,p3,p3] it is still geometrically
        // straight, but its parameter no longer moves with distance — it sweeps
        // as 3t²−2t³, easing in and out — so any code that reads a position along
        // it as a parameter is wrong by as much as an eighth of its length. On
        // the reported drawing that mismatch reached 10.25 units, and it is what
        // made a boundary reconstruct along the wrong stretch of its own line.
        if (p[1] - p[0]).length() < 1e-6 && (p[2] - p[3]).length() < 1e-6 {
            let ci = curves.len() as u32;
            curves.push(CurveSeg::Line { node, seg: i as u32, a: p[0], b: p[3], free });
            out.push(FlatSeg { a: p[0], b: p[3], node, group, curve: ci, ta: 0.0, tb: 1.0 });
        } else {
            push_cubic(p, node, group, i as u32, free, curves, out);
        }
    }
}

/// Register a cubic in the curve table and append its flattened `FlatSeg`s.
fn push_cubic(
    p: [Vec2; 4], node: u32, group: u32, seg: u32, free: (bool, bool),
    curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>,
) {
    let ci = curves.len() as u32;
    curves.push(CurveSeg::Cubic { node, seg, p, free });
    let mut flat: Vec<(Vec2, f32)> = vec![(p[0], 0.0)];
    flatten_cubic_t(p[0], p[1], p[2], p[3], 0.0, 1.0, FLATTEN_TOL, &mut flat);
    for w in flat.windows(2) {
        out.push(FlatSeg { a: w[0].0, b: w[1].0, node, group, curve: ci, ta: w[0].1, tb: w[1].1 });
    }
}

/// Rect → 4 Line curves.
/// One subpath, taken to world space and handed to the curve extractor. A closed
/// subpath gets its wrap segment (last → first) so the region actually closes.
fn push_world_subpath(
    sp: &Subpath, transform: &[f32; 9], node: u32, group: u32,
    curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>,
) {
    let mut world_points: Vec<PathPoint> = sp.points.iter().map(|p| PathPoint {
        x: transform[0] * p.x + transform[3] * p.y + transform[6],
        y: transform[1] * p.x + transform[4] * p.y + transform[7],
        cp1: Vec2::new(
            transform[0] * p.cp1.x + transform[3] * p.cp1.y + transform[6],
            transform[1] * p.cp1.x + transform[4] * p.cp1.y + transform[7],
        ),
        cp2: Vec2::new(
            transform[0] * p.cp2.x + transform[3] * p.cp2.y + transform[6],
            transform[1] * p.cp2.x + transform[4] * p.cp2.y + transform[7],
        ),
        corner_radius: p.corner_radius,
    }).collect();
    if sp.closed && world_points.len() >= 2 {
        world_points.push(world_points[0].clone());
    }
    push_path_curves(&world_points, node, group, sp.closed, curves, out);
}

fn push_rect_curves(w: f32, h: f32, transform: &[f32; 9], node: u32, group: u32, curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>) {
    let c = [
        transform_point(Vec2::new(0.0, 0.0), transform),
        transform_point(Vec2::new(w, 0.0), transform),
        transform_point(Vec2::new(w, h), transform),
        transform_point(Vec2::new(0.0, h), transform),
    ];
    for i in 0..4 {
        let (a, b) = (c[i], c[(i + 1) % 4]);
        let ci = curves.len() as u32;
        curves.push(CurveSeg::Line { node, seg: i as u32, a, b, free: (false, false) });
        out.push(FlatSeg { a, b, node, group, curve: ci, ta: 0.0, tb: 1.0 });
    }
}

/// Ellipse → 4 cubic arcs (kappa approximation), so the network — and the faces
/// carved from it — are true curves, not a 32-gon.
fn push_ellipse_curves(rx: f32, ry: f32, transform: &[f32; 9], node: u32, group: u32, curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>) {
    const K: f32 = 0.552_284_75; // 4/3 * (sqrt(2) - 1)
    let arcs = [
        [Vec2::new(rx, 0.0), Vec2::new(rx, K * ry), Vec2::new(K * rx, ry), Vec2::new(0.0, ry)],
        [Vec2::new(0.0, ry), Vec2::new(-K * rx, ry), Vec2::new(-rx, K * ry), Vec2::new(-rx, 0.0)],
        [Vec2::new(-rx, 0.0), Vec2::new(-rx, -K * ry), Vec2::new(-K * rx, -ry), Vec2::new(0.0, -ry)],
        [Vec2::new(0.0, -ry), Vec2::new(K * rx, -ry), Vec2::new(rx, -K * ry), Vec2::new(rx, 0.0)],
    ];
    for (i, arc) in arcs.iter().enumerate() {
        let p = [
            transform_point(arc[0], transform),
            transform_point(arc[1], transform),
            transform_point(arc[2], transform),
            transform_point(arc[3], transform),
        ];
        push_cubic(p, node, group, i as u32, (false, false), curves, out);
    }
}

fn transform_point(p: Vec2, t: &[f32; 9]) -> Vec2 {
    // t is column-major Mat3
    Vec2::new(
        t[0] * p.x + t[3] * p.y + t[6],
        t[1] * p.x + t[4] * p.y + t[7],
    )
}

// ─── Segment-Segment Intersection ──────────────────────────────────────────────

/// Find the intersection point of two line segments, if any.
/// Returns the parameter t for seg1 (0..1) and the intersection point.
pub(crate) fn segment_intersection(
    a1: Vec2, a2: Vec2,
    b1: Vec2, b2: Vec2,
) -> Option<(f32, f32, Vec2)> {
    let d1 = a2 - a1;
    let d2 = b2 - b1;
    let cross = d1.x * d2.y - d1.y * d2.x;
    if cross.abs() < 1e-10 {
        return None; // Parallel
    }
    let d = b1 - a1;
    let t = (d.x * d2.y - d.y * d2.x) / cross;
    let u = (d.x * d1.y - d.y * d1.x) / cross;

    const EPS: f32 = 1e-6;
    if t > EPS && t < 1.0 - EPS && u > EPS && u < 1.0 - EPS {
        let point = a1 + d1 * t;
        Some((t, u, point))
    } else {
        None
    }
}

/// Move a point from the space a group used to be in into the space it is in now.
///
/// `from` is the transform the point was measured under, `to` the group's current
/// one. With either missing — a first build, or a group that has since gone —
/// there is nothing to compose and the point stands as it is.
fn carry_point(p: Vec2, from: Option<&[f32; 9]>, to: Option<&[f32; 9]>) -> Vec2 {
    let (Some(from), Some(to)) = (from, to) else { return p };
    if from == to {
        return p; // the common case: nothing moved
    }
    let m_from = glam::Mat3::from_cols_array(from);
    let m_to = glam::Mat3::from_cols_array(to);
    let det = m_from.determinant();
    if !det.is_finite() || det.abs() < 1e-12 {
        return p; // degenerate: better to leave the point than to invent one
    }
    let local = m_from.inverse() * glam::Vec3::new(p.x, p.y, 1.0);
    let world = m_to * local;
    if world.z.abs() < 1e-12 {
        return p;
    }
    Vec2::new(world.x / world.z, world.y / world.z)
}

// ─── Core Algorithm ────────────────────────────────────────────────────────────

impl VectorNetwork {
    /// Rebuild the entire planar graph from the given scene segments + curves.
    pub(crate) fn rebuild(
        &mut self,
        engine_segments: Vec<FlatSeg>,
        curves: Vec<CurveSeg>,
        group_transforms: &HashMap<u32, [f32; 9]>,
    ) {
        // Snapshot old filled faces as (signature, centroid, color) for re-mapping.
        // The signature (which closed shapes contain the face) lets a fill
        // re-attach to the same region even after shapes move (see remap_fills).
        //
        // The point is carried through whatever the group has done since it was
        // taken. Without that, dragging a Live Paint group shifted every colour
        // onto a neighbouring region: the stored points stayed where the drawing
        // used to be, and matching them against the moved arrangement is asking
        // which region is now nearest to where a different region used to sit.
        // Rigid or not — a move, a scale, a rotation — the answer is the same
        // composition, so this handles all of them.
        let old_filled: Vec<(u32, Vec<u32>, Vec2, Paint)> = self.faces.values()
            .filter(|f| f.fill.is_some() && !f.is_outer)
            .map(|f| (
                f.group,
                f.signature.clone(),
                carry_point(
                    // A point guaranteed to lie INSIDE the face. The plain
                    // centroid is not: a concave region (an L, a wedge, most of
                    // any traced drawing) puts it in the neighbour it wraps, and
                    // the containment tier below then hands that neighbour the
                    // colour and leaves this region bare.
                    representative_point(&f.boundary_polygon),
                    self.group_built_transform.get(&f.group),
                    group_transforms.get(&f.group),
                ),
                f.fill.clone().unwrap(),
            ))
            .collect();
        self.group_built_transform = group_transforms.clone();

        // Group the incoming (un-split) segments by source node into closed
        // outlines, used to compute each new face's containment signature.
        let node_outlines = build_node_outlines(&engine_segments);

        self.clear();
        self.faces.clear();
        self.curves = curves;

        if engine_segments.is_empty() {
            self.dirty = false;
            return;
        }

        // Step 1: Find all intersections and split segments
        let split_segments = self.find_intersections_and_split(engine_segments);

        if split_segments.is_empty() {
            self.dirty = false;
            return;
        }

        // Step 2: Build vertices (merge endpoints within gap tolerance, per group)
        let segments_remapped = self.build_vertices(split_segments);

        if segments_remapped.is_empty() {
            self.dirty = false;
            return;
        }

        // Step 3: Create half-edges
        self.create_half_edges(segments_remapped);

        // Step 4: Close gaps — bridge dangling open ends within tolerance so
        // not-quite-closed regions become fillable (Illustrator "Gap Options").
        // The tolerance is per Live Paint group, so one group can be painted
        // with a wide tolerance without loosening every other group.
        // Runs whenever there is any distance to work with — the user's Gaps
        // setting OR the snapping tolerance, which is the same claim about which
        // points are meant to be one (see `bridge_gaps`). Gated on Gaps alone,
        // an end stopping a third of a unit short of the line it meets stayed
        // open, and the region it was drawn to close could not be painted.
        if self.gap_tolerance > 0.0
            || self.gap_bridge_distance > 0.0
            || self.group_gap.values().any(|&d| d > 0.0)
        {
            self.bridge_gaps();
        }

        // Step 5: Sort outgoing edges radially at each vertex
        self.sort_edges_radially();

        // Step 6: Detect faces via left-hand turn traversal
        self.detect_faces();

        // Step 6b: Give every face the islands that sit inside it.
        self.attach_holes();

        // Step 7: Tag each face with its containment signature.
        self.compute_face_signatures(&node_outlines);

        // Step 8: Merge planar edges into logical edges (for edge painting).
        self.build_logical_edges();

        // Step 9: Re-attach old + pending fills to the new faces.
        self.remap_fills(old_filled);

        self.dirty = false;
    }

    /// Merge planar half-edges into logical edges: maximal same-source chains
    /// running between graph nodes (vertices of non-synthetic degree ≠ 2).
    /// Synthetic gap bridges are excluded — they are not paintable geometry.
    fn build_logical_edges(&mut self) {
        self.logical_edges.clear();

        // Canonical undirected, non-synthetic edges (id < twin picks one of each pair).
        let mut canon: Vec<u32> = self.edges.values()
            .filter(|e| !e.synthetic && e.id < e.twin)
            .map(|e| e.id)
            .collect();
        canon.sort_unstable();

        // Incident canonical edges per vertex → undirected degree.
        let mut incident: HashMap<u32, Vec<u32>> = HashMap::new();
        for &eid in &canon {
            let e = &self.edges[&eid];
            incident.entry(e.from_vertex).or_default().push(eid);
            incident.entry(e.to_vertex).or_default().push(eid);
        }

        let mut visited: HashSet<u32> = HashSet::new();
        for &start in &canon {
            if visited.contains(&start) {
                continue;
            }
            let src = self.edges[&start].source_node;
            let grp = self.edges[&start].group;
            let (v0, v1) = (self.edges[&start].from_vertex, self.edges[&start].to_vertex);
            visited.insert(start);

            // Ordered vertex sequence of the chain, seeded with the start edge.
            let mut verts: std::collections::VecDeque<u32> = std::collections::VecDeque::new();
            verts.push_back(v0);
            verts.push_back(v1);

            // Extend forward from v1, then backward from v0. A chain continues
            // through a vertex only if it has exactly 2 same-context incident
            // edges (a pass-through point) and the next edge shares the source.
            self.walk_chain(v1, start, src, &incident, &mut visited, &mut verts, false);
            self.walk_chain(v0, start, src, &incident, &mut visited, &mut verts, true);

            let verts: Vec<u32> = verts.into_iter().collect();
            let polyline: Vec<Vec2> = verts.iter()
                .filter_map(|v| self.vertices.get(v).map(|pv| pv.position))
                .collect();
            if polyline.len() < 2 {
                continue;
            }
            // The painted line is the arrangement's own chain, for the same
            // reason a face's outline is (see `face_outline`): a second geometry
            // re-derived from stored curve parameters is a second answer to a
            // question that already has one, and the two drift apart.
            let chain_edges = self.verts_to_edges(&verts);
            let outline: Vec<PathPoint> = polyline.iter()
                .map(|&p| PathPoint { x: p.x, y: p.y, cp1: p, cp2: p, corner_radius: 0.0 })
                .collect();
            // Structural identity: which source segments (+ t-ranges) the chain
            // covers, and a representative anchor (its middle fragment).
            let mut segs: Vec<(u32, f32, f32)> = Vec::new();
            for &eid in &chain_edges {
                if let Some(fr) = self.edges.get(&eid).and_then(|e| e.frag) {
                    if let Some(cv) = self.curves.get(fr.curve as usize) {
                        segs.push((cv.seg(), fr.ta.min(fr.tb), fr.ta.max(fr.tb)));
                    }
                }
            }
            let (anchor_seg, anchor_t) = chain_edges.get(chain_edges.len() / 2)
                .and_then(|&eid| self.edges.get(&eid))
                .and_then(|e| e.frag)
                .and_then(|fr| self.curves.get(fr.curve as usize).map(|cv| (cv.seg() as i32, 0.5 * (fr.ta + fr.tb))))
                .unwrap_or((-1, 0.0));
            let id = self.alloc_id();
            self.logical_edges.insert(id, LogicalEdge {
                id, source_node: src, group: grp, polyline, outline, segs, anchor_seg, anchor_t, paint: None, width: 0.0,
            });
        }
    }

    /// Ordered directed half-edges connecting a run of vertices head-to-tail.
    fn verts_to_edges(&self, verts: &[u32]) -> Vec<u32> {
        let mut out = Vec::new();
        for w in verts.windows(2) {
            if let Some(v) = self.vertices.get(&w[0]) {
                if let Some(&eid) = v.outgoing_edges.iter()
                    .find(|&&e| self.edges.get(&e).map(|x| x.to_vertex) == Some(w[1]))
                {
                    out.push(eid);
                }
            }
        }
        out
    }

    /// Walk a degree-2 same-source chain from `from_vertex` (reached via
    /// `came_edge`), appending traversed vertices to `verts`.
    #[allow(clippy::too_many_arguments)]
    fn walk_chain(
        &self,
        from_vertex: u32,
        came_edge: u32,
        src: u32,
        incident: &HashMap<u32, Vec<u32>>,
        visited: &mut HashSet<u32>,
        verts: &mut std::collections::VecDeque<u32>,
        push_front: bool,
    ) {
        let mut cur_v = from_vertex;
        let mut came = came_edge;
        loop {
            let inc = match incident.get(&cur_v) {
                Some(i) if i.len() == 2 => i,
                _ => break, // node vertex (crossing/endpoint) → chain ends here
            };
            let next = if inc[0] == came { inc[1] } else { inc[0] };
            if visited.contains(&next) || self.edges[&next].source_node != src {
                break;
            }
            visited.insert(next);
            let ne = &self.edges[&next];
            let far = if ne.from_vertex == cur_v { ne.to_vertex } else { ne.from_vertex };
            if push_front { verts.push_front(far); } else { verts.push_back(far); }
            if far == cur_v { break; } // degenerate guard
            came = next;
            cur_v = far;
        }
    }

    /// Nearest paintable logical edge to a point, within `tolerance` world units.
    pub fn query_edge_at(&self, x: f32, y: f32, tolerance: f32) -> Option<u32> {
        let p = Vec2::new(x, y);
        let mut best: Option<(u32, f32)> = None;
        for (&id, le) in &self.logical_edges {
            let d = point_to_polyline_distance(p, &le.polyline);
            if d <= tolerance && best.map_or(true, |(_, bd)| d < bd) {
                best = Some((id, d));
            }
        }
        best.map(|(id, _)| id)
    }

    /// Reconstruct a face's boundary as EXACT béziers (anchor + handles): walk
    /// How far a source curve may stray from the arrangement before it is
    /// refused as a description of it.
    ///
    /// Crossings are refined onto the curves themselves, so a curve now passes
    /// through the vertices it created. What it cannot pass through is a vertex
    /// that was MERGED: two junctions within the snapping tolerance become one
    /// point, and that point can sit anywhere within that tolerance of either
    /// curve. So the bound is the tolerance itself — deriving it keeps the two
    /// honest when the tolerance changes, which a fixed constant did not.
    ///
    /// The floor covers the vertices no merge touched, which sit on the curve to
    /// within the flattening error.
    ///
    /// This is not a precision knob; it is a lie detector. What it exists to
    /// catch is a curve that has no business describing a boundary at all — the
    /// drifted parameter range that started this work reconstructed 16.6 units
    /// away from its own vertices.
    fn curve_agreement_eps(&self) -> f32 {
        self.gap_tolerance.max(0.25)
    }

    /// The boundary of a face: the arrangement, described by a source curve
    /// wherever that curve provably IS the arrangement.
    ///
    /// ## The rule, and why it exists
    ///
    /// Every decision about this surface is made on the flattened arrangement:
    /// where segments cross, where a loose end lands, which points are one
    /// point, which cycle of half-edges encloses a region. Drawing the fill from
    /// a *second* description of that boundary — source curves re-derived from
    /// stored parameter ranges — means two geometries claim to be one boundary,
    /// and nothing made them agree.
    ///
    /// They did not agree. A fragment's `t` range is carried through flattening
    /// and through every split, and one arriving here claiming `t[0.0588,
    /// 0.9412]` reconstructed to an arc whose ends sat 16.6 units from the
    /// vertices it was supposed to join. Drawn, that swung the outline across
    /// the drawing — straight artwork acquiring curves it never contained, at
    /// the moment it was painted. A shape alone never showed it, because nothing
    /// splits its curves; one line across it was the whole reproduction.
    ///
    /// The curve does not get to assert; it gets to agree. A run of half-edges
    /// along one source curve is reconstructed, then checked against the
    /// arrangement at both ends AND at its middle — the middle because two
    /// matching endpoints say nothing about the bulge between them. Agreement
    /// means the two geometries are the same boundary and the exact curve is
    /// kept, which is what makes a painted circle export as a circle. Anything
    /// else is drawn as the arrangement holds it: straight between its vertices.
    /// So a curve appears only where the drawing has one.
    pub(crate) fn face_outline(&self, face: &PlanarFace) -> Vec<PathPoint> {
        quads_to_closed_pathpoints(&self.edges_to_quads(&face.boundary_edges))
    }

    /// Every ring that bounds this face: the outline first, then each island.
    ///
    /// Drawn as one path with these contours, the islands are holes rather than
    /// something the face paints over — which is what makes an enclosed region
    /// paintable in its own right. Callers that only want the silhouette can
    /// keep using `face_outline`.
    pub(crate) fn face_rings(&self, face: &PlanarFace) -> Vec<Vec<PathPoint>> {
        let mut rings = vec![self.face_outline(face)];
        for hole in &face.holes {
            let ring = quads_to_closed_pathpoints(&self.edges_to_quads(hole));
            if ring.len() >= 3 {
                rings.push(ring);
            }
        }
        rings
    }

    /// Ordered half-edges → cubic control quads, one per run of edges that share
    /// a source curve contiguously and in one direction. See `face_outline` for
    /// why each run has to earn its curve.
    fn edges_to_quads(&self, edge_ids: &[u32]) -> Vec<[Vec2; 4]> {
        let mut quads: Vec<[Vec2; 4]> = Vec::new();
        // (curve, t_start, t_last, ordered vertices the run passes through)
        let mut run: Option<(u32, f32, f32, Vec<u32>)> = None;

        let flush = |run: &mut Option<(u32, f32, f32, Vec<u32>)>, quads: &mut Vec<[Vec2; 4]>, me: &Self| {
            let Some((c, t0, t1, verts)) = run.take() else { return };
            let pos = |v: &u32| me.vertices.get(v).map(|x| x.position).unwrap_or_default();
            let (a, b) = (pos(&verts[0]), pos(verts.last().unwrap()));

            let eps = me.curve_agreement_eps();
            // The parameter range is re-derived from the run's own end vertices
            // rather than taken from the fragments' accumulated bookkeeping.
            //
            // Those two can disagree, and the disagreement is visible. A range
            // whose end lands even a fraction off the vertex is still drawn TO
            // that vertex — the ends are snapped so neighbouring pieces meet —
            // so the curve gets dragged there, and the error grows steadily
            // along the last stretch before collapsing to zero at the anchor.
            // That is a boundary sliding off the shape that bounds it, thickest
            // just before the corner. Asking the curve where the vertices
            // actually sit on it removes the disagreement instead of snapping
            // over it.
            let range = me.curves.get(c as usize).and_then(|cv| {
                let (u, _) = refine_closest_point(cv, a, t0)?;
                let (v, _) = refine_closest_point(cv, b, t1)?;
                // Still the same stretch of curve, in the same direction: a
                // vertex whose nearest point is somewhere else entirely means
                // this run is not describable by this curve, and the fallback
                // below is the honest answer.
                ((u - t0).abs() < 0.25 && (v - t1).abs() < 0.25).then_some((u, v))
            });
            let (t0, t1) = range.unwrap_or((t0, t1));

            let accepted = me.curves.get(c as usize).map(|cv| cv.subsegment(t0, t1)).filter(|q| {
                if (q[0] - a).length() > eps { return false; }
                if (q[3] - b).length() > eps { return false; }
                // Matching ends say nothing about the bulge between them. Every
                // vertex this run passes through must lie on the curve, so
                // sample the curve finely enough to measure that and ask each
                // one. A drifted parameter range fails immediately: the run whose
                // reconstruction started this — t[0.0588, 0.9412] — put its curve
                // 16.6 units from its own vertices.
                let polyline: Vec<Vec2> = verts.iter().map(pos).collect();
                (1..16).all(|k| {
                    let t = k as f32 / 16.0;
                    point_to_polyline_distance(cubic_point(q, t), &polyline)
                        <= eps
                })
            });

            match accepted {
                // Snap the ends to the arrangement so consecutive pieces meet
                // exactly. A straight source stays straight through that snap:
                // keeping its interior handles while moving an end bends the
                // last stretch of a line that has no bend in it, which is what a
                // pen stroke ending just short of the line it meets produced —
                // the join curling into the junction instead of running to it.
                Some(q) if is_straight(&q) => quads.push([a, a, b, b]),
                Some(q) => quads.push([a, q[1], q[2], b]),
                None => {
                    // The arrangement, as it holds it: straight from vertex to vertex.
                    for w in verts.windows(2) {
                        let (p, q) = (pos(&w[0]), pos(&w[1]));
                        quads.push([p, p, q, q]);
                    }
                }
            }
        };

        for &eid in edge_ids {
            let Some(e) = self.edges.get(&eid) else { continue };
            match e.frag {
                Some(f) if (f.curve as usize) < self.curves.len() => {
                    let extend = matches!(&run, Some((c, t0, t1, _))
                        if *c == f.curve
                            && (f.ta - t1).abs() < 1e-3
                            && (t1 - t0) * (f.tb - f.ta) >= 0.0);
                    if extend {
                        if let Some((_, _, t1, verts)) = run.as_mut() {
                            *t1 = f.tb;
                            verts.push(e.to_vertex);
                        }
                    } else {
                        flush(&mut run, &mut quads, self);
                        run = Some((f.curve, f.ta, f.tb, vec![e.from_vertex, e.to_vertex]));
                    }
                }
                _ => {
                    flush(&mut run, &mut quads, self);
                    let a = self.vertices[&e.from_vertex].position;
                    let b = self.vertices[&e.to_vertex].position;
                    quads.push([a, a, b, b]);
                }
            }
        }
        flush(&mut run, &mut quads, self);
        quads
    }

    /// Compute each non-outer face's containment signature: the sorted ids of
    /// the closed source shapes whose interior contains the face. This is the
    /// stable identity used to re-attach fills across edits.
    fn compute_face_signatures(&mut self, node_outlines: &HashMap<u32, NodeOutline>) {
        for face in self.faces.values_mut() {
            if face.is_outer {
                continue;
            }
            let p = representative_point(&face.boundary_polygon);
            let fg = face.group;
            let mut sig: Vec<u32> = node_outlines.iter()
                .filter(|(_, o)| o.group == fg && o.closed && point_inside_segments(p, &o.segments))
                .map(|(&nid, _)| nid)
                .collect();
            sig.sort_unstable();
            face.signature = sig;
        }
    }

    fn find_intersections_and_split(&self, segments: Vec<FlatSeg>) -> Vec<FlatSeg> {
        /// A fragment-local position (0..1 along the chord) as a parameter on the
        /// source curve. `None` for a fragment spanning no parameter at all.
        fn curve_param(seg: &FlatSeg, local: f32) -> Option<f32> {
            (seg.tb != seg.ta).then(|| seg.ta + local * (seg.tb - seg.ta))
        }
        /// The inverse: a curve parameter back to fragment-local, which is what
        /// the split list is keyed and sorted by.
        fn local_param(seg: &FlatSeg, curve: f32) -> Option<f32> {
            (seg.tb != seg.ta).then(|| (curve - seg.ta) / (seg.tb - seg.ta))
        }
        /// Strictly inside the fragment, so a split never degenerates to an end.
        fn in_span(local: f32) -> bool {
            local > 1e-4 && local < 1.0 - 1e-4
        }

        // Split points are stored as the flat-local parameter `t` ∈ [0,1] + point.
        let n = segments.len();
        let mut splits: Vec<Vec<(f32, Vec2)>> = vec![Vec::new(); n];

        // Spatial hash: bucket each segment into every cell its AABB touches, so
        // only segments sharing a cell are candidate pairs. Two segments can only
        // cross (or one's endpoint lie on the other) if their AABBs overlap, so
        // shared-cell candidates are a superset of all real intersections — this
        // replaces the old O(n²) pairwise scan.
        const CELL: f32 = 32.0;
        let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
        for (i, s) in segments.iter().enumerate() {
            let cx0 = (s.a.x.min(s.b.x) / CELL).floor() as i32;
            let cx1 = (s.a.x.max(s.b.x) / CELL).floor() as i32;
            let cy0 = (s.a.y.min(s.b.y) / CELL).floor() as i32;
            let cy1 = (s.a.y.max(s.b.y) / CELL).floor() as i32;
            for cx in cx0..=cx1 {
                for cy in cy0..=cy1 {
                    grid.entry((cx, cy)).or_default().push(i);
                }
            }
        }
        let mut pairs: HashSet<(usize, usize)> = HashSet::new();
        for ids in grid.values() {
            for a in 0..ids.len() {
                for b in (a + 1)..ids.len() {
                    pairs.insert((ids[a].min(ids[b]), ids[a].max(ids[b])));
                }
            }
        }

        // How far apart two things can be and still count as touching. This has
        // to be the SAME number `build_vertices` merges vertices with, and for a
        // long time it was not: endpoints merged with each other within
        // `gap_tolerance` (2.0) while an endpoint landing on the INTERIOR of
        // another line only counted within 0.1. Twenty times stricter, for the
        // junction a drawing is most often made of.
        //
        // A pen line dropped onto another line lands a fraction of a unit off —
        // measured on a real drawing: ends sitting 0.25 to 0.92 units from the
        // line they plainly meet. Every one of those fell through this test, so
        // no vertex was ever created there, so nothing merged, so the region
        // stayed open and flooded into its neighbour. That is "some areas paint,
        // some are totally wrong": the ones that happened to land under 0.1
        // worked, the rest silently did not.
        //
        // Beyond this distance the ends are a real gap, which is what the group's
        // gap-closing distance is for — a separate, visible, user-set number.
        let on_eps = self.gap_tolerance.max(0.1);
        const T_EPS: f32 = 1e-4; // keep the split strictly interior
        for &(i, j) in &pairs {
            // Different Live Paint groups are independent — they never split each
            // other, so their overlapping shapes form faces independently.
            if segments[i].group != segments[j].group {
                continue;
            }
            // Proper crossing (both interiors). The chord answer is only the
            // seed: `refine_crossing` walks it onto the curves themselves, so
            // the vertex lands where the artwork actually crosses rather than a
            // flattening error inside it.
            if let Some((t, u, pt)) = segment_intersection(
                segments[i].a, segments[i].b, segments[j].a, segments[j].b,
            ) {
                let refined = self
                    .curves
                    .get(segments[i].curve as usize)
                    .zip(self.curves.get(segments[j].curve as usize))
                    .and_then(|(ci, cj)| {
                        let (u_seed, v_seed) = (
                            curve_param(&segments[i], t)?,
                            curve_param(&segments[j], u)?,
                        );
                        let (cu, cv, p) = refine_crossing(ci, cj, u_seed, v_seed)?;
                        let (li, lj) =
                            (local_param(&segments[i], cu)?, local_param(&segments[j], cv)?);
                        // The refined root has to be the crossing THESE two
                        // fragments have. Newton can walk to a different root of
                        // the same pair of curves — a circle crossed by a line
                        // has two — and adopting that one would move the split to
                        // a place this fragment does not cover, handing it a
                        // parameter range that describes some other part of the
                        // curve entirely.
                        (in_span(li) && in_span(lj)).then_some((li, lj, p))
                    });
                let (ti, tj, point) = refined.unwrap_or((t, u, pt));
                splits[i].push((ti, point));
                splits[j].push((tj, point));
            }
            // T-junctions & collinear overlaps, both directions: an endpoint of
            // one segment lying on the interior of the other (missed by the
            // crossing test — endpoint touch / parallel). Common with aligned
            // rectangles; without it the region stays unsplit and unfillable.
            for &(x, y) in &[(i, j), (j, i)] {
                let (pa, pb) = (segments[x].a, segments[x].b);
                for &p in &[segments[y].a, segments[y].b] {
                    let (proj, t) = project_point_to_segment(p, pa, pb);
                    if t > T_EPS && t < 1.0 - T_EPS && (proj - p).length() < on_eps {
                        // Split the crossed segment AT ITS OWN GEOMETRY — the
                        // point on the curve nearest the open end, not the end's
                        // own position, which differs by however far it missed
                        // and bends the line it landed on.
                        let refined = self
                            .curves
                            .get(segments[x].curve as usize)
                            .and_then(|cx| {
                                let seed = curve_param(&segments[x], t)?;
                                let (ct, q) = refine_closest_point(cx, p, seed)?;
                                Some((local_param(&segments[x], ct)?, q))
                            })
                            .filter(|(lt, q)| {
                                // Only if it still describes this fragment's own
                                // span and still counts as touching.
                                *lt > T_EPS && *lt < 1.0 - T_EPS && (*q - p).length() < on_eps
                            });
                        splits[x].push(refined.unwrap_or((t, proj)));
                    }
                }
            }
        }

        // Split each flat segment at its intersection points, carrying a linearly
        // interpolated CURVE parameter so fragments know their exact sub-arc.
        let mut result = Vec::new();
        for (i, seg) in segments.iter().enumerate() {
            let curve_t = |ft: f32| seg.ta + ft * (seg.tb - seg.ta);
            if splits[i].is_empty() {
                result.push(*seg);
                continue;
            }
            let mut pts = splits[i].clone();
            pts.sort_by_key(|(t, _)| OrderedFloat(*t));
            let mut prev = seg.a;
            let mut prev_ct = seg.ta;
            let (lo, hi) = (seg.ta.min(seg.tb), seg.ta.max(seg.tb));
            for (ft, pt) in &pts {
                // The parameter of a split, asked of the curve rather than
                // assumed from the chord.
                //
                // Position along a chord is not proportional to the parameter
                // that produced it: a cubic with handles anywhere but the thirds
                // sweeps its parameter unevenly, and a straight one flattens to a
                // SINGLE chord spanning the whole range, so the assumption is
                // applied at full length with nothing to bound the error. On the
                // reported drawing that put a fragment's parameter 10.25 units
                // away from the fragment's own endpoint. Everything downstream
                // then reconstructs the wrong stretch of curve — a boundary that
                // wanders off the artwork, which is the shape of this whole bug.
                let linear = curve_t(*ft);
                let ct = self
                    .curves
                    .get(seg.curve as usize)
                    .and_then(|cv| {
                        let (t, q) = refine_closest_point(cv, *pt, linear)?;
                        ((q - *pt).length() < 0.05 && t >= lo && t <= hi).then_some(t)
                    })
                    .unwrap_or(linear);
                if (*pt - prev).length() > 1e-6 {
                    result.push(FlatSeg { a: prev, b: *pt, node: seg.node, group: seg.group, curve: seg.curve, ta: prev_ct, tb: ct });
                }
                prev = *pt;
                prev_ct = ct;
            }
            if (seg.b - prev).length() > 1e-6 {
                result.push(FlatSeg { a: prev, b: seg.b, node: seg.node, group: seg.group, curve: seg.curve, ta: prev_ct, tb: seg.tb });
            }
        }
        result
    }

    /// Resolve every fragment endpoint to a vertex, merging points that are
    /// within tolerance of each other.
    ///
    /// ## Why the *nearest* one, and why ties go to the lowest id
    ///
    /// This used to take the first vertex it found within tolerance while
    /// walking `self.vertices` — a `HashMap`, whose iteration order changes with
    /// the process hash seed. Wherever two existing vertices were both in range,
    /// which one absorbed the point was decided by that seed, so the same
    /// drawing arranged differently from one run to the next: usually the same,
    /// occasionally a region that closed before now leaked into its neighbour and
    /// stopped being paintable at all. It reproduced as a fuzz seed that failed
    /// roughly one run in three with no code change between them, and it is the
    /// most likely explanation for a document that paints correctly once and
    /// wrongly after a reload.
    ///
    /// Nearest-wins is both deterministic and the better answer — a point
    /// belongs to the junction it is closest to — and the id tie-break settles
    /// exact ties, which coincident geometry produces constantly. The result now
    /// depends only on the fragment order, which is built from the scene in
    /// document order.
    ///
    /// The grid is what keeps that affordable: cells are one tolerance wide, so
    /// everything within reach of a point lives in the nine cells around it, and
    /// a document with thousands of crossings no longer costs a full scan per
    /// endpoint.
    fn build_vertices(&mut self, segments: Vec<FlatSeg>) -> Vec<RemFlat> {
        let tolerance = self.gap_tolerance;
        let tol2 = tolerance * tolerance;
        // Exact-position dedup keyed by (position, group), which is what catches
        // coincident points when the tolerance is zero.
        let mut vertex_map: HashMap<(OrderedVec2, u32), u32> = HashMap::new();
        // Vertex ids by grid cell, per group: two groups' coincident points must
        // stay distinct so their graphs don't fuse.
        let mut grid: HashMap<(i32, i32, u32), Vec<u32>> = HashMap::new();
        let cell = tolerance.max(1e-4);
        let cell_of = |p: Vec2| ((p.x / cell).floor() as i32, (p.y / cell).floor() as i32);

        let get_or_create_vertex = |pos: Vec2,
                                        group: u32,
                                        tol2: f32,
                                        vn: &mut VectorNetwork,
                                        vmap: &mut HashMap<(OrderedVec2, u32), u32>,
                                        grid: &mut HashMap<(i32, i32, u32), Vec<u32>>|
         -> u32 {
            let (cx, cy) = cell_of(pos);
            let mut best: Option<(f32, u32)> = None;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    let Some(ids) = grid.get(&(cx + dx, cy + dy, group)) else { continue };
                    for &id in ids {
                        let d2 = (vn.vertices[&id].position - pos).length_squared();
                        if d2 >= tol2 {
                            continue;
                        }
                        if best.is_none_or(|(bd, bid)| d2 < bd || (d2 == bd && id < bid)) {
                            best = Some((d2, id));
                        }
                    }
                }
            }
            if let Some((_, id)) = best {
                return id;
            }
            let key = (OrderedVec2(OrderedFloat(pos.x), OrderedFloat(pos.y)), group);
            if let Some(&id) = vmap.get(&key) {
                return id;
            }
            let id = vn.alloc_id();
            vn.vertices.insert(id, PlanarVertex {
                id,
                position: pos,
                outgoing_edges: Vec::new(),
                group,
            });
            vmap.insert(key, id);
            grid.entry((cx, cy, group)).or_default().push(id);
            id
        };

        // Two passes, and the order is the point.
        //
        // A merge keeps one position and discards the other, so whichever point
        // arrives first decides where the junction IS. Done in one pass, that is
        // whichever fragment happened to come first — and when a pen stroke ends
        // three quarters of a unit off the line it meets, the line gets dragged
        // to the stray end. The whole line then renders off its own path, and
        // every region bounded by it is painted along the wrong edge. That is
        // visible: a fill that runs parallel to the line it should sit on.
        //
        // An endpoint whose curve parameter is INTERIOR is a point the geometry
        // itself produced — a crossing, or where an open end met this curve — and
        // it lies on the curve exactly. Those go first and claim their positions.
        // Free ends merge into them afterwards, so what moves is the loose end,
        // which is the thing that was never precisely anywhere.
        // "Structural" means the artwork defines this point: a crossing, or a
        // joint between two segments of one path — the corner arc meeting the
        // side it runs into. Only a FREE end of an open path is exempt, and only
        // at the parameter where it is actually free.
        let free_ends: Vec<(bool, bool)> = self.curves.iter().map(|c| c.free_ends()).collect();
        let structural = |seg: &FlatSeg, t: f32, at_start: bool| -> bool {
            if t > 1e-4 && t < 1.0 - 1e-4 {
                return true; // interior: a split, and splits sit on the curve
            }
            match free_ends.get(seg.curve as usize).copied() {
                Some((free_at_0, free_at_1)) => {
                    if at_start { !free_at_0 } else { !free_at_1 }
                }
                None => true,
            }
        };
        // Structural points are held to a far tighter radius than free ends.
        //
        // The tolerance exists for one thing: a hand-drawn end that stops short
        // of what it meets. Applying it to everything makes it destructive —
        // two shapes whose outlines run within it, like a rounded rectangle and
        // a copy of itself a unit away, have their junctions fused, and the thin
        // region between them stops existing. What the drawing shows is a fill
        // crossing straight over a corner arc into the shape beyond it, because
        // the boundary that should have stopped it was merged away.
        //
        // So: geometry the artwork defines merges only when it genuinely
        // coincides, at flattening scale. Free ends still merge across the full
        // tolerance, because that is the case the tolerance was for. A wide
        // setting now closes gaps without deleting anything.
        let structural_tol2 = STRUCTURAL_MERGE_EPS * STRUCTURAL_MERGE_EPS;
        for seg in &segments {
            if structural(seg, seg.ta, seg.ta <= seg.tb) {
                get_or_create_vertex(seg.a, seg.group, structural_tol2, self, &mut vertex_map, &mut grid);
            }
            if structural(seg, seg.tb, seg.tb < seg.ta) {
                get_or_create_vertex(seg.b, seg.group, structural_tol2, self, &mut vertex_map, &mut grid);
            }
        }

        let mut remapped = Vec::new();
        for seg in &segments {
            let from = get_or_create_vertex(seg.a, seg.group, tol2, self, &mut vertex_map, &mut grid);
            let to = get_or_create_vertex(seg.b, seg.group, tol2, self, &mut vertex_map, &mut grid);
            if from != to {
                remapped.push(RemFlat { from, to, node: seg.node, group: seg.group, curve: seg.curve, ta: seg.ta, tb: seg.tb });
            }
        }
        remapped
    }

    fn create_half_edges(&mut self, segments: Vec<RemFlat>) {
        // Deduplicate: skip if we already have an edge from→to
        let mut seen: HashSet<(u32, u32)> = HashSet::new();

        for s in segments {
            let (from, to, source_node) = (s.from, s.to, s.node);
            if seen.contains(&(from, to)) || seen.contains(&(to, from)) {
                continue;
            }
            seen.insert((from, to));

            let e1_id = self.alloc_id();
            let e2_id = self.alloc_id();

            let from_pos = self.vertices[&from].position;
            let to_pos = self.vertices[&to].position;

            // Forward half-edge carries the fragment oriented from→to; the twin
            // carries the reverse (tb→ta) so its reconstruction runs backwards.
            self.edges.insert(e1_id, PlanarEdge {
                id: e1_id,
                from_vertex: from,
                to_vertex: to,
                polyline: vec![from_pos, to_pos],
                source_node,
                twin: e2_id,
                face: None,
                synthetic: false,
                group: s.group,
                frag: Some(Frag { curve: s.curve, ta: s.ta, tb: s.tb }),
            });

            // Backward half-edge (twin)
            self.edges.insert(e2_id, PlanarEdge {
                id: e2_id,
                from_vertex: to,
                to_vertex: from,
                polyline: vec![to_pos, from_pos],
                source_node,
                twin: e1_id,
                face: None,
                synthetic: false,
                group: s.group,
                frag: Some(Frag { curve: s.curve, ta: s.tb, tb: s.ta }),
            });

            // Register outgoing edges at vertices
            if let Some(v) = self.vertices.get_mut(&from) {
                v.outgoing_edges.push(e1_id);
            }
            if let Some(v) = self.vertices.get_mut(&to) {
                v.outgoing_edges.push(e2_id);
            }
        }
    }

    /// Create a half-edge pair `from`↔`to` and register them at both vertices.
    /// Unlike `create_half_edges` this does no dedup — callers ensure uniqueness.
    fn add_half_edge_pair(&mut self, from: u32, to: u32, source_node: u32, synthetic: bool) {
        let e1 = self.alloc_id();
        let e2 = self.alloc_id();
        let from_pos = self.vertices[&from].position;
        let to_pos = self.vertices[&to].position;
        let group = self.vertices.get(&from).map(|v| v.group).unwrap_or(0);
        self.edges.insert(e1, PlanarEdge {
            id: e1, from_vertex: from, to_vertex: to,
            polyline: vec![from_pos, to_pos], source_node, twin: e2, face: None, synthetic, group, frag: None,
        });
        self.edges.insert(e2, PlanarEdge {
            id: e2, from_vertex: to, to_vertex: from,
            polyline: vec![to_pos, from_pos], source_node, twin: e1, face: None, synthetic, group, frag: None,
        });
        self.vertices.get_mut(&from).unwrap().outgoing_edges.push(e1);
        self.vertices.get_mut(&to).unwrap().outgoing_edges.push(e2);
    }

    /// Split the undirected edge `eid` at `pos`, inserting a new vertex there.
    /// Returns the new vertex id. The two resulting sub-edges keep the original
    /// edge's `source_node`/`synthetic` flags.
    fn split_edge_at(&mut self, eid: u32, pos: Vec2) -> u32 {
        let e = self.edges[&eid].clone();
        let (from, to, twin) = (e.from_vertex, e.to_vertex, e.twin);
        // Remove both half-edges and unregister them from their vertices.
        self.edges.remove(&eid);
        self.edges.remove(&twin);
        if let Some(v) = self.vertices.get_mut(&from) { v.outgoing_edges.retain(|&x| x != eid); }
        if let Some(v) = self.vertices.get_mut(&to) { v.outgoing_edges.retain(|&x| x != twin); }
        // New vertex at the split point (inherits the split edge's group).
        let nv = self.alloc_id();
        self.vertices.insert(nv, PlanarVertex { id: nv, position: pos, outgoing_edges: Vec::new(), group: e.group });
        self.add_half_edge_pair(from, nv, e.source_node, e.synthetic);
        self.add_half_edge_pair(nv, to, e.source_node, e.synthetic);
        nv
    }

    /// The gap-closing distance in force for a Live Paint group: the group's own
    /// setting when it has one, otherwise the document default.
    fn gap_distance_for(&self, group: u32) -> f32 {
        self.group_gap.get(&group).copied().unwrap_or(self.gap_bridge_distance)
    }

    /// Would a bridge from `a` to `b` cross existing geometry in `group`?
    ///
    /// At the small tolerances this feature launched with the answer was almost
    /// always no, so the question went unasked. It stops being rhetorical once
    /// the tolerance is wide enough to reach past a neighbouring contour: a
    /// bridge laid across an existing edge breaks planarity, and the face walk
    /// downstream then carves regions that do not match what is on screen.
    /// Rejecting those candidates is what lets the tolerance go up safely.
    /// `ignore_v` are the bridge's own attachment vertices — an edge that ends
    /// where the bridge ends is touched, not crossed. `ignore_e` is the edge the
    /// bridge lands *on* (and its twin), when it lands mid-edge.
    fn bridge_crosses(
        &self, a: Vec2, b: Vec2, group: u32, ignore_v: &[u32], ignore_e: Option<u32>,
    ) -> bool {
        let (lo, hi) = (a.min(b), a.max(b));
        for (&eid, e) in &self.edges {
            if e.twin < eid || e.group != group { continue; }
            if ignore_e.is_some_and(|x| x == eid || x == e.twin) { continue; }
            if ignore_v.contains(&e.from_vertex) || ignore_v.contains(&e.to_vertex) { continue; }
            let p = self.vertices[&e.from_vertex].position;
            let q = self.vertices[&e.to_vertex].position;
            // Cheap bounding-box reject first — most edges are nowhere near.
            if p.x.min(q.x) > hi.x || p.x.max(q.x) < lo.x { continue; }
            if p.y.min(q.y) > hi.y || p.y.max(q.y) < lo.y { continue; }
            if segment_intersection(a, b, p, q).is_some() {
                return true;
            }
        }
        false
    }

    /// Close gaps by bridging dangling open ends (degree-1 vertices) to the
    /// nearest vertex or edge within the group's gap distance, via synthetic
    /// edges. Greedy: once a vertex is bridged it is no longer dangling, so a
    /// facing pair of open ends is joined by exactly one bridge.
    fn bridge_gaps(&mut self) {
        // Deterministic processing order (HashMap iteration is not stable).
        let mut dangling: Vec<u32> = self.vertices.values()
            .filter(|v| v.outgoing_edges.len() == 1)
            .map(|v| v.id)
            .collect();
        dangling.sort_unstable();

        for vid in dangling {
            // Skip if a prior bridge already resolved this open end.
            let out = match self.vertices.get(&vid) {
                Some(v) if v.outgoing_edges.len() == 1 => v.outgoing_edges[0],
                _ => continue,
            };
            let vpos = self.vertices[&vid].position;
            let vgrp = self.vertices[&vid].group;
            // The snapping tolerance is a floor here, not just the user's Gaps
            // setting.
            //
            // Those two say different things. Gaps is "close holes up to this
            // wide, on purpose". The tolerance says "points this close are meant
            // to be the same point" — and that claim has to be honoured for a
            // DANGLING end, or a line that stops a third of a unit short of the
            // line it meets leaves the region it was drawn to close hanging open,
            // and the area inside it cannot be painted separately at all.
            //
            // It is safe here in a way that merging is not, because a dangling
            // end is a terminal: nothing continues past it, so attaching it adds
            // a boundary instead of destroying one. Two shapes running parallel
            // within the tolerance have joints, not terminals, and are untouched
            // — which is what keeps a thin region between two shapes alive.
            let max_d = self.gap_distance_for(vgrp).max(self.gap_tolerance);
            if max_d <= 0.0 { continue; }
            let max_d2 = max_d * max_d;
            let neighbor = self.edges[&out].to_vertex;

            // Candidate vertices, nearest first (lower id wins ties for
            // determinism). Sorted rather than reduced to a single best because
            // the nearest one may be rejected for crossing something.
            let mut cand_v: Vec<(u32, f32)> = self.vertices.iter()
                .filter(|(&uid, u)| uid != vid && uid != neighbor && u.group == vgrp)
                .filter_map(|(&uid, u)| {
                    let d2 = (u.position - vpos).length_squared();
                    (d2 <= max_d2 && d2 >= 1e-6).then_some((uid, d2))
                })
                .collect();
            cand_v.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.cmp(&b.0)));

            // Candidate interior points on non-incident edges (one per twin pair).
            let mut cand_e: Vec<(u32, f32, Vec2)> = self.edges.iter()
                .filter(|(&eid, e)| e.twin >= eid && e.group == vgrp
                    && e.from_vertex != vid && e.to_vertex != vid)
                .filter_map(|(&eid, e)| {
                    let a = self.vertices[&e.from_vertex].position;
                    let b = self.vertices[&e.to_vertex].position;
                    let (proj, t) = project_point_to_segment(vpos, a, b);
                    if t <= 1e-3 || t >= 1.0 - 1e-3 { return None; } // endpoint → vertex case
                    let d2 = (proj - vpos).length_squared();
                    (d2 <= max_d2 && d2 >= 1e-6).then_some((eid, d2, proj))
                })
                .collect();
            cand_e.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.cmp(&b.0)));

            // Merge the two candidate lists by distance and take the first that
            // can be reached without crossing anything.
            let (mut iv, mut ie) = (0usize, 0usize);
            loop {
                let dv = cand_v.get(iv).map(|c| c.1);
                let de = cand_e.get(ie).map(|c| c.1);
                match (dv, de) {
                    (None, None) => break,
                    (Some(d), other) if other.map_or(true, |o| d <= o) => {
                        let (uid, _) = cand_v[iv];
                        iv += 1;
                        // The two endpoints are the bridge's own attachment
                        // points — touching them is not a crossing.
                        if self.bridge_crosses(vpos, self.vertices[&uid].position, vgrp, &[vid, uid], None) {
                            continue;
                        }
                        self.add_half_edge_pair(vid, uid, SYNTHETIC_SOURCE, true);
                        break;
                    }
                    _ => {
                        let (eid, _, proj) = cand_e[ie];
                        ie += 1;
                        // Only the landing edge is exempt: ignoring everything
                        // incident to it let bridges through that crossed real
                        // geometry on the way there.
                        if self.bridge_crosses(vpos, proj, vgrp, &[vid], Some(eid)) {
                            continue;
                        }
                        let nv = self.split_edge_at(eid, proj);
                        self.add_half_edge_pair(vid, nv, SYNTHETIC_SOURCE, true);
                        break;
                    }
                }
            }
        }
    }

    fn sort_edges_radially(&mut self) {
        let edge_angles: HashMap<u32, f64> = self.edges.iter().map(|(&eid, e)| {
            let from_pos = self.vertices[&e.from_vertex].position;
            let to_pos = self.vertices[&e.to_vertex].position;
            let d = to_pos - from_pos;
            let angle = (d.y as f64).atan2(d.x as f64);
            (eid, angle)
        }).collect();

        for v in self.vertices.values_mut() {
            v.outgoing_edges.sort_by(|a, b| {
                let angle_a = edge_angles.get(a).copied().unwrap_or(0.0);
                let angle_b = edge_angles.get(b).copied().unwrap_or(0.0);
                angle_a.partial_cmp(&angle_b).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }

    /// Drop out-and-back excursions from a face walk.
    ///
    /// A dangling end — an open path that stops inside a region, or a line whose
    /// tip does not quite reach the shape it looks like it meets — has the same
    /// face on both sides, so the boundary walk goes out along it and comes
    /// straight back. That is correct traversal and wrong geometry: the pair
    /// encloses nothing, and leaving it in the outline hangs a zero-area spike
    /// off the filled region. Where the stub is curved the spike is a curve
    /// wandering into the middle of a region that has no boundary there, which
    /// is what it looks like on screen.
    ///
    /// It is not only cosmetic. The polygon built from this list is what
    /// `representative_point` and `polygon_centroid` run on, so a spur can drag
    /// a region's identity point onto a line — or outside the region entirely —
    /// and that point is what re-attaches a fill after every rebuild.
    ///
    /// Removing an `e, twin(e)` pair can expose another one underneath (a spur
    /// hanging off a spur), so this collapses repeatedly, and finally across the
    /// seam, because the walk is a cycle with no privileged first edge.
    fn prune_spurs(&self, edges: &[u32]) -> Vec<u32> {
        let twin_of = |eid: u32| self.edges.get(&eid).map(|e| e.twin);
        let mut out: Vec<u32> = Vec::with_capacity(edges.len());
        for &eid in edges {
            if out.last().copied().and_then(twin_of) == Some(eid) {
                out.pop();
                continue;
            }
            out.push(eid);
        }
        while out.len() >= 2 && twin_of(out[out.len() - 1]) == Some(out[0]) {
            out.pop();
            out.remove(0);
        }
        out
    }

    fn detect_faces(&mut self) {
        let mut visited: HashSet<u32> = HashSet::new();
        // Sorted, so a document's faces come out with the same ids every time it
        // is arranged. The set of faces does not depend on where the walks start,
        // but their ids do, and reproducible ids are what make a wrong region
        // possible to chase across runs.
        let mut edge_ids: Vec<u32> = self.edges.keys().copied().collect();
        edge_ids.sort_unstable();

        for start_edge_id in edge_ids {
            if visited.contains(&start_edge_id) {
                continue;
            }

            let mut face_edges = Vec::new();
            let mut current = start_edge_id;
            let max_steps = self.edges.len() + 1;
            let mut steps = 0;

            loop {
                if visited.contains(&current) && !face_edges.is_empty() {
                    // If we hit a visited edge that's our start, we found a face
                    if current == start_edge_id {
                        break;
                    }
                    // Otherwise this path leads nowhere useful
                    face_edges.clear();
                    break;
                }

                visited.insert(current);
                face_edges.push(current);

                // Get the twin of current edge, then find next edge CCW at that vertex
                let edge = match self.edges.get(&current) {
                    Some(e) => e.clone(),
                    None => break,
                };
                let twin_id = edge.twin;
                let twin = match self.edges.get(&twin_id) {
                    Some(e) => e.clone(),
                    None => break,
                };

                // At the vertex where twin starts (= edge.to_vertex), find the next edge
                // after twin in the radial order (this implements the left-hand turn rule)
                let vertex = match self.vertices.get(&twin.from_vertex) {
                    Some(v) => v,
                    None => break,
                };

                let twin_pos = vertex.outgoing_edges.iter().position(|&e| e == twin_id);
                current = match twin_pos {
                    Some(pos) => {
                        // Next edge in CW order = previous in our CCW-sorted list
                        let n = vertex.outgoing_edges.len();
                        if n == 0 { break; }
                        let next_idx = (pos + n - 1) % n;
                        vertex.outgoing_edges[next_idx]
                    }
                    None => break,
                };

                steps += 1;
                if steps > max_steps {
                    face_edges.clear();
                    break;
                }
            }

            if face_edges.len() >= 3 {
                // The walk records what it traversed, which includes going out
                // along every dangling end inside this face and back. Those
                // excursions are not boundary — see `prune_spurs`.
                let outline_edges = self.prune_spurs(&face_edges);
                if outline_edges.len() < 3 {
                    continue;
                }

                // Build boundary polygon
                let mut polygon = Vec::new();
                for &eid in &outline_edges {
                    if let Some(e) = self.edges.get(&eid) {
                        let pos = self.vertices[&e.from_vertex].position;
                        polygon.push([pos.x, pos.y]);
                    }
                }

                let area = signed_polygon_area(&polygon);
                let face_id = self.alloc_id();
                // All boundary edges share one group (graph is partitioned).
                let group = face_edges.first()
                    .and_then(|eid| self.edges.get(eid))
                    .map(|e| e.group)
                    .unwrap_or(0);

                let face = PlanarFace {
                    id: face_id,
                    boundary_edges: outline_edges,
                    holes: Vec::new(),
                    hole_polygons: Vec::new(),
                    fill: None,
                    boundary_polygon: polygon,
                    signed_area: area,
                    is_outer: area < 0.0, // CW winding = outer face
                    group,
                    signature: Vec::new(), // filled in by compute_face_signatures
                };

                // Assign the face to every edge the WALK visited, spurs included:
                // a stub is still part of this region for painting and for
                // `query_edge_at`, it just is not part of the region's outline.
                for &eid in &face_edges {
                    if let Some(e) = self.edges.get_mut(&eid) {
                        e.face = Some(face_id);
                    }
                }

                self.faces.insert(face_id, face);
            }
        }
    }

    /// Re-attach fills to the freshly-detected faces.
    ///
    /// Matching is two-tier:
    ///   1. **Signature** — a face contained by the exact same set of closed
    ///      shapes is the same region, no matter how far it moved or reshaped.
    ///      Ties (several regions share a signature) break by nearest centroid.
    ///   2. **Containment** — the stored point still lies inside a face. Survives
    ///      the outline changing shape under the fill, which a distance match
    ///      does not: a file painted before dangling ends stopped polluting face
    ///      polygons carries centroids pulled toward those stubs.
    ///   3. **Centroid fallback** — when neither matches (topology changed, or a
    ///      pre-v6 file with no stored signature), attach to the nearest
    ///      unclaimed face within `FILL_REMAP_THRESHOLD`, else drop the fill.
    ///
    /// `old_filled` are the fills from before this rebuild; `pending_fills` are
    /// fills loaded from a file/undo snapshot. Both are placed here.
    fn remap_fills(&mut self, old_filled: Vec<(u32, Vec<u32>, Vec2, Paint)>) {
        // `ANY_GROUP` is for fills read from a file: they predate this
        // arrangement and carry no group, so they may land wherever they fit.
        // A fill lifted from a live face keeps its group and may only return to
        // one — two Live Paint groups are independent surfaces, and a colour
        // crossing from one to the other is never the right answer, however
        // close the geometry happens to be.
        const ANY_GROUP: u32 = u32::MAX;
        let to_place: Vec<(u32, Vec<u32>, Vec2, Paint)> = old_filled.into_iter()
            .chain(self.pending_fills.drain(..)
                .map(|pf| (ANY_GROUP, pf.signature, pf.centroid, pf.color)))
            .collect();
        if to_place.is_empty() {
            return;
        }

        // Precompute candidate faces once: (id, signature, centroid).
        // Ordered by id: every tier below walks this list, and two faces that
        // are equally good a match must not be separated by which one the map
        // happened to yield first.
        let mut all_candidates: Vec<(u32, u32, Vec<u32>, Vec2)> = self.faces.values()
            .filter(|f| !f.is_outer)
            // Interior points on both sides, so "nearest" compares like with
            // like and a concave face is represented by somewhere it actually is.
            .map(|f| (f.id, f.group, f.signature.clone(), representative_point(&f.boundary_polygon)))
            .collect();
        all_candidates.sort_by_key(|(fid, _, _, _)| *fid);

        let mut taken: HashSet<u32> = HashSet::new();
        for (fill_group, sig, centroid, color) in &to_place {
            let candidates: Vec<(u32, Vec<u32>, Vec2)> = all_candidates.iter()
                .filter(|(_, fgroup, _, _)| *fill_group == ANY_GROUP || fgroup == fill_group)
                .map(|(id, _, s, c)| (*id, s.clone(), *c))
                .collect();
            let mut best: Option<(u32, f32)> = None;

            // Tier 1: exact signature match (distance-independent).
            if !sig.is_empty() {
                for (fid, csig, ccent) in &candidates {
                    if taken.contains(fid) || csig != sig {
                        continue;
                    }
                    let d = (*centroid - *ccent).length();
                    if best.is_none_or(|(bid, bd)| d < bd || (d == bd && *fid < bid)) {
                        best = Some((*fid, d));
                    }
                }
            }

            // Tier 2: the stored point lies INSIDE a candidate. Containment beats
            // distance whenever the outline itself changed shape between the save
            // and this load — which is exactly what happened when face walks
            // stopped recording excursions out along dangling ends. A stub drags
            // the centroid of the polygon it pollutes toward itself, so a file
            // painted before that fix carries points tens of units from where the
            // same region's centre now computes, and a purely distance-based
            // match would hand the fill to a neighbour or drop it. The point was
            // inside its region when it was written and it still is; that is the
            // durable fact, so use it. Faces partition the plane within a group,
            // so at most one can claim the point.
            //
            // Only for a fill with NO signature. One with a signature already has
            // a better answer above, and letting containment speak for it breaks
            // something this depends on: when two shapes separate, the fill in
            // their vanished overlap must DROP rather than move. Its stored point
            // still lands inside whichever shape it used to sit in, so
            // containment would happily rescue a region that no longer exists.
            // A signature-less fill has no such story — the region it names is
            // bounded by open lines, contained by nothing, and the point is the
            // only evidence there is.
            if best.is_none() && sig.is_empty() {
                for (fid, _, _) in &candidates {
                    if taken.contains(fid) {
                        continue;
                    }
                    let inside = self.faces.get(fid).is_some_and(|f| {
                        point_in_polygon(&[centroid.x, centroid.y], &f.boundary_polygon)
                    });
                    if inside {
                        best = Some((*fid, 0.0));
                        break;
                    }
                }
            }

            // Tier 3: nearest centroid within threshold. To avoid a fill bleeding
            // onto an unrelated region (e.g. its defining shapes were deleted),
            // a candidate must still share at least one defining shape with the
            // old fill. Legacy fills with no signature fall back to pure centroid.
            if best.is_none() {
                for (fid, csig, ccent) in &candidates {
                    if taken.contains(fid) {
                        continue;
                    }
                    let shares_shape = sig.is_empty()
                        || csig.iter().any(|n| sig.contains(n));
                    if !shares_shape {
                        continue;
                    }
                    let d = (*centroid - *ccent).length();
                    if d <= FILL_REMAP_THRESHOLD
                        && best.is_none_or(|(bid, bd)| d < bd || (d == bd && *fid < bid))
                    {
                        best = Some((*fid, d));
                    }
                }
            }

            if let Some((fid, _)) = best {
                taken.insert(fid);
                if let Some(face) = self.faces.get_mut(&fid) {
                    face.fill = Some(color.clone());
                }
            }
        }
    }

    /// Hand each island's boundary to the face that surrounds it.
    ///
    /// The face walk yields one cycle per face, so a region with an island in it
    /// comes out as two pieces: the region (bounded by its outer cycle) and the
    /// island's cycle, wound the other way and therefore classified "outer" and
    /// thrown away. Nothing then told the region that a hole was punched in it,
    /// and it painted over the island — an inner area that looks unpaintable
    /// however often you click it.
    ///
    /// A clockwise cycle is an island of whichever face contains it, and the
    /// SMALLEST containing face is the one it actually bounds: with nested
    /// shapes, every ancestor contains the ring, but only the innermost has it
    /// as a boundary. The one cycle contained by nothing is the true unbounded
    /// face, and it keeps its role.
    fn attach_holes(&mut self) {
        // (ring id, its polygon, a point on it, its area) for every clockwise cycle.
        let islands: Vec<(u32, Vec<[f32; 2]>, [f32; 2], f64)> = self
            .faces
            .values()
            .filter(|f| f.is_outer && !f.boundary_polygon.is_empty())
            .map(|f| {
                let p = polygon_centroid(&f.boundary_polygon);
                (f.id, f.boundary_polygon.clone(), [p.x, p.y], f.signed_area.abs())
            })
            .collect();

        // Candidate parents, smallest first, so the innermost wins.
        let mut parents: Vec<(u32, f64)> = self
            .faces
            .values()
            .filter(|f| !f.is_outer)
            .map(|f| (f.id, f.signed_area.abs()))
            .collect();
        parents.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));

        let mut assign: Vec<(u32, u32)> = Vec::new(); // (parent, island)
        for (island, poly, probe, island_area) in &islands {
            let parent = parents.iter().find(|(pid, parea)| {
                // Bigger than the island, and containing it. The centroid of a
                // ring is not guaranteed to be inside the ring itself, but it is
                // reliably inside the PARENT either way, which is what is being
                // tested here.
                parea > island_area
                    && self.faces.get(pid).is_some_and(|f| {
                        point_in_polygon(probe, &f.boundary_polygon)
                            && poly.iter().all(|v| point_in_polygon(v, &f.boundary_polygon))
                    })
            });
            if let Some((pid, _)) = parent {
                assign.push((*pid, *island));
            }
        }

        for (parent, island) in assign {
            let ring = self.faces.get(&island).map(|f| (f.boundary_edges.clone(), f.boundary_polygon.clone()));
            if let (Some((edges, poly)), Some(face)) = (ring, self.faces.get_mut(&parent)) {
                face.holes.push(edges);
                face.hole_polygons.push(poly);
            }
        }
    }

    /// Query which face contains the given point.
    pub fn query_face_at(&self, x: f32, y: f32) -> Option<u32> {
        self.query_face_at_in_group(x, y, None)
    }

    /// The same query, optionally confined to ONE Live Paint group.
    ///
    /// Groups are independent surfaces that can overlap on screen, so "which
    /// region of THIS group is under the cursor" is not answerable by the
    /// smallest face overall — that can belong to the group next door.
    pub fn query_face_at_in_group(&self, x: f32, y: f32, group: Option<u32>) -> Option<u32> {
        let point = [x, y];
        // Find the smallest non-outer face containing the point
        // Smallest containing face wins — a region nested inside another is the
        // one under the cursor — and an exact tie goes to the lower id rather
        // than to whichever the map yielded first, so the same click always
        // paints the same region.
        let mut best: Option<(u32, f64)> = None;
        for (fid, face) in &self.faces {
            if face.is_outer {
                continue;
            }
            if group.is_some_and(|g| face.group != g) {
                continue;
            }
            if point_in_polygon(&point, &face.boundary_polygon)
                && !face.hole_polygons.iter().any(|h| point_in_polygon(&point, h))
            {
                let area = face.signed_area.abs();
                if best.is_none_or(|(bid, ba)| area < ba || (area == ba && *fid < bid)) {
                    best = Some((*fid, area));
                }
            }
        }
        best.map(|(id, _)| id)
    }
}

// ─── Geometry Helpers ──────────────────────────────────────────────────────────

#[derive(Hash, Eq, PartialEq, Clone)]
struct OrderedVec2(OrderedFloat<f32>, OrderedFloat<f32>);

/// A source node's world-space outline, grouped for containment testing.
struct NodeOutline {
    segments: Vec<(Vec2, Vec2)>,
    /// True when the segments form closed loop(s) — only then is "inside" defined.
    closed: bool,
    /// The Live Paint group this node belongs to (containment is same-group).
    group: u32,
}

/// Group raw scene segments by source node into outlines, flagging which ones
/// are closed (every endpoint has even degree ⇒ the outline forms loops).
fn build_node_outlines(segments: &[FlatSeg]) -> HashMap<u32, NodeOutline> {
    let mut by_node: HashMap<u32, (Vec<(Vec2, Vec2)>, u32)> = HashMap::new();
    for s in segments {
        let e = by_node.entry(s.node).or_insert_with(|| (Vec::new(), s.group));
        e.0.push((s.a, s.b));
    }
    by_node.into_iter().map(|(node, (segs, group))| {
        let mut degree: HashMap<OrderedVec2, i32> = HashMap::new();
        for &(a, b) in &segs {
            *degree.entry(OrderedVec2(OrderedFloat(a.x), OrderedFloat(a.y))).or_insert(0) += 1;
            *degree.entry(OrderedVec2(OrderedFloat(b.x), OrderedFloat(b.y))).or_insert(0) += 1;
        }
        let closed = degree.values().all(|&d| d % 2 == 0);
        (node, NodeOutline { segments: segs, closed, group })
    }).collect()
}

/// Even-odd point-in-outline test via a horizontal ray cast to +x. Correct for
/// closed loops (including multiple subpaths / holes).
fn point_inside_segments(p: Vec2, segments: &[(Vec2, Vec2)]) -> bool {
    let mut crossings = 0u32;
    for &(a, b) in segments {
        // Does the edge straddle the horizontal line y = p.y?
        if (a.y > p.y) != (b.y > p.y) {
            let t = (p.y - a.y) / (b.y - a.y);
            let x = a.x + t * (b.x - a.x);
            if x > p.x {
                crossings += 1;
            }
        }
    }
    crossings % 2 == 1
}

/// A point guaranteed to lie inside the simple polygon. The centroid works for
/// convex faces; for concave ones it may fall outside, so fall back to the
/// midpoint of the first interior span on a horizontal scanline through it.
fn representative_point(polygon: &[[f32; 2]]) -> Vec2 {
    let c = polygon_centroid(polygon);
    if point_in_polygon(&[c.x, c.y], polygon) {
        return c;
    }
    // Scanline at the centroid's y: collect x-crossings, sorted, and take the
    // midpoint of the first inside span (between crossing 0 and 1).
    let y = c.y as f64;
    let n = polygon.len();
    let mut xs: Vec<f64> = Vec::new();
    for i in 0..n {
        let j = (i + 1) % n;
        let (y0, y1) = (polygon[i][1] as f64, polygon[j][1] as f64);
        if (y0 > y) != (y1 > y) {
            let t = (y - y0) / (y1 - y0);
            xs.push(polygon[i][0] as f64 + t * (polygon[j][0] as f64 - polygon[i][0] as f64));
        }
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if xs.len() >= 2 {
        Vec2::new(((xs[0] + xs[1]) * 0.5) as f32, c.y)
    } else {
        c
    }
}

/// Shortest distance from a point to a polyline (min over its segments).
fn point_to_polyline_distance(p: Vec2, polyline: &[Vec2]) -> f32 {
    if polyline.is_empty() {
        return f32::MAX;
    }
    if polyline.len() == 1 {
        return (p - polyline[0]).length();
    }
    let mut best = f32::MAX;
    for w in polyline.windows(2) {
        let (proj, _) = project_point_to_segment(p, w[0], w[1]);
        best = best.min((p - proj).length());
    }
    best
}

/// The point at half the arc length of a polyline — a stable interior marker
/// used as a logical edge's identity anchor.
pub(crate) fn polyline_midpoint(polyline: &[Vec2]) -> Vec2 {
    if polyline.is_empty() {
        return Vec2::ZERO;
    }
    if polyline.len() == 1 {
        return polyline[0];
    }
    let total: f32 = polyline.windows(2).map(|w| (w[1] - w[0]).length()).sum();
    let mut half = total * 0.5;
    for w in polyline.windows(2) {
        let seg = (w[1] - w[0]).length();
        if seg >= half {
            let t = if seg > 0.0 { half / seg } else { 0.0 };
            return w[0] + (w[1] - w[0]) * t;
        }
        half -= seg;
    }
    polyline[polyline.len() - 1]
}

/// Project `p` onto segment `a`→`b`, returning the closest point and its
/// clamped parameter `t` ∈ [0,1] (0 = at `a`, 1 = at `b`).
pub(crate) fn project_point_to_segment(p: Vec2, a: Vec2, b: Vec2) -> (Vec2, f32) {
    let ab = b - a;
    let len2 = ab.length_squared();
    if len2 < 1e-12 {
        return (a, 0.0);
    }
    let t = ((p - a).dot(ab) / len2).clamp(0.0, 1.0);
    (a + ab * t, t)
}

fn signed_polygon_area(polygon: &[[f32; 2]]) -> f64 {
    let n = polygon.len();
    if n < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        area += polygon[i][0] as f64 * polygon[j][1] as f64;
        area -= polygon[j][0] as f64 * polygon[i][1] as f64;
    }
    area * 0.5
}

fn polygon_centroid(polygon: &[[f32; 2]]) -> Vec2 {
    if polygon.is_empty() {
        return Vec2::ZERO;
    }
    let mut cx = 0.0_f32;
    let mut cy = 0.0_f32;
    for p in polygon {
        cx += p[0];
        cy += p[1];
    }
    let n = polygon.len() as f32;
    Vec2::new(cx / n, cy / n)
}

/// Winding number point-in-polygon test.
fn point_in_polygon(point: &[f32; 2], polygon: &[[f32; 2]]) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let mut winding = 0i32;
    let px = point[0] as f64;
    let py = point[1] as f64;
    for i in 0..n {
        let j = (i + 1) % n;
        let y0 = polygon[i][1] as f64;
        let y1 = polygon[j][1] as f64;
        if y0 <= py {
            if y1 > py {
                let x0 = polygon[i][0] as f64;
                let x1 = polygon[j][0] as f64;
                let cross = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
                if cross > 0.0 {
                    winding += 1;
                }
            }
        } else if y1 <= py {
            let x0 = polygon[i][0] as f64;
            let x1 = polygon[j][0] as f64;
            let cross = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
            if cross < 0.0 {
                winding -= 1;
            }
        }
    }
    winding != 0
}

// ─── Engine Integration ────────────────────────────────────────────────────────

impl Engine {
    /// Collect all path segments from visible nodes in world space, together
    /// with the source curve table for exact-bézier reconstruction.
    pub(crate) fn collect_segments(&self) -> (Vec<FlatSeg>, Vec<CurveSeg>) {
        let mut segments = Vec::new();
        let mut curves: Vec<CurveSeg> = Vec::new();
        // In paint order, not map order. The arrangement is built greedily —
        // whichever endpoint arrives first at a junction creates the vertex the
        // rest snap onto — so the order shapes get read in is part of the answer.
        // Reading them out of a `HashMap` made that order the process's hash
        // seed, and the same document could arrange one way now and another way
        // after a reload. Document order is stable, and it is the order the
        // drawing is drawn in.
        for id in self.draw_order() {
            let Some(node) = self.scene.nodes.get(&id) else { continue };
            if !node.visible {
                continue;
            }
            // A shape participates only if it lives inside a Live Paint group;
            // its `group` is the nearest such flagged ancestor. Groups are
            // independent — segments of different groups never split or merge.
            let group = match self.live_paint_group_of(id) {
                Some(g) => g,
                None => continue,
            };
            // A mask inside the group is coverage, not a paintable contour. Left
            // in, its outline carved regions out of the artwork and its interior
            // became a face the bucket would happily fill — so the mask painted
            // itself as artwork.
            if self.is_within_mask(id) {
                continue;
            }
            let transform = self.global_transforms.get(&id)
                .copied()
                .unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

            match &node.geometry {
                // Per-vertex rounding is resolved for the same reason a rect's is:
                // the surface must be the shape on screen, corners included.
                Geometry::Path { ref subpaths, .. } => {
                    let rounded;
                    let source = if subpaths.iter().any(|sp| sp.points.iter().any(|p| p.corner_radius > 1e-3)) {
                        rounded = crate::round_subpaths(subpaths);
                        &rounded
                    } else {
                        subpaths
                    };
                    for sp in source {
                        push_world_subpath(sp, &transform, id, group, &mut curves, &mut segments);
                    }
                }
                // A rounded rect has to enter the network ROUNDED. Emitting its
                // four sharp corners meant the surface disagreed with the drawing
                // the moment a rect was flagged: the corner arcs vanished and the
                // faces — which is what a Live Paint group renders instead of its
                // members' own fills — came back square.
                Geometry::Rect { width, height } if node.style.corner_radius > 1e-3 => {
                    for sp in &crate::round_subpaths(&crate::rect_subpaths(
                        *width, *height, node.style.corner_radius,
                    )) {
                        push_world_subpath(sp, &transform, id, group, &mut curves, &mut segments);
                    }
                }
                Geometry::Rect { width, height } => {
                    push_rect_curves(*width, *height, &transform, id, group, &mut curves, &mut segments);
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    push_ellipse_curves(*radius_x, *radius_y, &transform, id, group, &mut curves, &mut segments);
                }
                Geometry::Text { .. } => {} // Skip text
                Geometry::Image { .. } => {} // Skip images (no vector segments)
            }
        }
        (segments, curves)
    }

    /// The nearest `live_paint`-flagged ancestor group of `node` (or itself), or
    /// None if the node isn't inside any Live Paint group.
    pub(crate) fn live_paint_group_of(&self, node: u32) -> Option<u32> {
        let mut cur = Some(node);
        while let Some(id) = cur {
            if let Some(n) = self.scene.nodes.get(&id) {
                if n.live_paint {
                    return Some(id);
                }
                cur = n.parent;
            } else {
                break;
            }
        }
        None
    }

    /// True if `node` is `ancestor` or nested anywhere beneath it.
    pub(crate) fn is_descendant_of(&self, node: u32, ancestor: u32) -> bool {
        let mut cur = Some(node);
        while let Some(id) = cur {
            if id == ancestor {
                return true;
            }
            cur = self.scene.nodes.get(&id).and_then(|n| n.parent);
        }
        false
    }

    /// Per-group gap-closing distances, read off the Live Paint group nodes.
    /// Groups that have never been given one are absent, and fall back to the
    /// document default inside the rebuild.
    pub(crate) fn gap_overrides(&self) -> HashMap<u32, f32> {
        self.scene.nodes.values()
            .filter(|n| n.live_paint)
            .filter_map(|n| n.gap_bridge_distance.map(|d| (n.id, d.max(0.0))))
            .collect()
    }

    /// Ensure the vector network is up to date.
    pub(crate) fn ensure_network_clean(&mut self) {
        if self.scene.vector_network.dirty {
            let (segments, curves) = self.collect_segments();
            self.scene.vector_network.group_gap = self.gap_overrides();
            let group_transforms: HashMap<u32, [f32; 9]> = self
                .live_paint_group_ids()
                .into_iter()
                .filter_map(|g| self.global_transforms.get(&g).copied().map(|t| (g, t)))
                .collect();
            self.scene.vector_network.rebuild(segments, curves, &group_transforms);
            self.resolve_painted_edges();
        }
    }
}

// ─── Per-Node Vector Network ───────────────────────────────────────────────────

/// Per-node vector network — the graph-based path representation.
/// This is the editing source of truth; subpaths are derived from it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NodeVectorNetwork {
    pub vertices: Vec<NetworkVertex>,
    pub edges: Vec<NetworkEdge>,
    /// Enclosed regions with independent fill styles.
    #[serde(default)]
    pub regions: Vec<NetworkRegion>,
}

// NOTE: these structs are serialized to protobuf inside Scene snapshots
// (history/drag) and files. New fields need a serde default AND a new proto
// tag in proto.rs (never renumber existing tags).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkVertex {
    pub position: Vec2,
    /// Incoming control handle (absolute position). None = sharp corner.
    #[serde(default)]
    pub handle_in: Option<Vec2>,
    /// Outgoing control handle (absolute position). None = sharp corner.
    #[serde(default)]
    pub handle_out: Option<Vec2>,
    /// Parametric corner radius at this vertex (non-destructive rounding).
    #[serde(default)]
    pub corner_radius: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkEdge {
    pub start_vertex: u32,  // index into vertices
    pub end_vertex: u32,    // index into vertices
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkRegion {
    /// Ordered edge indices forming a closed loop.
    pub edge_loop: Vec<u32>,
    /// Fill style for this enclosed area.
    #[serde(default)]
    pub fill: Option<Color>,
}

impl Default for NodeVectorNetwork {
    fn default() -> Self {
        Self {
            vertices: Vec::new(),
            edges: Vec::new(),
            regions: Vec::new(),
        }
    }
}

impl NodeVectorNetwork {
    /// Convert traditional subpaths to a NodeVectorNetwork.
    pub fn from_subpaths(subpaths: &[Subpath]) -> Self {
        let mut vertices = Vec::new();
        let mut edges = Vec::new();

        for sp in subpaths {
            let base = vertices.len() as u32;
            for point in &sp.points {
                let position = Vec2::new(point.x, point.y);
                let handle_in = if (point.cp1 - position).length() > 0.001 {
                    Some(point.cp1)
                } else {
                    None
                };
                let handle_out = if (point.cp2 - position).length() > 0.001 {
                    Some(point.cp2)
                } else {
                    None
                };
                vertices.push(NetworkVertex {
                    position,
                    handle_in,
                    handle_out,
                    corner_radius: point.corner_radius,
                });
            }

            let count = sp.points.len() as u32;
            // Create edges between consecutive vertices
            for i in 0..count.saturating_sub(1) {
                edges.push(NetworkEdge {
                    start_vertex: base + i,
                    end_vertex: base + i + 1,
                });
            }
            // If closed, add closing edge from last to first vertex of this subpath
            if sp.closed && count >= 2 {
                edges.push(NetworkEdge {
                    start_vertex: base + count - 1,
                    end_vertex: base,
                });
            }
        }

        NodeVectorNetwork {
            vertices,
            edges,
            regions: Vec::new(),
        }
    }

    /// Convert the network back to subpaths.
    pub fn to_subpaths(&self) -> Vec<Subpath> {
        if self.edges.is_empty() {
            return Vec::new();
        }

        // Build adjacency map: start_vertex -> Vec<(end_vertex, edge_index)>
        let mut adjacency: HashMap<u32, Vec<(u32, usize)>> = HashMap::new();
        for (idx, edge) in self.edges.iter().enumerate() {
            adjacency.entry(edge.start_vertex).or_default().push((edge.end_vertex, idx));
        }

        let mut visited_edges: HashSet<usize> = HashSet::new();
        let mut subpaths = Vec::new();

        for start_edge_idx in 0..self.edges.len() {
            if visited_edges.contains(&start_edge_idx) {
                continue;
            }

            let mut walk = Vec::new();
            let start_vertex = self.edges[start_edge_idx].start_vertex;
            let mut current_vertex = start_vertex;
            let mut closed = false;

            // Walk the chain
            loop {
                // Find an unvisited edge from current_vertex
                let next = adjacency.get(&current_vertex).and_then(|neighbors| {
                    neighbors.iter().find(|(_, eidx)| !visited_edges.contains(eidx)).copied()
                });

                match next {
                    Some((end_vertex, edge_idx)) => {
                        visited_edges.insert(edge_idx);
                        if walk.is_empty() {
                            walk.push(current_vertex);
                        }
                        if end_vertex == start_vertex {
                            // Closed loop
                            closed = true;
                            break;
                        }
                        walk.push(end_vertex);
                        current_vertex = end_vertex;
                    }
                    None => {
                        // Dead end (open subpath)
                        if walk.is_empty() {
                            walk.push(current_vertex);
                        }
                        break;
                    }
                }
            }

            if walk.is_empty() {
                continue;
            }

            // Convert vertex indices to PathPoints
            let points: Vec<PathPoint> = walk.iter().filter_map(|&vi| {
                self.vertices.get(vi as usize).map(|v| {
                    PathPoint {
                        x: v.position.x,
                        y: v.position.y,
                        cp1: v.handle_in.unwrap_or(v.position),
                        cp2: v.handle_out.unwrap_or(v.position),
                        corner_radius: v.corner_radius,
                    }
                })
            }).collect();

            if !points.is_empty() {
                subpaths.push(Subpath { points, closed });
            }
        }

        subpaths
    }
}
