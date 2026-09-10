use wasm_bindgen::prelude::*;
use glam::{Mat3, Vec2, Vec3};
use serde::{Serialize, Deserialize};
use std::collections::{BTreeMap, HashMap, HashSet};

mod vector_network;
pub use vector_network::{VectorNetwork, NodeVectorNetwork, NetworkVertex, NetworkEdge, NetworkRegion};

mod container;
pub use container::{ContainerError, CONTAINER_VERSION};

mod validate;
pub use validate::RepairReport;

mod proto;
pub use proto::{FORMAT_VERSION, LoadError};

#[cfg(test)]
mod format_tests;

#[cfg(test)]
mod format_properties;

/// Largest absolute world coordinate the editor supports, on any axis.
///
/// Geometry is stored as `f32`, whose precision degrades with magnitude: the
/// gap between representable values is ~0.00006 units at 1e3, 0.0078 at 1e5,
/// 0.0625 at 1e6, and a full unit at 1e7. Past this limit, nudging a point by a
/// small amount would silently do nothing, and snapping would land visibly off
/// target. 1e6 keeps the worst-case step at 1/16 of a unit — imperceptible at
/// any usable zoom — while still being ~60× the largest artboard anyone sets up.
///
/// `validate::repair` clamps incoming documents to this range, so no file can
/// push the editor into the region where arithmetic stops behaving.
pub const MAX_COORD: f32 = 1.0e6;

/// Deepest group nesting the renderer will descend.
///
/// Recursion in wasm runs on a ~1 MB stack, so an unbounded walk traps the
/// instance — the editor dies, rather than reporting an error — at a depth well
/// below what a hostile (or merely broken) file can encode. No real artwork
/// nests anywhere near this far.
pub const MAX_NODE_DEPTH: u32 = 1024;
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

/// Log an error to the browser console (or stderr in native tests).
fn log_error(msg: &str) {
    #[cfg(target_arch = "wasm32")]
    console_error(msg);
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{}", msg);
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum NodeType {
    Path,
    Rect,
    Ellipse,
    Group,
    Text,
    Image,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

/// A named, resizable artboard (frame) placed on the infinite canvas.
///
/// Artboards are a scene-level list, NOT nodes — they never enter the render
/// buffer or hit-testing; the renderer draws them from `get_artboards_json`.
/// Their ids live in a separate space from node ids (they are only ever looked
/// up within `Scene.artboards`).
#[derive(Serialize, Deserialize, Clone)]
pub struct Artboard {
    pub id: u32,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    #[serde(default = "default_artboard_bg")]
    pub background: Color,
}

fn default_artboard_bg() -> Color { Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 } }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GradientStop {
    pub offset: f32,
    pub color: Color,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum GradientType {
    Linear,
    Radial,
}

/// Radial-gradient focal point (SVG fx/fy/fr). Absent = concentric (focal at
/// the center circle, focal radius 0), which is the common case.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GradientFocal {
    pub x: f32,
    pub y: f32,
    #[serde(default)]
    pub r: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Gradient {
    pub gradient_type: GradientType,
    pub stops: Vec<GradientStop>,
    /// Start point (linear: line start; radial: center) in node-local space.
    pub start_x: f32,
    pub start_y: f32,
    /// End point (linear: line end; radial: a point at `r` from the center).
    pub end_x: f32,
    pub end_y: f32,
    /// spreadMethod: 0 = pad (clamp), 1 = repeat, 2 = reflect.
    #[serde(default)]
    pub spread: u8,
    /// Radial focal point; `None` means concentric (focal = center, fr = 0).
    #[serde(default)]
    pub focal: Option<GradientFocal>,
    /// Optional gradient→local affine `[a, b, c, d, e, f]` (x' = a·x + c·y + e).
    /// When present the renderer applies it as the shader's local matrix and
    /// `start`/`end`/`focal` are raw gradient-space coordinates — this represents
    /// rotated / non-uniform (elliptical) radial gradients exactly. `None` keeps
    /// the baked circular/linear form (coords already in node-local space).
    #[serde(default)]
    pub transform: Option<[f32; 6]>,
}

/// A tiled-image pattern fill. The tile is an encoded image in `Scene.images`;
/// `width`/`height` are one repeat in node-local units. `transform` is a
/// pattern→local affine (SVG/Skia 2x3 as [a,b,c,d,e,f]); identity by default.
/// Vector `<pattern>` content is rasterized to the tile image at import time,
/// so the engine only ever deals with image tiles.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Pattern {
    pub image_id: u32,
    pub width: f32,
    pub height: f32,
    #[serde(default = "default_pattern_transform")]
    pub transform: [f32; 6],
}

fn default_pattern_transform() -> [f32; 6] { [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] }

/// Direction handles of a mesh vertex, in ABSOLUTE node-local coordinates.
/// `None` = auto: 1/3 of the way toward the neighboring vertex (straight edge).
/// Directions follow grid axes: e = +u (next column), w = -u, s = +v (next
/// row), n = -v. Outward-facing handles on boundary vertices are meaningless
/// and stay `None`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MeshHandles {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub e: Option<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<[f32; 2]>,
}

impl MeshHandles {
    fn is_empty(&self) -> bool {
        self.e.is_none() && self.w.is_none() && self.s.is_none() && self.n.is_none()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MeshVertex {
    pub x: f32,
    pub y: f32,
    pub color: Color,
    #[serde(default, skip_serializing_if = "MeshHandles::is_empty")]
    pub handles: MeshHandles,
}

/// Coons-patch mesh fill: a `rows`×`cols` grid of patches over node-local
/// space with `(rows+1)*(cols+1)` vertices stored row-major. Grid lines are
/// cubic béziers shaped by the vertex handles; each patch interpolates its
/// four corner colors. Rendered by the JS renderer (tessellation +
/// drawVertices) clipped to the node's fill path.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MeshGradient {
    pub rows: u32,
    pub cols: u32,
    pub vertices: Vec<MeshVertex>,
}

impl MeshGradient {
    /// Structural sanity: non-zero grid and a matching vertex count.
    pub fn is_valid(&self) -> bool {
        self.rows >= 1
            && self.cols >= 1
            && self.vertices.len() == ((self.rows + 1) * (self.cols + 1)) as usize
    }

    /// Area-mean of the vertex colors (used wherever a single representative
    /// color is needed: Live Paint sampling, old-format degradation, UI).
    pub fn mean_color(&self) -> Color {
        let n = self.vertices.len().max(1) as f32;
        let mut acc = [0.0f32; 4];
        for v in &self.vertices {
            acc[0] += v.color.r;
            acc[1] += v.color.g;
            acc[2] += v.color.b;
            acc[3] += v.color.a;
        }
        Color { r: acc[0] / n, g: acc[1] / n, b: acc[2] / n, a: acc[3] / n }
    }

    /// Map every anchor and stored handle through the bbox→bbox affine
    /// `p' = new_min + (p − old_min) · scale`. Used to keep a mesh glued to
    /// its shape when the GEOMETRY (not the transform) is resized/edited.
    pub fn map_bbox_affine(&mut self, ox: f32, oy: f32, sx: f32, sy: f32, nx: f32, ny: f32) {
        let map = |p: [f32; 2]| [nx + (p[0] - ox) * sx, ny + (p[1] - oy) * sy];
        for v in &mut self.vertices {
            let m = map([v.x, v.y]);
            v.x = m[0];
            v.y = m[1];
            for h in [&mut v.handles.e, &mut v.handles.w, &mut v.handles.s, &mut v.handles.n] {
                if let Some(p) = h {
                    *p = map(*p);
                }
            }
        }
    }

    /// Handle position for vertex `idx` toward `dir` (0=e, 1=w, 2=s, 3=n),
    /// materializing the auto default (1/3 toward the neighbor). For outward
    /// boundary directions there is no neighbor: returns the anchor itself.
    pub fn effective_handle(&self, idx: usize, dir: u8) -> [f32; 2] {
        let v = &self.vertices[idx];
        let stored = match dir {
            0 => v.handles.e,
            1 => v.handles.w,
            2 => v.handles.s,
            _ => v.handles.n,
        };
        if let Some(h) = stored {
            return h;
        }
        let stride = (self.cols + 1) as usize;
        let (row, col) = (idx / stride, idx % stride);
        let neighbor = match dir {
            0 if col < self.cols as usize => Some(idx + 1),
            1 if col > 0 => Some(idx - 1),
            2 if row < self.rows as usize => Some(idx + stride),
            3 if row > 0 => Some(idx - stride),
            _ => None,
        };
        match neighbor {
            Some(ni) => {
                let nv = &self.vertices[ni];
                [v.x + (nv.x - v.x) / 3.0, v.y + (nv.y - v.y) / 3.0]
            }
            None => [v.x, v.y],
        }
    }
}

/// A paint can be a solid color, a gradient, a tiled-image pattern, or a
/// Coons-patch mesh gradient.
/// Custom Serialize/Deserialize for JSON interchange with JS (`set_node_style`
/// sends a Style whose fills are bare color/gradient/pattern/mesh objects).
/// Snapshots and files go through protobuf (proto.rs), not serde, so there is
/// no positional codec to keep in lockstep here.
#[derive(Clone, Debug)]
pub enum Paint {
    Gradient(Gradient),
    Solid(Color),
    Pattern(Pattern),
    Mesh(MeshGradient),
}

impl serde::Serialize for Paint {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // JSON: serialize naturally so JS can read it
        match self {
            Paint::Solid(c) => c.serialize(serializer),
            Paint::Gradient(g) => g.serialize(serializer),
            Paint::Pattern(p) => p.serialize(serializer),
            Paint::Mesh(m) => m.serialize(serializer),
        }
    }
}

impl<'de> serde::Deserialize<'de> for Paint {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // JSON: distinguish by a discriminating field — Gradient has
        // `gradient_type`, Pattern has `image_id`, Mesh has `vertices`,
        // otherwise it's a bare Color.
        let value = serde_json::Value::deserialize(deserializer)?;
        if value.get("gradient_type").is_some() {
            let g: Gradient = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            Ok(Paint::Gradient(g))
        } else if value.get("image_id").is_some() {
            let p: Pattern = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            Ok(Paint::Pattern(p))
        } else if value.get("vertices").is_some() {
            let m: MeshGradient =
                serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            if !m.is_valid() {
                return Err(serde::de::Error::custom("mesh vertex count mismatch"));
            }
            Ok(Paint::Mesh(m))
        } else {
            let c: Color = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            Ok(Paint::Solid(c))
        }
    }
}

impl Paint {
    /// Extract solid color if this paint is solid, or the first gradient stop
    /// color, or a neutral gray for patterns.
    pub fn solid_color(&self) -> Color {
        match self {
            Paint::Solid(c) => c.clone(),
            Paint::Gradient(g) => g.stops.first()
                .map(|s| s.color.clone())
                .unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
            Paint::Pattern(_) => Color { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
            Paint::Mesh(m) => m.mean_color(),
        }
    }

    /// Check if this paint has any visible content (non-zero alpha).
    pub fn is_visible(&self) -> bool {
        match self {
            Paint::Solid(c) => c.a > 0.0,
            Paint::Gradient(g) => g.stops.iter().any(|s| s.color.a > 0.0),
            Paint::Pattern(_) => true,
            Paint::Mesh(m) => m.vertices.iter().any(|v| v.color.a > 0.0),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum StrokeAlignment {
    Center,
    Inner,
    Outer,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Stroke {
    pub paint: Option<Paint>,
    pub width: f32,
    pub cap: u8,
    pub join: u8,
    #[serde(default)]
    pub dash_array: Vec<f32>,
    #[serde(default)]
    pub dash_offset: f32,
    #[serde(default = "default_miter_limit")]
    pub miter_limit: f32,
    #[serde(default = "default_alignment")]
    pub alignment: StrokeAlignment,
}

fn default_miter_limit() -> f32 { 4.0 }
fn default_alignment() -> StrokeAlignment { StrokeAlignment::Center }

/// Decomposed local transform — THE source of truth; matrices are always derived.
/// Matrix = T(x,y) · R(rotation_deg) · K(skew_x_deg, skew_y_deg) · S(scale_x, scale_y)
///
/// The skew angles name the two EDGE DIRECTIONS directly, and both edges keep
/// unit length:
///   x-edge (local +X) points at  sky      degrees from horizontal
///   y-edge (local +Y) points at  90 - skx degrees from horizontal
///
/// so the combined shear is
///   K = [[cos(sky), sin(skx)],
///        [sin(sky), cos(skx)]]        det(K) = cos(skx + sky)
///
/// This differs from the CSS `tan`-based model, and from the earlier
/// sequential `Kx · Ky` form in which skx bled into the x-edge and shortened
/// it (a square at skx=60°, sky=-30° came out half as wide as it should be,
/// so isometric top faces never tiled without a manual resize).
///
/// The two axes are now genuinely independent: each edge's direction and
/// length depends on exactly one skew angle. That is what makes an isometric
/// cube fall out of skew alone, with no rotation and no rescaling:
///   left  face: sky = +30°
///   right face: sky = -30°
///   top   face: skx = +60°, sky = -30°
/// All three keep unit-length edges, so the faces share edges exactly and a
/// corner radius set on one face is identical on all three.
///
/// The single-axis cases are bit-identical to the previous model (set either
/// angle to 0 and the two agree), so existing documents that skew on one axis
/// are unaffected.
///
/// Degenerate case: the two edges become parallel when skx + sky = ±90°, which
/// `is_valid` rejects — the shape would collapse to a line.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Transform2D {
    pub x: f32,
    pub y: f32,
    pub rotation_deg: f32,
    pub skew_x_deg: f32,
    pub skew_y_deg: f32,
    pub scale_x: f32,
    pub scale_y: f32,
}

impl Transform2D {
    pub const IDENTITY: Self = Self {
        x: 0.0, y: 0.0,
        rotation_deg: 0.0,
        skew_x_deg: 0.0, skew_y_deg: 0.0,
        scale_x: 1.0, scale_y: 1.0,
    };

    pub fn from_translation(x: f32, y: f32) -> Self {
        Self { x, y, ..Self::IDENTITY }
    }

    /// Compose: M = T(x,y) · R(θ) · K · S
    ///
    /// K = [[cos(sky), sin(skx)],
    ///      [sin(sky), cos(skx)]]
    ///
    /// Column 0 (the x-edge) is the unit vector at angle `sky`; column 1 (the
    /// y-edge) is the unit vector at angle `90° - skx`. Each edge is governed
    /// by exactly one angle and neither is shortened by the other.
    ///
    /// det(K) = cos(skx + sky) — positive while |skx + sky| < 90°, zero at the
    /// boundary where the two edges become parallel.
    pub fn to_mat3(&self) -> Mat3 {
        // Fast path for the axis-aligned node: a pure scale + translate, and by
        // far the most common transform in a real document. Worth special-casing
        // because this runs for every node of a subtree on every transform
        // change (see `compute_global_transform_recursive`) and the general path
        // below costs six trig calls.
        //
        // Bit-identical to the general path, not an approximation: at exactly
        // zero, cos is 1.0 and sin is 0.0, so p/ckx collapse to 1 and ry/q to 0,
        // leaving precisely the matrix built here.
        if self.rotation_deg == 0.0 && self.skew_x_deg == 0.0 && self.skew_y_deg == 0.0 {
            return Mat3::from_cols(
                Vec3::new(self.scale_x, 0.0, 0.0),
                Vec3::new(0.0, self.scale_y, 0.0),
                Vec3::new(self.x, self.y, 1.0),
            );
        }
        let r = self.rotation_deg.to_radians();
        let cos_r = r.cos();
        let sin_r = r.sin();
        let skx = self.skew_x_deg.to_radians();
        let sky = self.skew_y_deg.to_radians();
        let sx = self.scale_x;
        let sy = self.scale_y;
        // K elements — each column is a unit edge direction set by one angle:
        let p   = sky.cos();  // [0,0]  x-edge  ┐ direction sky
        let ry  = sky.sin();  // [1,0]          ┘
        let q   = skx.sin();  // [0,1]  y-edge  ┐ direction 90° - skx
        let ckx = skx.cos();  // [1,1]          ┘
        // (R · K · S) columns (glam is column-major):
        Mat3::from_cols(
            Vec3::new((cos_r * p  - sin_r * ry) * sx, (sin_r * p  + cos_r * ry) * sx, 0.0),
            Vec3::new((cos_r * q  - sin_r * ckx) * sy, (sin_r * q  + cos_r * ckx) * sy, 0.0),
            Vec3::new(self.x, self.y, 1.0),
        )
    }

    /// True when the transform is finite and its linear part is invertible
    /// and well-conditioned. This is the invariant every node transform in
    /// the scene must satisfy at all times; setters silently reject (or roll
    /// back) mutations that would break it (see transform_invariants tests).
    ///
    /// The check is deliberately on the COMPOSED MATRIX, not on component
    /// ranges — validity must be representation-independent.
    ///
    /// det/(‖col0‖·‖col1‖) = sin of the angle between the basis vectors;
    /// requiring > 1e-2 keeps the shape more than ~0.6° away from collapsing
    /// to a line.
    pub fn is_valid(&self) -> bool {
        if !(self.x.is_finite() && self.y.is_finite()
            && self.rotation_deg.is_finite()
            && self.skew_x_deg.is_finite() && self.skew_y_deg.is_finite()
            && self.scale_x.is_finite() && self.scale_y.is_finite())
        {
            return false;
        }
        let m = self.to_mat3();
        let (a, b) = (m.x_axis.x, m.x_axis.y);
        let (c, d) = (m.y_axis.x, m.y_axis.y);
        if !(a.is_finite() && b.is_finite() && c.is_finite() && d.is_finite()) {
            return false;
        }
        let n0 = (a * a + b * b).sqrt();
        let n1 = (c * c + d * d).sqrt();
        let det = a * d - b * c;
        n0 > 1e-4 && n0 < 1e7
            && n1 > 1e-4 && n1 < 1e7
            && det.abs() > 1e-2 * n0 * n1
    }

    /// Decompose an arbitrary 2D affine matrix into components.
    pub fn normalize_deg(deg: f32) -> Option<f32> {
        if deg.is_nan() || deg.is_infinite() {
            None
        } else {
            let mut d = deg % 360.0;
            if d > 180.0 { d -= 360.0; }
            if d <= -180.0 { d += 360.0; }
            Some(d)
        }
    }

    /// Distance metric between two transform decomposition representations.
    pub fn component_distance(&self, other: &Transform2D) -> f32 {
        let dr = (self.rotation_deg - other.rotation_deg).abs();
        let dr_norm = dr.min(360.0 - dr);
        let dskx = (self.skew_x_deg - other.skew_x_deg).abs();
        let dsky = (self.skew_y_deg - other.skew_y_deg).abs();
        let dsx = (self.scale_x - other.scale_x).abs();
        let dsy = (self.scale_y - other.scale_y).abs();
        // Translation is deliberately excluded: both candidates copy it
        // verbatim from the matrix, so it cancels — and px could not be
        // compared against degrees meaningfully anyway. The weights only have
        // to rank two candidates for the SAME matrix, so their absolute scale
        // is irrelevant; scale is weighted up because a decomposition that
        // invents a scale change reads far more wrong to a user than one that
        // shifts a few degrees between rotation and skew.
        dr_norm * 2.0 + dskx + dsky + (dsx + dsy) * 10.0
    }

    /// Decompose an arbitrary 2D affine matrix into components.
    /// Guarantees: from_mat3(m).to_mat3() ≈ m to float precision.
    pub fn from_mat3(m: &Mat3) -> Self {
        Self::from_mat3_hint(m, None)
    }

    /// Decompose a 2D affine matrix into components, preferring a decomposition
    /// closest in component space to `hint` when multiple decompositions exist.
    pub fn from_mat3_hint(m: &Mat3, hint: Option<&Transform2D>) -> Self {
        // Exact path: if the linear part is unchanged and only the translation
        // moved, the hint's components are still literally correct — reuse them.
        //
        // This is the common case for every reparent the UI performs (copy /
        // paste, group, ungroup between parents that differ only by offset), and
        // it is the ONLY way a two-axis skew survives. `decompose_skew_x` and
        // `decompose_skew_y` can each represent just one skew axis, so a face
        // like skx=60°, sky=-30° has no faithful candidate: both would return
        // the same matrix expressed as rotation + a single skew, silently
        // rewriting the values the user typed. Matching the linear part first
        // sidesteps the choice entirely.
        if let Some(h) = hint {
            let hm = h.to_mat3();
            let close = |a: f32, b: f32| {
                (a - b).abs() <= 1e-5 * a.abs().max(b.abs()).max(1.0)
            };
            if close(hm.x_axis.x, m.x_axis.x)
                && close(hm.x_axis.y, m.x_axis.y)
                && close(hm.y_axis.x, m.y_axis.x)
                && close(hm.y_axis.y, m.y_axis.y)
            {
                return Self { x: m.z_axis.x, y: m.z_axis.y, ..*h };
            }
        }

        let cand_x = Self::decompose_skew_x(m);
        let cand_y = Self::decompose_skew_y(m);

        // The linear part genuinely changed (a transformed group, a flip, a
        // scale about an anchor). Both candidates reproduce `m` exactly, so pick
        // whichever reads closer to what the node had before.
        if let Some(h) = hint {
            let dist_x = cand_x.component_distance(h);
            let dist_y = cand_y.component_distance(h);
            if dist_y < dist_x {
                return cand_y;
            } else {
                return cand_x;
            }
        }

        // Without a hint, prefer the reading a user would recognise. A pure
        // skew_y matrix is equally expressible as rotation + skew_x, and the
        // skew_x branch always picks the latter; when the skew_y branch can
        // account for the same matrix with NO rotation, that is the honest
        // reading. (`cand_y.skew_x_deg` is 0 by construction, so only the
        // rotation test carries information here.)
        if cand_x.skew_x_deg.abs() > 0.1 && cand_y.rotation_deg.abs() < 1e-3 {
            return cand_y;
        }

        cand_x
    }

    /// Decompose matrix assuming skew_y = 0 (standard skew_x representation).
    fn decompose_skew_x(m: &Mat3) -> Self {
        let a = m.x_axis.x;
        let b = m.x_axis.y;
        let c = m.y_axis.x;
        let d = m.y_axis.y;
        let det = a * d - b * c;
        let sx = (a * a + b * b).sqrt().max(1e-10);
        let rotation = b.atan2(a);
        let cos_r = rotation.cos();
        let sin_r = rotation.sin();
        let m01_prime = cos_r * c + sin_r * d;
        let m11_prime = -sin_r * c + cos_r * d;
        let (m01_adj, m11_adj) = if m11_prime >= 0.0 {
            (m01_prime, m11_prime)
        } else {
            (-m01_prime, -m11_prime)
        };
        let skew_x = m01_adj.atan2(m11_adj);
        let cos_skx = skew_x.cos();
        let sy = if cos_skx.abs() > 1e-10 {
            det / (sx * cos_skx)
        } else {
            let sin_skx = skew_x.sin();
            if sin_skx.abs() > 1e-10 { m01_prime / sin_skx } else { 1.0 }
        };
        let rot_deg = Self::normalize_deg(rotation.to_degrees()).unwrap_or(0.0);
        let skx_deg = Self::normalize_deg(skew_x.to_degrees()).unwrap_or(0.0);
        Self {
            x: m.z_axis.x, y: m.z_axis.y,
            rotation_deg: rot_deg,
            skew_x_deg: skx_deg,
            skew_y_deg: 0.0,
            scale_x: sx, scale_y: sy,
        }
    }

    /// Decompose matrix assuming skew_x = 0 (pure skew_y representation).
    fn decompose_skew_y(m: &Mat3) -> Self {
        let a = m.x_axis.x;
        let b = m.x_axis.y;
        let c = m.y_axis.x;
        let d = m.y_axis.y;
        let det = a * d - b * c;
        let sy = (c * c + d * d).sqrt().max(1e-10);
        let rotation = (-c).atan2(d);
        let cos_r = rotation.cos();
        let sin_r = rotation.sin();
        let m00_prime = cos_r * a + sin_r * b;
        let m10_prime = -sin_r * a + cos_r * b;
        let (m00_adj, m10_adj) = if m00_prime >= 0.0 {
            (m00_prime, m10_prime)
        } else {
            (-m00_prime, -m10_prime)
        };
        let skew_y = m10_adj.atan2(m00_adj);
        let cos_sky = skew_y.cos();
        let sx = if cos_sky.abs() > 1e-10 {
            det / (sy * cos_sky)
        } else {
            let sin_sky = skew_y.sin();
            if sin_sky.abs() > 1e-10 { m10_prime / sin_sky } else { 1.0 }
        };
        let rot_deg = Self::normalize_deg(rotation.to_degrees()).unwrap_or(0.0);
        let sky_deg = Self::normalize_deg(skew_y.to_degrees()).unwrap_or(0.0);
        Self {
            x: m.z_axis.x, y: m.z_axis.y,
            rotation_deg: rot_deg,
            skew_x_deg: 0.0,
            skew_y_deg: sky_deg,
            scale_x: sx, scale_y: sy,
        }
    }
}

/// Paint order: index 0 = bottom-most layer.
/// A post-processing effect applied to a node's rendered pixels.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum Effect {
    /// Gaussian blur. `radius` is the blur sigma (x axis) in local units.
    /// `radius_y` is the y-axis sigma for anisotropic blur (SVG two-value
    /// stdDeviation); `None` means isotropic (y sigma = `radius`).
    Blur {
        radius: f32,
        #[serde(default)]
        radius_y: Option<f32>,
    },
    /// Drop shadow offset by (dx, dy), blurred by `blur` (sigma), tinted `color`.
    DropShadow { dx: f32, dy: f32, blur: f32, color: Color },
    /// A 4×5 color matrix (row-major, applied to [R G B A 1]), matching SVG
    /// feColorMatrix / Skia ColorFilter.MakeMatrix. Covers grayscale, sepia,
    /// saturate, hue-rotate, luminanceToAlpha, etc.
    ColorMatrix {
        matrix: [f32; 20],
        /// When true (the default for SVG), the matrix is applied in linearRGB
        /// color space (sRGB→linear before, linear→sRGB after). When false the
        /// matrix is applied directly in sRGB.
        #[serde(default = "default_true")]
        linear_rgb: bool,
    },
}

fn default_true() -> bool { true }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Style {
    pub fills: Vec<Paint>,
    pub strokes: Vec<Stroke>,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    #[serde(default)]
    pub blend_mode: u8,
    #[serde(default)]
    pub fill_rule: u8,
    #[serde(default)]
    pub corner_radius: f32,
    /// Post-processing effects (blur, drop shadow), applied to the whole node.
    #[serde(default)]
    pub effects: Vec<Effect>,
}

fn default_opacity() -> f32 { 1.0 }

// ─── Precise Path Hit-Testing ───────────────────────────────────────────────────

/// World-space pick tolerance in document pixels (scaled to local space at use).
const HIT_TOLERANCE: f32 = 4.0;

/// Flatten a subpath's cubic segments into a polyline in local space.
/// Includes the closing curve when `closed`.
fn flatten_subpath(sp: &Subpath) -> Vec<Vec2> {
    let n = sp.points.len();
    let mut out = Vec::new();
    if n == 0 {
        return out;
    }
    out.push(Vec2::new(sp.points[0].x, sp.points[0].y));
    for i in 1..n {
        let a = &sp.points[i - 1];
        let b = &sp.points[i];
        vector_network::flatten_cubic(
            Vec2::new(a.x, a.y), a.cp2, b.cp1, Vec2::new(b.x, b.y), 0.25, &mut out,
        );
    }
    if sp.closed && n >= 2 {
        let a = &sp.points[n - 1];
        let b = &sp.points[0];
        vector_network::flatten_cubic(
            Vec2::new(a.x, a.y), a.cp2, b.cp1, Vec2::new(b.x, b.y), 0.25, &mut out,
        );
    }
    out
}

/// Containment test across all subpaths (ray cast toward +x).
/// Open subpaths are implicitly closed for filling, matching SVG semantics.
fn point_in_path_fill(subpaths: &[Subpath], p: Vec2, even_odd: bool) -> bool {
    let mut winding: i32 = 0;
    let mut crossings: u32 = 0;
    for sp in subpaths {
        let poly = flatten_subpath(sp);
        let n = poly.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let a = poly[i];
            let b = poly[(i + 1) % n]; // wrap = implicit close for fill
            if (a.y <= p.y) != (b.y <= p.y) {
                let t = (p.y - a.y) / (b.y - a.y);
                let x = a.x + t * (b.x - a.x);
                if x > p.x {
                    crossings += 1;
                    if b.y > a.y { winding += 1 } else { winding -= 1 }
                }
            }
        }
    }
    if even_odd { crossings % 2 == 1 } else { winding != 0 }
}

/// Squared distance from a point to a polyline (optionally closed).
fn dist_sq_to_polyline(poly: &[Vec2], p: Vec2, closed: bool) -> f32 {
    let n = poly.len();
    if n == 0 {
        return f32::MAX;
    }
    if n == 1 {
        return (poly[0] - p).length_squared();
    }
    let mut best = f32::MAX;
    let seg_count = if closed { n } else { n - 1 };
    for i in 0..seg_count {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let ab = b - a;
        let len_sq = ab.length_squared();
        let t = if len_sq > 1e-12 {
            ((p - a).dot(ab) / len_sq).clamp(0.0, 1.0)
        } else {
            0.0
        };
        best = best.min((a + ab * t - p).length_squared());
    }
    best
}

/// Hit test a path node in local space: stroke outline first (within
/// stroke_width/2 + tolerance), then fill containment if the path is filled.
fn path_hit(subpaths: &[Subpath], style: &Style, p: Vec2, tol: f32) -> bool {
    let max_stroke_w = style.strokes.iter()
        .filter(|s| s.paint.is_some())
        .map(|s| s.width)
        .fold(0.0f32, f32::max);
    let stroke_reach = if max_stroke_w > 0.0 {
        max_stroke_w * 0.5 + tol
    } else {
        tol
    };
    let reach_sq = stroke_reach * stroke_reach;
    for sp in subpaths {
        let poly = flatten_subpath(sp);
        if poly.len() >= 2 && dist_sq_to_polyline(&poly, p, sp.closed) <= reach_sq {
            return true;
        }
    }
    if !style.fills.is_empty() {
        return point_in_path_fill(subpaths, p, style.fill_rule == 1);
    }
    false
}

// ─── Corner-radius resolution ───────────────────────────────────────────────
//
// Corner radius is stored non-destructively as a per-vertex property on the
// *sharp* logical geometry (the editable source of truth). The rounded outline
// is re-derived from (sharp vertices + radius) whenever it is needed for
// rendering, hit-testing, boolean ops or export. Editing a vertex therefore
// keeps its rounding: a rectangle whose corner is dragged becomes a trapezoid
// that is still rounded, exactly like Figma.

/// The four corners of a `width`×`height` rect as one closed subpath, each
/// vertex carrying `corner_radius`.
///
/// A Rect keeps its radius on `style.corner_radius` (one value for the shape)
/// while a Path keeps one per vertex, so anything that wants to *resolve* a
/// rect's rounding has to move it onto vertices first. Sharing this between
/// `convert_to_path` and the bounds pass is what keeps a rounded rect measuring
/// the same before and after conversion.
pub(crate) fn rect_subpaths(width: f32, height: f32, corner_radius: f32) -> Vec<Subpath> {
    let cr = corner_radius;
    vec![Subpath {
        points: vec![
            PathPoint { x: 0.0,   y: 0.0,    cp1: Vec2::new(0.0, 0.0),      cp2: Vec2::new(0.0, 0.0),      corner_radius: cr },
            PathPoint { x: width, y: 0.0,    cp1: Vec2::new(width, 0.0),    cp2: Vec2::new(width, 0.0),    corner_radius: cr },
            PathPoint { x: width, y: height, cp1: Vec2::new(width, height), cp2: Vec2::new(width, height), corner_radius: cr },
            PathPoint { x: 0.0,   y: height, cp1: Vec2::new(0.0, height),   cp2: Vec2::new(0.0, height),   corner_radius: cr },
        ],
        closed: true,
    }]
}

/// Expand every straight-line corner that carries a `corner_radius` into an
/// explicit fillet (two anchors + an arc-as-cubic). Vertices that already have
/// Bézier handles, or sit on an open subpath's endpoint, are left untouched.
pub(crate) fn round_subpaths(subpaths: &[Subpath]) -> Vec<Subpath> {
    subpaths.iter().map(round_subpath).collect()
}

fn round_subpath(sp: &Subpath) -> Subpath {
    const EPS: f32 = 1e-3;
    let n = sp.points.len();
    // Need at least 3 points, and at least one requested radius, to do anything.
    if n < 3 || !sp.points.iter().any(|p| p.corner_radius > EPS) {
        // Still strip corner_radius from the resolved copy so downstream
        // consumers never see a residual value.
        let mut clone = sp.clone();
        for p in &mut clone.points {
            p.corner_radius = 0.0;
        }
        return clone;
    }

    let mut out: Vec<PathPoint> = Vec::with_capacity(n + 4);
    for i in 0..n {
        let cur = &sp.points[i];
        let has_prev = sp.closed || i > 0;
        let has_next = sp.closed || i + 1 < n;
        let prev = &sp.points[(i + n - 1) % n];
        let next = &sp.points[(i + 1) % n];

        let p = Vec2::new(cur.x, cur.y);
        let pv = Vec2::new(prev.x, prev.y);
        let nx = Vec2::new(next.x, next.y);

        // A corner is roundable only if both adjacent segments are straight
        // lines (no Bézier handles at either end) and the vertex itself sharp.
        let seg_in_straight = (prev.cp2 - pv).length() < EPS && (cur.cp1 - p).length() < EPS;
        let seg_out_straight = (cur.cp2 - p).length() < EPS && (next.cp1 - nx).length() < EPS;

        if cur.corner_radius > EPS && has_prev && has_next && seg_in_straight && seg_out_straight {
            let u = (pv - p).normalize_or_zero(); // toward previous vertex
            let w = (nx - p).normalize_or_zero(); // toward next vertex
            let len_in = (pv - p).length();
            let len_out = (nx - p).length();

            let a = u.dot(w).clamp(-1.0, 1.0).acos(); // interior angle at corner
            // Skip degenerate / collinear corners — nothing to round.
            if u.length_squared() < 0.5
                || w.length_squared() < 0.5
                || a < 1e-3
                || (std::f32::consts::PI - a) < 1e-3
            {
                let mut q = cur.clone();
                q.corner_radius = 0.0;
                out.push(q);
                continue;
            }

            let half = a * 0.5;
            let tan_half = half.tan();
            // Trim distance from the corner along each edge for the requested
            // radius, clamped so neighbouring corners never overlap (each may
            // consume at most half of a shared edge).
            let trim = (cur.corner_radius / tan_half)
                .min(0.5 * len_in)
                .min(0.5 * len_out);
            let radius = trim * tan_half; // effective radius after clamping
            let phi = std::f32::consts::PI - a; // arc sweep angle
            let handle_len = (4.0 / 3.0) * (phi * 0.25).tan() * radius;

            let t1 = p + u * trim; // tangent point on the incoming edge
            let t2 = p + w * trim; // tangent point on the outgoing edge

            // Anchor A: straight in from the previous point, arc out toward B.
            out.push(PathPoint {
                x: t1.x,
                y: t1.y,
                cp1: t1,
                cp2: t1 - u * handle_len,
                corner_radius: 0.0,
            });
            // Anchor B: arc in from A, straight out to the next point.
            out.push(PathPoint {
                x: t2.x,
                y: t2.y,
                cp1: t2 - w * handle_len,
                cp2: t2,
                corner_radius: 0.0,
            });
        } else {
            let mut q = cur.clone();
            q.corner_radius = 0.0;
            out.push(q);
        }
    }

    Subpath { points: out, closed: sp.closed }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum Geometry {
    Rect { width: f32, height: f32 },
    Ellipse { radius_x: f32, radius_y: f32 },
    Path {
        subpaths: Vec<Subpath>,
        /// Per-node vector network (graph-based editing source of truth).
        /// When present, editing goes through the network, which recomputes subpaths.
        #[serde(default)]
        network: Option<NodeVectorNetwork>,
    },
    Text {
        content: String,
        font_size: f32,
        #[serde(default)]
        font_family: String,
        #[serde(default)]
        text_align: u8,
        #[serde(default = "default_line_height")]
        line_height: f32,
        /// CSS font weight (100–900); 400 = normal, 700 = bold.
        #[serde(default = "default_font_weight")]
        font_weight: u16,
        #[serde(default)]
        italic: bool,
        /// Extra spacing between glyphs, in local units.
        #[serde(default)]
        letter_spacing: f32,
    },
    /// Raster image. `image_id` refers to encoded bytes stored on the Scene
    /// (`Scene.images`); `width`/`height` are the local display size.
    Image {
        width: f32,
        height: f32,
        image_id: u32,
        /// How to sample the image when it is scaled. `false` (the default)
        /// smooths; `true` keeps hard pixel edges, which is what SVG's
        /// `image-rendering: optimizeSpeed | pixelated | crisp-edges` asks for
        /// and the only correct way to magnify pixel art.
        #[serde(default)]
        pixelated: bool,
    },
}

/// Encoded raster image bytes stored on the Scene, referenced by
/// `Geometry::Image.image_id`. Kept encoded (PNG/JPEG) and content-addressed so
/// documents stay self-contained without bloating memory.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageData {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PathPoint {
    pub x: f32,
    pub y: f32,
    pub cp1: Vec2,
    pub cp2: Vec2,
    /// Parametric corner radius at this vertex. Non-destructive: the sharp
    /// vertex is the editable source of truth, and the rounded outline is
    /// re-derived at resolve time. Only applied to straight-line corners.
    #[serde(default)]
    pub corner_radius: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Subpath {
    pub points: Vec<PathPoint>,
    pub closed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Node {
    pub id: u32,
    pub name: String,
    pub node_type: NodeType,
    pub transform: Transform2D,
    pub style: Style,
    pub geometry: Geometry,
    pub children: Vec<u32>,
    pub parent: Option<u32>,
    pub visible: bool,
    pub locked: bool,
    /// When true, this node acts as a mask for the sibling(s) painted above it
    /// within the same parent, up to the next mask or the end of the parent
    /// (Figma-style). The mask node itself is not painted as normal content;
    /// only its coverage gates the siblings. See `mask_type`.
    #[serde(default)]
    pub is_mask: bool,
    /// How the mask's coverage is derived: 0 = alpha (default, uses the mask's
    /// painted alpha), 1 = luminance (reserved, not yet implemented — treated
    /// as alpha until the renderer grows a luminance path).
    #[serde(default)]
    pub mask_type: u8,
    /// Reserved: when true, this (group/frame) node clips its descendants to
    /// its own bounds. Frames don't exist yet, so the renderer treats this as a
    /// no-op; the field is serialized now so the format won't churn when frame
    /// clipping lands.
    #[serde(default)]
    pub clip_content: bool,
    /// When true, this Group is a Live Paint group — a special object whose
    /// child paths form one paintable planar surface (Illustrator's Live Paint
    /// Group). Only meaningful on `NodeType::Group`. See `Scene::live_paint_group`.
    #[serde(default)]
    pub live_paint: bool,
    /// Per-group Live Paint gap-closing distance, in world units. `None` means
    /// "inherit the document default" (`VectorNetwork::gap_bridge_distance`), so
    /// a group only carries a value once the user has set one on it. Only
    /// meaningful on a `live_paint` Group.
    #[serde(default)]
    pub gap_bridge_distance: Option<f32>,
    /// When set, this Group is a non-destructive **Boolean Group** (Figma-style):
    /// its children are the editable operands, and the group renders/hit-tests a
    /// single cached outline computed (in JS via CanvasKit) from the boolean of
    /// the children. Values: 0=union, 1=subtract, 2=intersect, 3=exclude. Only
    /// meaningful on `NodeType::Group`.
    #[serde(default)]
    pub boolean_op: Option<u8>,
    /// Cached resolved outline of a boolean group, in the group's LOCAL space.
    /// Recomputed by JS whenever a descendant changes (or after load); never the
    /// source of truth. Empty for non-boolean nodes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bool_cache: Vec<Subpath>,
}

use rstar::{RTree, RTreeObject, AABB, PointDistance};

// ─── Render Protocol ─────────────────────────────────────────────────────────────
//
// The render buffer is a hand-rolled, u32-aligned byte stream shared with the
// JS renderer (src/renderer.ts `Renderer.render`). It is framed:
//
//   [magic u32][version u32][command_count u32]  then command_count records of:
//   [record_len u32][cmd u32][node_id u32][payload...]
//
// `record_len` is the byte length of `[cmd][node_id][payload]` (excluding the
// length field itself). The reader asserts it consumed exactly that many bytes
// per record, so any writer/reader layout skew fails loudly and locally instead
// of silently garbling the frame. Bump RENDER_PROTOCOL_VERSION (and the matching
// EXPECTED_RENDER_PROTOCOL_VERSION in renderer.ts) whenever the layout changes.

// Render command types (first u32 of each record's payload).
const CMD_START_GROUP: u32 = 1;
const CMD_DRAW_NODE: u32 = 2;
const CMD_END_GROUP: u32 = 3;
/// Open a mask coverage layer; the following record draws the mask shape.
const CMD_BEGIN_MASK: u32 = 4;
/// Open the masked-content layer (composited into the mask via SrcIn).
const CMD_BEGIN_MASKED_CONTENT: u32 = 5;
/// Close both the content and mask layers, compositing the masked result.
const CMD_END_MASK: u32 = 6;
/// Live Paint face fills, emitted just inside a Live Paint group's START_GROUP
/// so they render UNDER the members' strokes. Payload: count u32, then per face
/// [r,g,b,a f32][point_count u32][x,y,cp1x,cp1y,cp2x,cp2y f32 × N] (closed).
const CMD_LP_FACES: u32 = 7;
/// Live Paint painted-edge strokes, emitted just before END_GROUP (on top of the
/// members). Payload: count u32, then per edge [r,g,b,a,width f32][point_count u32]
/// [x,y,cp1x,cp1y,cp2x,cp2y f32 × N] (open).
const CMD_LP_EDGES: u32 = 8;

/// Magic marker: ASCII "VEC1" as a little-endian u32.
pub const RENDER_PROTOCOL_MAGIC: u32 = 0x3143_4556;
/// Render-buffer layout version. Writer and renderer.ts reader must agree.
///
/// The render buffer is a per-frame handshake between this engine and the
/// renderer, which ship in the same bundle — it is never written to a file, so
/// this number has nothing to say about any saved document. (`.Editor` carries
/// its own, independent `container_version` / `min_reader_version`.)
///
/// It exists so writer/reader skew fails loudly instead of garbling a frame.
/// Bump it — and EXPECTED_RENDER_PROTOCOL_VERSION in renderer.ts — whenever the
/// layout below changes, in the same commit.
///
/// The pre-release version history (a long march to 14 as masks, images,
/// effects, patterns, mesh gradients and Live Paint each landed) has been
/// collapsed: none of those shapes was ever released, none is readable, and no
/// reader needs to know they existed. v1 is what the format is now:
///
///   header  [magic u32][version u32][record_count u32]
///   records [record_len u32][cmd u32][node_id u32][payload...]
///
/// with commands CMD_START_GROUP(1), CMD_DRAW_NODE(2), CMD_END_GROUP(3), the
/// mask trio CMD_BEGIN_MASK(4) / CMD_BEGIN_MASKED_CONTENT(5) / CMD_END_MASK(6),
/// and the Live Paint pair CMD_LP_FACES(7) / CMD_LP_EDGES(8) — each documented
/// at its constant above.
pub const RENDER_PROTOCOL_VERSION: u32 = 1;

/// Begin a framed record: reserve a u32 length placeholder, return its offset.
fn begin_record(buf: &mut Vec<u8>) -> usize {
    let pos = buf.len();
    buf.extend_from_slice(&0u32.to_le_bytes());
    pos
}

/// Close a framed record: backpatch the length placeholder at `len_pos` with the
/// number of payload bytes written since (excluding the 4-byte length field).
fn end_record(buf: &mut Vec<u8>, len_pos: usize) {
    let record_len = (buf.len() - len_pos - 4) as u32;
    buf[len_pos..len_pos + 4].copy_from_slice(&record_len.to_le_bytes());
}

/// Write a paint value (solid color, gradient, or pattern) to a byte buffer.
/// Type tags: 0=none, 1=solid, 2=linear, 3=radial, 4=pattern.
/// Write a bézier outline into the render buffer: `[point_count u32]` then per
/// point `x, y, cp1x, cp1y, cp2x, cp2y` (6 f32) — the layout CMD_LP_FACES/EDGES
/// and the reader's cubic reconstruction share.
fn write_outline_points(buf: &mut Vec<u8>, pts: &[PathPoint]) {
    buf.extend_from_slice(&(pts.len() as u32).to_le_bytes());
    for p in pts {
        for v in [p.x, p.y, p.cp1.x, p.cp1.y, p.cp2.x, p.cp2.y] {
            buf.extend_from_slice(&v.to_le_bytes());
        }
    }
}

/// Serialize a fill/stroke paint. `opacity` is the node's element-level
/// `opacity` (0..1): SVG applies it to the whole rendered element, so for a
/// leaf it's folded into the emitted alpha here (fills/strokes are drawn, then
/// this scales their coverage). For a blur/shadow effect this is exact — those
/// filters are linear, so scaling the source alpha equals scaling the filtered
/// result. Patterns carry no alpha channel in the stream, so element opacity on
/// a pattern fill is not represented (rare).
fn write_paint(buf: &mut Vec<u8>, paint: &Option<Paint>, opacity: f32) {
    match paint {
        None => {
            buf.extend_from_slice(&0u32.to_le_bytes()); // type: none
        }
        Some(Paint::Pattern(p)) => {
            buf.extend_from_slice(&4u32.to_le_bytes()); // type: pattern
            buf.extend_from_slice(&p.image_id.to_le_bytes());
            buf.extend_from_slice(&p.width.to_le_bytes());
            buf.extend_from_slice(&p.height.to_le_bytes());
            for v in p.transform {
                buf.extend_from_slice(&v.to_le_bytes());
            }
        }
        Some(Paint::Solid(c)) => {
            buf.extend_from_slice(&1u32.to_le_bytes()); // type: solid
            buf.extend_from_slice(&c.r.to_le_bytes());
            buf.extend_from_slice(&c.g.to_le_bytes());
            buf.extend_from_slice(&c.b.to_le_bytes());
            buf.extend_from_slice(&(c.a * opacity).to_le_bytes());
        }
        Some(Paint::Mesh(m)) if !m.is_valid() => {
            // Corrupt grid (shouldn't happen — deserialize paths validate):
            // degrade to a solid so the writer can't index out of bounds.
            let c = m.mean_color();
            buf.extend_from_slice(&1u32.to_le_bytes());
            buf.extend_from_slice(&c.r.to_le_bytes());
            buf.extend_from_slice(&c.g.to_le_bytes());
            buf.extend_from_slice(&c.b.to_le_bytes());
            buf.extend_from_slice(&(c.a * opacity).to_le_bytes());
        }
        Some(Paint::Mesh(m)) => {
            // v12: mesh gradient. Handles are materialized via effective_handle
            // so the reader gets concrete control points, never "auto".
            buf.extend_from_slice(&5u32.to_le_bytes()); // type: mesh
            buf.extend_from_slice(&m.rows.to_le_bytes());
            buf.extend_from_slice(&m.cols.to_le_bytes());
            for (i, v) in m.vertices.iter().enumerate() {
                buf.extend_from_slice(&v.x.to_le_bytes());
                buf.extend_from_slice(&v.y.to_le_bytes());
                buf.extend_from_slice(&v.color.r.to_le_bytes());
                buf.extend_from_slice(&v.color.g.to_le_bytes());
                buf.extend_from_slice(&v.color.b.to_le_bytes());
                buf.extend_from_slice(&(v.color.a * opacity).to_le_bytes());
                for dir in 0..4u8 {
                    let h = m.effective_handle(i, dir);
                    buf.extend_from_slice(&h[0].to_le_bytes());
                    buf.extend_from_slice(&h[1].to_le_bytes());
                }
            }
        }
        Some(Paint::Gradient(g)) => {
            let type_tag = match g.gradient_type {
                GradientType::Linear => 2u32,
                GradientType::Radial => 3u32,
            };
            buf.extend_from_slice(&type_tag.to_le_bytes());
            buf.extend_from_slice(&(g.stops.len() as u32).to_le_bytes());
            for stop in &g.stops {
                buf.extend_from_slice(&stop.offset.to_le_bytes());
                buf.extend_from_slice(&stop.color.r.to_le_bytes());
                buf.extend_from_slice(&stop.color.g.to_le_bytes());
                buf.extend_from_slice(&stop.color.b.to_le_bytes());
                buf.extend_from_slice(&(stop.color.a * opacity).to_le_bytes());
            }
            buf.extend_from_slice(&g.start_x.to_le_bytes());
            buf.extend_from_slice(&g.start_y.to_le_bytes());
            buf.extend_from_slice(&g.end_x.to_le_bytes());
            buf.extend_from_slice(&g.end_y.to_le_bytes());
            // spreadMethod + radial focal point (v9). Focal defaults to the
            // center circle (fx=cx, fy=cy, fr=0), which the renderer's
            // two-point conical builder renders identically to a concentric
            // radial — so pre-focal gradients are unaffected.
            buf.extend_from_slice(&(g.spread as u32).to_le_bytes());
            let (fx, fy, fr) = match &g.focal {
                Some(f) => (f.x, f.y, f.r),
                None => (g.start_x, g.start_y, 0.0),
            };
            buf.extend_from_slice(&fx.to_le_bytes());
            buf.extend_from_slice(&fy.to_le_bytes());
            buf.extend_from_slice(&fr.to_le_bytes());
            // v11: optional gradient→local affine for rotated / non-uniform
            // (elliptical) radials. A leading u32 flag says whether the 6 affine
            // floats [a,b,c,d,e,f] follow. Absent (0) = baked circular/linear.
            match &g.transform {
                Some(t) => {
                    buf.extend_from_slice(&1u32.to_le_bytes());
                    for v in t {
                        buf.extend_from_slice(&v.to_le_bytes());
                    }
                }
                None => buf.extend_from_slice(&0u32.to_le_bytes()),
            }
        }
    }
}

// ─── Object identity ────────────────────────────────────────────────────
//
// Node ids are partitioned by *site* so that two people editing the same
// document concurrently can create objects without ever colliding:
//
//     id = (site << COUNTER_BITS) | counter
//
// A "site" is one concurrent editing session, not one user and not one
// account — two tabs are two sites. Ids only have to be unique among sites
// that are live at the same time, because on load each engine resumes its own
// site's counter past the highest one already present in the document (see
// `recompute_next_id`). That makes site ids safely *reusable* across sessions,
// which is what keeps 10 bits sufficient.
//
// Site 0 is the default, and `make_id(0, n) == n` — so a document written
// before any of this, by an engine that just counted 1, 2, 3…, is bit-identical
// under the new scheme and keeps allocating exactly where it left off.
const COUNTER_BITS: u32 = 22;
/// Largest site id: 1023 concurrent editors of one document.
pub const MAX_SITE: u32 = (1 << (32 - COUNTER_BITS)) - 1;
/// Largest per-site counter: ~4.19M objects created by one site in one document.
pub const MAX_COUNTER: u32 = (1 << COUNTER_BITS) - 1;

#[inline]
pub fn make_id(site: u32, counter: u32) -> u32 {
    (site << COUNTER_BITS) | (counter & MAX_COUNTER)
}
#[inline]
pub fn site_of(id: u32) -> u32 {
    id >> COUNTER_BITS
}
#[inline]
pub fn counter_of(id: u32) -> u32 {
    id & MAX_COUNTER
}

#[wasm_bindgen]
pub struct Engine {
    scene: Scene,
    /// Next *counter* (not a whole id) to hand out for `site_id`. Part of the
    /// document: serialized, and restored by undo.
    next_id: u32,
    /// Highest counter this SESSION has ever emitted, for `site_id`. Session
    /// state, never serialized, and never decreases.
    ///
    /// It exists because `next_id` alone is ambiguous after an undo. Undo
    /// rewinds `next_id` (which is what keeps a snapshot round-trip
    /// byte-identical), but an id that undo retired must still never be handed
    /// to a *different* object — a peer may already know that id, and reissuing
    /// it would give two distinct objects one identity. Allocation therefore
    /// takes `max(next_id, id_high_water)`.
    id_high_water: u32,
    /// This engine's site. Set by the host before editing a shared document.
    site_id: u32,
    /// Global transforms stored in glam column-major format.
    /// Converted to Skia row-major only at the JS boundary.
    global_transforms: HashMap<u32, [f32; 9]>,
    /// Temporary buffer for returning row-major transform to JS.
    transform_out_buf: [f32; 9],
    spatial_index: RTree<SpatialNode>,
    node_to_spatial: HashMap<u32, SpatialNode>,
    dirty_flags: HashMap<u32, bool>,
    /// Ids of nodes flagged as Live Paint groups. Cached so the "is anything a
    /// Live Paint group / is this node inside one" checks are O(1)/O(#groups)
    /// instead of scanning every node — those checks run per node on every
    /// mutation (mark_dirty) and per node during render-buffer rebuild, so a
    /// naive scan made both O(n²). Kept in sync at the mutation sites that can
    /// change the flag and rebuilt wholesale on snapshot load.
    live_paint_groups: HashSet<u32>,
    /// Ids of Groups flagged as Boolean Groups (`node.boolean_op.is_some()`).
    /// Cached like `live_paint_groups` so "is this node inside a boolean group"
    /// checks stay cheap on every mutation.
    boolean_groups: HashSet<u32>,
    /// Boolean groups whose cached outline went stale since JS last drained this
    /// set (a descendant was edited, or the op changed). JS reads it via
    /// `take_dirty_boolean_groups`, recomputes each, and pushes back `bool_cache`.
    dirty_boolean_groups: HashSet<u32>,
    /// Subtrees lifted out of the document by Cut, keyed by their original id.
    ///
    /// These live OUTSIDE `self.scene` on purpose, and that is the whole design:
    /// serialization writes only the scene, and undo *replaces* only the scene,
    /// so a clipboard kept inside it would either be saved into the user's file
    /// or silently dropped by the first ⌘Z after a cut. Cleared by the next cut.
    clipboard: HashMap<u32, Node>,
    /// The cut roots, in cut order — `clipboard` also holds their descendants.
    clipboard_roots: Vec<u32>,
    render_buffer: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
struct SpatialNode {
    id: u32,
    aabb: AABB<[f32; 2]>,
}

impl RTreeObject for SpatialNode {
    type Envelope = AABB<[f32; 2]>;
    fn envelope(&self) -> Self::Envelope {
        self.aabb
    }
}

impl PointDistance for SpatialNode {
    fn distance_2(&self, point: &[f32; 2]) -> f32 {
        self.aabb.distance_2(point)
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Scene {
    pub nodes: HashMap<u32, Node>,
    pub root_nodes: Vec<u32>,
    pub selection: Vec<u32>,
    #[serde(default)]
    pub vector_network: VectorNetwork,
    #[serde(default = "default_document_size")]
    pub document_width: f32,
    #[serde(default = "default_document_size")]
    pub document_height: f32,
    /// Encoded raster images, keyed by image id (referenced by Geometry::Image).
    #[serde(default)]
    pub images: HashMap<u32, ImageData>,
    /// Named artboards on the canvas. The source of truth for the drawable
    /// page(s); `document_width/height` above are kept as a legacy mirror of
    /// `artboards[0]` for back-compat with pre-artboard readers.
    #[serde(default)]
    pub artboards: Vec<Artboard>,
    /// When set, Live Paint is scoped to this group's descendants (an Illustrator
    /// "Live Paint Group"). None = the whole visible scene participates.
    #[serde(default)]
    pub live_paint_group: Option<u32>,
    /// Vertical ruler guides — world x positions (each spans the whole canvas).
    #[serde(default)]
    pub guides_x: Vec<f32>,
    /// Horizontal ruler guides — world y positions.
    #[serde(default)]
    pub guides_y: Vec<f32>,
    /// Document colour swatches.
    #[serde(default)]
    pub swatches: Vec<Swatch>,
    /// Text-on-path links: text node id → the path its glyphs follow.
    ///
    /// `BTreeMap`, not `HashMap`, because serialization must be deterministic:
    /// undo coalescing compares snapshots byte-for-byte, and hash iteration
    /// order is not stable across runs.
    #[serde(default)]
    pub text_paths: BTreeMap<u32, u32>,
    /// Arrowheads / line endings, per node id. `BTreeMap` for the same reason.
    #[serde(default)]
    pub markers: BTreeMap<u32, NodeMarkers>,
    /// Ruler guides that cannot be dragged.
    #[serde(default)]
    pub guide_locks: GuideLocks,
    /// Stable identity and provenance for this document.
    #[serde(default)]
    pub meta: DocumentMeta,
    /// Font faces embedded in the document so it renders identically without a
    /// network round-trip. See `FontFace`.
    #[serde(default)]
    pub fonts: Vec<FontFace>,
}

/// A document colour swatch.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Swatch {
    pub color: Color,
    /// Optional user-visible name; empty when unnamed.
    #[serde(default)]
    pub name: String,
}

/// Arrowheads / line endings on one node's path ends.
/// 0 = none, 1 = arrow, 2 = circle, 3 = square.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
pub struct NodeMarkers {
    #[serde(default)]
    pub start: u8,
    #[serde(default)]
    pub end: u8,
}

/// Ruler guide positions that cannot be dragged.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct GuideLocks {
    #[serde(default)]
    pub x: Vec<f32>,
    #[serde(default)]
    pub y: Vec<f32>,
}

/// Marker kind names, indexed by wire code. Order is the contract.
pub const MARKER_KINDS: [&str; 4] = ["none", "arrow", "circle", "square"];

/// Identity and provenance that travel with the document.
///
/// Every field here is set by the editor, never invented during serialization.
/// That is load-bearing: `serialize_snapshot` runs on every undo step and must
/// be a byte-exact fixed point (see `gesture_history.test.ts`), so a timestamp
/// or uuid generated inside `from_scene` would make two snapshots of an
/// unchanged scene differ and break undo coalescing.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
pub struct DocumentMeta {
    /// Stable document identity, assigned once at creation and preserved across
    /// every save, copy, and sync. Cloud sync needs this to tell "the same
    /// document edited twice" from "two documents"; filenames cannot.
    #[serde(default)]
    pub uuid: String,
    /// Unix epoch milliseconds. 0 = unknown (documents predating this field).
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub modified_at_ms: u64,
    /// Version of the editor that last wrote the file — the first thing worth
    /// knowing on any "this file won't open" report.
    #[serde(default)]
    pub app_version: String,
    /// Human-readable document title, independent of the filename.
    #[serde(default)]
    pub title: String,
}

/// A font face embedded in the document.
///
/// Text nodes reference a family by name and the renderer fetches faces from a
/// CDN at draw time, which means a document is not self-contained: offline, or
/// after the CDN reissues a family with different metrics, the same file lays
/// out differently. Embedding the faces actually used makes the file archival.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct FontFace {
    pub family: String,
    /// CSS weight (400 regular, 700 bold).
    pub weight: u16,
    pub italic: bool,
    /// The raw TTF/OTF bytes.
    pub bytes: Vec<u8>,
    /// Provenance, e.g. `fontsource:inter@latest/latin-400-normal`. Purely
    /// informational — the bytes are authoritative.
    #[serde(default)]
    pub source: String,
}

fn default_document_size() -> f32 { 1000.0 }
fn default_line_height() -> f32 { 1.2 }
fn default_font_weight() -> u16 { 400 }

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self {
            scene: Scene {
                nodes: HashMap::new(),
                root_nodes: Vec::new(),
                selection: Vec::new(),
                vector_network: VectorNetwork::default(),
                document_width: 1000.0,
                document_height: 1000.0,
                images: HashMap::new(),
                artboards: vec![Artboard {
                    id: 1,
                    name: "Artwork 1".to_string(),
                    x: 0.0,
                    y: 0.0,
                    w: 1000.0,
                    h: 1000.0,
                    background: default_artboard_bg(),
                }],
                live_paint_group: None,
                guides_x: Vec::new(),
                guides_y: Vec::new(),
                swatches: Vec::new(),
                text_paths: BTreeMap::new(),
                markers: BTreeMap::new(),
                guide_locks: GuideLocks::default(),
                // Left empty on purpose: identity is assigned by the editor
                // (which owns the clock and the uuid source), never invented
                // here. See `DocumentMeta`.
                meta: DocumentMeta::default(),
                fonts: Vec::new(),
            },
            next_id: 1,
            id_high_water: 1,
            site_id: 0,
            global_transforms: HashMap::new(),
            transform_out_buf: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            spatial_index: RTree::new(),
            node_to_spatial: HashMap::new(),
            dirty_flags: HashMap::new(),
            live_paint_groups: HashSet::new(),
            boolean_groups: HashSet::new(),
            dirty_boolean_groups: HashSet::new(),
            clipboard: HashMap::new(),
            clipboard_roots: Vec::new(),
            render_buffer: Vec::new(),
        }
    }

    pub fn get_render_buffer(&self) -> *const u8 {
        self.render_buffer.as_ptr()
    }

    pub fn get_render_buffer_size(&self) -> usize {
        self.render_buffer.len()
    }

    /// The render-buffer protocol version the engine emits. Exposed so JS and
    /// tests can assert the freshly-built wasm matches what the reader expects.
    pub fn render_protocol_version() -> u32 {
        RENDER_PROTOCOL_VERSION
    }

    pub fn update_render_buffer(&mut self, visible_ids: Vec<u32>, sprite_roots: Vec<u32>) {
        // Live Paint faces render in-stream at each group's z, so the network
        // must be current before we walk the tree (any flagged group counts).
        if self.has_live_paint() {
            self.ensure_network_clean();
        }
        let visible_set: HashSet<u32> = visible_ids.into_iter().collect();
        self.build_render_buffer(visible_set, sprite_roots);
    }

    /// Cull + build in one call: run the R-tree viewport query internally and
    /// build the render buffer directly, avoiding the ordered visible-id Vec,
    /// its marshal across the wasm boundary, and the redundant second tree walk
    /// that the separate `get_visible_nodes` + `update_render_buffer` pair does.
    /// Used for ordinary frames; the renderer keeps the split path only for the
    /// drag/snapshot/bake passes that need a JS-side id subset.
    pub fn update_render_buffer_culled(
        &mut self,
        min_x: f32,
        min_y: f32,
        max_x: f32,
        max_y: f32,
        sprite_roots: Vec<u32>,
    ) {
        if self.has_live_paint() {
            self.ensure_network_clean();
        }
        let envelope = AABB::from_corners([min_x, min_y], [max_x, max_y]);
        let visible_set: HashSet<u32> = self
            .spatial_index
            .locate_in_envelope_intersecting(&envelope)
            .map(|node| node.id)
            .collect();
        self.build_render_buffer(visible_set, sprite_roots);
    }

    fn build_render_buffer(&mut self, visible_set: HashSet<u32>, sprite_roots: Vec<u32>) {
        self.render_buffer.clear();
        // Groups the renderer will draw as a cached GPU sprite this frame: emit
        // their START_GROUP/END_GROUP bracket (so the sprite draws inside the
        // group's opacity/blend layer) but skip descending into the subtree.
        // For a doc of many heavy groups this turns the per-frame tree walk from
        // O(total nodes) into O(groups) + non-sprited nodes.
        let sprite_set: HashSet<u32> = sprite_roots.into_iter().collect();

        // Header: magic + version, then a placeholder for the command count.
        self.render_buffer.extend_from_slice(&RENDER_PROTOCOL_MAGIC.to_le_bytes());
        self.render_buffer.extend_from_slice(&RENDER_PROTOCOL_VERSION.to_le_bytes());
        let count_pos = self.render_buffer.len();
        self.render_buffer.extend_from_slice(&[0u8; 4]);

        let mut total_nodes = 0;
        // Masks are GROUP-SCOPED: a mask's reach is bounded by its parent group
        // (the UI auto-creates that group on "Use as Mask"). Root nodes render
        // plainly — an is_mask flag on a root node is inert by design, so a
        // stray flag can never clip the whole document.
        let root_nodes = self.scene.root_nodes.clone();
        for root_id in root_nodes {
            self.write_node_recursive(root_id, &visible_set, &sprite_set, &mut total_nodes, 0);
        }

        // Fill in the total node count (number of "commands")
        let count_bytes = (total_nodes as u32).to_le_bytes();
        self.render_buffer[count_pos..count_pos + 4].copy_from_slice(&count_bytes);
    }

    /// Emit a mask bracketing command (BEGIN_MASK / BEGIN_MASKED_CONTENT /
    /// END_MASK). `id` is advisory (for debugging). CMD_BEGIN_MASK carries an
    /// extra `mask_type` u32 payload (0 = alpha, 1 = luminance).
    fn emit_mask_cmd(&mut self, cmd: u32, id: u32, mask_type: u8, total_nodes: &mut u32) {
        let rec = begin_record(&mut self.render_buffer);
        self.render_buffer.extend_from_slice(&cmd.to_le_bytes());
        self.render_buffer.extend_from_slice(&id.to_le_bytes());
        if cmd == CMD_BEGIN_MASK {
            self.render_buffer.extend_from_slice(&(mask_type as u32).to_le_bytes());
        }
        end_record(&mut self.render_buffer, rec);
        *total_nodes += 1;
    }

    /// True when `id` is emitted as a mask rather than as artwork: it carries
    /// the flag, it is visible, and something after it in its parent is left for
    /// it to mask. A mask with nothing to mask renders as an ordinary node, so
    /// it counts as artwork everywhere.
    ///
    /// Masks are group-scoped — only group children are walked for spans — so a
    /// root-level flag is inert by design and answers false here too.
    ///
    /// The single definition of the question. Three places need it (the render
    /// writer, the Live Paint network, and fill suppression) and when they each
    /// answered it their own way, a masked Live Paint group came apart.
    pub(crate) fn acts_as_mask(&self, id: u32) -> bool {
        let node = match self.scene.nodes.get(&id) {
            Some(n) => n,
            None => return false,
        };
        if !node.is_mask || !node.visible {
            return false;
        }
        let parent = match node.parent {
            Some(p) => p,
            None => return false,
        };
        let siblings = match self.scene.nodes.get(&parent) {
            Some(p) => &p.children,
            None => return false,
        };
        let idx = match siblings.iter().position(|&s| s == id) {
            Some(i) => i,
            None => return false,
        };
        siblings[idx + 1..]
            .iter()
            .any(|&s| self.scene.nodes.get(&s).map_or(false, |n| n.visible && !n.is_mask))
    }

    /// True when `id` is a mask or lives inside one. A mask is coverage, not
    /// artwork: Live Paint must not carve regions out of its outline, and must
    /// not strip the fill that gives an alpha mask its coverage in the first
    /// place.
    pub(crate) fn is_within_mask(&self, id: u32) -> bool {
        let mut cur = Some(id);
        while let Some(n) = cur {
            if self.acts_as_mask(n) {
                return true;
            }
            cur = self.scene.nodes.get(&n).and_then(|node| node.parent);
        }
        false
    }

    /// Emit a group's children, bracketing any mask spans. A visible child with
    /// is_mask=true masks the following siblings (up to the next mask or the
    /// end of the group), Figma-style: [mask, content...].
    ///
    /// `lp_group` is set when the parent is a Live Paint group, and its faces
    /// and painted edges are emitted HERE rather than around this call, so they
    /// land INSIDE the mask span. Emitting them around it put everything the
    /// user painted outside the mask — the faces were the one part of the group
    /// the mask never reached.
    fn write_siblings_with_masks(
        &mut self,
        siblings: &[u32],
        visible_set: &HashSet<u32>,
        sprite_set: &HashSet<u32>,
        total_nodes: &mut u32,
        depth: u32,
        lp_group: Option<u32>,
    ) {
        let mut open_mask = false;
        let mut faces_written = false;
        // Faces sit at the bottom of the group, under the members' strokes.
        let write_faces = |s: &mut Self, total: &mut u32, written: &mut bool| {
            if let Some(g) = lp_group {
                if !*written {
                    s.write_lp_faces(g, total);
                    *written = true;
                }
            }
        };

        for &child_id in siblings.iter() {
            if self.acts_as_mask(child_id) {
                let mt = self.scene.nodes.get(&child_id).map(|c| c.mask_type).unwrap_or(0);
                if open_mask {
                    self.emit_mask_cmd(CMD_END_MASK, child_id, 0, total_nodes);
                }
                self.emit_mask_cmd(CMD_BEGIN_MASK, child_id, mt, total_nodes);
                self.write_node_recursive(child_id, visible_set, sprite_set, total_nodes, depth + 1);
                self.emit_mask_cmd(CMD_BEGIN_MASKED_CONTENT, child_id, 0, total_nodes);
                open_mask = true;
                // Now inside the span: the faces belong here.
                write_faces(self, total_nodes, &mut faces_written);
            } else {
                write_faces(self, total_nodes, &mut faces_written);
                self.write_node_recursive(child_id, visible_set, sprite_set, total_nodes, depth + 1);
            }
        }

        if let Some(g) = lp_group {
            write_faces(self, total_nodes, &mut faces_written); // an empty group still has faces
            self.write_lp_edges(g, total_nodes); // painted edges ride on top, still inside the span
        }
        if open_mask {
            self.emit_mask_cmd(CMD_END_MASK, 0, 0, total_nodes);
        }
    }

    /// Emit CMD_LP_FACES: every colored face (effective color) as a closed
    /// bézier path. Drawn at the bottom of the Live Paint group.
    fn write_lp_faces(&mut self, group: u32, total_nodes: &mut u32) {
        let faces = self.live_paint_faces_effective(Some(group));
        if faces.is_empty() { return; }
        let rec = begin_record(&mut self.render_buffer);
        self.render_buffer.extend_from_slice(&CMD_LP_FACES.to_le_bytes());
        self.render_buffer.extend_from_slice(&0u32.to_le_bytes()); // advisory nodeId
        self.render_buffer.extend_from_slice(&(faces.len() as u32).to_le_bytes());
        for (paint, rings) in &faces {
            // v13: a full paint block (same encoding as a node's fill), not the
            // four floats a face used to be limited to. This is what lets a
            // region hold a gradient.
            write_paint(&mut self.render_buffer, &Some(paint.clone()), 1.0);
            // v14: a ring COUNT, then that many contours. Ring 0 is the
            // silhouette; the rest are islands, drawn as holes (even-odd) so an
            // enclosed region stays visible and paintable instead of being
            // covered by the region around it.
            self.render_buffer.extend_from_slice(&(rings.len() as u32).to_le_bytes());
            for ring in rings {
                write_outline_points(&mut self.render_buffer, ring);
            }
        }
        end_record(&mut self.render_buffer, rec);
        *total_nodes += 1;
    }

    /// Emit CMD_LP_EDGES: painted edges as open bézier strokes (color + width).
    /// Drawn just before END_GROUP, on top of the members.
    fn write_lp_edges(&mut self, group: u32, total_nodes: &mut u32) {
        let edges = self.live_paint_edges_painted(Some(group));
        if edges.is_empty() { return; }
        let rec = begin_record(&mut self.render_buffer);
        self.render_buffer.extend_from_slice(&CMD_LP_EDGES.to_le_bytes());
        self.render_buffer.extend_from_slice(&0u32.to_le_bytes()); // advisory nodeId
        self.render_buffer.extend_from_slice(&(edges.len() as u32).to_le_bytes());
        for (c, width, outline) in &edges {
            for v in [c.r, c.g, c.b, c.a, *width] { self.render_buffer.extend_from_slice(&v.to_le_bytes()); }
            write_outline_points(&mut self.render_buffer, outline);
        }
        end_record(&mut self.render_buffer, rec);
        *total_nodes += 1;
    }

    fn write_node_recursive(
        &mut self,
        id: u32,
        visible_set: &HashSet<u32>,
        sprite_set: &HashSet<u32>,
        total_nodes: &mut u32,
        depth: u32,
    ) {
        // Every command must start 4-byte aligned so the JS reader can take
        // zero-copy Float32Array views over the buffer.
        debug_assert_eq!(self.render_buffer.len() % 4, 0, "render buffer misaligned before command");

        // Bound the recursion. `validate::repair` guarantees an acyclic graph
        // on load, so this should be unreachable — but overflowing here traps
        // the wasm instance and kills the editor outright, which is far too
        // harsh a penalty for a bug in an invariant maintained elsewhere.
        if depth > MAX_NODE_DEPTH {
            log_error(&format!("render: node {id} exceeds max nesting depth; subtree skipped"));
            return;
        }

        let node = match self.scene.nodes.get(&id) {
            Some(n) => n,
            None => return,
        };

        if !node.visible { return; }

        if node.node_type == NodeType::Group {
            // Boolean Group: render the single cached outline with the group's own
            // style (like a path leaf) and do NOT descend into the operand children.
            if node.boolean_op.is_some() {
                let m = self.global_transforms.get(&id).cloned()
                    .unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
                let style = node.style.clone();
                let cache = node.bool_cache.clone();
                self.write_boolean_group_draw(id, m, style, cache, total_nodes);
                return;
            }

            // Check if any descendant is visible (optimization: use R-tree indirectly via visible_set)
            // Groups aren't in R-tree themselves, but their children are.
            // If none of the descendants are in visible_set, we can skip.
            // For now, let's be safe and always process groups if they are visible.

            // CMD_START_GROUP
            let rec = begin_record(&mut self.render_buffer);
            self.render_buffer.extend_from_slice(&CMD_START_GROUP.to_le_bytes());
            self.render_buffer.extend_from_slice(&id.to_le_bytes());
            self.render_buffer.extend_from_slice(&node.style.opacity.to_le_bytes());
            // Group-level blend mode (packed like DRAW_NODE's style_flags) so the
            // group composites as a unit with its blend mode, not just its opacity.
            let style_flags: u32 = ((node.style.blend_mode as u32) << 16) | ((node.style.fill_rule as u32) << 24);
            self.render_buffer.extend_from_slice(&style_flags.to_le_bytes());
            end_record(&mut self.render_buffer, rec);
            *total_nodes += 1;

            // This group is a Live Paint group → its faces render here (bottom of
            // the group, under the members' strokes), and its painted edges just
            // before END_GROUP (on top of the members). Every flagged group
            // renders its own faces, so multiple groups coexist.
            let is_lp = self.scene.nodes.get(&id).map_or(false, |n| n.live_paint);

            // Sprite-cached plain group: the renderer draws its baked GPU image
            // inside this group's opacity/blend layer, so close the bracket now
            // and skip descending into the whole subtree. Live Paint groups are
            // never sprited (they compute faces/edges in-stream).
            if !is_lp && sprite_set.contains(&id) {
                let rec = begin_record(&mut self.render_buffer);
                self.render_buffer.extend_from_slice(&CMD_END_GROUP.to_le_bytes());
                self.render_buffer.extend_from_slice(&id.to_le_bytes());
                end_record(&mut self.render_buffer, rec);
                *total_nodes += 1;
                return;
            }

            // Children are a sibling list — same mask-span semantics as roots.
            // Cloned up front so `node`'s borrow ends before the &mut self calls.
            let children = node.children.clone();

            // Faces and edges are emitted INSIDE write_siblings_with_masks, so a
            // mask among the children contains them.
            self.write_siblings_with_masks(
                &children,
                visible_set,
                sprite_set,
                total_nodes,
                depth,
                if is_lp { Some(id) } else { None },
            );

            // CMD_END_GROUP
            let rec = begin_record(&mut self.render_buffer);
            self.render_buffer.extend_from_slice(&CMD_END_GROUP.to_le_bytes());
            self.render_buffer.extend_from_slice(&id.to_le_bytes());
            end_record(&mut self.render_buffer, rec);
            *total_nodes += 1;
        } else {
            // Only draw leaf if it's in the visible set
            if !visible_set.contains(&id) { return; }

            let rec = begin_record(&mut self.render_buffer);
            self.render_buffer.extend_from_slice(&CMD_DRAW_NODE.to_le_bytes());
            self.render_buffer.extend_from_slice(&id.to_le_bytes());
            
            // NodeType: Path=0, Rect=1, Ellipse=2, Text=4, Image=5
            let type_u8 = match node.node_type {
                NodeType::Path => 0u8,
                NodeType::Rect => 1u8,
                NodeType::Ellipse => 2u8,
                NodeType::Group => 3u8, // should not happen here
                NodeType::Text => 4u8,
                NodeType::Image => 5u8,
            };
            self.render_buffer.extend_from_slice(&(type_u8 as u32).to_le_bytes());

            // Global Transform (9 x f32) - Transpose to row-major for Skia
            let m = self.global_transforms.get(&id).cloned().unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
            let row_major = [
                m[0], m[3], m[6], // Row 0: scaleX, skewX, transX
                m[1], m[4], m[7], // Row 1: skewY, scaleY, transY  
                m[2], m[5], m[8], // Row 2: pers0, pers1, pers2
            ];
            for f in row_major {
                self.render_buffer.extend_from_slice(&f.to_le_bytes());
            }

            // Multi-fill, Multi-stroke, and Transforms format
            let s = &node.style;
            
            // Fills. A member of a Live Paint group writes ZERO fills — the
            // face pass provides its interior colour (so painted faces aren't
            // hidden behind the member's own fill), matching Illustrator.
            //
            // Which members, exactly, is `lp_surface_member`: only the shapes
            // that put contours INTO the surface, and never a mask. Anything
            // else has no face standing in for its fill, so taking the fill away
            // just erases it — which is what happened to text in a painted
            // group. The hit test asks the same question, so what the group
            // catches is what it paints.
            let suppress_fills = self.lp_surface_member(id).is_some();
            let active_fills = if suppress_fills { Vec::new() } else { s.fills.clone() };
            self.render_buffer.extend_from_slice(&(active_fills.len() as u32).to_le_bytes());
            for fill in &active_fills {
                write_paint(&mut self.render_buffer, &Some(fill.clone()), s.opacity);
            }

            // Strokes
            let active_strokes = s.strokes.clone();
            self.render_buffer.extend_from_slice(&(active_strokes.len() as u32).to_le_bytes());
            for st in &active_strokes {
                write_paint(&mut self.render_buffer, &st.paint, s.opacity);
                self.render_buffer.extend_from_slice(&st.width.to_le_bytes());
                self.render_buffer.extend_from_slice(&(st.cap as u32).to_le_bytes());
                self.render_buffer.extend_from_slice(&(st.join as u32).to_le_bytes());
                // The whole dash pattern, not its first two intervals: an SVG
                // may carry any number, and the file round-trips them all, so
                // truncating here made the canvas disagree with what a save
                // would produce.
                self.render_buffer
                    .extend_from_slice(&(st.dash_array.len() as u32).to_le_bytes());
                for d in &st.dash_array {
                    self.render_buffer.extend_from_slice(&d.to_le_bytes());
                }
                self.render_buffer.extend_from_slice(&st.dash_offset.to_le_bytes());
                self.render_buffer.extend_from_slice(&st.miter_limit.to_le_bytes());
                let align = match st.alignment {
                    StrokeAlignment::Center => 0u32,
                    StrokeAlignment::Inner => 1u32,
                    StrokeAlignment::Outer => 2u32,
                };
                self.render_buffer.extend_from_slice(&align.to_le_bytes());
            }

            // Common style properties
            self.render_buffer.extend_from_slice(&s.corner_radius.to_le_bytes());
            let style_flags: u32 = ((s.blend_mode as u32) << 16) | ((s.fill_rule as u32) << 24);
            self.render_buffer.extend_from_slice(&style_flags.to_le_bytes());

            // Effects block: count u32, then per effect a self-describing record
            // [kind u32][payload...] where the payload size is fixed per kind:
            //   0 = Blur:        radius_x, radius_y  (2 f32)             (8B)
            //   1 = DropShadow:  dx,dy,blur,r,g,b,a  (7 f32)             (28B)
            //   2 = ColorMatrix: 20 f32 + 1 u32 (linear_rgb flag)         (84B)
            self.render_buffer.extend_from_slice(&(s.effects.len() as u32).to_le_bytes());
            for eff in &s.effects {
                match eff {
                    Effect::Blur { radius, radius_y } => {
                        self.render_buffer.extend_from_slice(&0u32.to_le_bytes());
                        self.render_buffer.extend_from_slice(&radius.to_le_bytes());
                        // v11: y-axis sigma (anisotropic blur). Defaults to the
                        // x sigma so isotropic blurs are unchanged.
                        let ry = radius_y.unwrap_or(*radius);
                        self.render_buffer.extend_from_slice(&ry.to_le_bytes());
                    }
                    Effect::DropShadow { dx, dy, blur, color } => {
                        self.render_buffer.extend_from_slice(&1u32.to_le_bytes());
                        self.render_buffer.extend_from_slice(&dx.to_le_bytes());
                        self.render_buffer.extend_from_slice(&dy.to_le_bytes());
                        self.render_buffer.extend_from_slice(&blur.to_le_bytes());
                        self.render_buffer.extend_from_slice(&color.r.to_le_bytes());
                        self.render_buffer.extend_from_slice(&color.g.to_le_bytes());
                        self.render_buffer.extend_from_slice(&color.b.to_le_bytes());
                        self.render_buffer.extend_from_slice(&color.a.to_le_bytes());
                    }
                    Effect::ColorMatrix { matrix, linear_rgb } => {
                        self.render_buffer.extend_from_slice(&2u32.to_le_bytes());
                        for v in matrix {
                            self.render_buffer.extend_from_slice(&v.to_le_bytes());
                        }
                        self.render_buffer.extend_from_slice(&(if *linear_rgb { 1u32 } else { 0u32 }).to_le_bytes());
                    }
                }
            }

            // (transform effects removed — transforms are now decomposed components)

            // Geometry
            match &node.geometry {
                Geometry::Rect { width, height } => {
                    self.render_buffer.extend_from_slice(&8u32.to_le_bytes()); // Size: 2 * f32
                    self.render_buffer.extend_from_slice(&width.to_le_bytes());
                    self.render_buffer.extend_from_slice(&height.to_le_bytes());
                }
                Geometry::Image { width, height, image_id, pixelated } => {
                    // 2*f32 + u32 id + u32 flags. Stays 4-byte aligned, which
                    // the JS reader relies on for zero-copy Float32Array views.
                    self.render_buffer.extend_from_slice(&16u32.to_le_bytes());
                    self.render_buffer.extend_from_slice(&width.to_le_bytes());
                    self.render_buffer.extend_from_slice(&height.to_le_bytes());
                    self.render_buffer.extend_from_slice(&image_id.to_le_bytes());
                    self.render_buffer.extend_from_slice(&(*pixelated as u32).to_le_bytes());
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    self.render_buffer.extend_from_slice(&8u32.to_le_bytes()); // Size: 2 * f32
                    self.render_buffer.extend_from_slice(&radius_x.to_le_bytes());
                    self.render_buffer.extend_from_slice(&radius_y.to_le_bytes());
                }
                Geometry::Path { subpaths, .. } => {
                    // Emit the *resolved* outline (per-vertex corner radii baked
                    // into arcs) so rendering shows rounding while the stored
                    // geometry stays sharp and editable.
                    let resolved = round_subpaths(subpaths);
                    // Pre-calculate size or write a placeholder.
                    // Let's use a placeholder for Path size.
                    let size_offset = self.render_buffer.len();
                    self.render_buffer.extend_from_slice(&[0u8; 4]);
                    let start_len = self.render_buffer.len();

                    self.render_buffer.extend_from_slice(&(resolved.len() as u32).to_le_bytes());
                    for sp in &resolved {
                        self.render_buffer.extend_from_slice(&(if sp.closed { 1u32 } else { 0u32 }).to_le_bytes());
                        self.render_buffer.extend_from_slice(&(sp.points.len() as u32).to_le_bytes());
                        for pt in &sp.points {
                            self.render_buffer.extend_from_slice(&pt.x.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.y.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.cp1.x.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.cp1.y.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.cp2.x.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.cp2.y.to_le_bytes());
                        }
                    }

                    let end_len = self.render_buffer.len();
                    let total_size = (end_len - start_len) as u32;
                    self.render_buffer[size_offset..size_offset+4].copy_from_slice(&total_size.to_le_bytes());
                }
                Geometry::Text { content, font_size, ref font_family, text_align, line_height, font_weight, italic, letter_spacing } => {
                    let ff_bytes = font_family.as_bytes();
                    let ff_padding = (4 - (ff_bytes.len() % 4)) % 4;
                    let content_bytes = content.as_bytes();
                    let content_padding = (4 - (content_bytes.len() % 4)) % 4;
                    let total_size = 4 + 4 + 4  // font_size + text_align + line_height
                        + 4 + 4 + 4              // font_weight + italic + letter_spacing
                        + 4 + ff_bytes.len() as u32 + ff_padding as u32  // ff_len + ff + ff_pad
                        + 4 + content_bytes.len() as u32 + content_padding as u32; // content_len + content + pad
                    self.render_buffer.extend_from_slice(&total_size.to_le_bytes());

                    self.render_buffer.extend_from_slice(&font_size.to_le_bytes());
                    self.render_buffer.extend_from_slice(&(*text_align as u32).to_le_bytes());
                    self.render_buffer.extend_from_slice(&line_height.to_le_bytes());
                    self.render_buffer.extend_from_slice(&(*font_weight as u32).to_le_bytes());
                    self.render_buffer.extend_from_slice(&(if *italic { 1u32 } else { 0u32 }).to_le_bytes());
                    self.render_buffer.extend_from_slice(&letter_spacing.to_le_bytes());

                    // font_family string
                    self.render_buffer.extend_from_slice(&(ff_bytes.len() as u32).to_le_bytes());
                    self.render_buffer.extend_from_slice(ff_bytes);
                    let ff_padded = self.render_buffer.len() + ff_padding;
                    self.render_buffer.resize(ff_padded, 0);

                    // content string
                    self.render_buffer.extend_from_slice(&(content_bytes.len() as u32).to_le_bytes());
                    self.render_buffer.extend_from_slice(content_bytes);
                    let padded_len = self.render_buffer.len() + content_padding;
                    self.render_buffer.resize(padded_len, 0);
                }
            }
            end_record(&mut self.render_buffer, rec);
            *total_nodes += 1;
        }
    }

    /// Emit one CMD_DRAW_NODE (type Path) for a Boolean Group's cached outline,
    /// using the group's own transform/style. Mirrors the leaf-path branch of
    /// `write_node`, but takes owned clones so there's no disjoint-field borrow
    /// against `self.scene` (boolean groups are rare, so the clone cost is fine).
    fn write_boolean_group_draw(
        &mut self,
        id: u32,
        transform: [f32; 9],
        style: Style,
        cache: Vec<Subpath>,
        total_nodes: &mut u32,
    ) {
        let rec = begin_record(&mut self.render_buffer);
        self.render_buffer.extend_from_slice(&CMD_DRAW_NODE.to_le_bytes());
        self.render_buffer.extend_from_slice(&id.to_le_bytes());
        self.render_buffer.extend_from_slice(&0u32.to_le_bytes()); // NodeType::Path

        // Global transform → row-major for Skia (same transpose as write_node).
        let m = transform;
        let row_major = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
        for f in row_major {
            self.render_buffer.extend_from_slice(&f.to_le_bytes());
        }

        // Fills
        self.render_buffer.extend_from_slice(&(style.fills.len() as u32).to_le_bytes());
        for fill in &style.fills {
            write_paint(&mut self.render_buffer, &Some(fill.clone()), style.opacity);
        }

        // Strokes
        self.render_buffer.extend_from_slice(&(style.strokes.len() as u32).to_le_bytes());
        for st in &style.strokes {
            write_paint(&mut self.render_buffer, &st.paint, style.opacity);
            self.render_buffer.extend_from_slice(&st.width.to_le_bytes());
            self.render_buffer.extend_from_slice(&(st.cap as u32).to_le_bytes());
            self.render_buffer.extend_from_slice(&(st.join as u32).to_le_bytes());
            // See the note on the other stroke writer: the full dash array.
            self.render_buffer
                .extend_from_slice(&(st.dash_array.len() as u32).to_le_bytes());
            for d in &st.dash_array {
                self.render_buffer.extend_from_slice(&d.to_le_bytes());
            }
            self.render_buffer.extend_from_slice(&st.dash_offset.to_le_bytes());
            self.render_buffer.extend_from_slice(&st.miter_limit.to_le_bytes());
            let align = match st.alignment {
                StrokeAlignment::Center => 0u32,
                StrokeAlignment::Inner => 1u32,
                StrokeAlignment::Outer => 2u32,
            };
            self.render_buffer.extend_from_slice(&align.to_le_bytes());
        }

        // Common style properties
        self.render_buffer.extend_from_slice(&style.corner_radius.to_le_bytes());
        let style_flags: u32 = ((style.blend_mode as u32) << 16) | ((style.fill_rule as u32) << 24);
        self.render_buffer.extend_from_slice(&style_flags.to_le_bytes());

        // Effects (same self-describing layout as write_node)
        self.render_buffer.extend_from_slice(&(style.effects.len() as u32).to_le_bytes());
        for eff in &style.effects {
            match eff {
                Effect::Blur { radius, radius_y } => {
                    self.render_buffer.extend_from_slice(&0u32.to_le_bytes());
                    self.render_buffer.extend_from_slice(&radius.to_le_bytes());
                    let ry = radius_y.unwrap_or(*radius);
                    self.render_buffer.extend_from_slice(&ry.to_le_bytes());
                }
                Effect::DropShadow { dx, dy, blur, color } => {
                    self.render_buffer.extend_from_slice(&1u32.to_le_bytes());
                    self.render_buffer.extend_from_slice(&dx.to_le_bytes());
                    self.render_buffer.extend_from_slice(&dy.to_le_bytes());
                    self.render_buffer.extend_from_slice(&blur.to_le_bytes());
                    self.render_buffer.extend_from_slice(&color.r.to_le_bytes());
                    self.render_buffer.extend_from_slice(&color.g.to_le_bytes());
                    self.render_buffer.extend_from_slice(&color.b.to_le_bytes());
                    self.render_buffer.extend_from_slice(&color.a.to_le_bytes());
                }
                Effect::ColorMatrix { matrix, linear_rgb } => {
                    self.render_buffer.extend_from_slice(&2u32.to_le_bytes());
                    for v in matrix {
                        self.render_buffer.extend_from_slice(&v.to_le_bytes());
                    }
                    self.render_buffer.extend_from_slice(&(if *linear_rgb { 1u32 } else { 0u32 }).to_le_bytes());
                }
            }
        }

        // Path geometry (corner radii already baked into the cached outline).
        let resolved = round_subpaths(&cache);
        let size_offset = self.render_buffer.len();
        self.render_buffer.extend_from_slice(&[0u8; 4]);
        let start_len = self.render_buffer.len();
        self.render_buffer.extend_from_slice(&(resolved.len() as u32).to_le_bytes());
        for sp in &resolved {
            self.render_buffer.extend_from_slice(&(if sp.closed { 1u32 } else { 0u32 }).to_le_bytes());
            self.render_buffer.extend_from_slice(&(sp.points.len() as u32).to_le_bytes());
            for pt in &sp.points {
                self.render_buffer.extend_from_slice(&pt.x.to_le_bytes());
                self.render_buffer.extend_from_slice(&pt.y.to_le_bytes());
                self.render_buffer.extend_from_slice(&pt.cp1.x.to_le_bytes());
                self.render_buffer.extend_from_slice(&pt.cp1.y.to_le_bytes());
                self.render_buffer.extend_from_slice(&pt.cp2.x.to_le_bytes());
                self.render_buffer.extend_from_slice(&pt.cp2.y.to_le_bytes());
            }
        }
        let end_len = self.render_buffer.len();
        let total_size = (end_len - start_len) as u32;
        self.render_buffer[size_offset..size_offset + 4].copy_from_slice(&total_size.to_le_bytes());

        end_record(&mut self.render_buffer, rec);
        *total_nodes += 1;
    }

    pub fn is_node_dirty(&self, id: u32) -> bool {
        *self.dirty_flags.get(&id).unwrap_or(&true)
    }

    pub fn clear_node_dirty(&mut self, id: u32) {
        self.dirty_flags.insert(id, false);
    }

    fn mark_dirty(&mut self, id: u32) {
        self.dirty_flags.insert(id, true);
        // Invalidate the Live Paint network so faces recompute on next query.
        // Only edits inside (or of) a Live Paint group matter — skip the rebuild
        // for edits elsewhere (big win on busy documents). With no flagged group
        // there is nothing to rebuild.
        if self.is_in_any_live_paint(id) {
            self.scene.vector_network.dirty = true;
        }
        // A boolean group whose descendant changed needs its outline recomputed.
        self.mark_enclosing_boolean_groups_dirty(id);
    }

    pub fn add_rect(&mut self, x: f32, y: f32, w: f32, h: f32) -> u32 {
        let id = self.insert_rect_node(x, y, w, h);
        self.update_spatial_index(id);
        id
    }

    /// Batch-create rectangles from a JSON array of `[x, y, w, h]` tuples,
    /// returning the new node ids in order. Unlike calling `add_rect` in a
    /// loop, the spatial index is rebuilt once via `bulk_load` at the end
    /// rather than per node — turning O(n²) bulk creation into O(n log n).
    /// Used by bulk importers and the dev stress harness.
    pub fn add_rects(&mut self, rects_json: &str) -> Vec<u32> {
        let rects: Vec<[f32; 4]> = serde_json::from_str(rects_json).unwrap_or_default();
        let mut ids = Vec::with_capacity(rects.len());
        for [x, y, w, h] in rects {
            ids.push(self.insert_rect_node(x, y, w, h));
        }
        // Single bulk spatial rebuild instead of a per-node incremental insert.
        self.update_all_spatial_indices();
        ids
    }

    /// Hand out the next node id for this engine's site.
    ///
    /// Every node-creating path goes through here — allocating inline is how
    /// two sites end up producing the same id.
    fn alloc_id(&mut self) -> u32 {
        // Never below the session watermark, so an id retired by undo is not
        // reissued to a different object.
        self.next_id = self.next_id.max(self.id_high_water);
        if self.next_id > MAX_COUNTER {
            // Nothing safe is left to hand out: wrapping would start reissuing
            // ids that live nodes already hold, silently aliasing objects.
            // Refuse loudly instead — 4.19M objects from one session is far
            // past any real document, so this means a leak or a runaway loop.
            log_error(&format!(
                "id space exhausted for site {} ({} objects); refusing to reuse ids",
                self.site_id, MAX_COUNTER
            ));
            panic!("node id space exhausted for site {}", self.site_id);
        }
        let id = make_id(self.site_id, self.next_id);
        self.next_id += 1;
        self.id_high_water = self.next_id;
        id
    }

    /// Resume this site's counter past everything the document already holds
    /// FOR THIS SITE. Other sites' ids are irrelevant — they live in disjoint
    /// ranges — which is exactly what makes a site id safe to reuse in a later
    /// session without colliding with the objects it created in an earlier one.
    /// `monotonic` means "never hand out a counter this session already used".
    /// That matters for undo: restoring a snapshot taken before a node existed
    /// must NOT free that node's id for reuse. Reusing it would give a second,
    /// different object the identity of one other peers may already have seen —
    /// two objects that merge into one. Opening a *different* document is the
    /// opposite case: start from what that document actually contains.
    fn own_site_high_counter(&self) -> u32 {
        let mine = self.site_id;
        self.scene
            .nodes
            .keys()
            .filter(|id| site_of(**id) == mine)
            .map(|id| counter_of(*id))
            .max()
            .unwrap_or(0)
    }

    /// Resume allocation for a document being *opened*: this document defines
    /// the counter, and the session watermark restarts with it. (Undo does not
    /// use this — see `deserialize_scene`.)
    fn recompute_next_id(&mut self) {
        self.next_id = self.own_site_high_counter() + 1;
        self.id_high_water = self.next_id;
    }

    /// Set this engine's site before editing a shared document. Concurrent
    /// editors must each be given a different one; sessions that never overlap
    /// may reuse them freely.
    pub fn set_site_id(&mut self, site: u32) {
        self.site_id = site.min(MAX_SITE);
        // The counter is per-site, so switching site means resuming a
        // different sequence — not continuing the old site's.
        self.recompute_next_id();
    }

    pub fn site_id(&self) -> u32 {
        self.site_id
    }

    /// Create a default-styled rectangle node and attach it at the root,
    /// updating its global transform and dirty flag but NOT the spatial index.
    /// Shared by `add_rect` (which indexes the one node) and `add_rects` (which
    /// bulk-rebuilds the index once for the whole batch).
    fn insert_rect_node(&mut self, x: f32, y: f32, w: f32, h: f32) -> u32 {
        let id = self.alloc_id();

        let node = Node {
            id,
            name: format!("Rect {}", id),
            node_type: NodeType::Rect,
            transform: Transform2D::from_translation(x, y),
            style: Style {
                fills: vec![Paint::Solid(Color { r: 0.5, g: 0.5, b: 1.0, a: 1.0 })],
                strokes: vec![Stroke { paint: Some(Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })), width: 1.0, cap: 0, join: 0, dash_array: Vec::new(), dash_offset: 0.0, miter_limit: 4.0, alignment: StrokeAlignment::Center }],
                opacity: 1.0,
                blend_mode: 0,
                fill_rule: 0,
                corner_radius: 0.0,
                effects: Vec::new(),
            },
            geometry: Geometry::Rect { width: w, height: h },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
            };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.mark_dirty(id);
        id
    }

    pub fn add_ellipse(&mut self, cx: f32, cy: f32, rx: f32, ry: f32) -> u32 {
        let id = self.alloc_id();

        let node = Node {
            id,
            name: format!("Ellipse {}", id),
            node_type: NodeType::Ellipse,
            transform: Transform2D::from_translation(cx, cy),
            style: Style {
                fills: vec![Paint::Solid(Color { r: 0.5, g: 0.5, b: 1.0, a: 1.0 })],
                strokes: vec![Stroke { paint: Some(Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })), width: 1.0, cap: 0, join: 0, dash_array: Vec::new(), dash_offset: 0.0, miter_limit: 4.0, alignment: StrokeAlignment::Center }],
                opacity: 1.0,
                blend_mode: 0,
                fill_rule: 0,
                corner_radius: 0.0,
                effects: Vec::new(),
            },
            geometry: Geometry::Ellipse { radius_x: rx, radius_y: ry },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
            };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn add_path(&mut self, points_json: &str) -> u32 {
        let subpaths: Vec<Subpath> = serde_json::from_str(points_json).unwrap_or_default();
        let id = self.alloc_id();

        // Compute bbox center of all points for local-space normalization
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        for sp in &subpaths {
            for pt in &sp.points {
                min_x = min_x.min(pt.x);
                min_y = min_y.min(pt.y);
                max_x = max_x.max(pt.x);
                max_y = max_y.max(pt.y);
            }
        }
        let (center_x, center_y) = if min_x <= max_x && min_y <= max_y {
            ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0)
        } else {
            (0.0, 0.0)
        };

        // Subtract center from all points to make geometry local-space
        let subpaths: Vec<Subpath> = subpaths.into_iter().map(|sp| Subpath {
            points: sp.points.into_iter().map(|mut pt| {
                pt.x -= center_x;
                pt.y -= center_y;
                pt.cp1 -= Vec2::new(center_x, center_y);
                pt.cp2 -= Vec2::new(center_x, center_y);
                pt
            }).collect(),
            closed: sp.closed,
        }).collect();

        let node = Node {
            id,
            name: format!("Path {}", id),
            node_type: NodeType::Path,
            transform: Transform2D::from_translation(center_x, center_y),
            style: Style {
                fills: vec![Paint::Solid(Color { r: 0.5, g: 0.5, b: 1.0, a: 1.0 })],
                strokes: vec![Stroke { paint: Some(Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })), width: 1.0, cap: 0, join: 0, dash_array: Vec::new(), dash_offset: 0.0, miter_limit: 4.0, alignment: StrokeAlignment::Center }],
                opacity: 1.0,
                blend_mode: 0,
                fill_rule: 0,
                corner_radius: 0.0,
                effects: Vec::new(),
            },
            geometry: Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
            };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn add_polygon(&mut self, cx: f32, cy: f32, radius: f32, sides: u32) -> u32 {
        let sides = sides.max(3);
        let step = std::f32::consts::TAU / sides as f32;
        let mut points = Vec::new();
        for i in 0..sides {
            let angle = i as f32 * step - std::f32::consts::FRAC_PI_2;
            let px = radius * angle.cos();
            let py = radius * angle.sin();
            points.push(PathPoint {
                x: px,
                y: py,
                cp1: Vec2::new(px, py),
                cp2: Vec2::new(px, py),
                corner_radius: 0.0,
            });
        }

        let subpaths = vec![Subpath { points, closed: true }];

        let id = self.alloc_id();

        let node = Node {
            id,
            name: format!("Polygon {}", id),
            node_type: NodeType::Path,
            transform: Transform2D::from_translation(cx, cy),
            style: Style {
                fills: vec![Paint::Solid(Color { r: 0.5, g: 0.8, b: 0.5, a: 1.0 })],
                strokes: vec![Stroke { paint: Some(Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })), width: 1.0, cap: 0, join: 0, dash_array: Vec::new(), dash_offset: 0.0, miter_limit: 4.0, alignment: StrokeAlignment::Center }],
                opacity: 1.0,
                blend_mode: 0,
                fill_rule: 0,
                corner_radius: 0.0,
                effects: Vec::new(),
            },
            geometry: Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
            };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn add_star(&mut self, cx: f32, cy: f32, outer_r: f32, inner_r: f32, num_points: u32) -> u32 {
        let num_points = num_points.max(3);
        let step = std::f32::consts::PI / num_points as f32;
        let mut points = Vec::new();
        let total_verts = num_points * 2;
        for i in 0..total_verts {
            let r = if i % 2 == 0 { outer_r } else { inner_r };
            let angle = i as f32 * step - std::f32::consts::FRAC_PI_2;
            let px = r * angle.cos();
            let py = r * angle.sin();
            points.push(PathPoint {
                x: px,
                y: py,
                cp1: Vec2::new(px, py),
                cp2: Vec2::new(px, py),
                corner_radius: 0.0,
            });
        }

        let subpaths = vec![Subpath { points, closed: true }];

        let id = self.alloc_id();

        let node = Node {
            id,
            name: format!("Star {}", id),
            node_type: NodeType::Path,
            transform: Transform2D::from_translation(cx, cy),
            style: Style {
                fills: vec![Paint::Solid(Color { r: 1.0, g: 0.8, b: 0.2, a: 1.0 })],
                strokes: vec![Stroke { paint: Some(Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })), width: 1.0, cap: 0, join: 0, dash_array: Vec::new(), dash_offset: 0.0, miter_limit: 4.0, alignment: StrokeAlignment::Center }],
                opacity: 1.0,
                blend_mode: 0,
                fill_rule: 0,
                corner_radius: 0.0,
                effects: Vec::new(),
            },
            geometry: Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
            };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn update_path_points(&mut self, id: u32, subpaths_json: &str) {
        let subpaths: Vec<Subpath> = serde_json::from_str(subpaths_json).unwrap_or_default();
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            let old_bb = geometry_control_bbox(&node.geometry);
            node.geometry = Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            };
            // Mesh fills live in node-local coordinates: when the geometry
            // itself changes (path edit, not a transform), stretch them along
            // so the color field follows the shape. JS refines committed path
            // edits with an exact boundary re-snap on top of this affine.
            adapt_mesh_fills_to_bbox(node, old_bb);
            self.update_spatial_index(id);
            self.mark_dirty(id);
        }
    }

    pub fn set_node_style(&mut self, id: u32, style_json: &str) {
        if let Ok(style) = serde_json::from_str::<Style>(style_json) {
            // `corner_radius` is the one style field that changes a node's
            // measured extent: on a rotated or skewed Rect the arcs cut the
            // corner tips off, so the cached AABB has to be rebuilt. Every other
            // field is paint-only and a render-dirty flag is enough.
            let mut bounds_changed = false;
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                bounds_changed = matches!(node.geometry, Geometry::Rect { .. })
                    && (node.style.corner_radius - style.corner_radius).abs() > 1e-6;
                node.style = style;
                self.mark_dirty(id);
            }
            if bounds_changed {
                self.update_spatial_index_recursive(id);
                self.update_ancestor_group_bounds(id);
            }
        }
    }

    pub fn set_node_visible(&mut self, id: u32, visible: bool) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.visible = visible;
            self.mark_dirty(id);
        }
    }

    pub fn set_node_locked(&mut self, id: u32, locked: bool) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.locked = locked;
        }
    }

    /// Toggle whether a node masks the siblings painted above it. Marks the
    /// parent dirty so the mask span is recomputed on the next render.
    pub fn set_node_is_mask(&mut self, id: u32, is_mask: bool) {
        let parent = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.is_mask = is_mask;
        }
        self.mark_dirty(id);
        if let Some(pid) = parent {
            self.mark_dirty(pid);
        }
    }

    /// Set the mask coverage source: 0 = alpha, 1 = luminance (reserved).
    pub fn set_node_mask_type(&mut self, id: u32, mask_type: u32) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.mask_type = mask_type as u8;
        }
        self.mark_dirty(id);
    }

    pub fn get_node_is_mask(&self, id: u32) -> bool {
        self.scene.nodes.get(&id).map(|n| n.is_mask).unwrap_or(false)
    }

    /// Mark (or unmark) a Group node as a Live Paint group. No-op on non-groups.
    pub fn set_node_live_paint(&mut self, id: u32, live_paint: bool) {
        // One flag per nest. `live_paint_group_of` stops at the NEAREST flagged
        // ancestor, so a group flagged inside another one silently splits its
        // members off the outer network: their shapes stop dividing regions with
        // their neighbours and a fill spills across a boundary it should have
        // stopped at. There is no drawing this expresses — a Live Paint group is
        // "these shapes share one surface", and nesting says that twice about
        // the same shapes — so the inner flag is refused rather than honoured.
        if live_paint && self.live_paint_ancestor_of(id).is_some() {
            return;
        }
        let mut is_lp = false;
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            if node.node_type == NodeType::Group {
                node.live_paint = live_paint;
            }
            is_lp = node.live_paint;
        }
        // Flagging a group that already contains flagged ones is the same
        // conflict from the other side: the outer group is the surface the user
        // just asked for, so the flags beneath it lose.
        if is_lp {
            for nested in self.live_paint_descendants_of(id) {
                if let Some(node) = self.scene.nodes.get_mut(&nested) {
                    node.live_paint = false;
                }
                self.live_paint_groups.remove(&nested);
            }
        }
        // Keep the O(1) group cache in sync with the node's actual flag.
        if is_lp {
            self.live_paint_groups.insert(id);
        } else {
            self.live_paint_groups.remove(&id);
        }
        // Flagging or un-flagging a group changes which groups the network
        // tracks, so always force a rebuild (un-flagging wouldn't trip the
        // descendant check in mark_dirty).
        self.dirty_flags.insert(id, true);
        self.scene.vector_network.dirty = true;
    }

    pub fn get_node_live_paint(&self, id: u32) -> bool {
        self.scene.nodes.get(&id).map(|n| n.live_paint).unwrap_or(false)
    }

    /// Set (op = 0..3) or clear (op < 0) the boolean operation on a Group node,
    /// making it a non-destructive Boolean Group. No-op on non-groups. Flags the
    /// group so JS recomputes its cached outline on the next drain.
    pub fn set_boolean_op(&mut self, id: u32, op: i32) {
        let mut is_group = false;
        let mut is_bool = false;
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            is_group = node.node_type == NodeType::Group;
            if is_group {
                node.boolean_op = if op < 0 { None } else { Some(op as u8) };
                if node.boolean_op.is_none() {
                    node.bool_cache.clear();
                }
            }
            is_bool = node.boolean_op.is_some();
        }
        if !is_group {
            return;
        }
        if is_bool {
            self.boolean_groups.insert(id);
            self.dirty_boolean_groups.insert(id);
        } else {
            self.boolean_groups.remove(&id);
            self.dirty_boolean_groups.remove(&id);
        }
        self.dirty_flags.insert(id, true);
        // Becoming (or ceasing to be) a Boolean Group switches which geometry
        // defines the group's box: the cached outline vs. the operand union.
        self.update_spatial_index(id);
        self.update_ancestor_group_bounds(id);
    }

    /// The boolean op on a Group (0..3), or -1 if it isn't a Boolean Group.
    pub fn get_boolean_op(&self, id: u32) -> i32 {
        self.scene.nodes.get(&id)
            .and_then(|n| n.boolean_op)
            .map(|op| op as i32)
            .unwrap_or(-1)
    }

    /// Push a recomputed outline (JSON `Vec<Subpath>`, in the group's LOCAL space)
    /// into a Boolean Group's cache and clear its dirty flag. No-op otherwise.
    pub fn set_bool_cache(&mut self, id: u32, subpaths_json: &str) {
        let subpaths: Vec<Subpath> = match serde_json::from_str(subpaths_json) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut applied = false;
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            if node.boolean_op.is_some() {
                node.bool_cache = subpaths;
                applied = true;
            }
        }
        if applied {
            self.dirty_boolean_groups.remove(&id);
            self.dirty_flags.insert(id, true);
            // The group's bounds ARE its outline now, so a new outline is a new
            // box — for the group and for every ancestor that unions it.
            self.update_spatial_index(id);
            self.update_ancestor_group_bounds(id);
        }
    }

    /// Drain and return the ids of Boolean Groups whose outline is stale, ordered
    /// DEEPEST-FIRST so nested groups recompute before their parents. JSON array.
    pub fn take_dirty_boolean_groups(&mut self) -> String {
        let mut ids: Vec<u32> = self.dirty_boolean_groups.drain().collect();
        ids.sort_by_key(|&id| std::cmp::Reverse(self.node_depth(id)));
        serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
    }

    /// Ids of every Boolean Group in the scene (JSON array). JS uses this after a
    /// document load to recompute all cached outlines (they aren't serialized).
    pub fn get_boolean_group_ids(&self) -> String {
        let mut v: Vec<u32> = self.boolean_groups.iter().copied().collect();
        v.sort_unstable();
        serde_json::to_string(&v).unwrap_or_else(|_| "[]".to_string())
    }

    /// Number of ancestors above `id` (0 for a root). Used to order boolean-group
    /// recomputation deepest-first.
    fn node_depth(&self, id: u32) -> u32 {
        let mut depth = 0;
        let mut cur = id;
        while let Some(node) = self.scene.nodes.get(&cur) {
            match node.parent {
                Some(p) => {
                    depth += 1;
                    cur = p;
                }
                None => break,
            }
        }
        depth
    }

    /// Replace a node's effects from a JSON array of `Effect` (serde-tagged,
    /// e.g. `[{"Blur":{"radius":6}}, {"DropShadow":{"dx":4,"dy":4,"blur":8,
    /// "color":{"r":0,"g":0,"b":0,"a":0.5}}}]`).
    pub fn set_node_effects(&mut self, id: u32, effects_json: &str) {
        let effects: Vec<Effect> = match serde_json::from_str(effects_json) {
            Ok(e) => e,
            Err(_) => return,
        };
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.style.effects = effects;
        } else {
            return;
        }
        self.mark_dirty(id);
    }

    /// A node's effects as a serde-tagged JSON array.
    pub fn get_node_effects(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| serde_json::to_string(&n.style.effects).unwrap_or_else(|_| "[]".into()))
            .unwrap_or_else(|| "[]".into())
    }

    fn update_spatial_index(&mut self, id: u32) {
        if let Some(old_node) = self.node_to_spatial.remove(&id) {
            self.spatial_index.remove(&old_node);
        }
        if let Some(spatial_node) = self.compute_spatial_node(id) {
            self.spatial_index.insert(spatial_node);
            self.node_to_spatial.insert(id, spatial_node);
        }
    }

    /// Compute a node's spatial-index AABB entry without mutating the index.
    /// Group bounds union descendant entries read from `node_to_spatial`, so
    /// callers must ensure a group's children are already recorded there before
    /// computing the group. Returns `None` when the node has no representable
    /// bounds (missing transform, or a non-empty group whose descendants
    /// produced no valid AABB).
    fn compute_spatial_node(&self, id: u32) -> Option<SpatialNode> {
        let is_group = self.scene.nodes.get(&id)
            .map(|n| matches!(n.node_type, NodeType::Group))
            .unwrap_or(false);

        if is_group {
            // A Boolean Group paints its cached outline and NOTHING else — the
            // operands are consumed by the op (see write_boolean_group_draw). Its
            // bounds must hug that outline, not the operand union: an intersect of
            // two shapes is smaller than either, and a subtract's hole leaves the
            // subtrahend entirely outside the painted result. Anything reading
            // bounds — selection frame, resize handles, align/distribute, spacing,
            // snapping — would otherwise work off a box the user cannot see.
            if let Some(aabb) = self.boolean_group_aabb(id) {
                return Some(SpatialNode { id, aabb });
            }

            // Group AABB = union of all descendant AABBs
            let children = self.scene.nodes.get(&id)
                .map(|n| n.children.clone())
                .unwrap_or_default();
            if children.is_empty() {
                // Empty group — use a point AABB at the group's position
                let transform_bytes = self.global_transforms.get(&id)?;
                let transform = Mat3::from_cols_array(transform_bytes);
                let p = transform.transform_point2(Vec2::ZERO);
                let aabb = AABB::from_corners([p.x, p.y], [p.x, p.y]);
                return Some(SpatialNode { id, aabb });
            }
            let mut min_x = f32::MAX;
            let mut min_y = f32::MAX;
            let mut max_x = f32::MIN;
            let mut max_y = f32::MIN;
            self.collect_descendant_bounds(id, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
            if min_x <= max_x && min_y <= max_y {
                let aabb = AABB::from_corners([min_x, min_y], [max_x, max_y]);
                return Some(SpatialNode { id, aabb });
            }
            return None;
        }

        let node = self.scene.nodes.get(&id)?;
        let transform_bytes = self.global_transforms.get(&id)?;
        {
            let transform = Mat3::from_cols_array(transform_bytes);
            let aabb = match node.geometry {
                // A rounded rect's corner arcs are tangent to its edges, so in
                // LOCAL space the sharp corners and the rounded outline share a
                // box — which is why the four corners were enough for years.
                // They stop agreeing the moment the box is measured after a
                // non-axis-aligned transform: rotate or skew the rect and the
                // acute corner tips, which the arcs cut away, become the extreme
                // points. Resolve the rounding exactly as the Path arm does so
                // the selection frame hugs the border the renderer draws.
                Geometry::Rect { width, height } if node.style.corner_radius > 1e-3 => {
                    let resolved = round_subpaths(&rect_subpaths(width, height, node.style.corner_radius));
                    let mut min_x = f32::MAX;
                    let mut min_y = f32::MAX;
                    let mut max_x = f32::MIN;
                    let mut max_y = f32::MIN;
                    for sp in &resolved {
                        for lp in &flatten_subpath(sp) {
                            let p = transform.transform_point2(*lp);
                            min_x = min_x.min(p.x);
                            min_y = min_y.min(p.y);
                            max_x = max_x.max(p.x);
                            max_y = max_y.max(p.y);
                        }
                    }
                    if min_x > max_x {
                        AABB::from_corners([0.0, 0.0], [0.0, 0.0])
                    } else {
                        AABB::from_corners([min_x, min_y], [max_x, max_y])
                    }
                }
                Geometry::Rect { width, height } | Geometry::Image { width, height, .. } => {
                    let p1 = transform.transform_point2(Vec2::new(0.0, 0.0));
                    let p2 = transform.transform_point2(Vec2::new(width, 0.0));
                    let p3 = transform.transform_point2(Vec2::new(0.0, height));
                    let p4 = transform.transform_point2(Vec2::new(width, height));

                    let min_x = p1.x.min(p2.x).min(p3.x).min(p4.x);
                    let min_y = p1.y.min(p2.y).min(p3.y).min(p4.y);
                    let max_x = p1.x.max(p2.x).max(p3.x).max(p4.x);
                    let max_y = p1.y.max(p2.y).max(p3.y).max(p4.y);

                    AABB::from_corners([min_x, min_y], [max_x, max_y])
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    let p = transform.transform_point2(Vec2::ZERO);
                    AABB::from_corners([p.x - radius_x, p.y - radius_y], [p.x + radius_x, p.y + radius_y])
                }
                Geometry::Path { ref subpaths, .. } => {
                    let mut min_x = f32::MAX;
                    let mut min_y = f32::MAX;
                    let mut max_x = f32::MIN;
                    let mut max_y = f32::MIN;
                    let mut has_points = false;
                    // Bounds must hug the *resolved* (corner-radius-rounded) outline —
                    // the same geometry the renderer emits. Using the raw sharp subpaths
                    // makes the selection/resize box overshoot to the sharp corner
                    // vertices, which sit outside the visible rounded border.
                    let resolved = round_subpaths(subpaths);
                    // Flatten each subpath into line segments so bounds
                    // reflect the actual curve, not the control polygon.
                    for sp in &resolved {
                        let flattened = flatten_subpath(sp);
                        for lp in &flattened {
                            has_points = true;
                            let p = transform.transform_point2(*lp);
                            min_x = min_x.min(p.x);
                            min_y = min_y.min(p.y);
                            max_x = max_x.max(p.x);
                            max_y = max_y.max(p.y);
                        }
                    }
                    if !has_points {
                        AABB::from_corners([0.0, 0.0], [0.0, 0.0])
                    } else {
                        AABB::from_corners([min_x, min_y], [max_x, max_y])
                    }
                }
                Geometry::Text { ref content, font_size, line_height, text_align, .. } => {
                    let [x0, y0, x1, y1] =
                        text_local_bbox(content, font_size, line_height, text_align);
                    let c = [
                        transform.transform_point2(Vec2::new(x0, y0)),
                        transform.transform_point2(Vec2::new(x1, y0)),
                        transform.transform_point2(Vec2::new(x0, y1)),
                        transform.transform_point2(Vec2::new(x1, y1)),
                    ];
                    let min_x = c.iter().fold(f32::MAX, |m, p| m.min(p.x));
                    let min_y = c.iter().fold(f32::MAX, |m, p| m.min(p.y));
                    let max_x = c.iter().fold(f32::MIN, |m, p| m.max(p.x));
                    let max_y = c.iter().fold(f32::MIN, |m, p| m.max(p.y));
                    AABB::from_corners([min_x, min_y], [max_x, max_y])
                }
            };

            Some(SpatialNode { id, aabb })
        }
    }

    /// Bounds of a Boolean Group's resolved outline as `[minX, minY, maxX, maxY]`,
    /// in local space when `transform` is `None` and world space otherwise.
    /// `None` when the node isn't a Boolean Group, or its `bool_cache` is empty —
    /// JS recomputes the outline after a snapshot load, so between the load and
    /// that pass the descendant union is the only bound available.
    ///
    /// Resolved exactly as the renderer resolves it: rounded, then flattened —
    /// so the box matches the pixels rather than the control polygon.
    fn boolean_outline_bounds(&self, id: u32, transform: Option<Mat3>) -> Option<[f32; 4]> {
        let node = self.scene.nodes.get(&id)?;
        node.boolean_op?;
        if node.bool_cache.is_empty() {
            return None;
        }

        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        let mut has_points = false;
        for sp in &round_subpaths(&node.bool_cache) {
            for lp in &flatten_subpath(sp) {
                has_points = true;
                let p = match transform {
                    Some(t) => t.transform_point2(*lp),
                    None => *lp,
                };
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);
            }
        }
        if !has_points {
            return None;
        }
        Some([min_x, min_y, max_x, max_y])
    }

    /// World AABB of a Boolean Group's resolved outline (see `boolean_outline_bounds`).
    fn boolean_group_aabb(&self, id: u32) -> Option<AABB<[f32; 2]>> {
        let transform_bytes = self.global_transforms.get(&id)?;
        let transform = Mat3::from_cols_array(transform_bytes);
        let b = self.boolean_outline_bounds(id, Some(transform))?;
        Some(AABB::from_corners([b[0], b[1]], [b[2], b[3]]))
    }

    /// A Boolean Group's outline bounds in its OWN local space, as
    /// `[minX, minY, maxX, maxY]` — empty when it isn't a Boolean Group with a
    /// usable cache. JS needs this for the oriented selection frame, which is
    /// built in local space and then transformed (so it can sit rotated).
    pub fn get_boolean_local_bounds(&self, id: u32) -> Vec<f32> {
        self.boolean_outline_bounds(id, None)
            .map(|b| b.to_vec())
            .unwrap_or_default()
    }

    /// Recursively collect AABB bounds of all descendants of a node.
    fn collect_descendant_bounds(&self, id: u32, min_x: &mut f32, min_y: &mut f32, max_x: &mut f32, max_y: &mut f32) {
        self.collect_descendant_bounds_bounded(id, min_x, min_y, max_x, max_y, 0);
    }

    /// Depth-bounded body of `collect_descendant_bounds`.
    ///
    /// `validate::repair` guarantees an acyclic graph on load, so the bound
    /// should be unreachable — but this runs on every spatial-index rebuild,
    /// and overflowing it traps the wasm instance and kills the editor outright.
    /// That is far too harsh a penalty for a bug in an invariant maintained
    /// elsewhere, so the recursion is capped the same way the render walk is.
    fn collect_descendant_bounds_bounded(&self, id: u32, min_x: &mut f32, min_y: &mut f32, max_x: &mut f32, max_y: &mut f32, depth: u32) {
        if depth > MAX_NODE_DEPTH {
            log_error(&format!("bounds: node {id} exceeds max nesting depth; subtree ignored"));
            return;
        }
        if let Some(node) = self.scene.nodes.get(&id) {
            for &child_id in &node.children {
                let is_child_group = self.scene.nodes.get(&child_id)
                    .map(|n| matches!(n.node_type, NodeType::Group))
                    .unwrap_or(false);
                if is_child_group {
                    // A nested Boolean Group contributes its resolved outline and
                    // not its operands — the same reason compute_spatial_node
                    // special-cases it, applied one level down.
                    if let Some(aabb) = self.boolean_group_aabb(child_id) {
                        let lower = aabb.lower();
                        let upper = aabb.upper();
                        *min_x = min_x.min(lower[0]);
                        *min_y = min_y.min(lower[1]);
                        *max_x = max_x.max(upper[0]);
                        *max_y = max_y.max(upper[1]);
                        continue;
                    }
                    // Recurse into child groups
                    self.collect_descendant_bounds_bounded(child_id, min_x, min_y, max_x, max_y, depth + 1);
                } else if let Some(spatial) = self.node_to_spatial.get(&child_id) {
                    let lower = spatial.aabb.lower();
                    let upper = spatial.aabb.upper();
                    *min_x = min_x.min(lower[0]);
                    *min_y = min_y.min(lower[1]);
                    *max_x = max_x.max(upper[0]);
                    *max_y = max_y.max(upper[1]);
                }
            }
        }
    }

    pub fn update_all_spatial_indices(&mut self) {
        self.spatial_index = RTree::new();
        self.node_to_spatial.clear();
        // Process nodes bottom-up (leaves before groups) so that group bounds
        // can read child entries from node_to_spatial, collecting every entry
        // and then packing the R-tree in one `bulk_load`. Inserting nodes one
        // at a time is O(n) per insert (so O(n²) for a full rebuild); bulk_load
        // builds a balanced tree in O(n log n), which is what makes creating or
        // loading tens of thousands of shapes tractable.
        let root_ids: Vec<u32> = self.scene.root_nodes.clone();
        let mut entries: Vec<SpatialNode> = Vec::with_capacity(self.scene.nodes.len());
        for id in root_ids {
            self.collect_spatial_bottom_up(id, &mut entries);
        }
        self.spatial_index = RTree::bulk_load(entries);
    }

    /// Bottom-up traversal that records each node's spatial entry in
    /// `node_to_spatial` (so parent groups can union their descendants) and
    /// appends it to `out` for a single `bulk_load`. Does not touch the R-tree.
    fn collect_spatial_bottom_up(&mut self, id: u32, out: &mut Vec<SpatialNode>) {
        self.collect_spatial_bottom_up_bounded(id, out, 0);
    }

    /// Depth-bounded body of `collect_spatial_bottom_up`. Same reasoning as
    /// `collect_descendant_bounds_bounded`: repair should make this
    /// unreachable, but a stack overflow here is unrecoverable rather than
    /// merely wrong.
    fn collect_spatial_bottom_up_bounded(&mut self, id: u32, out: &mut Vec<SpatialNode>, depth: u32) {
        if depth > MAX_NODE_DEPTH {
            log_error(&format!("spatial: node {id} exceeds max nesting depth; subtree skipped"));
            return;
        }
        let children: Vec<u32> = self.scene.nodes.get(&id)
            .map(|n| n.children.clone())
            .unwrap_or_default();
        for child_id in children {
            self.collect_spatial_bottom_up_bounded(child_id, out, depth + 1);
        }
        if let Some(spatial_node) = self.compute_spatial_node(id) {
            self.node_to_spatial.insert(id, spatial_node);
            out.push(spatial_node);
        }
    }

    pub fn set_node_name(&mut self, id: u32, name: &str) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.name = name.to_string();
        }
    }

    pub fn remove_node(&mut self, id: u32) {
        // Removing a member (or the group itself) changes a Live Paint network,
        // so invalidate it while the node still exists to be classified.
        if self.is_in_any_live_paint(id) {
            self.scene.vector_network.dirty = true;
        }
        // Removing an operand (or the group) makes the enclosing boolean group's
        // outline stale — flag before the node is gone so ancestors resolve.
        self.mark_enclosing_boolean_groups_dirty(id);
        // Drop from the group cache and the paint scope; descendants are cleared
        // by the recursion below.
        self.forget_live_paint_group(id);
        self.boolean_groups.remove(&id);
        self.dirty_boolean_groups.remove(&id);
        if let Some(node) = self.scene.nodes.remove(&id) {
            if let Some(parent_id) = node.parent {
                if let Some(parent) = self.scene.nodes.get_mut(&parent_id) {
                    parent.children.retain(|&c| c != id);
                }
            } else {
                self.scene.root_nodes.retain(|&r| r != id);
            }

            self.scene.selection.retain(|&s| s != id);
            self.global_transforms.remove(&id);
            self.dirty_flags.remove(&id);
            if let Some(old_node) = self.node_to_spatial.remove(&id) {
                self.spatial_index.remove(&old_node);
            }

            let children = node.children.clone();
            for child_id in children {
                self.remove_node(child_id);
            }
        }
    }

    /// Restore a scene from a protobuf snapshot (history/undo/drag-restore).
    /// Returns false — and leaves the scene untouched — if the bytes don't
    /// decode. A silent failure here breaks undo invisibly, so callers should
    /// surface it.
    pub fn deserialize_scene(&mut self, data: &[u8]) -> bool {
        match proto::deserialize_snapshot(data) {
            Some((scene, next_id)) => {
                self.scene = scene;
                // Undo restores the snapshot's counter verbatim, which keeps a
                // snapshot round-trip byte-identical. Non-recycling is handled
                // by `id_high_water` in `alloc_id`, which this deliberately
                // does not touch.
                self.next_id = counter_of(next_id).max(self.own_site_high_counter() + 1);
                self.update_all_global_transforms();
                self.update_all_spatial_indices();
                self.rebuild_live_paint_cache();
                self.rebuild_boolean_groups_cache();
                true
            }
            None => {
                log_error("deserialize_scene failed: snapshot did not decode");
                false
            }
        }
    }

    pub fn set_parent(&mut self, child_id: u32, parent_id: Option<u32>) -> bool {
        // Validate both nodes exist
        if !self.scene.nodes.contains_key(&child_id) {
            return false;
        }
        if let Some(pid) = parent_id {
            if !self.scene.nodes.contains_key(&pid) {
                return false;
            }
            // Prevent cycles
            if self.is_ancestor(child_id, pid) {
                return false;
            }
        }

        // Remove from old parent
        let old_parent = self.scene.nodes.get(&child_id).and_then(|n| n.parent);
        if let Some(old_pid) = old_parent {
            if let Some(old_p) = self.scene.nodes.get_mut(&old_pid) {
                old_p.children.retain(|&c| c != child_id);
            }
        } else {
            self.scene.root_nodes.retain(|&r| r != child_id);
        }

        // Set new parent
        if let Some(node) = self.scene.nodes.get_mut(&child_id) {
            node.parent = parent_id;
        }

        if let Some(pid) = parent_id {
            if let Some(p) = self.scene.nodes.get_mut(&pid) {
                p.children.push(child_id);
            }
        } else {
            self.scene.root_nodes.push(child_id);
        }

        self.update_node_global_transform(child_id);
        self.update_spatial_index_recursive(child_id);

        // Reparenting into or out of a Live Paint group changes its network.
        if self.is_in_any_live_paint(child_id)
            || old_parent.map_or(false, |p| self.is_in_any_live_paint(p)) {
            self.scene.vector_network.dirty = true;
        }
        // Same nesting rule as the panel drag: see clear_nested_live_paint_flags.
        self.clear_nested_live_paint_flags();
        true
    }

    fn is_ancestor(&self, ancestor_id: u32, node_id: u32) -> bool {
        if ancestor_id == node_id { return true; }
        let mut current = node_id;
        while let Some(node) = self.scene.nodes.get(&current) {
            if let Some(parent_id) = node.parent {
                if parent_id == ancestor_id { return true; }
                current = parent_id;
            } else {
                break;
            }
        }
        false
    }

    pub fn update_all_global_transforms(&mut self) {
        let mut transforms = HashMap::new();
        for &id in &self.scene.root_nodes {
            Self::compute_global_transform_recursive(&self.scene.nodes, id, Mat3::IDENTITY, &mut transforms);
        }
        self.global_transforms = transforms;
    }

    /// Consolidates the four-call tail after any local transform mutation.
    fn after_local_transform_change(&mut self, id: u32) {
        self.update_node_global_transform(id);
        self.update_spatial_index_recursive(id);
        self.update_ancestor_group_bounds(id);
        self.mark_dirty(id);
    }

    fn update_node_global_transform(&mut self, id: u32) {
        let parent_transform = if let Some(node) = self.scene.nodes.get(&id) {
            if let Some(pid) = node.parent {
                self.global_transforms.get(&pid)
                    .map(|&m| Mat3::from_cols_array(&m))
                    .unwrap_or(Mat3::IDENTITY)
            } else {
                Mat3::IDENTITY
            }
        } else {
            return;
        };

        Self::compute_global_transform_recursive(&self.scene.nodes, id, parent_transform, &mut self.global_transforms);
    }

    /// Pre-order walk of the subtree at `id`, composing global transforms.
    ///
    /// Iterative with an explicit stack, and it refuses to visit a node twice.
    /// Both properties are load-bearing rather than stylistic: the recursive
    /// version stack-overflowed — an unrecoverable wasm trap, not a catchable
    /// error — on both a parent/child cycle and on legitimately deep nesting,
    /// and a scene can reach this code from paths that never went through
    /// `validate::repair` (an undo snapshot, or a mid-edit mutation).
    fn compute_global_transform_recursive(nodes: &HashMap<u32, Node>, id: u32, parent_transform: Mat3, transforms: &mut HashMap<u32, [f32; 9]>) {
        let mut stack = vec![(id, parent_transform)];
        let mut visited = HashSet::new();
        while let Some((node_id, parent)) = stack.pop() {
            if !visited.insert(node_id) {
                continue;
            }
            let Some(node) = nodes.get(&node_id) else { continue };
            let global_transform = parent * node.transform.to_mat3();
            // Store in glam's native column-major format
            transforms.insert(node_id, global_transform.to_cols_array());
            for &child_id in &node.children {
                stack.push((child_id, global_transform));
            }
        }
    }

    /// Post-order walk of the subtree at `id`, refreshing spatial index entries
    /// children-first so a group unions AABBs that are already current.
    ///
    /// Iterative and cycle-guarded, for the same reason as the transform walk.
    fn update_spatial_index_recursive(&mut self, id: u32) {
        // Collect the post-order sequence first, then apply it. Doing both in
        // one pass would need a mutable borrow of the scene while still walking
        // it.
        let mut order: Vec<u32> = Vec::new();
        let mut stack = vec![(id, false)];
        let mut visited = HashSet::new();
        while let Some((node_id, children_done)) = stack.pop() {
            if children_done {
                order.push(node_id);
                continue;
            }
            if !visited.insert(node_id) {
                continue;
            }
            let Some(node) = self.scene.nodes.get(&node_id) else { continue };
            stack.push((node_id, true));
            for &child_id in &node.children {
                stack.push((child_id, false));
            }
        }
        for node_id in order {
            self.update_spatial_index(node_id);
        }
    }

    /// Walk up the parent chain and re-update spatial index for each Group ancestor.
    ///
    /// The visited set matters here too, but the failure mode is different: a
    /// cycle in `parent` links makes this loop *forever* rather than overflow,
    /// hanging the tab with no crash to diagnose.
    fn update_ancestor_group_bounds(&mut self, id: u32) {
        let mut current = id;
        let mut visited = HashSet::from([id]);
        while let Some(parent_id) = self.scene.nodes.get(&current).and_then(|n| n.parent) {
            if !visited.insert(parent_id) {
                break;
            }
            let is_group = self.scene.nodes.get(&parent_id)
                .map(|n| matches!(n.node_type, NodeType::Group))
                .unwrap_or(false);
            if is_group {
                self.update_spatial_index(parent_id);
            }
            current = parent_id;
        }
    }

    pub fn move_node(&mut self, id: u32, dx: f32, dy: f32) {
        if !dx.is_finite() || !dy.is_finite() {
            return;
        }
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.transform.x += dx;
            node.transform.y += dy;
        }
        self.after_local_transform_change(id);
    }

    /// Move many nodes at once, each by its own delta.
    ///
    /// `moves_json` is `[{"id":1,"dx":2.0,"dy":3.0}, ...]`. Deltas are per-node
    /// because a drag converts one world delta into a different local delta for
    /// every node (each may sit under a differently-transformed parent).
    ///
    /// This exists for complexity, not tidiness. `move_node` finishes by
    /// re-unioning every group ancestor's AABB, and a group's AABB is the union
    /// of ALL its descendants — so moving N children of one group costs N × O(N).
    /// A 4000-node drag frame measured 436ms that way. Here the translations are
    /// applied first, then each distinct group ancestor is refreshed exactly
    /// once, deepest first so a parent's union reads its children's fresh
    /// entries. That makes a drag frame linear in the number of moved nodes.
    pub fn move_nodes(&mut self, moves_json: &str) {
        #[derive(Deserialize)]
        struct NodeMove {
            id: u32,
            dx: f32,
            dy: f32,
        }
        let moves: Vec<NodeMove> = match serde_json::from_str(moves_json) {
            Ok(v) => v,
            Err(_) => return,
        };

        let mut touched: Vec<u32> = Vec::with_capacity(moves.len());
        for m in &moves {
            if !m.dx.is_finite() || !m.dy.is_finite() {
                continue;
            }
            if let Some(node) = self.scene.nodes.get_mut(&m.id) {
                node.transform.x += m.dx;
                node.transform.y += m.dy;
                touched.push(m.id);
            }
        }
        if touched.is_empty() {
            return;
        }

        // Each moved subtree: globals, then its own spatial entries.
        for &id in &touched {
            self.update_node_global_transform(id);
            self.update_spatial_index_recursive(id);
            self.mark_dirty(id);
        }

        // Collect the distinct group ancestors and how deep each sits.
        let mut ancestors: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
        for &id in &touched {
            let mut current = id;
            while let Some(parent_id) = self.scene.nodes.get(&current).and_then(|n| n.parent) {
                let is_group = self.scene.nodes.get(&parent_id)
                    .map(|n| matches!(n.node_type, NodeType::Group))
                    .unwrap_or(false);
                if is_group && !ancestors.contains_key(&parent_id) {
                    ancestors.insert(parent_id, self.depth_from_root(parent_id));
                }
                current = parent_id;
            }
        }

        // Deepest first: a group's union reads `node_to_spatial` for its
        // descendants, so children must already be up to date.
        let mut ordered: Vec<(u32, u32)> = ancestors.into_iter().collect();
        ordered.sort_by(|a, b| b.1.cmp(&a.1));
        for (group_id, _) in ordered {
            self.update_spatial_index(group_id);
        }
    }

    /// Number of parent links between `id` and the root.
    fn depth_from_root(&self, id: u32) -> u32 {
        let mut depth = 0;
        let mut current = id;
        while let Some(parent_id) = self.scene.nodes.get(&current).and_then(|n| n.parent) {
            depth += 1;
            current = parent_id;
        }
        depth
    }

    pub fn bring_to_front(&mut self, id: u32) {
        let parent_id = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(pid) = parent_id {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                if let Some(pos) = parent.children.iter().position(|&x| x == id) {
                    parent.children.remove(pos);
                    parent.children.push(id);
                }
            }
        } else {
            if let Some(pos) = self.scene.root_nodes.iter().position(|&x| x == id) {
                self.scene.root_nodes.remove(pos);
                self.scene.root_nodes.push(id);
            }
        }
    }

    pub fn send_to_back(&mut self, id: u32) {
        let parent_id = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(pid) = parent_id {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                if let Some(pos) = parent.children.iter().position(|&x| x == id) {
                    parent.children.remove(pos);
                    parent.children.insert(0, id);
                }
            }
        } else {
            if let Some(pos) = self.scene.root_nodes.iter().position(|&x| x == id) {
                self.scene.root_nodes.remove(pos);
                self.scene.root_nodes.insert(0, id);
            }
        }
    }

    pub fn bring_forward(&mut self, id: u32) {
        let parent_id = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(pid) = parent_id {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                if let Some(pos) = parent.children.iter().position(|&x| x == id) {
                    if pos + 1 < parent.children.len() {
                        parent.children.swap(pos, pos + 1);
                    }
                }
            }
        } else {
            if let Some(pos) = self.scene.root_nodes.iter().position(|&x| x == id) {
                if pos + 1 < self.scene.root_nodes.len() {
                    self.scene.root_nodes.swap(pos, pos + 1);
                }
            }
        }
    }

    pub fn send_backward(&mut self, id: u32) {
        let parent_id = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(pid) = parent_id {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                if let Some(pos) = parent.children.iter().position(|&x| x == id) {
                    if pos > 0 {
                        parent.children.swap(pos, pos - 1);
                    }
                }
            }
        } else {
            if let Some(pos) = self.scene.root_nodes.iter().position(|&x| x == id) {
                if pos > 0 {
                    self.scene.root_nodes.swap(pos, pos - 1);
                }
            }
        }
    }

    /// Move `node_id` to become a child of `new_parent` (or a root when `None`),
    /// inserted at `index` among its new siblings. The node's global (visual)
    /// position is preserved by recomputing its local transform. Returns false
    /// if the move is invalid (missing node, non-group parent, or a cycle).
    ///
    /// `index` is a raw position in the parent's `children` vec (or `root_nodes`),
    /// where 0 is the back-most (bottom of z-order). The layer panel renders in
    /// reverse, so the UI is responsible for translating a visual drop position
    /// into this bottom-up index.
    pub fn reorder_node(&mut self, node_id: u32, new_parent: Option<u32>, index: usize) -> bool {
        self.reorder_many(&[node_id], new_parent, index) == 1
    }

    /// Batch variant of [`reorder_node`]. Moves every node in `ids_json` (a JSON
    /// array of ids, given in bottom-up z-order) so they become contiguous
    /// siblings under `new_parent` (or roots when `None`), starting at `index`.
    /// Their relative order is preserved. Nodes that fail validation (missing,
    /// non-group parent, or a cycle) are skipped. Returns the number moved.
    pub fn reorder_nodes(&mut self, ids_json: &str, new_parent: Option<u32>, index: usize) -> u32 {
        let ids: Vec<u32> = serde_json::from_str(ids_json).unwrap_or_default();
        self.reorder_many(&ids, new_parent, index)
    }

    /// Shared implementation for [`reorder_node`] / [`reorder_nodes`].
    ///
    /// `index` is a raw position in the destination's `children` vec (or
    /// `root_nodes`) *after* the moved nodes have been removed, where 0 is the
    /// back-most (bottom of z-order). The layer panel renders in reverse, so the
    /// UI is responsible for translating a visual drop position into this index.
    fn reorder_many(&mut self, ids: &[u32], new_parent: Option<u32>, index: usize) -> u32 {
        // Validate the destination parent once (groups only, no cycle).
        // Keep only nodes that exist and can legally move under `new_parent`.
        let mut valid: Vec<u32> = Vec::with_capacity(ids.len());
        for &id in ids {
            if !self.scene.nodes.contains_key(&id) {
                continue;
            }
            if let Some(pid) = new_parent {
                let is_group = matches!(
                    self.scene.nodes.get(&pid).map(|n| &n.node_type),
                    Some(NodeType::Group)
                );
                // Only groups can hold children; and a node can't be moved into
                // itself or one of its own descendants (is_ancestor is true when
                // id == pid or id is an ancestor of pid).
                if !is_group || self.is_ancestor(id, pid) {
                    continue;
                }
            }
            if !valid.contains(&id) {
                valid.push(id);
            }
        }
        if valid.is_empty() {
            return 0;
        }

        // A node dragged OUT of a Live Paint group must stop cutting that
        // group's regions. `mark_dirty` below only sees where the node landed,
        // so a move to the root looks like an edit outside every group and left
        // the departed shape's segments in the network — the group kept faces
        // split along an outline that is no longer part of it. Classify before
        // the move, while the node still sits in its old parent.
        let left_live_paint = valid.iter().any(|&id| self.is_in_any_live_paint(id));

        // An operand dragged OUT of a boolean group leaves that group's cached
        // outline describing a shape it no longer contains — the operand went on
        // drawing as part of the boolean AND on its own. `mark_dirty` below only
        // reaches the chain the node landed in, so flag the one it is leaving
        // while it is still attached to it. (Deleting an operand and dropping
        // one in were already covered; only moving one out was not.)
        for &id in &valid {
            self.mark_enclosing_boolean_groups_dirty(id);
        }

        // Compute each node's new local transform up front from the *current*
        // globals, so the visual position is preserved: new_local = parent⁻¹ * global.
        let new_parent_global = match new_parent {
            Some(pid) => self.global_transforms.get(&pid)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY),
            None => Mat3::IDENTITY,
        };
        let inv_parent = new_parent_global.inverse();
        let locals: Vec<(u32, Transform2D)> = valid.iter().map(|&id| {
            let g = self.global_transforms.get(&id)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY);
            let hint = self.scene.nodes.get(&id).map(|n| &n.transform);
            (id, Transform2D::from_mat3_hint(&(inv_parent * g), hint))
        }).collect();

        // Remove all moved nodes from their current parents / root list.
        let mut old_parents: Vec<u32> = Vec::new();
        for &id in &valid {
            let old_parent = self.scene.nodes.get(&id).and_then(|n| n.parent);
            if let Some(old_pid) = old_parent {
                if let Some(old_p) = self.scene.nodes.get_mut(&old_pid) {
                    old_p.children.retain(|&c| c != id);
                }
                if !old_parents.contains(&old_pid) {
                    old_parents.push(old_pid);
                }
            } else {
                self.scene.root_nodes.retain(|&r| r != id);
            }
        }

        // Re-parent and insert contiguously, preserving `valid` order.
        for (i, (id, local)) in locals.iter().enumerate() {
            if let Some(node) = self.scene.nodes.get_mut(id) {
                node.parent = new_parent;
                node.transform = *local;
            }
            match new_parent {
                Some(pid) => {
                    if let Some(p) = self.scene.nodes.get_mut(&pid) {
                        let pos = (index + i).min(p.children.len());
                        p.children.insert(pos, *id);
                    }
                }
                None => {
                    let pos = (index + i).min(self.scene.root_nodes.len());
                    self.scene.root_nodes.insert(pos, *id);
                }
            }
        }

        // Refresh transforms and spatial indices for the moved nodes and both the
        // old and new ancestor group chains.
        for &id in &valid {
            self.update_node_global_transform(id);
            self.update_spatial_index_recursive(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
        for &old_pid in &old_parents {
            let is_group = self.scene.nodes.get(&old_pid)
                .map(|n| matches!(n.node_type, NodeType::Group))
                .unwrap_or(false);
            if is_group {
                self.update_spatial_index(old_pid);
            }
            self.update_ancestor_group_bounds(old_pid);
        }
        if left_live_paint {
            self.scene.vector_network.dirty = true;
        }
        // A flagged group dragged INTO a flagged one is nested now even though
        // its own flag was legal where it was set.
        self.clear_nested_live_paint_flags();
        valid.len() as u32
    }

    pub fn get_scene_json(&self) -> String {
        serde_json::to_string(&self.scene).unwrap_or_default()
    }

    // ─── Per-Node Getters (avoid full-scene JSON serialization) ─────────

    /// Get a single node's full data as JSON. Used by UI panels.
    pub fn get_node_json(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| serde_json::to_string(n).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Get a node's style as JSON.
    pub fn get_node_style_json(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| serde_json::to_string(&n.style).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Get a node's geometry as JSON.
    pub fn get_node_geometry_json(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| serde_json::to_string(&n.geometry).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Resolve a Path node's per-vertex corner radii into an explicit rounded
    /// outline and return it as JSON subpaths. Non-path geometry (or a path
    /// with no rounding) yields the plain subpaths. Consumed by SVG export and
    /// boolean ops so their output matches the rendered (rounded) shape.
    pub fn resolve_subpaths_json(&self, id: u32) -> String {
        let resolved = self.scene.nodes.get(&id).and_then(|n| match &n.geometry {
            Geometry::Path { subpaths, .. } => Some(round_subpaths(subpaths)),
            _ => None,
        });
        match resolved {
            Some(s) => serde_json::to_string(&s).unwrap_or_else(|_| "[]".into()),
            None => "[]".into(),
        }
    }

    /// Get a node's name.
    pub fn get_node_name(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| n.name.clone())
            .unwrap_or_default()
    }

    /// Get a node's visible flag.
    pub fn get_node_visible(&self, id: u32) -> bool {
        self.scene.nodes.get(&id).map(|n| n.visible).unwrap_or(false)
    }

    /// True when this node OR any ancestor is locked. The raw flag is not
    /// enough for anything interactive: locking a group is meant to protect its
    /// contents, so every "can the user grab this?" test has to read the chain.
    pub fn is_locked_in_tree(&self, id: u32) -> bool {
        self.flag_in_tree(id, |n| n.locked)
    }

    /// True when this node and every ancestor is visible — what the user can
    /// actually see, as opposed to the node's own flag.
    pub fn is_visible_in_tree(&self, id: u32) -> bool {
        !self.flag_in_tree(id, |n| !n.visible)
    }

    /// Walk `id` and its ancestors, returning true as soon as `pred` holds.
    /// Depth-capped like the render and bounds walks: a cycle here would hang
    /// the tab rather than crash it.
    fn flag_in_tree(&self, id: u32, pred: fn(&Node) -> bool) -> bool {
        let mut current = Some(id);
        let mut depth = 0;
        while let Some(cid) = current {
            depth += 1;
            if depth > MAX_NODE_DEPTH {
                log_error(&format!("flag walk: node {id} exceeds max nesting depth"));
                return false;
            }
            match self.scene.nodes.get(&cid) {
                Some(node) => {
                    if pred(node) {
                        return true;
                    }
                    current = node.parent;
                }
                None => return false,
            }
        }
        false
    }

    /// Get a node's locked flag.
    pub fn get_node_locked(&self, id: u32) -> bool {
        self.scene.nodes.get(&id).map(|n| n.locked).unwrap_or(false)
    }

    /// Get a node's children IDs.
    pub fn get_node_children(&self, id: u32) -> Vec<u32> {
        self.scene.nodes.get(&id)
            .map(|n| n.children.clone())
            .unwrap_or_default()
    }

    /// Get root node IDs.
    pub fn get_root_nodes(&self) -> Vec<u32> {
        self.scene.root_nodes.clone()
    }

    /// Get a node's transform as a Vec<f32> (column-major, 9 elements).
    /// Used by SVG export which needs the local transform, not the global one.
    pub fn get_node_local_transform(&self, id: u32) -> Vec<f32> {
        self.scene.nodes.get(&id)
            .map(|n| n.transform.to_mat3().to_cols_array().to_vec())
            .unwrap_or_else(|| vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])
    }

    // ─── End Per-Node Getters ───────────────────────────────────────────

    pub fn serialize_scene(&self) -> Vec<u8> {
        proto::serialize_snapshot(&self.scene, self.next_id)
    }

    /// Returns a pointer to a 9-element f32 array in Skia row-major format.
    /// This transposes from the internal column-major storage.
    pub fn get_node_transform_ptr(&mut self, id: u32) -> *const f32 {
        if let Some(transform) = self.global_transforms.get(&id) {
            let m = *transform; // column-major
            // Transpose to row-major for CanvasKit/Skia
            self.transform_out_buf = [
                m[0], m[3], m[6], // Row 0: scaleX, skewX, transX
                m[1], m[4], m[7], // Row 1: skewY, scaleY, transY  
                m[2], m[5], m[8], // Row 2: pers0, pers1, pers2
            ];
            self.transform_out_buf.as_ptr()
        } else {
            std::ptr::null()
        }
    }

    /// The node a click at this world point lands on, topmost first.
    ///
    /// Takes `&mut self` for one reason: inside a Live Paint group the question
    /// "is this point painted?" is answered by the FACES, and those have to be
    /// current before it can be asked. Documents with no Live Paint group skip
    /// that entirely and this is a pure read.
    pub fn hit_test(&mut self, x: f32, y: f32) -> Option<u32> {
        if self.has_live_paint() {
            self.ensure_network_clean();
        }
        self.pick_at(x, y)
    }

    fn pick_at(&self, x: f32, y: f32) -> Option<u32> {
        // Walk the scene in reverse draw order (topmost first) and return the first hit.
        // This ensures we always pick the visually topmost element.
        let point = [x, y];
        
        // Quick spatial filter first
        let candidate_ids: std::collections::HashSet<u32> = self.spatial_index
            .locate_all_at_point(&point)
            .map(|n| n.id)
            .collect();
        
        if candidate_ids.is_empty() {
            return None;
        }

        // Walk scene tree in draw order, collect into flat list
        let mut draw_order = Vec::new();
        for &root_id in &self.scene.root_nodes {
            self.collect_draw_order(root_id, &mut draw_order);
        }

        // "Does this Live Paint group paint anything here?" is one question per
        // group, asked by every member and by the group itself. Answering it
        // walks the group's faces, so answer it once.
        let mut lp_painted: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();

        // Iterate in reverse (topmost first)
        for &id in draw_order.iter().rev() {
            // A Live Paint group is picked through its own faces, so it is
            // tested even though a group is not in the R-tree. Everything else
            // has to be a spatial candidate.
            let is_lp_group = self.scene.nodes.get(&id).map_or(false, |n| n.live_paint);
            if !is_lp_group && !candidate_ids.contains(&id) { continue; }

            // A node without a resolved global transform is mid-edit and not on
            // screen; `point_in_geometry` needs one either way.
            if let (Some(node), true) = (self.scene.nodes.get(&id), self.global_transforms.contains_key(&id)) {
                if !node.visible { continue; }
                if node.locked { continue; }
                
                // A Group is never hit as itself — its leaves are — with two
                // exceptions. A Boolean Group IS a leaf as far as the canvas is
                // concerned: it paints one resolved outline and its operands are
                // never drawn, so it is picked through that outline. Its children
                // don't reach this loop at all (collect_draw_order stops at the
                // group), which is what keeps a click in a subtract's hole, or
                // beside an intersection, from selecting the shape.
                //
                // A Live Paint group is the other: the colour in one belongs to
                // its FACES, which are the group's, not any member's. A region
                // painted between two crossing lines lies inside no member at
                // all — without this, clicking the paint you just applied
                // selected whatever was behind the group.
                if node.node_type == NodeType::Group && node.boolean_op.is_none() {
                    if node.live_paint
                        && *lp_painted.entry(id).or_insert_with(|| self.lp_paint_at(id, x, y))
                        && self.inside_group_mask(id, x, y)
                        && !self.masked_away(id, x, y)
                    {
                        return Some(id);
                    }
                    continue;
                }

                // Inside a Live Paint group a member paints NO fill of its own —
                // the face pass provides the interior colour — so its interior
                // picks it only where the group actually paints something. Its
                // outline (and stroke) is drawn either way and always picks it.
                // Without this an unpainted region swallowed every click over it,
                // and nothing behind the group could be reached.
                let hit = match self.lp_surface_member(id) {
                    Some(group) => {
                        self.point_on_outline(id, x, y)
                            || (self.point_in_geometry(id, x, y)
                                && *lp_painted
                                    .entry(group)
                                    .or_insert_with(|| self.lp_paint_at(group, x, y)))
                    }
                    None => self.point_in_geometry(id, x, y),
                };

                // Masked-away artwork is not painted, so it is not clickable
                // either — see `masked_away`.
                if hit && !self.masked_away(id, x, y) {
                    return Some(id);
                }
            }
        }
        None
    }

    /// The Live Paint group whose face pass replaces this node's own fill, if
    /// any. Mirrors the renderer's `suppress_fills` exactly — the two must agree
    /// or the editor picks something it never painted.
    ///
    /// Only shapes that CONTRIBUTE contours to the surface are suppressed: text
    /// and images add no segments (see `collect_segments`), so there is no face
    /// standing in for their fill and taking it away would simply erase them.
    /// A mask is the other exception — see the renderer for why.
    fn lp_surface_member(&self, id: u32) -> Option<u32> {
        let node = self.scene.nodes.get(&id)?;
        // A group carries a 0×0 Rect geometry it never paints; only leaves are
        // members of the surface.
        if node.node_type == NodeType::Group {
            return None;
        }
        if !matches!(
            node.geometry,
            Geometry::Path { .. } | Geometry::Rect { .. } | Geometry::Ellipse { .. }
        ) {
            return None;
        }
        if self.is_within_mask(id) {
            return None;
        }
        let group = self.live_paint_group_of(id)?;
        (group != id).then_some(group)
    }

    /// Does Live Paint group `group` paint anything at this world point?
    ///
    /// A face counts when it carries a visible paint — the one the user
    /// bucketed on, or the one it inherits from the shape showing through, the
    /// same resolution `live_paint_faces_effective` renders with. An unpainted
    /// (or fully transparent) region paints nothing, and nothing is what the
    /// canvas shows there.
    fn lp_paint_at(&self, group: u32, x: f32, y: f32) -> bool {
        let vn = &self.scene.vector_network;
        let face = match vn.query_face_at_in_group(x, y, Some(group)) {
            Some(fid) => match vn.faces.get(&fid) {
                Some(f) => f,
                None => return false,
            },
            None => return false,
        };
        let paint = match &face.fill {
            Some(p) => Some(p.clone()),
            None => {
                let order = self.draw_order();
                let rank: std::collections::HashMap<u32, usize> =
                    order.iter().enumerate().map(|(i, &id)| (id, i)).collect();
                self.inherited_face_paint(face, &rank)
            }
        };
        paint.map_or(false, |p| paint_is_visible(&p))
    }

    /// True when the point is inside a mask a group's own children impose (or
    /// there is none). A Live Paint group's faces render INSIDE that mask span,
    /// so paint outside it is not on the canvas.
    fn inside_group_mask(&self, group: u32, x: f32, y: f32) -> bool {
        let node = match self.scene.nodes.get(&group) {
            Some(n) => n,
            None => return true,
        };
        let mut masks = node.children.iter().copied().filter(|&c| self.acts_as_mask(c)).peekable();
        if masks.peek().is_none() {
            return true;
        }
        masks.any(|m| self.point_in_geometry(m, x, y))
    }

    /// Does the point land on this node's OUTLINE (its stroke, plus the pick
    /// tolerance) rather than its interior? This is what a shape with no fill
    /// answers to `point_in_geometry`; primitives get the same treatment here
    /// because inside a Live Paint group they have no fill either.
    fn point_on_outline(&self, id: u32, x: f32, y: f32) -> bool {
        let (node, transform_bytes) =
            match (self.scene.nodes.get(&id), self.global_transforms.get(&id)) {
                (Some(n), Some(t)) => (n, t),
                _ => return false,
            };
        let global_transform = Mat3::from_cols_array(transform_bytes);
        let local_point = global_transform.inverse().transform_point2(Vec2::new(x, y));
        let det = (global_transform.x_axis.x * global_transform.y_axis.y
            - global_transform.x_axis.y * global_transform.y_axis.x)
            .abs();
        let local_tol = HIT_TOLERANCE / det.sqrt().max(1e-6);
        // The same style minus its fills: `path_hit` then tests the outline only.
        let mut style = node.style.clone();
        style.fills.clear();
        match &node.geometry {
            Geometry::Rect { width, height } => path_hit(
                &round_subpaths(&rect_subpaths(*width, *height, node.style.corner_radius)),
                &style,
                local_point,
                local_tol,
            ),
            Geometry::Path { ref subpaths, .. } => {
                path_hit(subpaths, &style, local_point, local_tol)
            }
            Geometry::Ellipse { radius_x, radius_y } => {
                // Distance to the ellipse, near enough: the normalised radius
                // scaled back by the smaller semi-axis.
                let rx = radius_x.abs().max(1e-6);
                let ry = radius_y.abs().max(1e-6);
                let k = ((local_point.x / rx).powi(2) + (local_point.y / ry).powi(2)).sqrt();
                let reach = style.strokes.iter()
                    .filter(|s| s.paint.is_some())
                    .map(|s| s.width)
                    .fold(0.0f32, f32::max) * 0.5 + local_tol;
                ((k - 1.0).abs() * rx.min(ry)) <= reach
            }
            // Text and images are never surface members (see `lp_surface_member`),
            // so this is unreachable for them; answer for the whole shape rather
            // than silently making one unclickable.
            _ => self.point_in_geometry(id, x, y),
        }
    }

    /// Does the world point land on this node's own painted geometry?
    ///
    /// Ignores visibility, locking and masks — those are the caller's business.
    /// A Boolean Group answers for its resolved outline; a plain group paints
    /// nothing itself, so it answers for any visible descendant, which is what
    /// lets a group be used as a mask shape.
    fn point_in_geometry(&self, id: u32, x: f32, y: f32) -> bool {
        let (node, transform_bytes) =
            match (self.scene.nodes.get(&id), self.global_transforms.get(&id)) {
                (Some(n), Some(t)) => (n, t),
                _ => return false,
            };
        let global_transform = Mat3::from_cols_array(transform_bytes);
        let local_point = global_transform.inverse().transform_point2(Vec2::new(x, y));

        // Local-space tolerance: HIT_TOLERANCE is in world pixels, so
        // divide by the transform's average scale factor.
        let local_tol = {
            let det = (global_transform.x_axis.x * global_transform.y_axis.y
                - global_transform.x_axis.y * global_transform.y_axis.x)
                .abs();
            HIT_TOLERANCE / det.sqrt().max(1e-6)
        };

        if node.node_type == NodeType::Group {
            if node.boolean_op.is_some() {
                return path_hit(&node.bool_cache, &node.style, local_point, local_tol);
            }
            return node.children.iter().any(|&c| {
                self.scene.nodes.get(&c).map_or(false, |n| n.visible)
                    && self.point_in_geometry(c, x, y)
            });
        }

        match node.geometry {
            Geometry::Rect { width, height } | Geometry::Image { width, height, .. } => {
                local_point.x >= 0.0 && local_point.x <= width &&
                local_point.y >= 0.0 && local_point.y <= height
            },
            Geometry::Ellipse { radius_x, radius_y } => {
                let dx = local_point.x;
                let dy = local_point.y;
                (dx * dx) / (radius_x * radius_x) + (dy * dy) / (radius_y * radius_y) <= 1.0
            },
            Geometry::Path { ref subpaths, .. } => {
                // Precise geometric test against the actual outline.
                path_hit(subpaths, &node.style, local_point, local_tol)
            },
            Geometry::Text { ref content, font_size, line_height, text_align, .. } => {
                let [x0, y0, x1, y1] =
                    text_local_bbox(content, font_size, line_height, text_align);
                local_point.x >= x0 && local_point.x <= x1 &&
                local_point.y >= y0 && local_point.y <= y1
            },
        }
    }

    /// True when the point falls outside a mask that covers this node.
    ///
    /// What a mask paints is content ∩ mask; everything else is simply not
    /// there. The hit test used to ignore that entirely, so an image masked
    /// down to a small circle kept its whole rectangle clickable: clicks on
    /// empty canvas selected and dragged it, and anything sitting behind it
    /// could not be reached at all. Ancestors are walked too — a masked group
    /// clips everything inside it, however deep.
    fn masked_away(&self, id: u32, x: f32, y: f32) -> bool {
        let mut current = Some(id);
        while let Some(n) = current {
            if let Some(mask) = self.mask_covering(n) {
                if !self.point_in_geometry(mask, x, y) {
                    return true;
                }
            }
            current = self.scene.nodes.get(&n).and_then(|node| node.parent);
        }
        false
    }

    /// The mask a node is under: the nearest preceding sibling that acts as
    /// one, mirroring the spans `write_siblings_with_masks` opens.
    fn mask_covering(&self, id: u32) -> Option<u32> {
        let node = self.scene.nodes.get(&id)?;
        if node.is_mask {
            return None; // a mask defines the coverage, it isn't clipped by it
        }
        let parent = self.scene.nodes.get(&node.parent?)?;
        let idx = parent.children.iter().position(|&c| c == id)?;
        parent.children[..idx]
            .iter()
            .rev()
            .find(|&&s| self.acts_as_mask(s))
            .copied()
    }

    /// Group-aware hit test: finds the deepest leaf hit, then walks up the parent
    /// chain to find the topmost Group ancestor that is a direct child of root
    /// (or of a non-Group parent). Returns that group's ID, or the leaf ID if
    /// no Group ancestor exists.
    pub fn hit_test_grouped(&mut self, x: f32, y: f32) -> Option<u32> {
        let leaf_id = self.hit_test(x, y)?;
        Some(self.find_topmost_group_ancestor(leaf_id))
    }

    /// Walk the parent chain from `id` upward, returning the topmost Group ancestor
    /// whose parent is either None or a non-Group node. If `id` itself has no
    /// Group ancestor, returns `id`.
    fn find_topmost_group_ancestor(&self, id: u32) -> u32 {
        let mut topmost_group = id;
        let mut current = id;
        while let Some(node) = self.scene.nodes.get(&current) {
            if let Some(pid) = node.parent {
                if let Some(parent_node) = self.scene.nodes.get(&pid) {
                    if matches!(parent_node.node_type, NodeType::Group) {
                        topmost_group = pid;
                    }
                }
                current = pid;
            } else {
                break;
            }
        }
        topmost_group
    }

    /// Get the node type as u32: 0=Path, 1=Rect, 2=Ellipse, 3=Group, 4=Text, 5=Image
    pub fn get_node_type(&self, id: u32) -> Option<u32> {
        self.scene.nodes.get(&id).map(|n| match n.node_type {
            NodeType::Path => 0,
            NodeType::Rect => 1,
            NodeType::Ellipse => 2,
            NodeType::Group => 3,
            NodeType::Text => 4,
            NodeType::Image => 5,
        })
    }

    /// Get the parent node ID, or -1 if root.
    pub fn get_node_parent(&self, id: u32) -> i32 {
        self.scene.nodes.get(&id)
            .and_then(|n| n.parent)
            .map(|p| p as i32)
            .unwrap_or(-1)
    }

    /// Filter a list of IDs to only include ancestors — drop any node whose
    /// ancestor is also in the set. Useful for preventing overlapping selections
    /// (e.g., selecting both a group and its child).
    fn filter_ancestors_only(&self, ids: &[u32]) -> Vec<u32> {
        let id_set: std::collections::HashSet<u32> = ids.iter().cloned().collect();
        ids.iter()
            .filter(|&&id| {
                let mut current = id;
                while let Some(node) = self.scene.nodes.get(&current) {
                    if let Some(pid) = node.parent {
                        if id_set.contains(&pid) { return false; }
                        current = pid;
                    } else {
                        break;
                    }
                }
                true
            })
            .cloned()
            .collect()
    }

    /// Dedup a selection: remove any node whose ancestor is also selected.
    pub fn dedup_selection(&self, ids_json: &str) -> Vec<u32> {
        let ids: Vec<u32> = serde_json::from_str(ids_json).unwrap_or_default();
        self.filter_ancestors_only(&ids)
    }

    /// Returns visible node IDs in document draw order (back to front).
    /// Uses the spatial index for fast culling, then sorts by scene tree order.
    pub fn get_visible_nodes(&self, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> Vec<u32> {
        let envelope = AABB::from_corners([min_x, min_y], [max_x, max_y]);
        let visible_set: std::collections::HashSet<u32> = self.spatial_index
            .locate_in_envelope_intersecting(&envelope)
            .map(|node| node.id)
            .collect();
        
        if visible_set.is_empty() {
            return Vec::new();
        }

        // Walk scene tree in draw order, filtering to visible set
        let mut result = Vec::with_capacity(visible_set.len());
        for &root_id in &self.scene.root_nodes {
            self.collect_visible_in_order(root_id, &visible_set, &mut result);
        }
        result
    }

    /// Depth-first traversal collecting the hit-testable IDs in draw order.
    ///
    /// Hidden and locked SUBTREES are pruned whole. `hit_test` also checks both
    /// flags per node, but that alone only ever protects the node the cursor
    /// lands on — always a leaf — while `hit_test_grouped` then promotes the
    /// result to its top-level group. So locking or hiding a *group* protected
    /// nothing: a click on any child selected (and dragged, and deleted) the
    /// locked group. The flags have to be inherited, and pruning here is where
    /// that costs nothing.
    fn collect_draw_order(&self, id: u32, out: &mut Vec<u32>) {
        if let Some(node) = self.scene.nodes.get(&id) {
            if !node.visible || node.locked {
                return;
            }
        }
        out.push(id);
        if let Some(node) = self.scene.nodes.get(&id) {
            // A Boolean Group's operands are consumed by the op and never
            // painted, so they aren't part of the draw order — same stop the
            // renderer makes in write_node_recursive.
            if node.boolean_op.is_some() {
                return;
            }
            for &child_id in &node.children {
                self.collect_draw_order(child_id, out);
            }
        }
    }

    /// Depth-first traversal collecting only IDs present in the visible set.
    ///
    /// A hidden subtree is pruned whole: its children are still in the R-tree
    /// (visibility doesn't affect indexing), so without this a leaf inside a
    /// hidden group came back as "visible" and a marquee swept up the hidden
    /// group. Locked nodes are NOT filtered here — this also feeds the
    /// renderer's subset path, and locked artwork still has to draw. Callers
    /// that need it (marquee, scissors) ask `is_locked_in_tree`.
    fn collect_visible_in_order(&self, id: u32, visible_set: &std::collections::HashSet<u32>, out: &mut Vec<u32>) {
        if let Some(node) = self.scene.nodes.get(&id) {
            if !node.visible {
                return;
            }
        }
        if visible_set.contains(&id) {
            out.push(id);
        }
        if let Some(node) = self.scene.nodes.get(&id) {
            // A Boolean Group stands in for its operands: they are never drawn,
            // so a marquee that only crosses one of them must not sweep up the
            // group. The group's own entry is bounded by its outline.
            if node.boolean_op.is_some() {
                return;
            }
            for &child_id in &node.children {
                self.collect_visible_in_order(child_id, visible_set, out);
            }
        }
    }

    pub fn select_node(&mut self, id: u32, multi: bool) {
        if !multi {
            self.scene.selection.clear();
        }
        if !self.scene.selection.contains(&id) {
            self.scene.selection.push(id);
        }
    }

    /// Take one node out of the selection, leaving the rest untouched.
    ///
    /// `select_node(id, true)` only ever adds — so shift-clicking a shape that
    /// was already selected did nothing at all, when what it means everywhere
    /// else is "remove this one".
    pub fn deselect_node(&mut self, id: u32) {
        self.scene.selection.retain(|&s| s != id);
    }

    pub fn clear_selection(&mut self) {
        self.scene.selection.clear();
    }

    pub fn get_selection(&self) -> Vec<u32> {
        self.scene.selection.clone()
    }

    /// Convert any geometry to a Path (editable points).
    /// Rect → 4 corner points (closed). Ellipse → 4 bezier arcs (closed).
    /// Returns true if a conversion happened.
    pub fn convert_to_path(&mut self, id: u32) -> bool {
        let new_geometry = if let Some(node) = self.scene.nodes.get(&id) {
            match &node.geometry {
                Geometry::Rect { width, height } => {
                    // Transfer the parametric corner radius onto each vertex so
                    // rounding is preserved non-destructively after conversion.
                    let subpaths = rect_subpaths(*width, *height, node.style.corner_radius);
                    Some(Geometry::Path {
                        network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                        subpaths,
                    })
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    let rx = *radius_x;
                    let ry = *radius_y;
                    let k: f32 = 0.5522847498;
                    let kx = rx * k;
                    let ky = ry * k;
                    // 4 cardinal points, closed subpath (no duplicate)
                    let points = vec![
                        PathPoint { x: 0.0, y: -ry, cp1: Vec2::new(-kx, -ry), cp2: Vec2::new(kx, -ry), corner_radius: 0.0 },
                        PathPoint { x: rx,  y: 0.0, cp1: Vec2::new(rx, -ky),  cp2: Vec2::new(rx, ky),  corner_radius: 0.0 },
                        PathPoint { x: 0.0, y: ry,  cp1: Vec2::new(kx, ry),   cp2: Vec2::new(-kx, ry), corner_radius: 0.0 },
                        PathPoint { x: -rx, y: 0.0, cp1: Vec2::new(-rx, ky),  cp2: Vec2::new(-rx, -ky), corner_radius: 0.0 },
                    ];
                    {
                        let subpaths = vec![Subpath { points, closed: true }];
                        Some(Geometry::Path {
                            network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                            subpaths,
                        })
                    }
                }
                Geometry::Path { .. } => None, // Already a path
                Geometry::Text { .. } => None, // Can't convert text
                Geometry::Image { .. } => None, // Can't convert an image
            }
        } else {
            None
        };

        if let Some(geo) = new_geometry {
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                node.geometry = geo;
                node.node_type = NodeType::Path;
                // The radius now lives on the vertices; clear the shape-level
                // field so it isn't double-applied.
                node.style.corner_radius = 0.0;
                self.update_spatial_index(id);
                self.mark_dirty(id);
            }
            true
        } else {
            false
        }
    }

    /// Replace a node's geometry with a new path. Used for "Create Outlines".
    pub fn replace_geometry_with_path(&mut self, id: u32, subpaths_json: &str) -> bool {
        let subpaths: Vec<Subpath> = match serde_json::from_str(subpaths_json) {
            Ok(s) => s,
            Err(_) => return false,
        };
        
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.geometry = Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            };
            node.node_type = NodeType::Path;
            self.update_spatial_index(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
            true
        } else {
            false
        }
    }

    /// Resize a node's geometry to new width/height.
    pub fn resize_node(&mut self, id: u32, new_w: f32, new_h: f32) {
        // Groups have placeholder geometry — resize them by scaling the
        // group's transform about the bounds' top-left corner, so the whole
        // subtree scales together.
        let is_group = matches!(
            self.scene.nodes.get(&id).map(|n| n.node_type),
            Some(NodeType::Group)
        );
        if is_group {
            self.resize_group(id, new_w.max(1.0), new_h.max(1.0));
            return;
        }
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            let old_bb = geometry_control_bbox(&node.geometry);
            match &mut node.geometry {
                Geometry::Rect { width, height } => {
                    *width = new_w.max(1.0);
                    *height = new_h.max(1.0);
                }
                Geometry::Image { width, height, .. } => {
                    *width = new_w.max(1.0);
                    *height = new_h.max(1.0);
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    *radius_x = (new_w / 2.0).max(0.5);
                    *radius_y = (new_h / 2.0).max(0.5);
                }
                Geometry::Path { subpaths, ref mut network, .. } => {
                    // Resize semantics: make the *resolved* (corner-radius-rounded)
                    // outline — the geometry the renderer draws and get_node_bounds
                    // reports — fit new_w × new_h. Corner radii are absolute
                    // (Figma-style, not scaled), so the resolved size is not a
                    // linear function of the anchor scale; iterate to converge.
                    let target_w = new_w.max(1.0);
                    let target_h = new_h.max(1.0);
                    // Convergence is geometric with ratio ~ (rounding cut / size);
                    // 8 iterations lands well under a tenth of a pixel even for
                    // large radii, and each pass is just a flatten of the outline.
                    for _ in 0..8 {
                        // Bounds of the resolved outline in local geometry space
                        let mut min_x = f32::MAX; let mut min_y = f32::MAX;
                        let mut max_x = f32::MIN; let mut max_y = f32::MIN;
                        let mut has_points = false;
                        for sp in round_subpaths(subpaths).iter() {
                            for lp in flatten_subpath(sp) {
                                has_points = true;
                                min_x = min_x.min(lp.x); min_y = min_y.min(lp.y);
                                max_x = max_x.max(lp.x); max_y = max_y.max(lp.y);
                            }
                        }
                        if !has_points { return; }
                        let old_w = (max_x - min_x).max(1e-3);
                        let old_h = (max_y - min_y).max(1e-3);
                        if (old_w - target_w).abs() < 0.02 && (old_h - target_h).abs() < 0.02 {
                            break;
                        }
                        let sx = target_w / old_w;
                        let sy = target_h / old_h;
                        for sp in subpaths.iter_mut() {
                            for pt in sp.points.iter_mut() {
                                pt.x = min_x + (pt.x - min_x) * sx;
                                pt.y = min_y + (pt.y - min_y) * sy;
                                pt.cp1 = Vec2::new(
                                    min_x + (pt.cp1.x - min_x) * sx,
                                    min_y + (pt.cp1.y - min_y) * sy,
                                );
                                pt.cp2 = Vec2::new(
                                    min_x + (pt.cp2.x - min_x) * sx,
                                    min_y + (pt.cp2.y - min_y) * sy,
                                );
                            }
                        }
                    }
                    // Rebuild network from scaled subpaths to keep in sync
                    *network = Some(NodeVectorNetwork::from_subpaths(subpaths));
                }
                Geometry::Text { .. } => {}
            }
            // Mesh fills are node-local: stretch them with the geometry so
            // resizing a mesh-filled shape keeps the color field in place.
            adapt_mesh_fills_to_bbox(node, old_bb);
            self.update_spatial_index(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Resize a group by scaling its transform about its bounds' top-left
    /// corner (world space), so all descendants scale together.
    fn resize_group(&mut self, id: u32, new_w: f32, new_h: f32) {
        let bounds = self.get_node_bounds(id); // [min_x, min_y, max_x, max_y] world
        let old_w = (bounds[2] - bounds[0]).max(1e-3);
        let old_h = (bounds[3] - bounds[1]).max(1e-3);
        let sx = new_w / old_w;
        let sy = new_h / old_h;
        let anchor = Vec2::new(bounds[0], bounds[1]);

        let global = match self.global_transforms.get(&id) {
            Some(m) => Mat3::from_cols_array(m),
            None => return,
        };
        let parent_global = self.scene.nodes.get(&id)
            .and_then(|n| n.parent)
            .and_then(|pid| self.global_transforms.get(&pid))
            .map(Mat3::from_cols_array)
            .unwrap_or(Mat3::IDENTITY);

        // World-space scale about the anchor, applied on top of the global transform
        let scale_about = Mat3::from_translation(anchor)
            * Mat3::from_scale(Vec2::new(sx, sy))
            * Mat3::from_translation(-anchor);
        let hint = self.scene.nodes.get(&id).map(|n| n.transform);
        let new_local = Transform2D::from_mat3_hint(&(parent_global.inverse() * scale_about * global), hint.as_ref());
        if !new_local.is_valid() {
            return;
        }
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.transform = new_local;
        }
        self.update_node_global_transform(id);
        self.update_spatial_index_recursive(id);
        self.update_ancestor_group_bounds(id);
        // Mark the whole subtree dirty so every descendant re-renders
        let mut stack = vec![id];
        while let Some(cur) = stack.pop() {
            self.dirty_flags.insert(cur, true);
            if let Some(n) = self.scene.nodes.get(&cur) {
                stack.extend(n.children.iter().copied());
            }
        }
        self.scene.vector_network.dirty = true;
    }

    /// Set a node's absolute position (translation part of its local transform).
    pub fn set_node_position(&mut self, id: u32, x: f32, y: f32) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.transform.x = x;
            node.transform.y = y;
        }
        self.after_local_transform_change(id);
    }

    /// Set a node's full local transform from a JSON array of 9 f32 values (column-major, matching `Mat3::from_cols_array`).
    pub fn set_node_transform_matrix(&mut self, id: u32, transform_json: &str) {
        let parsed: [f32; 9] = match serde_json::from_str(transform_json) {
            Ok(v) => v,
            Err(_) => return,
        };
        // Hint with the node's current components. Interactive drags (oriented
        // resize, marquee transforms) route through here, and without a hint a
        // two-axis skew would be silently re-read as rotation + one skew the
        // first time the user grabs a handle.
        let hint = self.scene.nodes.get(&id).map(|n| n.transform);
        let t = Transform2D::from_mat3_hint(&Mat3::from_cols_array(&parsed), hint.as_ref());
        if !t.is_valid() {
            return;
        }
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.transform = t;
        }
        self.after_local_transform_change(id);
    }

    /// Mutate transform components while keeping the node's local center
    /// fixed in parent space (Figma-style center pivot). Without this,
    /// rotation/skew/scale edits pivot about the local origin — a rect's
    /// top-left corner — making the shape orbit/walk as values change.
    /// The mutation is rolled back if it would leave the transform invalid.
    fn set_components_about_center(&mut self, id: u32, f: impl FnOnce(&mut Transform2D)) {
        let (cx, cy) = self.compute_local_center(id);
        self.set_components_about_local_point(id, cx, cy, f);
    }

    /// Apply a component change while keeping the given LOCAL point fixed in
    /// world space (the pivot). `set_components_about_center` is the (0.5,0.5)
    /// bounding-box case; the reference-point transforms pass other anchors.
    fn set_components_about_local_point(
        &mut self,
        id: u32,
        cx: f32,
        cy: f32,
        f: impl FnOnce(&mut Transform2D),
    ) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            let c = Vec2::new(cx, cy);
            let old = node.transform;
            let before = node.transform.to_mat3().transform_point2(c);
            f(&mut node.transform);
            let after = node.transform.to_mat3().transform_point2(c);
            node.transform.x += before.x - after.x;
            node.transform.y += before.y - after.y;
            if !node.transform.is_valid() {
                node.transform = old;
                return;
            }
        }
        self.after_local_transform_change(id);
    }

    /// Normalize an angle into (-180, 180]. Non-finite input yields None.
    fn normalize_deg(deg: f32) -> Option<f32> {
        if !deg.is_finite() {
            return None;
        }
        let mut d = deg % 360.0;
        if d > 180.0 {
            d -= 360.0;
        } else if d <= -180.0 {
            d += 360.0;
        }
        Some(d)
    }

    pub fn set_node_rotation(&mut self, id: u32, deg: f32) {
        let Some(deg) = Self::normalize_deg(deg) else { return };
        self.set_components_about_center(id, |t| t.rotation_deg = deg);
    }

    /// Set rotation while keeping a reference point fixed. `ax`/`ay` are the
    /// normalized bounding-box anchor (0..1); (0.5,0.5) is the center and
    /// matches `set_node_rotation`.
    pub fn set_node_rotation_about(&mut self, id: u32, deg: f32, ax: f32, ay: f32) {
        let Some(deg) = Self::normalize_deg(deg) else { return };
        if !ax.is_finite() || !ay.is_finite() {
            return;
        }
        let (px, py) = self.compute_local_anchor(id, ax, ay);
        self.set_components_about_local_point(id, px, py, |t| t.rotation_deg = deg);
    }

    /// Set scale while keeping a reference point fixed (see `set_node_rotation_about`).
    pub fn set_node_scale_about(&mut self, id: u32, sx: f32, sy: f32, ax: f32, ay: f32) {
        if !sx.is_finite() || !sy.is_finite() || sx.abs() < 1e-4 || sy.abs() < 1e-4 {
            return;
        }
        if !ax.is_finite() || !ay.is_finite() {
            return;
        }
        let (px, py) = self.compute_local_anchor(id, ax, ay);
        self.set_components_about_local_point(id, px, py, |t| {
            t.scale_x = sx;
            t.scale_y = sy;
        });
    }

    /// Each angle is clamped to ±89°: at 90° the corresponding edge has turned
    /// a full quarter-turn and the shape degenerates to a line.
    ///
    /// The pair must also satisfy |x_deg + y_deg| < 90°, or the two edges are
    /// parallel and the shape collapses. That case is not clamped — it is
    /// rejected by the `is_valid` rollback in `set_components_about_center`,
    /// leaving the node exactly as it was (same contract as a zero scale).
    pub fn set_node_skew(&mut self, id: u32, x_deg: f32, y_deg: f32) {
        if !x_deg.is_finite() || !y_deg.is_finite() {
            return;
        }
        let x_deg = x_deg.clamp(-89.0, 89.0);
        let y_deg = y_deg.clamp(-89.0, 89.0);
        self.set_components_about_center(id, |t| {
            t.skew_x_deg = x_deg;
            t.skew_y_deg = y_deg;
        });
    }

    /// Scale factors of ~0 (or non-finite) are rejected: they collapse the
    /// matrix and the geometry could never be recovered by scaling back up.
    pub fn set_node_scale(&mut self, id: u32, sx: f32, sy: f32) {
        if !sx.is_finite() || !sy.is_finite() || sx.abs() < 1e-4 || sy.abs() < 1e-4 {
            return;
        }
        self.set_components_about_center(id, |t| {
            t.scale_x = sx;
            t.scale_y = sy;
        });
    }

    pub fn get_node_transform_components(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| serde_json::to_string(&n.transform).unwrap_or_default())
            .unwrap_or_else(|| serde_json::to_string(&Transform2D::IDENTITY).unwrap())
    }

    pub fn set_node_transform_components(&mut self, id: u32, json: &str) {
        if let Ok(t) = serde_json::from_str::<Transform2D>(json) {
            if !t.is_valid() {
                return;
            }
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                node.transform = t;
            }
            self.after_local_transform_change(id);
        }
    }

    /// Set a node's rotation (in radians), preserving its translation and
    /// scale. The linear part is decomposed as rotation × scale; only the
    /// rotation component is replaced (a resized group keeps its size).

    /// Compute the center of a node's geometry in its local coordinate space.
    fn compute_local_center(&self, id: u32) -> (f32, f32) {
        let [min_x, min_y, max_x, max_y] = self.compute_local_bounds(id);
        if min_x > max_x {
            return (0.0, 0.0);
        }
        ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0)
    }

    /// A node's bounding box in its own local (pre-transform) coordinate space,
    /// as `[min_x, min_y, max_x, max_y]`. Returns an inverted box (min > max)
    /// when no bounds can be determined. Used both for the center pivot and for
    /// the reference-point anchors (a normalized position within this box).
    fn compute_local_bounds(&self, id: u32) -> [f32; 4] {
        let node = match self.scene.nodes.get(&id) {
            Some(n) => n,
            None => return [f32::MAX, f32::MAX, f32::MIN, f32::MIN],
        };
        match node.node_type {
            NodeType::Group => {
                let bounds = self.get_node_bounds(id);
                if bounds[0] > bounds[2] {
                    return [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
                }
                // Map the world-space corners back into this group's local space.
                if let Some(gt) = self.global_transforms.get(&id) {
                    let inv = Mat3::from_cols_array(gt).inverse();
                    let mut min_x = f32::MAX;
                    let mut min_y = f32::MAX;
                    let mut max_x = f32::MIN;
                    let mut max_y = f32::MIN;
                    for &(wx, wy) in &[
                        (bounds[0], bounds[1]),
                        (bounds[2], bounds[1]),
                        (bounds[2], bounds[3]),
                        (bounds[0], bounds[3]),
                    ] {
                        let l = inv.transform_point2(Vec2::new(wx, wy));
                        min_x = min_x.min(l.x);
                        min_y = min_y.min(l.y);
                        max_x = max_x.max(l.x);
                        max_y = max_y.max(l.y);
                    }
                    [min_x, min_y, max_x, max_y]
                } else {
                    [f32::MAX, f32::MAX, f32::MIN, f32::MIN]
                }
            }
            _ => match &node.geometry {
                Geometry::Rect { width, height } => [0.0, 0.0, *width, *height],
                Geometry::Image { width, height, .. } => [0.0, 0.0, *width, *height],
                Geometry::Ellipse { radius_x, radius_y } => {
                    [-*radius_x, -*radius_y, *radius_x, *radius_y]
                }
                Geometry::Path { subpaths, .. } => {
                    let mut min_x = f32::MAX;
                    let mut max_x = f32::MIN;
                    let mut min_y = f32::MAX;
                    let mut max_y = f32::MIN;
                    for sp in subpaths {
                        for pt in &sp.points {
                            min_x = min_x.min(pt.x);
                            max_x = max_x.max(pt.x);
                            min_y = min_y.min(pt.y);
                            max_y = max_y.max(pt.y);
                        }
                    }
                    [min_x, min_y, max_x, max_y]
                }
                Geometry::Text { .. } => [f32::MAX, f32::MAX, f32::MIN, f32::MIN],
            },
        }
    }

    /// Local anchor point for a normalized bounding-box position: (0,0) =
    /// top-left, (0.5,0.5) = center, (1,1) = bottom-right. Falls back to the
    /// local center when no bounds are available (e.g. text).
    fn compute_local_anchor(&self, id: u32, ax: f32, ay: f32) -> (f32, f32) {
        let [min_x, min_y, max_x, max_y] = self.compute_local_bounds(id);
        if min_x > max_x {
            return self.compute_local_center(id);
        }
        (min_x + (max_x - min_x) * ax, min_y + (max_y - min_y) * ay)
    }

    /// Flip a node horizontally: mirror across the vertical axis through the
    /// center of its WORLD bounds. The mirror must be applied in world space
    /// (pre-multiplied): a local-space mirror is a visual no-op for any
    /// geometry that is symmetric in local space (rects, ellipses) no matter
    /// how the node is skewed or rotated.
    pub fn flip_node_horizontal(&mut self, id: u32) {
        self.flip_node_world(id, true);
    }

    /// Flip a node vertically (mirror across the horizontal center axis of
    /// its world bounds).
    pub fn flip_node_vertical(&mut self, id: u32) {
        self.flip_node_world(id, false);
    }

    fn flip_node_world(&mut self, id: u32, horizontal: bool) {
        let bounds = self.get_node_bounds(id); // [min_x, min_y, max_x, max_y] world
        if bounds[2] <= bounds[0] || bounds[3] <= bounds[1] {
            return;
        }
        let c = Vec2::new((bounds[0] + bounds[2]) / 2.0, (bounds[1] + bounds[3]) / 2.0);
        let global = match self.global_transforms.get(&id) {
            Some(m) => Mat3::from_cols_array(m),
            None => return,
        };
        let parent_global = self.scene.nodes.get(&id)
            .and_then(|n| n.parent)
            .and_then(|pid| self.global_transforms.get(&pid))
            .map(Mat3::from_cols_array)
            .unwrap_or(Mat3::IDENTITY);

        let s = if horizontal { Vec2::new(-1.0, 1.0) } else { Vec2::new(1.0, -1.0) };
        let mirror = Mat3::from_translation(c)
            * Mat3::from_scale(s)
            * Mat3::from_translation(-c);
        let hint = self.scene.nodes.get(&id).map(|n| n.transform);
        let t = Transform2D::from_mat3_hint(
            &(parent_global.inverse() * mirror * global),
            hint.as_ref(),
        );
        if !t.is_valid() {
            return;
        }
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.transform = t;
        }
        self.after_local_transform_change(id);
    }

    /// Check whether a node's local transform has a non-identity linear part
    /// (rotation, scale != 1, skew, or flip).
    pub fn has_non_identity_linear(&self, id: u32) -> bool {
        if let Some(node) = self.scene.nodes.get(&id) {
            let mat = node.transform.to_mat3();
            (mat.x_axis.x - 1.0).abs() > 1e-4 || mat.x_axis.y.abs() > 1e-4 ||
            mat.y_axis.x.abs() > 1e-4 || (mat.y_axis.y - 1.0).abs() > 1e-4
        } else {
            false
        }
    }

    /// Bake the node's rotation/scale/skew into its geometry, resetting the
    /// transform to translation-only. Rect/Ellipse nodes are first converted
    /// to paths; groups push their linear transform into each child.
    pub fn flatten_transform(&mut self, id: u32) -> bool {
        // Extract the linear part and check if it's non-identity
        let (node_type, linear, tx, ty) = {
            let node = match self.scene.nodes.get(&id) {
                Some(n) => n,
                None => return false,
            };
            let mat = node.transform.to_mat3();
            let is_identity =
                (mat.x_axis.x - 1.0).abs() < 1e-5 && mat.x_axis.y.abs() < 1e-5 &&
                mat.y_axis.x.abs() < 1e-5 && (mat.y_axis.y - 1.0).abs() < 1e-5;
            if is_identity { return false; }
            let linear = Mat3::from_cols(
                Vec3::new(mat.x_axis.x, mat.x_axis.y, 0.0),
                Vec3::new(mat.y_axis.x, mat.y_axis.y, 0.0),
                Vec3::new(0.0, 0.0, 1.0),
            );
            (node.node_type, linear, mat.z_axis.x, mat.z_axis.y)
        };

        match node_type {
            NodeType::Rect | NodeType::Ellipse => {
                // Convert primitive to path first, then flatten the path
                self.convert_to_path(id);
                self.flatten_path_geometry(id, linear, tx, ty)
            }
            NodeType::Path => {
                self.flatten_path_geometry(id, linear, tx, ty)
            }
            NodeType::Group => {
                // Push the linear transform into each child's transform
                let children = match self.scene.nodes.get(&id) {
                    Some(n) => n.children.clone(),
                    None => return false,
                };
                for &child_id in &children {
                    if let Some(child) = self.scene.nodes.get_mut(&child_id) {
                        let child_mat = child.transform.to_mat3();
                        let hint = child.transform;
                        child.transform = Transform2D::from_mat3_hint(&(linear * child_mat), Some(&hint));
                    }
                }
                if let Some(node) = self.scene.nodes.get_mut(&id) {
                    node.transform = Transform2D::from_translation(tx, ty);
                }
                self.update_node_global_transform(id);
                self.update_spatial_index_recursive(id);
                self.update_ancestor_group_bounds(id);
                self.mark_dirty(id);
                true
            }
            NodeType::Text => false,
            NodeType::Image => false, // images can't bake a transform into geometry
        }
    }

    /// Apply a linear transform to a path node's geometry and reset to
    /// translation-only. Returns true on success.
    ///
    /// `corner_radius` is a scalar: it can only ever describe a *circular*
    /// fillet in the node's own space. Transforming the anchors while leaving it
    /// alone therefore re-resolves the rounding against the new geometry, and
    /// the flattened shape stops matching what was on screen. How we keep them
    /// equal depends on the linear part:
    ///
    ///   - **Similarity** (rotation / uniform scale / reflection): circles stay
    ///     circles, so the parametric radius survives — just scale it. Rounding
    ///     stays editable, which is what you want after a plain rotate or scale.
    ///   - **Anything else** (skew, non-uniform scale): the corner arc becomes
    ///     elliptical, which no scalar radius can express. Resolve the fillets
    ///     into explicit cubics *first*, then transform those — the curve is
    ///     baked exactly, at the cost of the parametric radius. Flatten is a
    ///     bake, so that trade is the point.
    fn flatten_path_geometry(&mut self, id: u32, linear: Mat3, tx: f32, ty: f32) -> bool {
        let subpaths = match self.scene.nodes.get(&id) {
            Some(n) => match &n.geometry {
                Geometry::Path { subpaths, .. } => subpaths.clone(),
                _ => return false,
            },
            None => return false,
        };

        // Columns of the 2×2 linear part.
        let col_x = Vec2::new(linear.x_axis.x, linear.x_axis.y);
        let col_y = Vec2::new(linear.y_axis.x, linear.y_axis.y);
        let len_x = col_x.length();
        let len_y = col_y.length();
        // Orthogonal columns of equal length ⇒ similarity ⇒ circles stay circles.
        // Scale-relative epsilons so the test doesn't drift with shape size.
        let scale = (len_x + len_y) * 0.5;
        let is_similarity = scale > 1e-6
            && col_x.dot(col_y).abs() <= 1e-4 * scale * scale
            && (len_x - len_y).abs() <= 1e-4 * scale;

        let mut new_subpaths = if is_similarity {
            let mut sps = subpaths;
            for sp in &mut sps {
                for pt in &mut sp.points {
                    pt.corner_radius *= scale;
                }
            }
            sps
        } else {
            round_subpaths(&subpaths)
        };

        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;

        for sp in &mut new_subpaths {
            for pt in &mut sp.points {
                let p = linear.transform_point2(Vec2::new(pt.x, pt.y));
                let c1 = linear.transform_point2(pt.cp1);
                let c2 = linear.transform_point2(pt.cp2);
                pt.x = p.x;
                pt.y = p.y;
                pt.cp1 = c1;
                pt.cp2 = c2;
                min_x = min_x.min(p.x).min(c1.x).min(c2.x);
                min_y = min_y.min(p.y).min(c1.y).min(c2.y);
            }
        }

        if !min_x.is_finite() || !min_y.is_finite() {
            min_x = 0.0;
            min_y = 0.0;
        }

        // Offset geometry so it starts near the origin
        for sp in &mut new_subpaths {
            for pt in &mut sp.points {
                pt.x -= min_x;
                pt.y -= min_y;
                pt.cp1.x -= min_x;
                pt.cp1.y -= min_y;
                pt.cp2.x -= min_x;
                pt.cp2.y -= min_y;
            }
        }

        let network = Some(NodeVectorNetwork::from_subpaths(&new_subpaths));
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.geometry = Geometry::Path { subpaths: new_subpaths, network };
            node.transform = Transform2D::from_translation(tx + min_x, ty + min_y);
        }

        self.after_local_transform_change(id);
        true
    }

    /// Cut: lift whole subtrees out of the document and into the clipboard.
    ///
    /// As far as the document is concerned the nodes are gone — they don't
    /// render, hit-test, list or save. But unlike `remove_node`, they still
    /// exist, so `paste_clipboard` can put them back. That distinction is the
    /// entire reason this exists: an id-keyed clipboard plus a destructive cut
    /// leaves paste with nothing to copy from.
    ///
    /// Replaces any previous clipboard contents. Returns the number of roots cut.
    pub fn cut_nodes(&mut self, ids_json: &str) -> u32 {
        let ids: Vec<u32> = serde_json::from_str(ids_json).unwrap_or_default();
        self.clipboard.clear();
        self.clipboard_roots.clear();
        for id in ids {
            if !self.scene.nodes.contains_key(&id) {
                continue;
            }
            // A cut root is stored in WORLD terms. Its local transform is
            // measured against a parent that is not coming with it, so a shape
            // cut out of a group scaled to 200% and pasted back arrived at half
            // the size it was cut at — the paste re-reads that local transform
            // against the root. Baking the global here makes a paste land where
            // the cut happened, whether it goes back to the top level or into
            // another container.
            let world = self
                .global_transforms
                .get(&id)
                .map(|&m| Mat3::from_cols_array(&m));
            let hint = self.scene.nodes.get(&id).map(|n| n.transform);
            self.lift_subtree(id);
            if let Some(node) = self.clipboard.get_mut(&id) {
                node.parent = None;
            }
            if let Some(w) = world {
                let baked = Transform2D::from_mat3_hint(&w, hint.as_ref());
                if baked.is_valid() {
                    if let Some(node) = self.clipboard.get_mut(&id) {
                        node.transform = baked;
                    }
                }
            }
            self.clipboard_roots.push(id);
        }
        self.clipboard_roots.len() as u32
    }

    /// Move one subtree out of the scene and into `clipboard`. Does exactly the
    /// bookkeeping `remove_node` does — unlink from the parent or root list,
    /// drop the spatial entry, transforms, dirty flags and cache membership,
    /// invalidate any Live Paint network or boolean group that depended on it —
    /// and then keeps the node instead of dropping it.
    fn lift_subtree(&mut self, id: u32) {
        if self.is_in_any_live_paint(id) {
            self.scene.vector_network.dirty = true;
        }
        self.mark_enclosing_boolean_groups_dirty(id);
        self.forget_live_paint_group(id);
        self.boolean_groups.remove(&id);
        self.dirty_boolean_groups.remove(&id);
        if let Some(node) = self.scene.nodes.remove(&id) {
            if let Some(parent_id) = node.parent {
                if let Some(parent) = self.scene.nodes.get_mut(&parent_id) {
                    parent.children.retain(|&c| c != id);
                }
            } else {
                self.scene.root_nodes.retain(|&r| r != id);
            }
            self.scene.selection.retain(|&s| s != id);
            self.global_transforms.remove(&id);
            self.dirty_flags.remove(&id);
            if let Some(old_node) = self.node_to_spatial.remove(&id) {
                self.spatial_index.remove(&old_node);
            }
            let children = node.children.clone();
            self.clipboard.insert(id, node);
            for child_id in children {
                self.lift_subtree(child_id);
            }
        }
    }

    /// Paste every clipboard root back into the document at the top level,
    /// offset by (dx, dy). The clipboard is NOT consumed — pasting twice gives
    /// two copies, the way it does everywhere else. Returns the new ids.
    pub fn paste_clipboard(&mut self, dx: f32, dy: f32) -> Vec<u32> {
        let roots = self.clipboard_roots.clone();
        let mut out = Vec::with_capacity(roots.len());
        for root in roots {
            let mut id_map: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
            let new_id = self.clone_from_clipboard(root, &mut id_map);
            if let Some(node) = self.scene.nodes.get_mut(&new_id) {
                node.transform.x += dx;
                node.transform.y += dy;
                node.parent = None;
            }
            self.scene.root_nodes.retain(|&r| r != new_id);
            self.scene.root_nodes.push(new_id);
            self.update_node_global_transform(new_id);
            self.update_spatial_index_recursive(new_id);
            // A cut Live Paint group carries its face fills the same way a
            // duplicate does — by signature, remapped onto the clone's new ids.
            self.clone_live_paint_fills(&id_map, dx, dy);
            self.mark_dirty(new_id);
            out.push(new_id);
        }
        out
    }

    /// World-space AABB of one face's outline as `[minX, minY, maxX, maxY]`,
    /// or an empty vec if the id is unknown.
    ///
    /// Used to answer "what else is sitting on this region" — a shape outside
    /// the Live Paint group contributes no segments, so it divides nothing, and
    /// the only way to explain that to someone is to find it and name it.
    pub fn face_bounds(&mut self, face_id: u32) -> Vec<f32> {
        self.ensure_network_clean();
        match self.scene.vector_network.faces.get(&face_id) {
            Some(f) if !f.boundary_polygon.is_empty() => {
                let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
                for p in &f.boundary_polygon {
                    lo[0] = lo[0].min(p[0]); lo[1] = lo[1].min(p[1]);
                    hi[0] = hi[0].max(p[0]); hi[1] = hi[1].max(p[1]);
                }
                vec![lo[0], lo[1], hi[0], hi[1]]
            }
            _ => Vec::new(),
        }
    }

    /// True when a cut is waiting to be pasted.
    pub fn has_clipboard(&self) -> bool {
        !self.clipboard_roots.is_empty()
    }

    /// Recursive clone that reads from `clipboard` rather than the scene.
    /// Mirrors `deep_clone_subtree_inner`, minus the " copy" suffix — a cut
    /// object pasted back is the same object, not a copy of it.
    fn clone_from_clipboard(
        &mut self,
        id: u32,
        id_map: &mut std::collections::HashMap<u32, u32>,
    ) -> u32 {
        let new_id = self.alloc_id();
        id_map.insert(id, new_id);

        if let Some(node) = self.clipboard.get(&id).cloned() {
            let old_children = node.children.clone();
            let mut new_node = node;
            new_node.id = new_id;
            new_node.children = Vec::new();
            new_node.parent = None;
            if new_node.live_paint {
                self.live_paint_groups.insert(new_id);
            }
            if new_node.boolean_op.is_some() {
                self.boolean_groups.insert(new_id);
            }
            self.scene.nodes.insert(new_id, new_node);

            for child_id in old_children {
                let new_child_id = self.clone_from_clipboard(child_id, id_map);
                if let Some(child_node) = self.scene.nodes.get_mut(&new_child_id) {
                    child_node.parent = Some(new_id);
                }
                if let Some(parent_node) = self.scene.nodes.get_mut(&new_id) {
                    parent_node.children.push(new_child_id);
                }
            }
        }
        new_id
    }

    /// Duplicate a node (and its entire subtree if a group) and return the new id.
    pub fn duplicate_node(&mut self, id: u32) -> u32 {
        // Track old->new ids so any Live Paint fills the subtree carries can be
        // re-attached to the clone's freshly-numbered faces (see below).
        let mut id_map: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
        let new_id = self.deep_clone_subtree_inner(id, true, &mut id_map);
        // Offset the top-level clone by 20px
        if let Some(node) = self.scene.nodes.get_mut(&new_id) {
            node.transform.x += 20.0;
            node.transform.y += 20.0;
            node.parent = None;
        }
        // Remove from any parent it was temporarily added to and add to root
        self.scene.root_nodes.retain(|&r| r != new_id);
        self.scene.root_nodes.push(new_id);
        self.update_node_global_transform(new_id);
        self.update_spatial_index_recursive(new_id);
        // Live Paint face fills live on the vector network keyed by a containment
        // signature of SOURCE-NODE ids, not on the nodes themselves — so a plain
        // subtree clone leaves the copy's faces empty (the user sees only the
        // member strokes). Re-inject the fills under the clone's new ids.
        self.clone_live_paint_fills(&id_map, 20.0, 20.0);
        self.mark_dirty(new_id);
        new_id
    }

    /// Re-attach Live Paint face fills onto a freshly-cloned subtree.
    ///
    /// Each filled face records the sorted ids of the closed shapes that bound
    /// it (its signature). For a fill entirely defined by cloned shapes, map the
    /// signature through `id_map` and queue it as a pending fill offset by the
    /// clone's own (dx,dy); the next network rebuild's `remap_fills` then lands
    /// it on the matching new face by exact signature.
    fn clone_live_paint_fills(
        &mut self,
        id_map: &std::collections::HashMap<u32, u32>,
        dx: f32,
        dy: f32,
    ) {
        if id_map.is_empty() {
            return;
        }
        // The old faces (and their signatures) must exist to copy from.
        self.ensure_network_clean();
        let mut pending: Vec<vector_network::PendingFill> = Vec::new();
        for face in self.scene.vector_network.faces.values() {
            if face.is_outer || face.signature.is_empty() {
                continue;
            }
            let color = match &face.fill {
                Some(c) => c.clone(),
                None => continue,
            };
            // Only carry a fill whose bounding shapes were ALL part of the clone.
            if !face.signature.iter().all(|n| id_map.contains_key(n)) {
                continue;
            }
            let mut sig: Vec<u32> = face.signature.iter().map(|n| id_map[n]).collect();
            sig.sort();
            let n = face.boundary_polygon.len().max(1) as f32;
            let (mut sx, mut sy) = (0.0f32, 0.0f32);
            for p in &face.boundary_polygon {
                sx += p[0];
                sy += p[1];
            }
            pending.push(vector_network::PendingFill {
                centroid: glam::Vec2::new(sx / n + dx, sy / n + dy),
                signature: sig,
                color,
            });
        }
        if !pending.is_empty() {
            self.scene.vector_network.pending_fills.extend(pending);
            self.scene.vector_network.dirty = true;
        }
    }

    /// Recursively clone a node and all its descendants, returning the new root ID.
    /// The cloned nodes have fresh IDs and correct parent/children pointers.
    /// The cloned root's parent is set to None (caller is responsible for reparenting).
    #[allow(dead_code)]
    fn deep_clone_subtree(&mut self, id: u32) -> u32 {
        let mut id_map = std::collections::HashMap::new();
        self.deep_clone_subtree_inner(id, true, &mut id_map)
    }

    /// Inner recursion for [`Self::deep_clone_subtree`]. The `apply_copy_suffix`
    /// flag is only true for the top-level node being duplicated, so the
    /// " copy" suffix lands on the copied root and not on every descendant.
    /// `id_map` accumulates every old->new id pair in the clone.
    fn deep_clone_subtree_inner(
        &mut self,
        id: u32,
        apply_copy_suffix: bool,
        id_map: &mut std::collections::HashMap<u32, u32>,
    ) -> u32 {
        let new_id = self.alloc_id();
        id_map.insert(id, new_id);

        if let Some(node) = self.scene.nodes.get(&id).cloned() {
            let old_children = node.children.clone();
            let mut new_node = node;
            new_node.id = new_id;
            if apply_copy_suffix {
                new_node.name = format!("{} copy", new_node.name);
            }
            new_node.children = Vec::new();
            new_node.parent = None;

            // Clones keep the source's live_paint flag, so mirror it into the cache.
            if new_node.live_paint {
                self.live_paint_groups.insert(new_id);
            }
            // Same for the boolean-group flag (the cloned outline comes along too).
            if new_node.boolean_op.is_some() {
                self.boolean_groups.insert(new_id);
            }
            self.scene.nodes.insert(new_id, new_node);

            // Recursively clone children and reparent them
            for child_id in old_children {
                let new_child_id = self.deep_clone_subtree_inner(child_id, false, id_map);
                // set_parent handles adding to children vec and updating parent pointer
                if let Some(child_node) = self.scene.nodes.get_mut(&new_child_id) {
                    child_node.parent = Some(new_id);
                }
                if let Some(parent_node) = self.scene.nodes.get_mut(&new_id) {
                    parent_node.children.push(new_child_id);
                }
            }
        }
        new_id
    }

    /// Group selected nodes into a new Group node. Returns the group's id.
    /// Deduplicates the selection (drops descendants of selected ancestors).
    /// Places the group at the z-position of the topmost member in the common parent.
    pub fn group_nodes(&mut self, ids_json: &str) -> u32 {
        let raw_ids: Vec<u32> = serde_json::from_str(ids_json).unwrap_or_default();
        if raw_ids.is_empty() { return 0; }

        // Dedup: remove any node whose ancestor is also selected
        let ids = self.filter_ancestors_only(&raw_ids);
        if ids.is_empty() { return 0; }

        let group_id = self.alloc_id();

        // Determine the common parent of all selected nodes
        let first_parent = self.scene.nodes.get(&ids[0]).and_then(|n| n.parent);
        let all_same_parent = ids.iter().all(|&id| {
            self.scene.nodes.get(&id).and_then(|n| n.parent) == first_parent
        });
        let group_parent = if all_same_parent { first_parent } else { None };

        // Find the z-position: insert group at the position of the topmost (last) member
        // in the parent's children list (or root_nodes)
        let insert_index = {
            let sibling_list = if let Some(pid) = group_parent {
                self.scene.nodes.get(&pid).map(|n| n.children.clone()).unwrap_or_default()
            } else {
                self.scene.root_nodes.clone()
            };
            let id_set: std::collections::HashSet<u32> = ids.iter().cloned().collect();
            let mut max_idx = 0usize;
            for (i, &sib_id) in sibling_list.iter().enumerate() {
                if id_set.contains(&sib_id) {
                    max_idx = i;
                }
            }
            max_idx
        };

        // Compute group global transform: use the AABB min corner of selected members
        // so the group origin is at the top-left of the bounding box
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        for &id in &ids {
            if let Some(spatial) = self.node_to_spatial.get(&id) {
                let lower = spatial.aabb.lower();
                min_x = min_x.min(lower[0]);
                min_y = min_y.min(lower[1]);
            }
        }
        if min_x == f32::MAX { min_x = 0.0; }
        if min_y == f32::MAX { min_y = 0.0; }

        // Group local transform: if the group has a parent, compute local from global
        let group_global = Mat3::from_translation(Vec2::new(min_x, min_y));
        let group_local = if let Some(pid) = group_parent {
            let parent_global = self.global_transforms.get(&pid)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY);
            parent_global.inverse() * group_global
        } else {
            group_global
        };

        let group_node = Node {
            id: group_id,
            name: format!("Group {}", group_id),
            node_type: NodeType::Group,
            transform: Transform2D::from_mat3(&group_local),
            style: Style {
    fills: Vec::new(),
    strokes: vec![],
    opacity: 1.0,
    blend_mode: 0,
    fill_rule: 0,
    corner_radius: 0.0,
    effects: Vec::new(),
},
            geometry: Geometry::Rect { width: 0.0, height: 0.0 },
            children: Vec::new(),
            parent: group_parent,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
            };
        self.scene.nodes.insert(group_id, group_node);

        // Insert group at the correct z-position in its parent
        if let Some(pid) = group_parent {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                let pos = (insert_index + 1).min(parent.children.len());
                parent.children.insert(pos, group_id);
            }
        } else {
            let pos = (insert_index + 1).min(self.scene.root_nodes.len());
            self.scene.root_nodes.insert(pos, group_id);
        }

        // Compute the group's global transform so we can use it for child reparenting
        self.update_node_global_transform(group_id);
        let group_global_inv = group_global.inverse();

        // Reparent nodes: adjust their local transforms using proper matrix math
        // child_new_local = group_global_inv * child_global
        for &id in &ids {
            let child_global = self.global_transforms.get(&id)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY);
            let child_new_local = group_global_inv * child_global;

            // Remove from old parent
            let old_parent = self.scene.nodes.get(&id).and_then(|n| n.parent);
            if let Some(old_pid) = old_parent {
                if let Some(old_p) = self.scene.nodes.get_mut(&old_pid) {
                    old_p.children.retain(|&c| c != id);
                }
            } else {
                self.scene.root_nodes.retain(|&r| r != id);
            }

            // Update transform and parent
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                let hint = node.transform;
                node.transform = Transform2D::from_mat3_hint(&child_new_local, Some(&hint));
                node.parent = Some(group_id);
            }
            if let Some(g) = self.scene.nodes.get_mut(&group_id) {
                g.children.push(id);
            }
        }

        // Recompute transforms and spatial index for the entire group subtree
        self.update_node_global_transform(group_id);
        self.update_spatial_index_recursive(group_id);
        self.mark_dirty(group_id);
        group_id
    }

    /// Ungroup a group node, promoting its children to the group's parent level.
    /// Children are inserted at the group's z-position, preserving their global positions.
    pub fn ungroup_node(&mut self, id: u32) {
        // The group is about to stop existing: drop the Live Paint bookkeeping
        // that outlives the node, while it is still here to be classified. Its
        // members keep their geometry but leave the surface, so the network has
        // to be rebuilt without them — dissolving a painted group discards the
        // paint, the same as Release, rather than stranding it on the canvas.
        if self.is_in_any_live_paint(id) {
            self.scene.vector_network.dirty = true;
        }
        self.forget_live_paint_group(id);
        self.boolean_groups.remove(&id);
        self.dirty_boolean_groups.remove(&id);

        let (children, group_parent, group_global) = if let Some(node) = self.scene.nodes.get(&id) {
            if !matches!(node.node_type, NodeType::Group) { return; }
            let global = self.global_transforms.get(&id)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY);
            (node.children.clone(), node.parent, global)
        } else {
            return;
        };

        // Find the group's index in its parent's children list (or root_nodes)
        let group_index = if let Some(pid) = group_parent {
            self.scene.nodes.get(&pid)
                .and_then(|p| p.children.iter().position(|&c| c == id))
                .unwrap_or(0)
        } else {
            self.scene.root_nodes.iter().position(|&r| r == id).unwrap_or(0)
        };

        // Compute parent's global transform for local transform computation
        let parent_global = if let Some(pid) = group_parent {
            self.global_transforms.get(&pid)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY)
        } else {
            Mat3::IDENTITY
        };
        let parent_global_inv = parent_global.inverse();

        // Promote children to the group's parent, preserving global positions
        for (offset, &child_id) in children.iter().enumerate() {
            // child_new_local = parent_global_inv * child_global
            // where child_global = group_global * child_old_local
            let child_old_local = self.scene.nodes.get(&child_id)
                .map(|n| n.transform.to_mat3())
                .unwrap_or(Mat3::IDENTITY);
            let child_global = group_global * child_old_local;
            let child_new_local = parent_global_inv * child_global;

            if let Some(child) = self.scene.nodes.get_mut(&child_id) {
                let hint = child.transform;
                child.transform = Transform2D::from_mat3_hint(&child_new_local, Some(&hint));
                child.parent = group_parent;
            }

            // Insert at the group's former position
            if let Some(pid) = group_parent {
                if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                    let pos = (group_index + offset).min(parent.children.len());
                    parent.children.insert(pos, child_id);
                }
            } else {
                let pos = (group_index + offset).min(self.scene.root_nodes.len());
                self.scene.root_nodes.insert(pos, child_id);
            }
        }

        // Remove the group node itself
        if let Some(group) = self.scene.nodes.get_mut(&id) {
            group.children.clear();
        }
        self.scene.nodes.remove(&id);
        // Remove group from its parent's children list (or root_nodes)
        if let Some(pid) = group_parent {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                parent.children.retain(|&c| c != id);
            }
        } else {
            self.scene.root_nodes.retain(|&r| r != id);
        }
        self.global_transforms.remove(&id);
        if let Some(old) = self.node_to_spatial.remove(&id) {
            self.spatial_index.remove(&old);
        }
        self.scene.selection.retain(|&s| s != id);

        // Update children transforms and spatial indices
        for &child_id in &children {
            self.update_node_global_transform(child_id);
            self.update_spatial_index_recursive(child_id);
            self.mark_dirty(child_id);
        }

        // Update ancestor group bounds if we ungrouped inside another group
        if let Some(pid) = group_parent {
            self.update_ancestor_group_bounds(pid);
        }
    }

    /// Add a text node.
    pub fn add_text(&mut self, x: f32, y: f32, content: &str, font_size: f32) -> u32 {
        let id = self.alloc_id();

        let node = Node {
            id,
            name: format!("Text {}", id),
            node_type: NodeType::Text,
            transform: Transform2D::from_translation(x, y),
            style: Style {
    fills: vec![Paint::Solid(Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 })],
    strokes: vec![],
    opacity: 1.0,
    blend_mode: 0,
    fill_rule: 0,
    corner_radius: 0.0,
    effects: Vec::new(),
},
            geometry: Geometry::Text { content: content.to_string(), font_size, font_family: String::new(), text_align: 0, line_height: 1.2, font_weight: 400, italic: false, letter_spacing: 0.0 },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
            };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        // The one place that knows how much room a text node takes is the
        // shared bbox — a second estimate here (whole content as one line) went
        // stale the moment the shared one learned about line breaks.
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    /// Register encoded image bytes (PNG/JPEG/…), returning an image id.
    /// Content-addressed: identical bytes reuse the same id (dedup).
    pub fn register_image(&mut self, bytes: &[u8], mime: &str) -> u32 {
        // Cheap content hash for dedup (FNV-1a over the bytes).
        let mut hash: u64 = 0xcbf29ce484222325;
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        // Reuse an existing image with identical bytes.
        for (&id, data) in &self.scene.images {
            if data.bytes.len() == bytes.len() && data.bytes == bytes {
                let _ = hash;
                return id;
            }
        }
        // Images carry their own id space, and it collides across peers for the
        // same reason node ids did — so partition it by site too.
        let next = self
            .scene
            .images
            .keys()
            .filter(|k| site_of(**k) == self.site_id)
            .map(|k| counter_of(*k))
            .max()
            .unwrap_or(0)
            + 1;
        let id = make_id(self.site_id, next);
        self.scene.images.insert(id, ImageData { bytes: bytes.to_vec(), mime: mime.to_string() });
        id
    }

    /// Add a raster image node referencing a previously-registered image id.
    /// Set whether an image node samples with nearest-neighbour when scaled.
    ///
    /// SVG spells this `image-rendering`; `optimizeSpeed`, `pixelated` and
    /// `crisp-edges` all mean "do not smooth". Without it, magnifying pixel art
    /// blurs it, which is both wrong per spec and the opposite of what anyone
    /// drawing pixel art wants.
    pub fn set_image_pixelated(&mut self, id: u32, on: bool) -> bool {
        let Some(node) = self.scene.nodes.get_mut(&id) else { return false };
        let Geometry::Image { pixelated, .. } = &mut node.geometry else { return false };
        *pixelated = on;
        // Same as every sibling setter: the flag rides the render buffer, so
        // without this an interactive toggle would not repaint until something
        // else happened to dirty the node.
        self.mark_dirty(id);
        true
    }

    /// Whether an image node samples with nearest-neighbour.
    pub fn get_image_pixelated(&self, id: u32) -> bool {
        match self.scene.nodes.get(&id).map(|n| &n.geometry) {
            Some(Geometry::Image { pixelated, .. }) => *pixelated,
            _ => false,
        }
    }

    pub fn add_image(&mut self, x: f32, y: f32, w: f32, h: f32, image_id: u32) -> u32 {
        let id = self.alloc_id();

        let node = Node {
            id,
            name: format!("Image {}", id),
            node_type: NodeType::Image,
            transform: Transform2D::from_translation(x, y),
            style: Style {
                fills: vec![],
                strokes: vec![],
                opacity: 1.0,
                blend_mode: 0,
                fill_rule: 0,
                corner_radius: 0.0,
                effects: Vec::new(),
            },
            geometry: Geometry::Image { width: w, height: h, image_id, pixelated: false },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
        };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    /// Encoded bytes for a registered image (for the renderer to decode).
    pub fn get_image_bytes(&self, image_id: u32) -> Vec<u8> {
        self.scene.images.get(&image_id).map(|d| d.bytes.clone()).unwrap_or_default()
    }

    /// MIME type for a registered image.
    pub fn get_image_mime(&self, image_id: u32) -> String {
        self.scene.images.get(&image_id).map(|d| d.mime.clone()).unwrap_or_default()
    }

    /// Update a text node's content and font size.
    pub fn set_text_content(&mut self, id: u32, content: &str, font_size: f32) {
        let updated = if let Some(node) = self.scene.nodes.get_mut(&id) {
            if let Geometry::Text { content: c, font_size: fs, .. } = &mut node.geometry {
                *c = content.to_string();
                *fs = font_size.max(1.0);
                true
            } else {
                false
            }
        } else {
            false
        };
        if updated {
            self.update_spatial_index(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Update a text node's typography properties (font family, alignment, line height).
    pub fn set_text_properties(&mut self, id: u32, font_family: &str, text_align: u8, line_height: f32) {
        let updated = if let Some(node) = self.scene.nodes.get_mut(&id) {
            if let Geometry::Text { font_family: ff, text_align: ta, line_height: lh, .. } = &mut node.geometry {
                *ff = font_family.to_string();
                *ta = text_align;
                *lh = if line_height > 0.0 { line_height } else { 1.2 };
                true
            } else {
                false
            }
        } else {
            false
        };
        if updated {
            self.update_spatial_index(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Update a text node's weight/style: font_weight (100–900), italic,
    /// letter_spacing (local units).
    pub fn set_text_style(&mut self, id: u32, font_weight: u32, italic: bool, letter_spacing: f32) {
        let updated = if let Some(node) = self.scene.nodes.get_mut(&id) {
            if let Geometry::Text { font_weight: fw, italic: it, letter_spacing: ls, .. } = &mut node.geometry {
                *fw = font_weight.clamp(1, 1000) as u16;
                *it = italic;
                *ls = letter_spacing;
                true
            } else {
                false
            }
        } else {
            false
        };
        if updated {
            self.update_spatial_index(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Get bounding box of a node in world coordinates: [minX, minY, maxX, maxY]
    pub fn get_node_bounds(&self, id: u32) -> Vec<f32> {
        if let Some(spatial) = self.node_to_spatial.get(&id) {
            let lower = spatial.aabb.lower();
            let upper = spatial.aabb.upper();
            vec![lower[0], lower[1], upper[0], upper[1]]
        } else {
            vec![0.0, 0.0, 0.0, 0.0]
        }
    }

    // ─── Per-Node VectorNetwork Editing API ─────────────────────────────

    /// Get the per-node vector network as JSON.
    pub fn get_node_network_json(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .and_then(|n| match &n.geometry {
                Geometry::Path { network, .. } => network.as_ref(),
                _ => None,
            })
            .map(|net| serde_json::to_string(net).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Update a vertex position and handles in a node's network.
    pub fn set_network_vertex(
        &mut self, node_id: u32, vertex_idx: u32,
        x: f32, y: f32,
        hin_x: f32, hin_y: f32, has_hin: bool,
        hout_x: f32, hout_y: f32, has_hout: bool,
    ) {
        if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, ref mut subpaths, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    if let Some(v) = net.vertices.get_mut(vertex_idx as usize) {
                        v.position = Vec2::new(x, y);
                        v.handle_in = if has_hin { Some(Vec2::new(hin_x, hin_y)) } else { None };
                        v.handle_out = if has_hout { Some(Vec2::new(hout_x, hout_y)) } else { None };
                    }
                    *subpaths = net.to_subpaths();
                }
            }
        }
        self.update_spatial_index(node_id);
        self.mark_dirty(node_id);
    }

    /// Add a vertex to a node's network. Returns the new vertex index.
    pub fn add_network_vertex(&mut self, node_id: u32, x: f32, y: f32) -> i32 {
        let result = if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, ref mut subpaths, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    let idx = net.vertices.len() as u32;
                    net.vertices.push(NetworkVertex {
                        position: Vec2::new(x, y),
                        handle_in: None,
                        handle_out: None,
                        corner_radius: 0.0,
                    });
                    *subpaths = net.to_subpaths();
                    idx as i32
                } else { -1 }
            } else { -1 }
        } else { -1 };
        if result >= 0 {
            self.update_spatial_index(node_id);
            self.mark_dirty(node_id);
        }
        result
    }

    /// Add an edge between two vertices in a node's network. Returns the edge index.
    pub fn add_network_edge(&mut self, node_id: u32, start: u32, end: u32) -> i32 {
        let result = if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, ref mut subpaths, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    let idx = net.edges.len() as u32;
                    net.edges.push(NetworkEdge {
                        start_vertex: start,
                        end_vertex: end,
                    });
                    *subpaths = net.to_subpaths();
                    idx as i32
                } else { -1 }
            } else { -1 }
        } else { -1 };
        if result >= 0 {
            self.update_spatial_index(node_id);
            self.mark_dirty(node_id);
        }
        result
    }

    /// Remove a vertex (and its edges) from a node's network.
    pub fn remove_network_vertex(&mut self, node_id: u32, vertex_idx: u32) {
        if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, ref mut subpaths, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    let vi = vertex_idx as usize;
                    if vi < net.vertices.len() {
                        net.vertices.remove(vi);
                        // Remove edges referencing this vertex, and remap indices
                        net.edges.retain(|e| {
                            e.start_vertex != vertex_idx && e.end_vertex != vertex_idx
                        });
                        for e in &mut net.edges {
                            if e.start_vertex > vertex_idx { e.start_vertex -= 1; }
                            if e.end_vertex > vertex_idx { e.end_vertex -= 1; }
                        }
                        // Also remap region edge references
                        net.regions.clear(); // Regions invalidated by topology change
                        *subpaths = net.to_subpaths();
                    }
                }
            }
        }
        self.update_spatial_index(node_id);
        self.mark_dirty(node_id);
    }

    /// Detect enclosed regions in a node's network (placeholder — uses simple cycle detection).
    pub fn detect_node_regions(&mut self, node_id: u32) {
        if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, .. } = node.geometry {
                if let Some(_net) = network.as_mut() {
                    // TODO: Implement per-node planar face detection
                    // For now, regions are managed manually via set_node_region_fill
                }
            }
        }
    }

    /// Set fill color on a specific region of a node's network.
    pub fn set_node_region_fill(
        &mut self, node_id: u32, region_idx: u32,
        r: f32, g: f32, b: f32, a: f32,
    ) {
        if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    if let Some(region) = net.regions.get_mut(region_idx as usize) {
                        region.fill = Some(Color { r, g, b, a });
                    }
                }
            }
        }
        self.mark_dirty(node_id);
    }

    // ─── End Per-Node VectorNetwork API ─────────────────────────────────
}

#[wasm_bindgen]
pub struct History {
    undo_stack: Vec<Vec<u8>>,
    redo_stack: Vec<Vec<u8>>,
    max_size: usize,
}

#[wasm_bindgen]
impl History {
    #[wasm_bindgen(constructor)]
    pub fn new(max_size: usize) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_size,
        }
    }

    pub fn push_state(&mut self, data: Vec<u8>) {
        self.undo_stack.push(data);
        if self.undo_stack.len() > self.max_size {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    pub fn undo(&mut self, current_state: Vec<u8>) -> Option<Vec<u8>> {
        if let Some(state) = self.undo_stack.pop() {
            self.redo_stack.push(current_state);
            Some(state)
        } else {
            None
        }
    }

    pub fn redo(&mut self, current_state: Vec<u8>) -> Option<Vec<u8>> {
        if let Some(state) = self.redo_stack.pop() {
            self.undo_stack.push(current_state);
            Some(state)
        } else {
            None
        }
    }

    /// How many states are on each stack. The editor keeps a parallel stack of
    /// the *mode* each state was captured in (which shape was being
    /// node-edited, which group you had drilled into) so undo can put you back
    /// where you were, and it trims that mirror against these lengths — this
    /// struct silently drops the oldest state once `max_size` is exceeded, and
    /// a mirror that missed the drop would hand every undo the wrong mode.
    pub fn undo_len(&self) -> usize {
        self.undo_stack.len()
    }

    pub fn redo_len(&self) -> usize {
        self.redo_stack.len()
    }
}

// ─── Live Paint / Vector Network API ────────────────────────────────────────────

#[wasm_bindgen]
impl Engine {
    /// Rebuild the planar graph from all visible paths.
    pub fn rebuild_vector_network(&mut self) {
        let (segments, curves) = self.collect_segments();
        self.scene.vector_network.group_gap = self.gap_overrides();
        // Where each Live Paint group is now, so fills can be carried from where
        // it was (see `rebuild`).
        let group_transforms: std::collections::HashMap<u32, [f32; 9]> = self
            .live_paint_group_ids()
            .into_iter()
            .filter_map(|g| self.global_transforms.get(&g).copied().map(|t| (g, t)))
            .collect();
        self.scene.vector_network.rebuild(segments, curves, &group_transforms);
    }

    /// Mark the vector network as needing recomputation.
    pub fn invalidate_vector_network(&mut self) {
        self.scene.vector_network.dirty = true;
    }

    /// Query which face contains the given point. Returns face ID or -1.
    pub fn query_face_at(&mut self, x: f32, y: f32) -> i32 {
        self.ensure_network_clean();
        match self.scene.vector_network.query_face_at(x, y) {
            Some(id) => id as i32,
            None => -1,
        }
    }

    /// Get a face's exact-bézier outline as JSON `[{x,y,cp1:[x,y],cp2:[x,y]}]`
    /// (closed subpath). Used for the hover highlight.
    pub fn get_face_boundary(&mut self, face_id: u32) -> String {
        self.ensure_network_clean();
        let vn = &self.scene.vector_network;
        match vn.faces.get(&face_id) {
            Some(face) => serde_json::to_string(&pathpoints_to_json(&vn.face_outline(face))).unwrap_or_default(),
            None => "[]".to_string(),
        }
    }

    /// Assign a solid fill colour to a face.
    pub fn set_face_fill(&mut self, face_id: u32, r: f32, g: f32, b: f32, a: f32) {
        if let Some(face) = self.scene.vector_network.faces.get_mut(&face_id) {
            face.fill = Some(Paint::Solid(Color { r, g, b, a }));
        }
    }

    /// Assign any paint to a face — the gradient path. `paint_json` is the same
    /// shape a node's `style.fills[0]` uses. Returns false if it doesn't parse,
    /// rather than silently leaving the face unpainted.
    ///
    /// Gradient coordinates are WORLD space here: a face is a world-space
    /// outline with no transform of its own, unlike a node's fill.
    pub fn set_face_paint(&mut self, face_id: u32, paint_json: &str) -> bool {
        let paint: Paint = match serde_json::from_str(paint_json) {
            Ok(p) => p,
            Err(_) => return false,
        };
        match self.scene.vector_network.faces.get_mut(&face_id) {
            Some(face) => {
                face.fill = Some(paint);
                true
            }
            None => false,
        }
    }

    /// A face's paint as JSON, or "" when it has none. The gradient handles
    /// read through this: a face is not a node, so there is no style to query.
    pub fn get_face_paint(&self, face_id: u32) -> String {
        self.scene
            .vector_network
            .faces
            .get(&face_id)
            .and_then(|f| f.fill.as_ref())
            .and_then(|p| serde_json::to_string(p).ok())
            .unwrap_or_default()
    }

    /// Clear a face's fill.
    pub fn clear_face_fill(&mut self, face_id: u32) {
        if let Some(face) = self.scene.vector_network.faces.get_mut(&face_id) {
            face.fill = None;
        }
    }

    /// Get all filled faces as JSON for rendering. Each face carries both the
    /// flattened `boundary` polygon (hit tests) and the exact-bézier `outline`
    /// (anchor + handles) used to render/export true curves.
    pub fn get_filled_faces(&mut self) -> String {
        self.ensure_network_clean();
        let vn = &self.scene.vector_network;
        let filled: Vec<serde_json::Value> = vn.faces.values()
            .filter(|f| f.fill.is_some() && !f.is_outer)
            .map(|f| {
                let fill = f.fill.as_ref().unwrap();
                let c = paint_color(fill).unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 });
                serde_json::json!({
                    "id": f.id,
                    "boundary": f.boundary_polygon,
                    "outline": pathpoints_to_json(&vn.face_outline(f)),
                    // `fill` stays a flat colour for callers that only need one
                    // (Expand's stroke pass); `paint` carries the real thing.
                    "fill": { "r": c.r, "g": c.g, "b": c.b, "a": c.a },
                    "paint": fill,
                })
            })
            .collect();
        serde_json::to_string(&filled).unwrap_or_default()
    }

    /// Per-group Live Paint render data for SVG export, mirroring the in-app
    /// compositing: every colored face (effective color, tagged with its owning
    /// group) that draws UNDER the members' strokes, plus painted edges (on top).
    /// JSON: `{"groups":[id,…],"faces":[{group,outline,fill}],"edges":[{group,outline,color,width}]}`.
    pub fn get_live_paint_render_data(&mut self) -> String {
        self.ensure_network_clean();
        let order = self.draw_order();
        let rank: std::collections::HashMap<u32, usize> =
            order.iter().enumerate().map(|(i, &id)| (id, i)).collect();
        let vn = &self.scene.vector_network;
        let mut ordered: Vec<&crate::vector_network::PlanarFace> =
            vn.faces.values().filter(|f| !f.is_outer).collect();
        ordered.sort_by(|a, b| b.signed_area.abs()
            .partial_cmp(&a.signed_area.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.id.cmp(&b.id)));
        let faces: Vec<serde_json::Value> = ordered.into_iter()
            .filter_map(|f| {
                let paint = f.fill.clone().or_else(|| self.inherited_face_paint(f, &rank));
                paint.map(|p| {
                    let c = paint_color(&p).unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 });
                    let rings = vn.face_rings(f);
                    serde_json::json!({
                        "group": f.group,
                        "outline": pathpoints_to_json(&rings[0]),
                        // Islands inside this region. An exporter that ignores
                        // them draws a solid region over whatever it enclosed.
                        "holes": rings[1..].iter().map(|r| pathpoints_to_json(r)).collect::<Vec<_>>(),
                        "fill": { "r": c.r, "g": c.g, "b": c.b, "a": c.a },
                        "paint": p,
                    })
                })
            })
            .collect();
        let edges: Vec<serde_json::Value> = vn.logical_edges.values()
            .filter_map(|le| le.paint.map(|c| serde_json::json!({
                "group": le.group,
                "outline": pathpoints_to_json(&le.outline),
                "color": { "r": c.r, "g": c.g, "b": c.b, "a": c.a },
                "width": le.width,
            })))
            .collect();
        let groups = self.live_paint_group_ids();
        serde_json::to_string(&serde_json::json!({
            "groups": groups, "faces": faces, "edges": edges,
        })).unwrap_or_else(|_| "{\"groups\":[],\"faces\":[],\"edges\":[]}".to_string())
    }

    /// Faces to bake on Expand: every non-outer face with an EFFECTIVE fill —
    /// the painted override if set, else the fill of the topmost source shape
    /// covering it (Illustrator absorbs source appearance). Faces with no fill
    /// are omitted (discarded on expand). JSON: `[{outline, fill}]`.
    pub fn get_live_paint_faces(&mut self) -> String {
        self.ensure_network_clean();
        let items: Vec<serde_json::Value> = self.live_paint_faces_effective(self.scene.live_paint_group).into_iter()
            .map(|(paint, rings)| {
                let c = paint_color(&paint).unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 });
                serde_json::json!({
                    "outline": pathpoints_to_json(&rings[0]),
                    // Islands, so a baked region keeps its holes instead of
                    // becoming a solid slab over whatever it enclosed.
                    "holes": rings[1..].iter().map(|r| pathpoints_to_json(r)).collect::<Vec<_>>(),
                    "fill": { "r": c.r, "g": c.g, "b": c.b, "a": c.a },
                    "paint": paint,
                })
            })
            .collect();
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
    }

    /// Edges to bake on Expand: every logical edge of the ACTIVE group with an
    /// effective stroke — the painted override if set, else the source shape's
    /// own stroke. Expand deletes the originals, so this is what keeps the drawn
    /// lines alive. JSON: `[{outline, color, width, cap, join}]`.
    pub fn get_live_paint_expand_edges(&mut self) -> String {
        self.ensure_network_clean();
        let items: Vec<serde_json::Value> = self
            .live_paint_edges_effective(self.scene.live_paint_group)
            .into_iter()
            .map(|(c, width, cap, join, outline)| serde_json::json!({
                "outline": pathpoints_to_json(&outline),
                "color": { "r": c.r, "g": c.g, "b": c.b, "a": c.a },
                "width": width,
                "cap": cap,
                "join": join,
            }))
            .collect();
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
    }

    /// Every colored face as (effective color, exact-bézier outline). Effective
    /// color = painted override, else the topmost covering source fill. Shared by
    /// Expand (JSON) and the render writer (in-stream faces). Pure reads.
    fn live_paint_faces_effective(&self, group: Option<u32>) -> Vec<(Paint, Vec<Vec<PathPoint>>)> {
        let order = self.draw_order();
        let rank: std::collections::HashMap<u32, usize> =
            order.iter().enumerate().map(|(i, &id)| (id, i)).collect();
        let vn = &self.scene.vector_network;
        let mut faces: Vec<&crate::vector_network::PlanarFace> = vn.faces.values()
            .filter(|f| !f.is_outer)
            .filter(|f| group.map_or(true, |g| f.group == g))
            .collect();
        // Largest first, ties by id. Faces carry their islands as holes now, so
        // nothing should depend on this order — but a region drawn over its
        // neighbour was previously decided by map iteration, which is not an
        // order at all, and "biggest underneath" is the one that degrades
        // sensibly if a hole is ever missed.
        faces.sort_by(|a, b| b.signed_area.abs()
            .partial_cmp(&a.signed_area.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.id.cmp(&b.id)));
        faces.into_iter()
            .filter_map(|f| {
                let paint = f.fill.clone().or_else(|| self.inherited_face_paint(f, &rank));
                paint.map(|p| (p, vn.face_rings(f)))
            })
            .collect()
    }

    /// Painted logical edges as (color, width, exact-bézier outline). Optionally
    /// filtered to a single Live Paint group. Pure reads.
    fn live_paint_edges_painted(&self, group: Option<u32>) -> Vec<(Color, f32, Vec<PathPoint>)> {
        self.scene.vector_network.logical_edges.values()
            .filter(|le| group.map_or(true, |g| le.group == g))
            .filter_map(|le| le.paint.map(|c| (c, le.width, le.outline.clone())))
            .collect()
    }

    /// Every logical edge with an EFFECTIVE stroke, as (color, world width, cap,
    /// join, outline). Effective stroke = the painted override, else the stroke
    /// of the edge's source shape — Illustrator absorbs source appearance on
    /// Expand, so lines the user drew (but never bucket-painted) survive it.
    /// Edges whose source carries no visible stroke are omitted. Pure reads.
    fn live_paint_edges_effective(
        &self,
        group: Option<u32>,
    ) -> Vec<(Color, f32, u8, u8, Vec<PathPoint>)> {
        self.scene.vector_network.logical_edges.values()
            .filter(|le| group.map_or(true, |g| le.group == g))
            .filter_map(|le| {
                let (color, width, cap, join) = match le.paint {
                    // Painted edges render round-capped, in world units already.
                    Some(c) => (c, le.width, 1u8, 1u8),
                    None => {
                        let node = self.scene.nodes.get(&le.source_node)?;
                        let sk = node.style.strokes.first()?;
                        let c = sk.paint.as_ref().and_then(paint_color)?;
                        // The outline is world space; the stroke width is local.
                        (c, sk.width * self.node_world_scale(le.source_node), sk.cap, sk.join)
                    }
                };
                if width <= 0.0 || color.a <= 0.0 {
                    return None;
                }
                Some((color, width, cap, join, le.outline.clone()))
            })
            .collect()
    }

    /// Average scale factor of a node's global transform (√|det|), for turning
    /// local lengths — stroke widths — into world lengths. 1.0 if unknown.
    fn node_world_scale(&self, node: u32) -> f32 {
        match self.global_transforms.get(&node) {
            Some(m) => {
                let mat = Mat3::from_cols_array(m);
                let det = (mat.x_axis.x * mat.y_axis.y - mat.x_axis.y * mat.y_axis.x).abs();
                det.sqrt().max(1e-6)
            }
            None => 1.0,
        }
    }

    /// Ids of every node flagged as a Live Paint group, ascending (stable order).
    fn live_paint_group_ids(&self) -> Vec<u32> {
        let mut v: Vec<u32> = self.live_paint_groups.iter().copied().collect();
        v.sort_unstable();
        v
    }

    /// Whether any node in the scene is a Live Paint group.
    fn has_live_paint(&self) -> bool {
        !self.live_paint_groups.is_empty()
    }

    /// Whether `id` is a Live Paint group or a descendant of one.
    fn is_in_any_live_paint(&self, id: u32) -> bool {
        if self.live_paint_groups.is_empty() {
            return false;
        }
        self.live_paint_groups.contains(&id)
            || self.live_paint_groups.iter().any(|&g| self.is_descendant_of(id, g))
    }

    /// The nearest FLAGGED ancestor of `id`, excluding `id` itself. Unlike
    /// `live_paint_group_of` this answers "would flagging this nest it inside
    /// another one", which is a question about the ancestors only.
    fn live_paint_ancestor_of(&self, id: u32) -> Option<u32> {
        let mut cur = self.scene.nodes.get(&id).and_then(|n| n.parent);
        while let Some(pid) = cur {
            match self.scene.nodes.get(&pid) {
                Some(node) => {
                    if node.live_paint {
                        return Some(pid);
                    }
                    cur = node.parent;
                }
                None => break
            }
        }
        None
    }

    /// Every flagged group strictly beneath `id`.
    fn live_paint_descendants_of(&self, id: u32) -> Vec<u32> {
        self.live_paint_groups
            .iter()
            .copied()
            .filter(|&g| g != id && self.is_descendant_of(g, id))
            .collect()
    }

    /// Recompute the Live Paint group cache from scratch. Called after bulk
    /// scene replacement (snapshot load), where per-node maintenance doesn't apply.
    ///
    /// This is also where a document saved with a NESTED flag is healed. Until
    /// `set_node_live_paint` learned to refuse one, arming the bucket on a shape
    /// that was already inside a Live Paint group wrapped it in a second one, and
    /// that flag went into the saved file — so the shape kept painting as its own
    /// surface on every later open, and no amount of fixing the write path would
    /// reach it. Clearing the inner flag on load is the migration: it is the only
    /// interpretation that was ever meaningful, it needs no file-format change,
    /// and it costs one ancestor walk per flagged group.
    fn rebuild_live_paint_cache(&mut self) {
        self.live_paint_groups = self.scene.nodes.iter()
            .filter(|(_, n)| n.live_paint)
            .map(|(&id, _)| id)
            .collect();
        self.clear_nested_live_paint_flags();
    }

    /// Forget a group that is being destroyed.
    ///
    /// Three pieces of state outlive a `nodes.remove()` and every one of them is
    /// a dangling id afterwards: the group cache, the network built from that
    /// group's members, and the active paint scope. Ungroup skipped all three,
    /// so ungrouping a Live Paint group left its id in the render list and its
    /// faces on the canvas — paint belonging to a group that no longer existed,
    /// which survived until something else happened to dirty the network.
    fn forget_live_paint_group(&mut self, id: u32) {
        if self.live_paint_groups.remove(&id) {
            self.scene.vector_network.dirty = true;
        }
        if self.scene.live_paint_group == Some(id) {
            self.scene.live_paint_group = None;
            self.scene.vector_network.dirty = true;
        }
    }

    /// Enforce one flag per nest: clear the flag on every group that has a
    /// flagged ancestor. Returns true if anything changed.
    ///
    /// Nesting is reachable from three directions and the rule has to hold from
    /// all of them, so it lives here rather than in any one caller: flagging a
    /// group (`set_node_live_paint`), *moving* an already-flagged group into a
    /// flagged one (the Objects panel drag — a flag that was legal where it was
    /// set becomes nested by the move), and loading a document written before
    /// any of this was enforced. The set is the flagged groups only, so this is
    /// a walk per flagged group, not per node.
    fn clear_nested_live_paint_flags(&mut self) -> bool {
        let nested: Vec<u32> = self.live_paint_groups
            .iter()
            .copied()
            .filter(|&g| self.live_paint_ancestor_of(g).is_some())
            .collect();
        if nested.is_empty() {
            return false;
        }
        for id in nested {
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                node.live_paint = false;
            }
            self.live_paint_groups.remove(&id);
        }
        self.scene.vector_network.dirty = true;
        true
    }

    /// Recompute the Boolean Group cache from scratch, and flag every one dirty so
    /// JS recomputes their outlines after a snapshot load (`bool_cache` isn't
    /// serialized). Mirrors `rebuild_live_paint_cache`.
    fn rebuild_boolean_groups_cache(&mut self) {
        self.boolean_groups = self.scene.nodes.iter()
            .filter(|(_, n)| n.boolean_op.is_some())
            .map(|(&id, _)| id)
            .collect();
        self.dirty_boolean_groups = self.boolean_groups.clone();
    }

    /// Whether `id` is a Boolean Group or a descendant of one.
    #[allow(dead_code)]
    fn is_in_any_boolean_group(&self, id: u32) -> bool {
        if self.boolean_groups.is_empty() {
            return false;
        }
        self.boolean_groups.contains(&id)
            || self.boolean_groups.iter().any(|&g| self.is_descendant_of(id, g))
    }

    /// Flag every Boolean Group that is `id` itself or an ancestor of `id` as
    /// stale, so JS recomputes their outlines. Cheap no-op when none exist.
    fn mark_enclosing_boolean_groups_dirty(&mut self, id: u32) {
        if self.boolean_groups.is_empty() {
            return;
        }
        if self.boolean_groups.contains(&id) {
            self.dirty_boolean_groups.insert(id);
        }
        let mut cur = id;
        while let Some(node) = self.scene.nodes.get(&cur) {
            match node.parent {
                Some(pid) => {
                    if self.boolean_groups.contains(&pid) {
                        self.dirty_boolean_groups.insert(pid);
                    }
                    cur = pid;
                }
                None => break,
            }
        }
    }

    /// The fill of the topmost source shape whose interior contains `face`
    /// (its containment signature), or None if none of them has a fill color.
    fn inherited_face_paint(&self, face: &vector_network::PlanarFace, rank: &std::collections::HashMap<u32, usize>) -> Option<Paint> {
        let mut best: Option<(usize, Paint)> = None;
        for &nid in &face.signature {
            let node = match self.scene.nodes.get(&nid) { Some(n) => n, None => continue };
            if let Some(p) = node.style.fills.first() {
                let r = rank.get(&nid).copied().unwrap_or(0);
                if best.as_ref().map_or(true, |(br, _)| r >= *br) {
                    best = Some((r, self.paint_to_world(nid, p)));
                }
            }
        }
        best.map(|(_, p)| p)
    }

    /// Re-express a node's paint in WORLD space.
    ///
    /// A node's gradient coordinates are node-LOCAL — the renderer draws the
    /// node with its global transform applied, so the gradient rides along. A
    /// Live Paint face has no transform of its own: its outline is already
    /// world-space. Handing the local gradient over unchanged would park it at
    /// the origin, so fold the node's global transform into the gradient's own
    /// local matrix, which the renderer applies as the shader matrix.
    ///
    /// Solids, patterns and meshes are returned untouched.
    fn paint_to_world(&self, node_id: u32, paint: &Paint) -> Paint {
        let g = match paint {
            Paint::Gradient(g) => g,
            other => return other.clone(),
        };
        let m = match self.global_transforms.get(&node_id) {
            Some(m) => *m,
            None => return paint.clone(),
        };
        // Column-major glam [a,b,_, c,d,_, e,f,_] -> SVG affine [a,b,c,d,e,f].
        let node = [m[0], m[1], m[3], m[4], m[6], m[7]];
        let mut out = g.clone();
        out.transform = Some(match &g.transform {
            // Already has one: the node transform composes on the outside.
            Some(t) => compose_affine(&node, t),
            None => node,
        });
        Paint::Gradient(out)
    }

    /// Node ids in paint order (root list, depth-first; later = drawn on top).
    fn draw_order(&self) -> Vec<u32> {
        fn dfs(engine: &Engine, id: u32, out: &mut Vec<u32>) {
            out.push(id);
            if let Some(n) = engine.scene.nodes.get(&id) {
                for &c in &n.children { dfs(engine, c, out); }
            }
        }
        let mut out = Vec::new();
        for &r in &self.scene.root_nodes { dfs(self, r, &mut out); }
        out
    }

    /// Scope Live Paint to a group's descendants (an Illustrator "Live Paint
    /// Group"). Pass 0 to clear the scope (whole scene participates again).
    pub fn set_live_paint_group(&mut self, node_id: u32) {
        self.scene.live_paint_group = if node_id == 0 { None } else { Some(node_id) };
        self.scene.vector_network.dirty = true;
    }

    /// The active Live Paint group node id, or -1 if none.
    pub fn get_live_paint_group(&self) -> i32 {
        self.scene.live_paint_group.map(|g| g as i32).unwrap_or(-1)
    }

    /// Remove ALL Live Paint face fills and edge paints. Used by Expand once the
    /// painted marks have been baked into real path shapes so they don't
    /// double-render on top of the baked geometry.
    /// Drop every mark belonging to ONE Live Paint group.
    ///
    /// Expand bakes a group's colours into real shapes and then has to remove the
    /// marks it baked, or the same paint exists twice. It used to do that with
    /// the document-wide clear below — so expanding one group erased the colours
    /// of every OTHER group too. Copy a painted group, expand the copy, and the
    /// original came back blank, which is what it looked like from the outside:
    /// paint vanishing from something the user had not touched.
    ///
    /// Faces and logical edges carry their group, and a painted edge is found
    /// through the shape it was painted on. A pending fill — one read from a file
    /// and not yet placed — is attributed by its signature: if every shape that
    /// bounded it belongs to this group, it was this group's.
    pub fn clear_live_paint_marks_in_group(&mut self, group: u32) {
        let members: HashSet<u32> = self.scene.nodes.keys()
            .copied()
            .filter(|&id| self.live_paint_group_of(id) == Some(group))
            .collect();

        for face in self.scene.vector_network.faces.values_mut() {
            if face.group == group {
                face.fill = None;
            }
        }
        for le in self.scene.vector_network.logical_edges.values_mut() {
            if le.group == group {
                le.paint = None;
                le.width = 0.0;
            }
        }
        self.scene.vector_network.painted_edges.retain(|pe| !members.contains(&pe.source_node));
        self.scene.vector_network.pending_fills.retain(|pf| {
            // No signature means nothing ties it to a group; leaving it is the
            // conservative half — it can still find a home, where dropping it
            // would lose a colour that was never this group's to discard.
            pf.signature.is_empty() || !pf.signature.iter().all(|n| members.contains(n))
        });
    }

    pub fn clear_live_paint_marks(&mut self) {
        self.scene.vector_network.pending_fills.clear();
        self.scene.vector_network.painted_edges.clear();
        for face in self.scene.vector_network.faces.values_mut() {
            face.fill = None;
        }
        for le in self.scene.vector_network.logical_edges.values_mut() {
            le.paint = None;
            le.width = 0.0;
        }
    }

    /// Nearest paintable edge to a point (world units), or -1.
    pub fn query_edge_at(&mut self, x: f32, y: f32, tolerance: f32) -> i32 {
        self.ensure_network_clean();
        match self.scene.vector_network.query_edge_at(x, y, tolerance) {
            Some(id) => id as i32,
            None => -1,
        }
    }

    /// Paint a logical edge with a stroke color/width. The paint is anchored in
    /// the source path's local space so it follows the path when it moves.
    pub fn set_edge_paint(&mut self, edge_id: u32, r: f32, g: f32, b: f32, a: f32, width: f32) {
        self.ensure_network_clean();
        let (src, world_mid, seg, t) = match self.scene.vector_network.logical_edges.get(&edge_id) {
            Some(le) => (le.source_node, vector_network::polyline_midpoint(&le.polyline), le.anchor_seg, le.anchor_t),
            None => return,
        };
        let color = Color { r, g, b, a };
        let local = self.world_to_local(src, world_mid);
        let edges = &mut self.scene.vector_network.painted_edges;
        // Replace any paint already anchored to this edge (same node + segment,
        // or ~same spot for legacy entries).
        edges.retain(|pe| !(pe.source_node == src
            && ((seg >= 0 && pe.seg == seg && (pe.t - t).abs() < 0.02)
                || (pe.local - local).length() < 2.0)));
        edges.push(vector_network::PaintedEdge { source_node: src, local, color, width, seg, t });
        // Reflect immediately on the live logical edge.
        if let Some(le) = self.scene.vector_network.logical_edges.get_mut(&edge_id) {
            le.paint = Some(color);
            le.width = width;
        }
    }

    /// Remove the paint from a logical edge.
    pub fn clear_edge_paint(&mut self, edge_id: u32) {
        self.ensure_network_clean();
        let (src, world_mid, seg, t) = match self.scene.vector_network.logical_edges.get(&edge_id) {
            Some(le) => (le.source_node, vector_network::polyline_midpoint(&le.polyline), le.anchor_seg, le.anchor_t),
            None => return,
        };
        let local = self.world_to_local(src, world_mid);
        // Same predicate `set_edge_paint` uses to replace an entry — matching on
        // proximity alone missed paints anchored by segment identity, and the
        // survivor was re-applied by the next rebuild as if nothing happened.
        self.scene.vector_network.painted_edges.retain(|pe| !(pe.source_node == src
            && ((seg >= 0 && pe.seg == seg && (pe.t - t).abs() < 0.02)
                || (pe.local - local).length() < 2.0)));
        if let Some(le) = self.scene.vector_network.logical_edges.get_mut(&edge_id) {
            le.paint = None;
            le.width = 0.0;
        }
    }

    /// A logical edge's exact-bézier outline as JSON `[{x,y,cp1,cp2}]` (for the
    /// hover highlight), or `[]` if the id is unknown.
    pub fn get_edge_polyline(&mut self, edge_id: u32) -> String {
        self.ensure_network_clean();
        match self.scene.vector_network.logical_edges.get(&edge_id) {
            Some(le) => serde_json::to_string(&pathpoints_to_json(&le.outline)).unwrap_or_else(|_| "[]".to_string()),
            None => "[]".to_string(),
        }
    }

    /// All painted logical edges as JSON for rendering. Carries the exact-bézier
    /// `outline` (anchor + handles) and the flattened `polyline` (fallback).
    pub fn get_painted_edges(&mut self) -> String {
        self.ensure_network_clean();
        let items: Vec<serde_json::Value> = self.scene.vector_network.logical_edges.values()
            .filter_map(|le| le.paint.map(|c| serde_json::json!({
                "polyline": le.polyline.iter().map(|p| [p.x, p.y]).collect::<Vec<_>>(),
                "outline": pathpoints_to_json(&le.outline),
                "color": { "r": c.r, "g": c.g, "b": c.b, "a": c.a },
                "width": le.width,
            })))
            .collect();
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
    }

    /// Re-attach persisted edge paints to freshly-built logical edges. Runs
    /// after each rebuild: the local anchor is mapped to world through the
    /// current transform, then matched to the nearest same-source logical edge.
    pub(crate) fn resolve_painted_edges(&mut self) {
        if self.scene.vector_network.painted_edges.is_empty() {
            return;
        }
        // Snapshot each logical edge's identity: id, source, world midpoint, and
        // the source segments (+t-ranges) it covers.
        let candidates: Vec<(u32, u32, glam::Vec2, Vec<(u32, f32, f32)>)> =
            self.scene.vector_network.logical_edges.values()
                .map(|le| (le.id, le.source_node, vector_network::polyline_midpoint(&le.polyline), le.segs.clone()))
                .collect();

        let painted = self.scene.vector_network.painted_edges.clone();
        const MATCH_TOL: f32 = 40.0;
        for pe in &painted {
            let same: Vec<&(u32, u32, glam::Vec2, Vec<(u32, f32, f32)>)> =
                candidates.iter().filter(|(_, src, _, _)| *src == pe.source_node).collect();
            if same.is_empty() {
                continue;
            }
            // Tier 1 (structural): the logical edge on this source whose covered
            // segments include (pe.seg, pe.t). Robust when a crossing moves.
            let mut chosen: Option<u32> = None;
            if pe.seg >= 0 {
                let seg = pe.seg as u32;
                chosen = same.iter()
                    .find(|(_, _, _, segs)| segs.iter().any(|&(s, lo, hi)| s == seg && pe.t >= lo - 1e-4 && pe.t <= hi + 1e-4))
                    .map(|(id, _, _, _)| *id);
            }
            // Tier 2 (fallback): nearest midpoint (legacy files / no structural id).
            if chosen.is_none() {
                let target = self.local_to_world(pe.source_node, pe.local);
                let mut best: Option<(u32, f32)> = None;
                for (id, _, mid, _) in &same {
                    let d = (*mid - target).length();
                    if best.map_or(true, |(_, bd)| d < bd) { best = Some((*id, d)); }
                }
                if let Some((id, d)) = best {
                    if d <= MATCH_TOL || same.len() == 1 { chosen = Some(id); }
                }
            }
            if let Some(id) = chosen {
                if let Some(le) = self.scene.vector_network.logical_edges.get_mut(&id) {
                    le.paint = Some(pe.color);
                    le.width = pe.width;
                }
            }
        }
    }

    /// World→local for a node using its global transform (identity if unknown).
    fn world_to_local(&self, node: u32, p: glam::Vec2) -> glam::Vec2 {
        match self.global_transforms.get(&node) {
            Some(m) => {
                let mat = glam::Mat3::from_cols_array(m);
                mat.inverse().transform_point2(p)
            }
            None => p,
        }
    }

    /// Local→world for a node using its global transform (identity if unknown).
    fn local_to_world(&self, node: u32, p: glam::Vec2) -> glam::Vec2 {
        match self.global_transforms.get(&node) {
            Some(m) => glam::Mat3::from_cols_array(m).transform_point2(p),
            None => p,
        }
    }

    /// Set gap tolerance for the vector network.
    pub fn set_gap_tolerance(&mut self, tolerance: f32) {
        self.scene.vector_network.gap_tolerance = tolerance;
        self.scene.vector_network.dirty = true;
    }

    /// Set the Live Paint gap-closing distance (world units). Open path ends
    /// within this distance are bridged so the enclosed region is fillable.
    /// 0 disables gap closing.
    pub fn set_gap_bridge_distance(&mut self, distance: f32) {
        self.scene.vector_network.gap_bridge_distance = distance.max(0.0);
        self.scene.vector_network.dirty = true;
    }

    /// Get the current Live Paint gap-closing distance.
    pub fn get_gap_bridge_distance(&self) -> f32 {
        self.scene.vector_network.gap_bridge_distance
    }

    /// Set one Live Paint group's own gap-closing distance (world units), or
    /// clear it with a negative value so the group goes back to inheriting the
    /// document default. No-op on a node that isn't a Live Paint group.
    pub fn set_node_gap_bridge_distance(&mut self, id: u32, distance: f32) {
        let mut changed = false;
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            if node.live_paint {
                node.gap_bridge_distance =
                    if distance < 0.0 { None } else { Some(distance) };
                changed = true;
            }
        }
        if changed {
            // Which regions exist changes, so the graph has to be rebuilt.
            self.dirty_flags.insert(id, true);
            self.scene.vector_network.dirty = true;
        }
    }

    /// A Live Paint group's own gap-closing distance, or -1 when it has none of
    /// its own (it inherits the document default).
    pub fn get_node_gap_bridge_distance(&self, id: u32) -> f32 {
        self.scene.nodes.get(&id)
            .and_then(|n| n.gap_bridge_distance)
            .unwrap_or(-1.0)
    }

    /// The gap-closing distance actually in force for a group — its own setting
    /// if it has one, otherwise the document default. This is the number the UI
    /// shows, so what the control reads is what the bucket obeys.
    pub fn get_effective_gap_bridge_distance(&self, id: u32) -> f32 {
        self.scene.nodes.get(&id)
            .and_then(|n| n.gap_bridge_distance)
            .unwrap_or(self.scene.vector_network.gap_bridge_distance)
    }

    /// Check if the vector network is dirty.
    pub fn is_vector_network_dirty(&self) -> bool {
        self.scene.vector_network.dirty
    }
}

// ─── Protobuf File Format API ───────────────────────────────────────────────────

#[wasm_bindgen]
impl Engine {
    /// Serialize scene to protobuf bytes (.vec file format).
    pub fn serialize_proto(&self) -> Vec<u8> {
        proto::serialize_to_proto(&self.scene, self.next_id)
    }

    /// Deserialize scene from a `.Editor` file. Returns true on success.
    ///
    /// Prefer `load_document`, which reports *why* a load failed and what had
    /// to be repaired. This boolean form is kept for callers that genuinely
    /// only branch on success.
    pub fn deserialize_proto(&mut self, data: &[u8]) -> bool {
        self.load_document(data).starts_with("{\"ok\":true")
    }

    /// Load a `.Editor` file, returning a JSON status object.
    ///
    /// On success: `{"ok":true,"repairs":{…},"repaired":bool,"summary":"…"}`.
    /// On failure: `{"ok":false,"error":"too_new","detail":"…","requiredVersion":9,
    /// "supportedVersion":8}`.
    ///
    /// Failure leaves the current scene **untouched**. That matters: the old
    /// path assigned `self.scene` before it knew the load was sound, so a bad
    /// file could half-replace a good document.
    pub fn load_document(&mut self, data: &[u8]) -> String {
        match proto::deserialize_from_proto(data) {
            Ok((scene, _next_id, report)) => {
                self.adopt_loaded_scene(scene);
                Self::load_ok_json(&report)
            }
            Err(e) => Self::load_error_json(&e),
        }
    }

    /// Serialize scene to base64-encoded protobuf (for SVG embedding).
    pub fn serialize_proto_base64(&self) -> String {
        proto::serialize_to_base64(&self.scene, self.next_id)
    }

    /// Deserialize scene from base64-encoded protobuf (from SVG metadata).
    /// Returns true on success.
    pub fn deserialize_proto_base64(&mut self, b64: &str) -> bool {
        self.load_document_base64(b64).starts_with("{\"ok\":true")
    }

    /// Base64 counterpart of `load_document`, for the payload embedded in an
    /// exported SVG. Same JSON status contract.
    pub fn load_document_base64(&mut self, b64: &str) -> String {
        match proto::deserialize_from_base64(b64) {
            Ok((scene, _next_id, report)) => {
                self.adopt_loaded_scene(scene);
                Self::load_ok_json(&report)
            }
            Err(e) => Self::load_error_json(&e),
        }
    }

    /// Get the current format version — the newest this build can write.
    pub fn get_format_version(&self) -> u32 {
        FORMAT_VERSION
    }

    // ─── Document metadata ──────────────────────────────────────────────────
    //
    // Set by the editor, never invented here: `serialize_snapshot` runs on
    // every undo step and must be a byte-exact fixed point, which a clock or a
    // uuid generator inside serialization would destroy.

    /// Replace the document's identity block. `created_at_ms`/`modified_at_ms`
    /// are Unix epoch milliseconds; 0 means unknown.
    pub fn set_document_meta(
        &mut self,
        uuid: String,
        created_at_ms: f64,
        modified_at_ms: f64,
        app_version: String,
        title: String,
    ) {
        self.scene.meta = DocumentMeta {
            uuid,
            // f64 at the boundary because JS numbers are doubles and
            // wasm-bindgen has no u64 that survives the crossing cleanly.
            created_at_ms: created_at_ms.max(0.0) as u64,
            modified_at_ms: modified_at_ms.max(0.0) as u64,
            app_version,
            title,
        };
    }

    pub fn get_document_uuid(&self) -> String {
        self.scene.meta.uuid.clone()
    }

    pub fn get_document_title(&self) -> String {
        self.scene.meta.title.clone()
    }

    pub fn get_document_created_at(&self) -> f64 {
        self.scene.meta.created_at_ms as f64
    }

    pub fn get_document_modified_at(&self) -> f64 {
        self.scene.meta.modified_at_ms as f64
    }

    pub fn get_document_app_version(&self) -> String {
        self.scene.meta.app_version.clone()
    }

    /// Stamp the modification time, called by the editor just before a save.
    pub fn touch_modified_at(&mut self, now_ms: f64) {
        self.scene.meta.modified_at_ms = now_ms.max(0.0) as u64;
    }

    // ─── Embedded fonts ─────────────────────────────────────────────────────

    /// Embed (or replace) a font face. Faces are keyed by family+weight+italic,
    /// so re-embedding the same face overwrites rather than duplicating it.
    pub fn embed_font(
        &mut self,
        family: String,
        weight: u32,
        italic: bool,
        bytes: Vec<u8>,
        source: String,
    ) {
        let weight = weight as u16;
        let face = FontFace { family, weight, italic, bytes, source };
        match self.scene.fonts.iter_mut().find(|f| {
            f.family == face.family && f.weight == face.weight && f.italic == face.italic
        }) {
            Some(existing) => *existing = face,
            None => self.scene.fonts.push(face),
        }
    }

    /// How many font faces this document embeds.
    pub fn embedded_font_count(&self) -> u32 {
        self.scene.fonts.len() as u32
    }

    /// The raw bytes of embedded face `index`.
    ///
    /// Returned directly rather than base64 inside a JSON blob, matching
    /// `get_image_bytes`. A face is 100–300 KB; base64 inflates it by a third,
    /// and routing it through a JSON string means building that string in wasm,
    /// copying it out, parsing it, and decoding it back to the bytes we already
    /// had — several times the size of the payload, on every document open.
    pub fn embedded_font_bytes(&self, index: u32) -> Vec<u8> {
        self.scene.fonts.get(index as usize).map(|f| f.bytes.clone()).unwrap_or_default()
    }

    /// Family name of embedded face `index`.
    pub fn embedded_font_family(&self, index: u32) -> String {
        self.scene.fonts.get(index as usize).map(|f| f.family.clone()).unwrap_or_default()
    }

    /// CSS weight of embedded face `index` (400 regular, 700 bold).
    pub fn embedded_font_weight(&self, index: u32) -> u32 {
        self.scene.fonts.get(index as usize).map(|f| f.weight as u32).unwrap_or(400)
    }

    /// Whether embedded face `index` is italic.
    pub fn embedded_font_italic(&self, index: u32) -> bool {
        self.scene.fonts.get(index as usize).map(|f| f.italic).unwrap_or(false)
    }

    /// Which (family, weight, italic) faces the document's text actually needs.
    /// Returned as JSON so the editor can fetch and embed exactly these — there
    /// is no point shipping a bold face for text that is never bold.
    pub fn get_required_fonts_json(&self) -> String {
        let mut needed: Vec<(String, u16, bool)> = self
            .scene
            .nodes
            .values()
            .filter_map(|n| match &n.geometry {
                Geometry::Text { font_family, font_weight, italic, .. }
                    if !font_family.is_empty() =>
                {
                    Some((font_family.clone(), *font_weight, *italic))
                }
                _ => None,
            })
            .collect();
        needed.sort();
        needed.dedup();

        let items: Vec<serde_json::Value> = needed
            .into_iter()
            .map(|(family, weight, italic)| {
                serde_json::json!({ "family": family, "weight": weight, "italic": italic })
            })
            .collect();
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".into())
    }

    /// Drop embedded faces no text node references any more, so a document
    /// doesn't accumulate megabytes of fonts from text that has been deleted.
    pub fn prune_unused_fonts(&mut self) -> u32 {
        let used: HashSet<(String, u16, bool)> = self
            .scene
            .nodes
            .values()
            .filter_map(|n| match &n.geometry {
                Geometry::Text { font_family, font_weight, italic, .. } => {
                    Some((font_family.clone(), *font_weight, *italic))
                }
                _ => None,
            })
            .collect();
        let before = self.scene.fonts.len();
        self.scene
            .fonts
            .retain(|f| used.contains(&(f.family.clone(), f.weight, f.italic)));
        (before - self.scene.fonts.len()) as u32
    }
}

#[cfg(test)]
impl Engine {
    /// Read-only view of the scene, for format tests that need to serialize it
    /// through a different entry point than the engine's own.
    pub fn scene_for_test(&self) -> Scene {
        self.scene.clone()
    }
}

impl Engine {
    /// Install a scene that has already been validated, and rebuild every
    /// derived index from it.
    fn adopt_loaded_scene(&mut self, scene: Scene) {
        self.scene = scene;
        // Opening a document: resume this site's counter from what THIS
        // document contains, rather than inheriting a counter from
        // whatever was open before.
        self.recompute_next_id();
        self.update_all_global_transforms();
        self.update_all_spatial_indices();
        self.rebuild_live_paint_cache();
        self.rebuild_boolean_groups_cache();
    }

    fn load_ok_json(report: &RepairReport) -> String {
        // Hand-built rather than serde_json::to_string so the `{"ok":true`
        // prefix the boolean wrappers test for is guaranteed to lead.
        format!(
            r#"{{"ok":true,"repaired":{},"summary":{},"repairs":{}}}"#,
            !report.is_clean(),
            serde_json::to_string(&report.summary()).unwrap_or_else(|_| "\"\"".into()),
            serde_json::to_string(report).unwrap_or_else(|_| "{}".into()),
        )
    }

    fn load_error_json(e: &LoadError) -> String {
        let required = e.required_version().unwrap_or(0);
        format!(
            r#"{{"ok":false,"error":{},"detail":{},"requiredVersion":{},"supportedVersion":{}}}"#,
            serde_json::to_string(e.code()).unwrap_or_else(|_| "\"error\"".into()),
            serde_json::to_string(&e.detail()).unwrap_or_else(|_| "\"\"".into()),
            required,
            FORMAT_VERSION,
        )
    }
}

#[wasm_bindgen]
impl Engine {
    pub fn get_document_width(&self) -> f32 {
        // Legacy shim: the primary artboard is the source of truth.
        self.scene.artboards.first().map(|a| a.w).unwrap_or(self.scene.document_width)
    }

    pub fn get_document_height(&self) -> f32 {
        self.scene.artboards.first().map(|a| a.h).unwrap_or(self.scene.document_height)
    }

    pub fn set_document_size(&mut self, w: f32, h: f32) {
        self.scene.document_width = w;
        self.scene.document_height = h;
        // Keep the primary artboard in sync (used by the SVG conformance harness).
        if let Some(a) = self.scene.artboards.first_mut() {
            a.w = w;
            a.h = h;
        }
    }

    // ─── Artboards ──────────────────────────────────────────────────────────

    /// Add a new artboard; returns its id. Auto-named "Artwork N".
    pub fn add_artboard(&mut self, x: f32, y: f32, w: f32, h: f32) -> u32 {
        // Artboards likewise have their own id space — partition it by site so
        // two people adding an artboard at once don't create the same one.
        let next = self
            .scene
            .artboards
            .iter()
            .filter(|a| site_of(a.id) == self.site_id)
            .map(|a| counter_of(a.id))
            .max()
            .unwrap_or(0)
            + 1;
        let id = make_id(self.site_id, next);
        let n = self.scene.artboards.len() + 1;
        self.scene.artboards.push(Artboard {
            id,
            name: format!("Artwork {}", n),
            x,
            y,
            w: w.max(1.0),
            h: h.max(1.0),
            background: default_artboard_bg(),
        });
        id
    }

    /// Remove an artboard. Returns true if one was removed.
    pub fn remove_artboard(&mut self, id: u32) -> bool {
        let before = self.scene.artboards.len();
        self.scene.artboards.retain(|a| a.id != id);
        self.scene.artboards.len() != before
    }

    /// Resize/move an artboard. Rejects non-positive dimensions. Returns true on success.
    pub fn set_artboard_bounds(&mut self, id: u32, x: f32, y: f32, w: f32, h: f32) -> bool {
        if w <= 0.0 || h <= 0.0 {
            return false;
        }
        let is_primary = self.scene.artboards.first().map(|a| a.id == id).unwrap_or(false);
        if let Some(a) = self.scene.artboards.iter_mut().find(|a| a.id == id) {
            a.x = x;
            a.y = y;
            a.w = w;
            a.h = h;
            if is_primary {
                self.scene.document_width = w;
                self.scene.document_height = h;
            }
            true
        } else {
            false
        }
    }

    pub fn set_artboard_name(&mut self, id: u32, name: String) -> bool {
        if let Some(a) = self.scene.artboards.iter_mut().find(|a| a.id == id) {
            a.name = name;
            true
        } else {
            false
        }
    }

    pub fn set_artboard_background(&mut self, id: u32, r: f32, g: f32, b: f32, a_: f32) -> bool {
        if let Some(a) = self.scene.artboards.iter_mut().find(|a| a.id == id) {
            a.background = Color { r, g, b, a: a_ };
            true
        } else {
            false
        }
    }

    /// All artboards as JSON: `[{id,name,x,y,w,h,background:{r,g,b,a}}, …]`.
    pub fn get_artboards_json(&self) -> String {
        let items: Vec<String> = self.scene.artboards.iter().map(|a| {
            format!(
                "{{\"id\":{},\"name\":{},\"x\":{},\"y\":{},\"w\":{},\"h\":{},\"background\":{{\"r\":{},\"g\":{},\"b\":{},\"a\":{}}}}}",
                a.id,
                json_string(&a.name),
                a.x, a.y, a.w, a.h,
                a.background.r, a.background.g, a.background.b, a.background.a,
            )
        }).collect();
        format!("[{}]", items.join(","))
    }

    // ─── Ruler guides ───────────────────────────────────────────────────────
    // Guides are stored as bare positions per axis: `guides_x` are vertical
    // guides (fixed world x), `guides_y` horizontal (fixed world y). History is
    // handled JS-side (serialize snapshots include guides), so these mutators
    // don't push undo entries themselves.

    /// Guides as JSON: `{"x":[..world x..],"y":[..world y..]}`.
    pub fn get_guides_json(&self) -> String {
        let fmt = |v: &Vec<f32>| v.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
        format!("{{\"x\":[{}],\"y\":[{}]}}", fmt(&self.scene.guides_x), fmt(&self.scene.guides_y))
    }

    /// Add a guide on the given axis ("x" = vertical, "y" = horizontal).
    /// Returns the index of the new guide, or u32::MAX for a bad axis/value.
    pub fn add_guide(&mut self, axis: &str, pos: f32) -> u32 {
        if !pos.is_finite() {
            return u32::MAX;
        }
        let list = match axis {
            "x" => &mut self.scene.guides_x,
            "y" => &mut self.scene.guides_y,
            _ => return u32::MAX,
        };
        list.push(pos);
        (list.len() - 1) as u32
    }

    /// Move an existing guide (live drag; no history).
    pub fn set_guide(&mut self, axis: &str, index: u32, pos: f32) -> bool {
        if !pos.is_finite() {
            return false;
        }
        let list = match axis {
            "x" => &mut self.scene.guides_x,
            "y" => &mut self.scene.guides_y,
            _ => return false,
        };
        if let Some(g) = list.get_mut(index as usize) {
            *g = pos;
            true
        } else {
            false
        }
    }

    /// Remove the guide at `index` on the given axis.
    pub fn remove_guide(&mut self, axis: &str, index: u32) -> bool {
        let list = match axis {
            "x" => &mut self.scene.guides_x,
            "y" => &mut self.scene.guides_y,
            _ => return false,
        };
        if (index as usize) < list.len() {
            list.remove(index as usize);
            true
        } else {
            false
        }
    }

    /// Remove every guide on both axes.
    pub fn clear_guides(&mut self) {
        self.scene.guides_x.clear();
        self.scene.guides_y.clear();
    }

    // ─── Color swatches ───────────────────────────────────────────────────────
    // Stored as an opaque JSON string owned by the editor. History rides the
    // scene snapshot, so this setter is history-free (the caller decides).

    // These four are stored as typed values on the `Scene` and converted to and
    // from JSON *here*, at the boundary, because the editor's existing API
    // speaks JSON for them.
    //
    // The conversion deliberately does not live any deeper. They used to be
    // JSON strings in the model itself, which meant `from_scene` parsed and
    // re-rendered all four on every save — including every undo snapshot, i.e.
    // every mutation. That cost ~17% of snapshot time on a document with a
    // populated swatch list and scaled with blob size rather than node count.
    // Now it is paid only when the editor actually reads or writes them, which
    // is at user-action frequency.

    pub fn get_swatches_json(&self) -> String {
        let items: Vec<serde_json::Value> = self.scene.swatches.iter().map(|s| {
            let mut o = serde_json::Map::new();
            o.insert("r".into(), s.color.r.into());
            o.insert("g".into(), s.color.g.into());
            o.insert("b".into(), s.color.b.into());
            o.insert("a".into(), s.color.a.into());
            if !s.name.is_empty() { o.insert("name".into(), s.name.clone().into()); }
            serde_json::Value::Object(o)
        }).collect();
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".into())
    }

    pub fn set_swatches_json(&mut self, json: String) {
        let Ok(serde_json::Value::Array(items)) = serde_json::from_str(&json) else {
            self.scene.swatches.clear();
            return;
        };
        self.scene.swatches = items.iter().map(|v| {
            let f = |k: &str, d: f32| v.get(k).and_then(|x| x.as_f64()).unwrap_or(d as f64) as f32;
            Swatch {
                color: Color { r: f("r", 0.0), g: f("g", 0.0), b: f("b", 0.0), a: f("a", 1.0) },
                name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            }
        }).collect();
    }

    pub fn get_text_paths_json(&self) -> String {
        let mut o = serde_json::Map::new();
        for (t, p) in &self.scene.text_paths {
            o.insert(t.to_string(), (*p).into());
        }
        serde_json::to_string(&serde_json::Value::Object(o)).unwrap_or_else(|_| "{}".into())
    }

    pub fn set_text_paths_json(&mut self, json: String) {
        self.scene.text_paths.clear();
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&json) else { return };
        for (k, v) in map {
            if let (Ok(t), Some(p)) = (k.parse::<u32>(), v.as_u64()) {
                self.scene.text_paths.insert(t, p as u32);
            }
        }
    }

    pub fn get_markers_json(&self) -> String {
        let name = |c: u8| MARKER_KINDS.get(c as usize).copied().unwrap_or("none");
        let mut o = serde_json::Map::new();
        for (id, m) in &self.scene.markers {
            let mut e = serde_json::Map::new();
            if m.start != 0 { e.insert("start".into(), name(m.start).into()); }
            if m.end != 0 { e.insert("end".into(), name(m.end).into()); }
            if !e.is_empty() { o.insert(id.to_string(), serde_json::Value::Object(e)); }
        }
        serde_json::to_string(&serde_json::Value::Object(o)).unwrap_or_else(|_| "{}".into())
    }

    pub fn set_markers_json(&mut self, json: String) {
        let code = |s: &str| MARKER_KINDS.iter().position(|&k| k == s).unwrap_or(0) as u8;
        self.scene.markers.clear();
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&json) else { return };
        for (k, v) in map {
            let Ok(id) = k.parse::<u32>() else { continue };
            let get = |end: &str| v.get(end).and_then(|x| x.as_str()).map(&code).unwrap_or(0);
            self.scene.markers.insert(id, NodeMarkers { start: get("start"), end: get("end") });
        }
    }

    pub fn get_guide_locks_json(&self) -> String {
        serde_json::json!({ "x": self.scene.guide_locks.x, "y": self.scene.guide_locks.y }).to_string()
    }

    pub fn set_guide_locks_json(&mut self, json: String) {
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
        let axis = |k: &str| -> Vec<f32> {
            parsed.get(k).and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())
                .unwrap_or_default()
        };
        self.scene.guide_locks = GuideLocks { x: axis("x"), y: axis("y") };
    }
}

/// Control-point bounding box of a geometry in node-local space (anchors and
/// bezier handles for paths). Used to derive the bbox→bbox affine that keeps
/// mesh fills glued to a geometry edit; both sides of the mapping use the
/// same measure, so any linear geometry scaling maps meshes exactly.

/// The box a text node occupies in its own local space, as
/// `[min_x, min_y, max_x, max_y]`.
///
/// The origin is the BASELINE of the first line, so the first line spans
/// `-font_size..0` and every further line sits one `line_height` below;
/// Local-space AABB of a text run. Origin is the first-line baseline; width is
/// an em estimate (the engine has no font metrics — JS measures for the
/// selection frame). Alignment no longer shifts the box: Paragraph lays out in
/// a hug / fixed width and draws from x=0 (center/right align inside that box).
///
/// Width uses a per-character advance so CJK (~1em) is not clipped to the Latin
/// 0.6em estimate — that left the right half of Chinese runs unselectable.
fn text_char_advance_em(c: char) -> f32 {
    // Fullwidth / CJK / Hangul / kana / emoji presentation ≈ 1em.
    if c <= '\u{007f}' {
        // ASCII: average Latin advance.
        0.6
    } else if ('\u{1100}'..='\u{11ff}').contains(&c) // Hangul Jamo
        || ('\u{2e80}'..='\u{9fff}').contains(&c) // CJK radicals … CJK Unified
        || ('\u{ac00}'..='\u{d7af}').contains(&c) // Hangul syllables
        || ('\u{f900}'..='\u{faff}').contains(&c) // CJK Compatibility Ideographs
        || ('\u{fe10}'..='\u{fe1f}').contains(&c) // Vertical forms
        || ('\u{ff01}'..='\u{ff60}').contains(&c) // Fullwidth forms
        || ('\u{ffe0}'..='\u{ffe6}').contains(&c)
    {
        1.0
    } else {
        // Other scripts (Cyrillic, Arabic, …): between Latin and CJK.
        0.85
    }
}

fn text_local_bbox(content: &str, font_size: f32, line_height: f32, _text_align: u8) -> [f32; 4] {
    let mut lines = 0usize;
    let mut longest_em = 0.0f32;
    for line in content.split('\n') {
        lines += 1;
        let mut em = 0.0f32;
        for c in line.chars() {
            em += text_char_advance_em(c);
        }
        if em > longest_em {
            longest_em = em;
        }
    }
    let w = longest_em * font_size;
    let below = (lines.saturating_sub(1)) as f32 * font_size * line_height;
    // Hug / fixed Paragraph box starts at x=0 (see renderer drawParagraph).
    [0.0, -font_size, w, below]
}

fn geometry_control_bbox(geo: &Geometry) -> Option<[f32; 4]> {
    match geo {
        Geometry::Rect { width, height } | Geometry::Image { width, height, .. } => {
            Some([0.0, 0.0, *width, *height])
        }
        Geometry::Ellipse { radius_x, radius_y } => {
            Some([-radius_x, -radius_y, *radius_x, *radius_y])
        }
        Geometry::Path { subpaths, .. } => {
            let mut bb = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
            let mut any = false;
            for sp in subpaths {
                for p in &sp.points {
                    for [x, y] in [[p.x, p.y], [p.cp1.x, p.cp1.y], [p.cp2.x, p.cp2.y]] {
                        any = true;
                        bb[0] = bb[0].min(x);
                        bb[1] = bb[1].min(y);
                        bb[2] = bb[2].max(x);
                        bb[3] = bb[3].max(y);
                    }
                }
            }
            if any { Some(bb) } else { None }
        }
        _ => None,
    }
}

/// Stretch a node's mesh fills through the affine that maps the old geometry
/// bbox onto the current one. No-op when either bbox is missing/degenerate
/// or nothing actually moved.
fn adapt_mesh_fills_to_bbox(node: &mut Node, old_bb: Option<[f32; 4]>) {
    let Some(old) = old_bb else { return };
    let Some(new) = geometry_control_bbox(&node.geometry) else { return };
    let ow = old[2] - old[0];
    let oh = old[3] - old[1];
    if ow < 1e-6 || oh < 1e-6 || old == new {
        return;
    }
    let sx = (new[2] - new[0]) / ow;
    let sy = (new[3] - new[1]) / oh;
    for fill in &mut node.style.fills {
        if let Paint::Mesh(m) = fill {
            m.map_bbox_affine(old[0], old[1], sx, sy, new[0], new[1]);
        }
    }
}

/// A representative solid color for a paint: solids as-is, gradients → first
/// stop, meshes → mean vertex color (documented approximations for Live
/// Paint), patterns → none.
/// Compose two SVG affines `[a,b,c,d,e,f]` (x' = a·x + c·y + e), outer ∘ inner.
fn compose_affine(outer: &[f32; 6], inner: &[f32; 6]) -> [f32; 6] {
    let (a1, b1, c1, d1, e1, f1) = (outer[0], outer[1], outer[2], outer[3], outer[4], outer[5]);
    let (a2, b2, c2, d2, e2, f2) = (inner[0], inner[1], inner[2], inner[3], inner[4], inner[5]);
    [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    ]
}

/// Does this paint put anything on the canvas? A fully transparent solid (or a
/// gradient whose every stop is) draws nothing, and something that draws
/// nothing must not be clickable either.
fn paint_is_visible(p: &Paint) -> bool {
    match p {
        Paint::Solid(c) => c.a > 0.001,
        Paint::Gradient(g) => g.stops.iter().any(|s| s.color.a > 0.001),
        Paint::Pattern(_) | Paint::Mesh(_) => true,
    }
}

fn paint_color(p: &Paint) -> Option<Color> {
    match p {
        Paint::Solid(c) => Some(*c),
        Paint::Gradient(g) => g.stops.first().map(|s| s.color),
        Paint::Pattern(_) => None,
        Paint::Mesh(m) => Some(m.mean_color()),
    }
}

/// Serialize a bézier outline (anchor + handles) to the JSON shape the renderer,
/// SVG export, and Expand consume: `[{x,y,cp1:[x,y],cp2:[x,y]}]`.
fn pathpoints_to_json(pts: &[PathPoint]) -> Vec<serde_json::Value> {
    pts.iter().map(|p| serde_json::json!({
        "x": p.x,
        "y": p.y,
        "cp1": [p.cp1.x, p.cp1.y],
        "cp2": [p.cp2.x, p.cp2.y],
    })).collect()
}

/// Minimal JSON string escaper for artboard names.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod transform_invariants;

#[cfg(test)]
mod identity_tests {
    use super::*;

    #[test]
    fn id_encoding_round_trips() {
        for &(site, counter) in &[(0u32, 1u32), (1, 1), (7, 42), (MAX_SITE, MAX_COUNTER)] {
            let id = make_id(site, counter);
            assert_eq!(site_of(id), site, "site of ({site},{counter})");
            assert_eq!(counter_of(id), counter, "counter of ({site},{counter})");
        }
    }

    /// Site 0 must produce exactly the ids the old plain counter produced, so
    /// documents written before sites existed are unchanged.
    #[test]
    fn site_zero_is_backward_compatible() {
        for n in [1u32, 2, 3, 999, MAX_COUNTER] {
            assert_eq!(make_id(0, n), n);
        }
        let mut e = Engine::new();
        assert_eq!(e.site_id(), 0);
        let a = e.add_rect(0.0, 0.0, 10.0, 10.0);
        let b = e.add_rect(0.0, 0.0, 10.0, 10.0);
        assert_eq!((a, b), (1, 2), "legacy id sequence must be preserved");
    }

    /// The property the whole scheme exists for: two peers editing at once
    /// never produce the same id.
    #[test]
    fn concurrent_sites_never_collide() {
        let mut alice = Engine::new();
        let mut bob = Engine::new();
        alice.set_site_id(1);
        bob.set_site_id(2);

        let mut ids = std::collections::HashSet::new();
        for _ in 0..500 {
            assert!(ids.insert(alice.add_rect(0.0, 0.0, 1.0, 1.0)), "alice reissued an id");
            assert!(ids.insert(bob.add_rect(0.0, 0.0, 1.0, 1.0)), "bob reissued an id");
        }
        assert_eq!(ids.len(), 1000);
    }

    /// A site id may be reused by a later session: on load the counter resumes
    /// past that site's own highest existing object, so the second session
    /// cannot reissue ids the first one created.
    #[test]
    fn reused_site_resumes_past_its_own_objects() {
        let mut first = Engine::new();
        first.set_site_id(3);
        let created: Vec<u32> = (0..5).map(|_| first.add_rect(0.0, 0.0, 1.0, 1.0)).collect();
        let doc = first.serialize_proto();

        let mut second = Engine::new();
        second.set_site_id(3); // same site, later session
        assert!(second.deserialize_proto(&doc));
        let next = second.add_rect(0.0, 0.0, 1.0, 1.0);

        assert!(!created.contains(&next), "reused an id from the earlier session");
        assert_eq!(site_of(next), 3);
        assert_eq!(counter_of(next), counter_of(*created.last().unwrap()) + 1);
    }

    /// Loading a document must not adopt ids belonging to other sites as our
    /// own — our counter is ours alone.
    #[test]
    fn foreign_site_objects_do_not_advance_our_counter() {
        let mut bob = Engine::new();
        bob.set_site_id(9);
        for _ in 0..20 {
            bob.add_rect(0.0, 0.0, 1.0, 1.0);
        }
        let doc = bob.serialize_proto();

        let mut alice = Engine::new();
        alice.set_site_id(4);
        assert!(alice.deserialize_proto(&doc));
        let mine = alice.add_rect(0.0, 0.0, 1.0, 1.0);

        assert_eq!(site_of(mine), 4);
        assert_eq!(counter_of(mine), 1, "should start fresh in our own range");
    }

    /// Undo restores an older scene. The id of a node that undo removed must
    /// NOT be handed out again — a peer may already know that id, and reusing
    /// it would merge two different objects into one identity.
    #[test]
    fn undo_does_not_recycle_ids() {
        let mut e = Engine::new();
        e.set_site_id(5);
        let before = e.serialize_scene();
        let doomed = e.add_rect(0.0, 0.0, 1.0, 1.0);

        assert!(e.deserialize_scene(&before), "snapshot should restore");
        let after_undo = e.add_rect(0.0, 0.0, 1.0, 1.0);

        assert_ne!(after_undo, doomed, "undo recycled a node id");
    }

    /// The two undo properties have to hold at the same time, and they pull in
    /// opposite directions: a snapshot round-trip must be byte-identical (the
    /// serialized counter rewinds), yet a retired id must never be reissued
    /// (allocation does not rewind). That is what `id_high_water` buys.
    #[test]
    fn undo_round_trip_is_byte_identical_and_still_does_not_recycle() {
        let mut e = Engine::new();
        e.set_site_id(2);
        e.add_rect(0.0, 0.0, 1.0, 1.0);
        let before = e.serialize_scene();

        let doomed = e.add_rect(0.0, 0.0, 1.0, 1.0);
        assert!(e.deserialize_scene(&before));

        assert_eq!(e.serialize_scene(), before, "undo must restore the exact bytes");
        assert_ne!(e.add_rect(0.0, 0.0, 1.0, 1.0), doomed, "must not reissue a retired id");
    }

    /// A high site id makes ids very large (site 1000 starts above 4.1 billion).
    /// Nothing may assume ids are small or densely packed — they key hash maps
    /// and are varint-encoded, but this pins it against a future regression.
    #[test]
    fn large_ids_survive_a_document_round_trip() {
        let mut e = Engine::new();
        e.set_site_id(MAX_SITE);
        let ids: Vec<u32> = (0..10).map(|_| e.add_rect(1.0, 2.0, 3.0, 4.0)).collect();
        assert!(ids.iter().all(|id| *id > 4_000_000_000), "expected very large ids: {ids:?}");

        let bytes = e.serialize_proto();
        let mut reloaded = Engine::new();
        reloaded.set_site_id(MAX_SITE);
        assert!(reloaded.deserialize_proto(&bytes));

        let roots = reloaded.get_root_nodes();
        assert_eq!(roots.len(), ids.len(), "all nodes should survive the round trip");
        for id in &ids {
            assert!(roots.contains(id), "id {id} lost in round trip");
        }
    }

    #[test]
    fn set_site_id_is_clamped() {
        let mut e = Engine::new();
        e.set_site_id(u32::MAX);
        assert_eq!(e.site_id(), MAX_SITE);
        // Still allocates inside its own range rather than overflowing into
        // another site's.
        let id = e.add_rect(0.0, 0.0, 1.0, 1.0);
        assert_eq!(site_of(id), MAX_SITE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A red→blue linear gradient over (0,0)-(100,100) in the node's LOCAL space.
    fn local_gradient() -> Paint {
        Paint::Gradient(Gradient {
            gradient_type: GradientType::Linear,
            stops: vec![
                GradientStop { offset: 0.0, color: Color { r: 1.0, g: 0.0, b: 0.0, a: 1.0 } },
                GradientStop { offset: 1.0, color: Color { r: 0.0, g: 0.0, b: 1.0, a: 1.0 } },
            ],
            start_x: 0.0,
            start_y: 0.0,
            end_x: 100.0,
            end_y: 100.0,
            spread: 0,
            focal: None,
            transform: None,
        })
    }

    // ─── Gradients in Live Paint ────────────────────────────────────────────

    /// A face can hold a gradient, not just a colour.
    #[test]
    fn a_face_can_be_painted_with_a_gradient() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{a}]"));
        engine.set_node_live_paint(group, true);
        engine.ensure_network_clean();

        let face = engine.query_face_at(50.0, 50.0);
        assert!(face >= 0, "the rect should make one region");

        let ok = engine.set_face_paint(
            face as u32,
            r#"{"gradient_type":"Linear","stops":[
                 {"offset":0.0,"color":{"r":1.0,"g":0.0,"b":0.0,"a":1.0}},
                 {"offset":1.0,"color":{"r":0.0,"g":0.0,"b":1.0,"a":1.0}}],
               "start_x":0.0,"start_y":0.0,"end_x":100.0,"end_y":100.0}"#,
        );
        assert!(ok);

        match engine.scene.vector_network.faces.get(&(face as u32)).unwrap().fill.as_ref() {
            Some(Paint::Gradient(g)) => assert_eq!(g.stops.len(), 2),
            other => panic!("expected a gradient, got {other:?}"),
        }
    }

    /// Malformed paint leaves the face alone rather than clearing it.
    #[test]
    fn a_paint_that_does_not_parse_changes_nothing() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{a}]"));
        engine.set_node_live_paint(group, true);
        engine.ensure_network_clean();
        let face = engine.query_face_at(50.0, 50.0) as u32;
        engine.set_face_fill(face, 1.0, 0.0, 0.0, 1.0);

        assert!(!engine.set_face_paint(face, "{ not json"));

        match engine.scene.vector_network.faces.get(&face).unwrap().fill.as_ref() {
            Some(Paint::Solid(c)) => assert_eq!(c.r, 1.0),
            other => panic!("the previous fill should survive, got {other:?}"),
        }
    }

    /// The bug this whole change started from: an UNPAINTED region shows the
    /// paint of the shape beneath, and for a gradient-filled shape that has to
    /// stay a gradient. It used to collapse to the gradient's first stop.
    #[test]
    fn an_unpainted_region_inherits_a_gradient_whole() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.scene.nodes.get_mut(&a).unwrap().style.fills = vec![local_gradient()];
        let group = engine.group_nodes(&format!("[{a}]"));
        engine.set_node_live_paint(group, true);
        engine.ensure_network_clean();

        let faces = engine.live_paint_faces_effective(Some(group));
        assert_eq!(faces.len(), 1);
        match &faces[0].0 {
            Paint::Gradient(g) => {
                assert_eq!(g.stops.len(), 2, "both stops, not just the first");
                assert_eq!(g.stops[1].color.b, 1.0);
            }
            other => panic!("expected the gradient to survive, got {other:?}"),
        }
    }

    /// An inherited gradient is re-expressed in world space — a face outline has
    /// no transform of its own to carry the node's placement.
    #[test]
    fn an_inherited_gradient_is_moved_into_world_space() {
        let mut engine = Engine::new();
        let a = engine.add_rect(300.0, 200.0, 100.0, 100.0);
        engine.scene.nodes.get_mut(&a).unwrap().style.fills = vec![local_gradient()];
        let group = engine.group_nodes(&format!("[{a}]"));
        engine.set_node_live_paint(group, true);
        engine.ensure_network_clean();

        let faces = engine.live_paint_faces_effective(Some(group));
        match &faces[0].0 {
            Paint::Gradient(g) => {
                let t = g.transform.expect("the node transform must ride along");
                assert_eq!((t[4], t[5]), (300.0, 200.0), "translation folded in");
            }
            other => panic!("expected a gradient, got {other:?}"),
        }
    }

    /// A gradient face survives a save/load round trip.
    #[test]
    fn a_gradient_face_survives_serialization() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{a}]"));
        engine.set_node_live_paint(group, true);
        engine.ensure_network_clean();
        let face = engine.query_face_at(50.0, 50.0) as u32;
        engine.set_face_paint(
            face,
            r#"{"gradient_type":"Radial","stops":[
                 {"offset":0.0,"color":{"r":0.0,"g":1.0,"b":0.0,"a":1.0}},
                 {"offset":1.0,"color":{"r":0.0,"g":0.0,"b":0.0,"a":0.0}}],
               "start_x":50.0,"start_y":50.0,"end_x":100.0,"end_y":50.0}"#,
        );

        let bytes = engine.serialize_scene();
        let mut reloaded = Engine::new();
        assert!(reloaded.deserialize_scene(&bytes));
        reloaded.ensure_network_clean();

        let faces = reloaded.live_paint_faces_effective(None);
        assert_eq!(faces.len(), 1);
        match &faces[0].0 {
            Paint::Gradient(g) => assert_eq!(g.stops.len(), 2),
            other => panic!("expected the gradient back, got {other:?}"),
        }
    }

    // ─── A masked Live Paint group ──────────────────────────────────────────
    // Three separate mechanisms used to pull this apart, so there are three
    // tests. The stream helper reads back what the renderer would actually be
    // handed, which is the only place two of the bugs were visible at all.

    /// Command names in emission order, e.g. ["START_GROUP", "LP_FACES", …].
    fn render_stream(engine: &mut Engine) -> Vec<&'static str> {
        let ids: Vec<u32> = engine.scene.nodes.keys().copied().collect();
        engine.update_render_buffer(ids, vec![]);
        let buf = engine.render_buffer.clone();
        let u32_at = |o: usize| {
            u32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
        };
        let mut out = Vec::new();
        let mut off = 12; // magic + version + count
        while off + 8 <= buf.len() {
            let len = u32_at(off) as usize;
            out.push(match u32_at(off + 4) {
                1 => "START_GROUP",
                2 => "DRAW_NODE",
                3 => "END_GROUP",
                4 => "BEGIN_MASK",
                5 => "BEGIN_MASKED_CONTENT",
                6 => "END_MASK",
                7 => "LP_FACES",
                8 => "LP_EDGES",
                _ => "?",
            });
            if len == 0 {
                break;
            }
            off += 4 + len;
        }
        out
    }

    /// Build [mask, contents] inside one Live Paint group, and paint a region.
    fn masked_live_paint_group() -> (Engine, u32, u32) {
        let mut engine = Engine::new();
        let mask = engine.add_ellipse(220.0, 200.0, 150.0, 150.0);
        let a = engine.add_rect(100.0, 100.0, 200.0, 200.0);
        let b = engine.add_ellipse(280.0, 260.0, 120.0, 120.0);
        let group = engine.group_nodes(&format!("[{mask},{a},{b}]"));
        engine.set_node_is_mask(mask, true);
        engine.set_node_live_paint(group, true);
        (engine, group, mask)
    }

    /// The bug that made this worthless: faces were emitted before BEGIN_MASK,
    /// so everything you painted fell outside the mask.
    #[test]
    fn live_paint_faces_render_inside_the_mask_span() {
        let (mut engine, _group, _mask) = masked_live_paint_group();
        let stream = render_stream(&mut engine);

        let faces = stream.iter().position(|c| *c == "LP_FACES").expect("faces emitted");
        let begin = stream.iter().position(|c| *c == "BEGIN_MASKED_CONTENT").expect("mask opened");
        let end = stream.iter().position(|c| *c == "END_MASK").expect("mask closed");
        assert!(
            begin < faces && faces < end,
            "faces must be inside the mask span, got {stream:?}"
        );
    }

    /// A mask is coverage, not a paintable contour.
    #[test]
    fn the_mask_is_not_part_of_the_paint_network() {
        let (mut engine, _group, mask) = masked_live_paint_group();
        engine.ensure_network_clean();

        let carves = engine
            .scene
            .vector_network
            .faces
            .values()
            .any(|f| f.signature.contains(&mask));
        assert!(!carves, "the mask must not bound any paintable face");
    }

    /// An alpha mask's coverage IS its painted alpha, so Live Paint's
    /// fill-suppression must skip it — stripping it made the group vanish.
    #[test]
    fn the_mask_keeps_the_fill_that_gives_it_coverage() {
        let (engine, _group, mask) = masked_live_paint_group();
        let member = *engine.scene.nodes.get(&mask).unwrap().parent.as_ref().unwrap();
        let content = engine.scene.nodes.get(&member).unwrap().children[1];

        assert!(engine.acts_as_mask(mask));
        assert!(engine.is_within_mask(mask), "the mask keeps its fill");
        assert!(!engine.is_within_mask(content), "ordinary members still lose theirs");
    }

    /// A flag with nothing after it to mask is ordinary artwork, everywhere.
    #[test]
    fn a_mask_with_nothing_to_mask_is_just_a_shape() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let last = engine.add_rect(20.0, 0.0, 10.0, 10.0);
        let group = engine.group_nodes(&format!("[{a},{last}]"));
        engine.set_node_is_mask(last, true); // nothing follows it

        assert!(!engine.acts_as_mask(last));
        assert!(!engine.is_within_mask(last));
        let stream = render_stream(&mut engine);
        assert!(!stream.contains(&"BEGIN_MASK"), "no span should open, got {stream:?}");
        let _ = group;
    }

    /// The unmasked case must be untouched: faces still at the bottom of the
    /// group, edges still on top, no stray mask commands.
    #[test]
    fn an_unmasked_live_paint_group_is_unchanged() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_ellipse(80.0, 80.0, 60.0, 60.0);
        let group = engine.group_nodes(&format!("[{a},{b}]"));
        engine.set_node_live_paint(group, true);

        let stream = render_stream(&mut engine);
        assert_eq!(
            stream,
            vec!["START_GROUP", "LP_FACES", "DRAW_NODE", "DRAW_NODE", "END_GROUP"],
            "got {stream:?}"
        );
    }

    /// A cut leaves the document, but not existence — paste has to have
    /// something to copy from.
    #[test]
    fn cut_removes_from_the_document_and_paste_brings_it_back() {
        let mut engine = Engine::new();
        let id = engine.add_rect(40.0, 60.0, 100.0, 50.0);

        assert_eq!(engine.cut_nodes(&format!("[{id}]")), 1);
        assert!(engine.scene.nodes.get(&id).is_none(), "cut must leave the document");
        assert!(engine.scene.root_nodes.is_empty());
        assert!(engine.has_clipboard());

        let pasted = engine.paste_clipboard(0.0, 0.0);
        assert_eq!(pasted.len(), 1);
        assert_eq!(engine.scene.root_nodes, pasted);
        let node = engine.scene.nodes.get(&pasted[0]).unwrap();
        assert_eq!(node.transform.x, 40.0, "paste in place keeps the position");
        assert_eq!(node.transform.y, 60.0);
        assert_ne!(pasted[0], id, "the pasted node gets a fresh id");
    }

    /// An operand dragged out of a boolean group leaves it needing a recompute.
    ///
    /// Only the chain a node LANDS in was flagged, so the group it left kept
    /// drawing the outline that included the departed shape — which was now
    /// also drawing on its own, in two places at once.
    #[test]
    fn moving_an_operand_out_flags_the_boolean_group() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 60.0, 60.0);
        let b = engine.add_rect(30.0, 30.0, 60.0, 60.0);
        let g = engine.group_nodes(&format!("[{a},{b}]"));
        engine.set_boolean_op(g, 0); // union
        engine.take_dirty_boolean_groups(); // the JS recompute has run

        engine.reorder_nodes(&format!("[{b}]"), None, 0);
        assert_eq!(engine.take_dirty_boolean_groups(), format!("[{g}]"));
    }

    /// A mask hides artwork; the hit test has to agree.
    ///
    /// An image masked down to a small circle used to keep its whole rectangle
    /// clickable: clicks on empty canvas selected and dragged it, and anything
    /// behind it could not be reached at all.
    #[test]
    fn masked_away_artwork_is_not_clickable() {
        let mut engine = Engine::new();
        let behind = engine.add_rect(60.0, 60.0, 40.0, 40.0);
        let mask = engine.add_rect(0.0, 0.0, 20.0, 20.0); // bottom of the group
        let art = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.group_nodes(&format!("[{mask},{art}]"));
        engine.set_node_is_mask(mask, true);

        assert_eq!(engine.hit_test(10.0, 10.0), Some(art), "where it is painted");
        assert_eq!(engine.hit_test(30.0, 10.0), None, "and nowhere the mask isn't");
        assert_eq!(engine.hit_test(80.0, 80.0), Some(behind), "what is behind is reachable");

        // A mask that isn't drawn masks nothing — the same rule the renderer
        // uses to decide whether to open the span at all.
        engine.set_node_visible(mask, false);
        assert_eq!(engine.hit_test(30.0, 10.0), Some(art));
    }

    /// A masked group clips everything inside it, however deep.
    #[test]
    fn a_masked_group_clips_its_whole_subtree() {
        let mut engine = Engine::new();
        let mask = engine.add_rect(0.0, 0.0, 20.0, 20.0);
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 0.0, 40.0, 40.0);
        let inner = engine.group_nodes(&format!("[{a},{b}]"));
        engine.group_nodes(&format!("[{mask},{inner}]"));
        engine.set_node_is_mask(mask, true);

        assert_eq!(engine.hit_test(10.0, 10.0), Some(a));
        assert_eq!(engine.hit_test(60.0, 10.0), None, "b is masked away with the rest");
    }

    /// Every line of a paragraph is clickable, and only where its glyphs are.
    ///
    /// The text box was the whole content measured as ONE line: a three-line
    /// text was one line tall and three lines wide, so the second and third
    /// lines selected nothing while a strip of empty canvas to the right of the
    /// first line selected the text.
    #[test]
    fn a_paragraph_is_clickable_on_every_line_and_nowhere_else() {
        let mut engine = Engine::new();
        let t = engine.add_text(200.0, 300.0, "Hello\nWorld\nAgain", 24.0);

        // Baseline of line 1 is y=300; the box runs from 300-24 to the last
        // line's baseline (two line-heights below).
        let b = engine.get_node_bounds(t);
        assert!((b[1] - 276.0).abs() < 0.01, "top is the first line's ascent");
        assert!((b[3] - (300.0 + 2.0 * 24.0 * 1.2)).abs() < 0.01, "bottom reaches the last line");
        // Longest line "Hello" / "World" / "Again" = 5 ASCII × 0.6em.
        assert!((b[2] - (200.0 + 5.0 * 24.0 * 0.6)).abs() < 0.01, "width is the LONGEST line");

        assert_eq!(engine.hit_test(210.0, 292.0), Some(t), "first line");
        assert_eq!(engine.hit_test(210.0, 320.0), Some(t), "second line");
        assert_eq!(engine.hit_test(210.0, 350.0), Some(t), "third line");
        assert_eq!(engine.hit_test(400.0, 292.0), None, "not the empty canvas beside it");
        assert_eq!(engine.hit_test(210.0, 380.0), None, "nor below the last line");
    }

    /// CJK advances ~1em — the old 0.6em Latin estimate left the right half
    /// of Chinese runs outside the hit AABB (marquee / click miss).
    #[test]
    fn cjk_text_hit_covers_full_run() {
        let mut engine = Engine::new();
        let t = engine.add_text(100.0, 200.0, "打算阿萨", 32.0);
        let b = engine.get_node_bounds(t);
        // 4 CJK × 1.0em
        assert!((b[2] - (100.0 + 4.0 * 32.0)).abs() < 0.01, "CJK width ≈ N×em");
        assert_eq!(engine.hit_test(100.0 + 8.0, 190.0), Some(t), "left glyphs");
        assert_eq!(engine.hit_test(100.0 + 4.0 * 32.0 - 8.0, 190.0), Some(t), "right glyphs");
        assert_eq!(engine.hit_test(100.0 + 4.0 * 32.0 + 20.0, 190.0), None, "past the run");
    }

    /// Center/right align inside the hug box (x=0…w) — hit AABB stays at origin.
    #[test]
    fn aligned_text_is_clickable_where_it_is_drawn() {
        let mut engine = Engine::new();
        let t = engine.add_text(200.0, 300.0, "Hello", 24.0);
        let w = 5.0 * 24.0 * 0.6;
        engine.set_text_properties(t, "", 1, 1.2); // centre
        assert_eq!(engine.hit_test(200.0 + 2.0, 295.0), Some(t));
        assert_eq!(engine.hit_test(200.0 + w - 2.0, 295.0), Some(t));
        assert_eq!(engine.hit_test(200.0 + w + 5.0, 295.0), None);
        engine.set_text_properties(t, "", 2, 1.2); // right
        assert_eq!(engine.hit_test(200.0 + 2.0, 295.0), Some(t));
        assert_eq!(engine.hit_test(200.0 + w - 2.0, 295.0), Some(t));
        assert_eq!(engine.hit_test(200.0 - 5.0, 295.0), None);
    }

    /// A shape cut out of a scaled group comes back the size it left at.
    ///
    /// The clipboard holds a node's LOCAL transform, and paste reads it back
    /// against the root — so a child of a group scaled to 200% returned at half
    /// the size it was cut at. The cut roots are stored in world terms instead.
    #[test]
    fn a_cut_out_of_a_scaled_group_pastes_back_at_its_old_size() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 40.0, 40.0);
        let b = engine.add_rect(60.0, 0.0, 40.0, 40.0);
        let g = engine.group_nodes(&format!("[{a},{b}]"));
        engine.set_node_scale(g, 2.0, 2.0);

        let before = engine.get_node_bounds(a);
        let w = before[2] - before[0];
        assert!((w - 80.0).abs() < 0.01, "the child is 80 wide on the canvas, not 40");

        engine.cut_nodes(&format!("[{a}]"));
        let pasted = engine.paste_clipboard(0.0, 0.0);
        let after = engine.get_node_bounds(pasted[0]);
        assert!((after[2] - after[0] - w).abs() < 0.01, "same size as it was cut at");
        assert!((after[0] - before[0]).abs() < 0.01, "and in the same place");
        assert!((after[1] - before[1]).abs() < 0.01);
    }

    /// The reason the clipboard lives outside `Scene`: undo swaps the whole
    /// scene out, and a clipboard stored inside it would go with it. Cut, undo,
    /// then paste is an ordinary thing to do.
    #[test]
    fn the_clipboard_survives_undo_and_is_never_serialized() {
        let mut engine = Engine::new();
        let id = engine.add_rect(10.0, 10.0, 20.0, 20.0);
        engine.cut_nodes(&format!("[{id}]"));

        // A save must not carry the cut nodes into the user's file...
        let saved = engine.serialize_scene();
        let mut reloaded = Engine::new();
        assert!(reloaded.deserialize_scene(&saved));
        assert!(reloaded.scene.nodes.is_empty(), "the clipboard must not be saved");

        // ...and a round trip through undo must not lose them.
        assert!(engine.deserialize_scene(&saved));
        assert!(engine.has_clipboard(), "undo must not take the clipboard with it");
        assert_eq!(engine.paste_clipboard(0.0, 0.0).len(), 1);
    }

    /// Dissolving a Live Paint group takes its paint with it.
    ///
    /// Ungroup removes the node, and the three things that outlive that removal
    /// were all left dangling: the group cache still listed the id, so the render
    /// data kept naming a group that did not exist; the paint scope still pointed
    /// at it; and nothing dirtied the network, so its faces stayed on the canvas
    /// as paint belonging to nothing — until some unrelated edit rebuilt it.
    #[test]
    fn ungrouping_a_live_paint_group_takes_its_network_with_it() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{a},{b}]"));
        engine.set_node_live_paint(group, true);
        engine.set_live_paint_group(group);
        let face = engine.query_face_at(75.0, 75.0);
        assert!(face >= 0, "the overlap is paintable to begin with");
        engine.set_face_fill(face as u32, 0.0, 1.0, 0.0, 1.0);

        engine.ungroup_node(group);

        assert!(engine.scene.nodes.get(&group).is_none());
        assert!(!engine.live_paint_groups.contains(&group), "cache still names it");
        assert_eq!(engine.get_live_paint_group(), -1, "scope still points at it");
        // The shapes are still there and are still shapes — they are just not a
        // painted surface any more, so nothing is fillable.
        assert!(engine.scene.nodes.contains_key(&a));
        assert_eq!(engine.query_face_at(75.0, 75.0), -1);
        assert_eq!(engine.get_live_paint_faces(), "[]");
    }

    /// Deleting a Live Paint group clears the paint scope too, for the same
    /// reason: a scope pointing at a removed node is a dangling id.
    #[test]
    fn deleting_the_active_live_paint_group_clears_the_scope() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{a}]"));
        engine.set_node_live_paint(group, true);
        engine.set_live_paint_group(group);

        engine.remove_node(group);

        assert_eq!(engine.get_live_paint_group(), -1);
        assert!(!engine.live_paint_groups.contains(&group));
    }

    /// Loading a document written before nesting was refused heals it.
    ///
    /// The flag is set on both groups directly here, which is the one way to
    /// produce the state a pre-fix save left behind — every public path now
    /// refuses it, so the only remaining source of a nested flag is a file.
    /// Left alone, the inner group keeps its own network for the rest of the
    /// document's life: `live_paint_group_of` stops at the nearest flag, so the
    /// shapes under it never divide regions with their neighbours.
    #[test]
    fn loading_a_legacy_nested_live_paint_group_clears_the_inner_flag() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let added = engine.add_rect(120.0, 0.0, 100.0, 100.0);
        let inner = engine.group_nodes(&format!("[{added}]"));
        let outer = engine.group_nodes(&format!("[{a},{inner}]"));
        // Straight onto the nodes: what a 0.x snapshot restores.
        engine.scene.nodes.get_mut(&outer).unwrap().live_paint = true;
        engine.scene.nodes.get_mut(&inner).unwrap().live_paint = true;

        let saved = engine.serialize_scene();
        let mut reloaded = Engine::new();
        assert!(reloaded.deserialize_scene(&saved));

        assert!(reloaded.get_node_live_paint(outer), "the real group keeps its flag");
        assert!(!reloaded.get_node_live_paint(inner), "the nested flag is cleared on load");
        assert!(!reloaded.live_paint_groups.contains(&inner), "and leaves the cache");
        // The shape it wrapped now belongs to the outer group's surface.
        assert_eq!(reloaded.live_paint_group_of(added), Some(outer));
    }

    /// A line that pokes into a region but does not cross it.
    ///
    /// The face walk goes out along that stub and back, so the boundary it
    /// records visits the same geometry twice. Rendered, that is a zero-area
    /// spike hanging off the fill — and where the stub is curved, a curve
    /// wandering into the middle of a region that has no boundary there. It is
    /// also what the region's representative point and centroid are computed
    /// from, so a fill can end up keyed to a point that is not inside the shape
    /// a user sees.
    ///
    /// The stub stays in the graph — it is still a paintable edge — it just
    /// stops being part of the outline of the fill.
    #[test]
    fn a_dangling_stub_is_not_part_of_the_face_outline() {
        let mut engine = Engine::new();
        let rect = engine.add_rect(0.0, 0.0, 200.0, 100.0);
        // An open path entering the rect from the left and stopping halfway.
        let stub = engine.add_path(
            r#"[{"points":[{"x":-20.0,"y":50.0,"cp1":[-20.0,50.0],"cp2":[-20.0,50.0]},
                            {"x":90.0,"y":50.0,"cp1":[90.0,50.0],"cp2":[90.0,50.0]}],"closed":false}]"#,
        );
        let group = engine.group_nodes(&format!("[{rect},{stub}]"));
        engine.set_node_live_paint(group, true);
        engine.set_live_paint_group(group);

        // The stub does not divide the rectangle: one region, as in Illustrator.
        let face = engine.query_face_at(150.0, 50.0);
        assert!(face >= 0);
        assert_eq!(engine.query_face_at(20.0, 20.0), face, "a stub must not split the region");

        let f = engine.scene.vector_network.faces.get(&(face as u32)).unwrap();
        // The outline is the rectangle: four corners, no excursion along the stub
        // and back. Before this was pruned the walk recorded the stub twice.
        let outline = engine.scene.vector_network.face_outline(f);
        assert!(
            outline.len() <= 6,
            "outline should trace the rectangle, got {} points — the stub is in it",
            outline.len()
        );
        for p in &outline {
            assert!(
                p.x >= -1.0,
                "outline reaches x={} — that is out along the stub, outside the region",
                p.x
            );
        }

        // The stub is still there to paint: an edge query on it must still hit.
        assert!(engine.query_edge_at(50.0, 50.0, 4.0) >= 0, "the stub must stay paintable");
    }

    /// Two overlapping circles: no gaps, no open ends, nothing dangling.
    ///
    /// The lens is bounded by exactly two arcs, and its area is analytic. If the
    /// fill's outline wanders off the real boundary — an arc reconstructed over
    /// the wrong t-range, a fragment merged across a junction it should have
    /// turned at — the area moves and the outline leaves the lens's bounding box.
    #[test]
    fn a_lens_between_two_circles_is_exactly_the_lens() {
        let mut engine = Engine::new();
        // Unit-ish circles of radius 100, centres 100 apart → d = r.
        let a = engine.add_ellipse(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_ellipse(100.0, 0.0, 100.0, 100.0);
        let g = engine.group_nodes(&format!("[{a},{b}]"));
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);

        let lens = engine.query_face_at(50.0, 0.0);
        assert!(lens >= 0, "the overlap must be a region");
        engine.set_face_fill(lens as u32, 1.0, 0.0, 0.0, 1.0);

        let f = engine.scene.vector_network.faces.get(&(lens as u32)).unwrap();
        let poly = &f.boundary_polygon;
        let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
        for p in poly {
            lo[0] = lo[0].min(p[0]); lo[1] = lo[1].min(p[1]);
            hi[0] = hi[0].max(p[0]); hi[1] = hi[1].max(p[1]);
        }
        // The lens spans x ∈ [0,100] and y ∈ [-86.6, 86.6] (r√3/2).
        assert!(lo[0] > -1.0 && hi[0] < 101.0, "outline x extent {:?}..{:?} leaves the lens", lo[0], hi[0]);
        assert!(lo[1] > -87.6 && hi[1] < 87.6, "outline y extent {:?}..{:?} leaves the lens", lo[1], hi[1]);

        // Analytic lens area for two equal circles at distance d = r:
        // 2r²·acos(d/2r) − (d/2)·√(4r²−d²) = 2·10000·acos(0.5) − 50·√30000
        // `signed_area` runs on `boundary_polygon`, which is the FLATTENED hull —
        // chords inside arcs — so it sits a little under the analytic figure by
        // construction. What matters is that it is the lens and not something
        // else: a stray arc or a fragment merged across a junction moves this by
        // far more than flattening does.
        let expected = 2.0 * 10000.0 * (0.5f64).acos() - 50.0 * 30000.0f64.sqrt();
        let got = engine.scene.vector_network.faces[&(lens as u32)].signed_area.abs();
        let err = (expected - got) / expected;
        assert!(
            (0.0..0.05).contains(&err),
            "lens area {got:.0} vs analytic {expected:.0} — {:.1}% out, expected a small under-read",
            err * 100.0
        );

        // And the rendered outline is arcs, not the flattened hull. An ellipse is
        // four quarter-arcs, so the exact count depends on how many of them each
        // side of the lens spans — what matters is that it is a handful of
        // control points rather than the ~40 the flattened polyline would give.
        let outline = engine.scene.vector_network.face_outline(&engine.scene.vector_network.faces[&(lens as u32)]);
        assert!(
            (2..=8).contains(&outline.len()),
            "outline should be a few arcs, got {} points",
            outline.len()
        );
    }

    /// A document painted BEFORE dangling ends stopped polluting face outlines.
    ///
    /// Its fills were saved with a centroid computed from a polygon that ran out
    /// along every stub in the region and back, so the stored point sits well
    /// away from where that same region's centre computes now — further than the
    /// distance fallback will reach. The point was inside its region when it was
    /// written and it still is, which is what re-attachment now uses. Without
    /// that, opening such a file drops the paint or hands it to a neighbour.
    #[test]
    fn a_fill_saved_against_the_old_outline_still_lands_on_its_region() {
        let mut engine = Engine::new();
        let rect = engine.add_rect(0.0, 0.0, 400.0, 200.0);
        // A long stub reaching deep into the region — the thing that used to drag
        // the polygon, and with it the centroid this fill was saved against.
        let stub = engine.add_path(
            r#"[{"points":[{"x":10.0,"y":100.0,"cp1":[10.0,100.0],"cp2":[10.0,100.0]},
                            {"x":300.0,"y":100.0,"cp1":[300.0,100.0],"cp2":[300.0,100.0]}],"closed":false}]"#,
        );
        let group = engine.group_nodes(&format!("[{rect},{stub}]"));
        engine.set_node_live_paint(group, true);
        engine.set_live_paint_group(group);

        let face = engine.query_face_at(200.0, 50.0);
        assert!(face >= 0);

        // Stand in for the old file: a fill whose stored point is inside the
        // region but 120 units from the pruned centroid — far outside the
        // FILL_REMAP_THRESHOLD of 50 that a distance match would allow.
        let here = crate::vector_network::face_centroid(&engine.scene.vector_network.faces[&(face as u32)]);
        let stored = Vec2::new(here.x - 120.0, here.y);
        assert!(stored.x > 0.0, "the stand-in point must still be inside the rectangle");
        // No signature, which is what the old build wrote whenever the polluted
        // polygon put the representative point on the stub rather than in the
        // region — a point on a line is inside no closed shape. That leaves the
        // signature tier nothing to match, and 120 units leaves the distance
        // tier nothing either.
        engine.scene.vector_network.pending_fills.push(crate::vector_network::PendingFill {
            centroid: stored,
            signature: Vec::new(),
            color: Paint::Solid(Color { r: 1.0, g: 0.0, b: 0.0, a: 1.0 }),
        });

        // Force the rebuild that a load performs.
        engine.scene.vector_network.dirty = true;
        engine.ensure_network_clean();

        let landed = engine.query_face_at(stored.x, stored.y);
        assert!(landed >= 0, "the stored point must still resolve to a region");
        let fill = engine.scene.vector_network.faces[&(landed as u32)].fill.clone();
        assert!(fill.is_some(), "the fill was dropped — an existing painted file would open blank");
        // And it is the region the point was written inside, not a neighbour.
        assert_eq!(landed, engine.query_face_at(200.0, 50.0));
    }

    /// A pen line dropped onto another line lands a fraction of a unit off, and
    /// that has to count as meeting it.
    ///
    /// Measured on a real drawing: ends sitting 0.25 to 0.92 units from the line
    /// they plainly touch. Vertices merged within `gap_tolerance` (2.0), but an
    /// endpoint landing on the INTERIOR of another line only counted within 0.1 —
    /// twenty times stricter, for the junction a drawing is mostly made of. Every
    /// one of those ends fell through, so no vertex appeared there, so nothing
    /// merged, and the region flooded into its neighbour. Some areas painted and
    /// some did not, with nothing to distinguish them.
    #[test]
    fn a_line_ending_just_short_of_another_still_divides_the_region() {
        for miss in [0.0_f32, 0.3, 0.9] {
            let mut engine = Engine::new();
            let rect = engine.add_rect(0.0, 0.0, 200.0, 100.0);
            // A divider crossing the rect, whose ends stop `miss` units short of
            // the top and bottom edges.
            let d = engine.add_path(&format!(
                r#"[{{"points":[{{"x":100.0,"y":{top},"cp1":[100.0,{top}],"cp2":[100.0,{top}]}},
                                 {{"x":100.0,"y":{bot},"cp1":[100.0,{bot}],"cp2":[100.0,{bot}]}}],"closed":false}}]"#,
                top = miss, bot = 100.0 - miss
            ));
            let g = engine.group_nodes(&format!("[{rect},{d}]"));
            engine.set_node_live_paint(g, true);
            engine.set_live_paint_group(g);

            let left = engine.query_face_at(50.0, 50.0);
            let right = engine.query_face_at(150.0, 50.0);
            assert!(left >= 0 && right >= 0, "both halves must be regions (miss {miss})");
            assert_ne!(left, right, "a divider {miss} units short must still divide the rectangle");
        }
    }

    /// A rounded rectangle enters the Live Paint surface rounded.
    ///
    /// A flagged group renders its faces instead of its members' own fills, so
    /// emitting the rect's four sharp corners into the network meant the corner
    /// arcs disappeared the instant Live Paint was applied — the shape on screen
    /// changed under the user at the moment they asked to paint it.
    #[test]
    fn a_rounded_rect_keeps_its_corners_in_the_surface() {
        let mut engine = Engine::new();
        let rect = engine.add_rect(0.0, 0.0, 200.0, 200.0);
        engine.set_node_style(rect, r#"{"fills":[{"r":0.5,"g":0.5,"b":0.5,"a":1.0}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":40.0,"effects":[]}"#);
        let g = engine.group_nodes(&format!("[{rect}]"));
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);

        let face = engine.query_face_at(100.0, 100.0);
        assert!(face >= 0);

        // The corner is cut away: a point 6 units inside the sharp corner sits
        // outside a 40-unit rounded one, so it must belong to no region.
        assert_eq!(
            engine.query_face_at(6.0, 6.0), -1,
            "the sharp corner is still in the surface — the rounding was dropped"
        );
        // And the outline carries real curvature rather than four straight sides.
        let f = engine.scene.vector_network.faces.get(&(face as u32)).unwrap();
        let outline = engine.scene.vector_network.face_outline(f);
        let curved = outline.iter().any(|p| {
            (p.cp1.x - p.x).abs() > 0.5 || (p.cp1.y - p.y).abs() > 0.5
                || (p.cp2.x - p.x).abs() > 0.5 || (p.cp2.y - p.y).abs() > 0.5
        });
        assert!(curved, "the region's outline has no curves — corners came back square");
    }

    fn deviation_of(e: &mut Engine) -> f32 {
        e.ensure_network_clean();
        let (segs, _) = e.collect_segments();
        let ids: Vec<u32> = e.scene.vector_network.faces.values().filter(|f| !f.is_outer).map(|f| f.id).collect();
        let mut maxd = 0.0f32;
        for fid in ids {
            let f = &e.scene.vector_network.faces[&fid];
            for w in e.scene.vector_network.face_outline(f).windows(2) {
                let p0 = Vec2::new(w[0].x, w[0].y);
                let p3 = Vec2::new(w[1].x, w[1].y);
                let (c1, c2) = (w[0].cp2, w[1].cp1);
                for k in 0..=10 {
                    let t = k as f32 / 10.0; let mt = 1.0 - t;
                    let pt = p0*(mt*mt*mt) + c1*(3.0*mt*mt*t) + c2*(3.0*mt*t*t) + p3*(t*t*t);
                    let mut best = f32::MAX;
                    for sg in &segs {
                        let (proj, _) = crate::vector_network::project_point_to_segment(pt, sg.a, sg.b);
                        best = best.min((proj - pt).length());
                    }
                    maxd = maxd.max(best);
                }
            }
        }
        maxd
    }

    /// A region's outline never wanders off the geometry that bounds it.
    ///
    /// The reported failure, in one number. A fragment carries the t-range of
    /// the curve it came from, derived through flattening and through every
    /// split, and that range can drift from the geometry it labels: one claiming
    /// t[0.0588, 0.9412] reconstructed to an arc whose ends sat 16.6 units from
    /// its own vertices. Drawn, it swung the region's outline clean across the
    /// artwork — straight shapes acquiring curves they never contained, at the
    /// moment they were painted.
    ///
    /// A shape on its own never showed it, because nothing splits its curves.
    /// One line across it is the whole reproduction: 10.5 units of stray.
    #[test]
    fn a_face_outline_stays_on_the_geometry_that_bounds_it() {
        let mut e = Engine::new();
        let r = e.add_rect(0.0, 0.0, 300.0, 200.0);
        e.set_node_style(r, r#"{"fills":[{"r":0.5,"g":0.5,"b":0.5,"a":1.0}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":30.0,"effects":[]}"#);
        let l = e.add_path(
            r#"[{"points":[{"x":-20.0,"y":100.0,"cp1":[-20.0,100.0],"cp2":[-20.0,100.0]},
                            {"x":320.0,"y":100.0,"cp1":[320.0,100.0],"cp2":[320.0,100.0]}],"closed":false}]"#,
        );
        let g = e.group_nodes(&format!("[{r},{l}]"));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        e.ensure_network_clean();

        let (segs, _) = e.collect_segments();
        let ids: Vec<u32> = e.scene.vector_network.faces.values()
            .filter(|f| !f.is_outer).map(|f| f.id).collect();
        assert!(ids.len() >= 2, "the line must divide the rectangle");

        let mut worst = 0.0f32;
        for fid in ids {
            let f = &e.scene.vector_network.faces[&fid];
            for w in e.scene.vector_network.face_outline(f).windows(2) {
                let (p0, p3) = (Vec2::new(w[0].x, w[0].y), Vec2::new(w[1].x, w[1].y));
                let (c1, c2) = (w[0].cp2, w[1].cp1);
                for k in 0..=10 {
                    let t = k as f32 / 10.0;
                    let mt = 1.0 - t;
                    let pt = p0 * (mt * mt * mt) + c1 * (3.0 * mt * mt * t)
                        + c2 * (3.0 * mt * t * t) + p3 * (t * t * t);
                    let mut best = f32::MAX;
                    for sg in &segs {
                        let (proj, _) = crate::vector_network::project_point_to_segment(pt, sg.a, sg.b);
                        best = best.min((proj - pt).length());
                    }
                    worst = worst.max(best);
                }
            }
        }
        // Flattening alone accounts for well under a unit; anything beyond that
        // is outline that does not follow the drawing.
        assert!(worst < 1.0, "outline strays {worst:.2} units from any geometry in the document");
    }








    /// A stroke stopping just short of the line it meets still closes its region.
    ///
    /// The snapping tolerance says "points this close are meant to be the same
    /// point". That claim used to be honoured by merging any two points within
    /// it, which also fused shapes running parallel and deleted the thin regions
    /// between them — so merging is now held to genuine coincidence. But the
    /// claim still has to hold for a DANGLING end, or a line drawn to close a
    /// region and falling a third of a unit short leaves it open, and the area
    /// inside it can only be painted together with everything around it.
    ///
    /// Bridging is the right mechanism for that: a terminal has nothing
    /// continuing past it, so attaching it ADDS a boundary rather than
    /// destroying one. It runs on the tolerance alone, with no Gaps setting.
    #[test]
    fn a_stroke_that_stops_just_short_still_closes_its_region() {
        let mut e = Engine::new();
        let frame = e.add_rect(0.0, 0.0, 200.0, 100.0);
        // Two strokes cutting the frame into three, the second stopping 0.4
        // units short of the frame's top edge — the reported drawing's case.
        let full = e.add_path(
            r#"[{"points":[{"x":60.0,"y":0.0,"cp1":[60.0,0.0],"cp2":[60.0,0.0]},
                           {"x":60.0,"y":100.0,"cp1":[60.0,100.0],"cp2":[60.0,100.0]}],"closed":false}]"#,
        );
        // Drawn as a CLOSED path doubling back on itself, which is how the
        // reported drawing's strokes are built. Its tip is not a free end — the
        // path continues through it on paper — so merging will not move it, and
        // only bridging can attach it.
        let short = e.add_path(
            r#"[{"points":[{"x":140.0,"y":0.4,"cp1":[140.0,0.4],"cp2":[140.0,0.4]},
                           {"x":140.0,"y":100.0,"cp1":[140.0,100.0],"cp2":[140.0,100.0]}],"closed":true}]"#,
        );
        let g = e.group_nodes(&format!("[{frame},{full},{short}]"));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        e.set_gap_tolerance(1.0); // no Gaps setting at all, just the tolerance
        e.ensure_network_clean();

        let left = e.query_face_at(30.0, 50.0);
        let middle = e.query_face_at(100.0, 50.0);
        let right = e.query_face_at(170.0, 50.0);
        assert!(left >= 0 && middle >= 0 && right >= 0, "all three should be paintable");
        assert_ne!(
            middle, right,
            "the stroke stopped 0.4 short, so its region never closed and paints with its neighbour"
        );
        assert_ne!(left, middle, "the full-length stroke divides its side");
    }


    /// Moving a Live Paint group does not shuffle its colours.
    ///
    /// A fill is re-attached to its region after every rebuild, and part of that
    /// is where the region was. "Where" was recorded in world space, so moving
    /// the group left every stored point behind: matching then asks which region
    /// is nearest to where a DIFFERENT region used to sit, and the colours land
    /// on their neighbours. Dragging a painted group was enough to scramble it.
    ///
    /// The points are now carried through whatever the group did in between, so
    /// this holds for a scale and a rotation as much as a drag.
    #[test]
    fn moving_a_live_paint_group_keeps_every_colour_on_its_region() {
        // Overlapping shapes plus an open line, so some regions have a
        // containment signature to match on and others have nothing but the
        // point — which is the case that broke.
        let build = || {
            let mut e = Engine::new();
            let a = e.add_rect(0.0, 0.0, 120.0, 110.0);
            let b = e.add_rect(70.0, 12.0, 140.0, 96.0);
            let l = e.add_path(
                r#"[{"points":[{"x":-20.0,"y":47.0,"cp1":[-20.0,47.0],"cp2":[-20.0,47.0]},
                               {"x":240.0,"y":71.0,"cp1":[240.0,71.0],"cp2":[240.0,71.0]}],"closed":false}]"#,
            );
            let g = e.group_nodes(&format!("[{a},{b},{l}]"));
            e.set_node_live_paint(g, true);
            e.set_live_paint_group(g);
            e.ensure_network_clean();

            // A distinct colour per region, and a probe point inside each.
            let mut painted: Vec<(f32, f32, String)> = Vec::new();
            let mut seen: Vec<i32> = Vec::new();
            for gx in 0..12 {
                for gy in 0..12 {
                    let (x, y) = (-10.0 + 200.0 * gx as f32 / 12.0, -10.0 + 140.0 * gy as f32 / 12.0);
                    let fid = e.query_face_at(x, y);
                    if fid < 0 || seen.contains(&fid) {
                        continue;
                    }
                    seen.push(fid);
                    let shade = seen.len() as f32 / 20.0;
                    e.set_face_paint(fid as u32, &format!(r#"{{"r":{shade},"g":0.2,"b":0.3,"a":1}}"#));
                    painted.push((x, y, e.get_face_paint(fid as u32)));
                }
            }
            (e, g, painted)
        };

        // 1. A drag.
        let (mut e, g, painted) = build();
        assert!(painted.len() >= 5, "the fixture should have several painted regions");
        e.move_node(g, 250.0, 130.0);
        e.ensure_network_clean();
        for (x, y, paint) in &painted {
            let fid = e.query_face_at(x + 250.0, y + 130.0);
            assert!(fid >= 0, "a region vanished after the move");
            assert_eq!(
                &e.get_face_paint(fid as u32), paint,
                "the colour at ({x},{y}) moved to another region"
            );
        }

        // 2 and 3. A scale and a rotation. Predicting where a point lands is not
        //    the test's business — a group carries its own transform already — so
        //    these check an invariant that needs no coordinates: order the
        //    painted regions by area and the sequence of colours must be
        //    unchanged. A shuffle moves a colour onto a differently-sized region
        //    and breaks it.
        // Each colour keyed to the area of the region carrying it. Areas are the
        // one thing a rigid transform relates predictably — unchanged by a
        // rotation, scaled by k² by a scale — and keying per colour rather than
        // comparing an ordering means two equally sized regions cannot make the
        // check ambiguous.
        let area_by_colour = |e: &Engine| -> Vec<(String, f64)> {
            let mut rows: Vec<(String, f64)> = e
                .scene
                .vector_network
                .faces
                .values()
                .filter(|f| !f.is_outer && f.fill.is_some())
                .map(|f| (e.get_face_paint(f.id), f.signed_area.abs()))
                .collect();
            rows.sort_by(|a, b| a.0.cmp(&b.0));
            rows
        };

        for (matrix, factor) in [("[2,0,0,0,2,0,0,0,1]", 4.0), ("[0,1,0,-1,0,0,0,0,1]", 1.0)] {
            let (mut e, g, painted) = build();
            let before = area_by_colour(&e);
            assert_eq!(before.len(), painted.len(), "every painted region should be counted");
            e.set_node_transform_matrix(g, matrix);
            e.ensure_network_clean();
            let after = area_by_colour(&e);
            assert_eq!(
                after.len(), before.len(),
                "a painted region was lost transforming with {matrix}"
            );
            for ((c1, a1), (c2, a2)) in before.iter().zip(after.iter()) {
                assert_eq!(c1, c2, "a colour disappeared transforming with {matrix}");
                let want = a1 * factor;
                assert!(
                    (a2 - want).abs() <= want * 0.02,
                    "colour {c1} was on a region of area {a1:.0} and is now on one of {a2:.0} \
                     (expected about {want:.0}) after {matrix}"
                );
            }
        }
    }


    /// Expanding one Live Paint group leaves every other group's colours alone.
    ///
    /// Expand bakes a group's regions into real shapes and then drops the marks
    /// it baked, or the same paint would exist twice. It did that with the
    /// document-wide clear, so it also erased every other group — copy a painted
    /// group, expand the copy, and the original came back blank. From the outside
    /// that is paint disappearing from something the user never touched.
    #[test]
    fn expanding_one_group_does_not_strip_another_groups_paint() {
        let mut e = Engine::new();
        let build = |e: &mut Engine, dx: f32| {
            let a = e.add_rect(dx, 0.0, 120.0, 110.0);
            let b = e.add_rect(dx + 70.0, 12.0, 140.0, 96.0);
            let g = e.group_nodes(&format!("[{a},{b}]"));
            e.set_node_live_paint(g, true);
            g
        };
        let keep = build(&mut e, 0.0);
        let copy = build(&mut e, 400.0);
        e.set_live_paint_group(keep);
        e.ensure_network_clean();

        // Paint both groups.
        let mut kept: Vec<(f32, f32, String)> = Vec::new();
        let mut seen: Vec<i32> = Vec::new();
        for gx in 0..10 {
            for gy in 0..10 {
                let (x, y) = (5.0 + 200.0 * gx as f32 / 10.0, 5.0 + 100.0 * gy as f32 / 10.0);
                for offset in [0.0, 400.0] {
                    let fid = e.query_face_at(x + offset, y);
                    if fid < 0 || seen.contains(&fid) {
                        continue;
                    }
                    seen.push(fid);
                    let shade = seen.len() as f32 / 10.0;
                    e.set_face_paint(fid as u32, &format!(r#"{{"r":{shade},"g":0.2,"b":0.3,"a":1}}"#));
                    if offset == 0.0 {
                        kept.push((x, y, e.get_face_paint(fid as u32)));
                    }
                }
            }
        }
        assert!(kept.len() >= 3, "the group we keep should have several painted regions");

        // Expand the copy, as the UI does: bake, drop that group's marks, delete it.
        let baked = e.get_live_paint_faces();
        assert!(!baked.is_empty());
        e.set_live_paint_group(0);
        e.clear_live_paint_marks_in_group(copy);
        e.remove_node(copy);
        e.set_live_paint_group(keep);
        e.ensure_network_clean();

        for (x, y, colour) in &kept {
            let fid = e.query_face_at(*x, *y);
            assert!(fid >= 0, "a region of the untouched group vanished");
            assert_eq!(
                &e.get_face_paint(fid as u32), colour,
                "expanding the other group took the colour at ({x},{y}) with it"
            );
        }
    }


    /// A colour never crosses from one Live Paint group to another.
    ///
    /// Two groups are independent surfaces. When the region a fill belonged to
    /// stops existing, the fill looks for the region that replaced it — and that
    /// search used to consider every face in the document. The exposed case is a
    /// region bounded only by open lines: it has no containment signature, so
    /// nothing about which shapes made it constrains where its colour may go, and
    /// the fallback is "whichever face contains the point". Another group's face
    /// sitting over the same spot answers that perfectly well, and a colour turns
    /// up in a group the user never painted.
    #[test]
    fn a_fill_never_migrates_into_another_live_paint_group() {
        let mut e = Engine::new();
        // Group A: four open strokes boxing in a cell. No closed shape bounds
        // it, so the region has an empty signature.
        let mut lines = Vec::new();
        for (x1, y1, x2, y2) in [
            (-10.0f32, 20.0f32, 110.0f32, 20.0f32),
            (-10.0, 80.0, 110.0, 80.0),
            (20.0, -10.0, 20.0, 110.0),
            (80.0, -10.0, 80.0, 110.0),
        ] {
            lines.push(e.add_path(&format!(
                r#"[{{"points":[{{"x":{x1},"y":{y1},"cp1":[{x1},{y1}],"cp2":[{x1},{y1}]}},
                                {{"x":{x2},"y":{y2},"cp1":[{x2},{y2}],"cp2":[{x2},{y2}]}}],"closed":false}}]"#
            )));
        }
        let list = lines.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let a = e.group_nodes(&format!("[{list}]"));
        e.set_node_live_paint(a, true);

        // Group B: a plain rect over the same ground, cut so it has regions of
        // its own — one of which contains the middle of A's cell.
        let rect = e.add_rect(0.0, 0.0, 100.0, 100.0);
        let cut = e.add_path(
            r#"[{"points":[{"x":-10.0,"y":90.0,"cp1":[-10.0,90.0],"cp2":[-10.0,90.0]},
                           {"x":110.0,"y":90.0,"cp1":[110.0,90.0],"cp2":[110.0,90.0]}],"closed":false}]"#,
        );
        let b = e.group_nodes(&format!("[{rect},{cut}]"));
        e.set_node_live_paint(b, true);
        e.set_live_paint_group(a);
        e.ensure_network_clean();

        let target = e.query_face_at(50.0, 50.0);
        assert!(target >= 0, "the cell should be paintable");
        let face = &e.scene.vector_network.faces[&(target as u32)];
        assert_eq!(face.group, a, "fixture: the cell belongs to group A");
        assert!(face.signature.is_empty(), "fixture: bounded by open lines, so no signature");
        e.set_face_paint(target as u32, r#"{"r":1,"g":0,"b":0,"a":1}"#);

        // Take group A away. Its colour is homeless, and the only faces left
        // belong to B — one of which contains the very point it was stored at.
        e.remove_node(a);
        e.ensure_network_clean();

        let strays: Vec<u32> = e.scene.vector_network.faces.values()
            .filter(|f| !f.is_outer && f.fill.is_some() && f.group == b)
            .map(|f| f.id)
            .collect();
        assert!(
            strays.is_empty(),
            "a colour painted in one group turned up in another: faces {strays:?}"
        );
    }

    /// A region that encloses another does not paint over it.
    ///
    /// A planar face is not always simply connected: draw a shape inside another
    /// and the region between them has two boundary components. The walk yields
    /// one cycle per face, so the island's cycle came out clockwise, was
    /// classified as an outer face and discarded — and the enclosing region,
    /// knowing nothing about it, rendered as a solid closed path across it. The
    /// island was a real region the whole time: clicking picked it, and its paint
    /// then vanished under its neighbour, which reads as an inner area that
    /// cannot be painted no matter how many times you click.
    #[test]
    fn a_region_that_encloses_another_keeps_it_as_a_hole() {
        let mut e = Engine::new();
        let outer = e.add_rect(0.0, 0.0, 200.0, 200.0);
        let inner = e.add_rect(70.0, 70.0, 60.0, 60.0); // inside, touching nothing
        let g = e.group_nodes(&format!("[{outer},{inner}]"));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        e.ensure_network_clean();

        let ring = e.query_face_at(20.0, 100.0);
        let island = e.query_face_at(100.0, 100.0);
        assert!(ring >= 0 && island >= 0, "both regions should be paintable");
        assert_ne!(ring, island, "the island is its own region");

        // The enclosing region carries the island as a hole...
        let vn = &e.scene.vector_network;
        let ring_face = &vn.faces[&(ring as u32)];
        assert_eq!(ring_face.holes.len(), 1, "the enclosing region has no hole for the island");
        assert_eq!(vn.face_rings(ring_face).len(), 2, "the region should draw as two contours");

        // ...and the island's own area is NOT part of it, so a click there can
        // never be answered with the region around it.
        assert_eq!(
            ring_face.hole_polygons.len(),
            1,
            "the hole needs a polygon, or hit-testing cannot exclude it"
        );
        assert!(
            ring_face.hole_polygons[0].iter().any(|p| p[0] > 69.0 && p[0] < 131.0),
            "the hole polygon should be the island's own outline"
        );

        // Painting them separately keeps both colours.
        assert!(e.set_face_paint(ring as u32, r#"{"r":1,"g":0,"b":0,"a":1}"#));
        assert!(e.set_face_paint(island as u32, r#"{"r":0,"g":0,"b":1,"a":1}"#));
        let data = e.get_live_paint_render_data();
        assert!(data.contains("\"holes\""), "render data should carry the hole rings");
    }

    /// Three shapes nested one inside the next: each ring belongs to the region
    /// immediately around it, not to every region that contains it.
    #[test]
    fn nested_islands_attach_to_the_region_that_actually_bounds_them() {
        let mut e = Engine::new();
        let a = e.add_rect(0.0, 0.0, 300.0, 300.0);
        let b = e.add_rect(50.0, 50.0, 200.0, 200.0);
        let c = e.add_rect(100.0, 100.0, 100.0, 100.0);
        let g = e.group_nodes(&format!("[{a},{b},{c}]"));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        e.ensure_network_clean();

        let outer_ring = e.query_face_at(20.0, 150.0);
        let mid_ring = e.query_face_at(70.0, 150.0);
        let core = e.query_face_at(150.0, 150.0);
        assert!(outer_ring >= 0 && mid_ring >= 0 && core >= 0);
        assert_ne!(outer_ring, mid_ring);
        assert_ne!(mid_ring, core);

        let vn = &e.scene.vector_network;
        // Each ring holds exactly ONE island: the next one in. If containment
        // alone decided it, the outermost would have claimed both.
        assert_eq!(vn.faces[&(outer_ring as u32)].holes.len(), 1, "outer ring holes");
        assert_eq!(vn.faces[&(mid_ring as u32)].holes.len(), 1, "middle ring holes");
        assert_eq!(vn.faces[&(core as u32)].holes.len(), 0, "the core encloses nothing");
    }

    /// A wide gap tolerance closes gaps; it does not delete thin regions.
    ///
    /// The tolerance is there for hand-drawn ends that stop short of what they
    /// meet, and documents carry generous values. Applied to every point it
    /// becomes destructive: two shapes whose outlines run within it — a rounded
    /// rectangle and a copy of itself a unit away, which is what the reported
    /// drawing contains — have their junctions fused, and the thin region between
    /// them stops existing. On screen a fill then crosses straight over a corner
    /// arc into the shape beyond, because the boundary that should have stopped
    /// it was merged away.
    ///
    /// So geometry the artwork defines merges only when it genuinely coincides,
    /// and only free ends travel the full tolerance.
    #[test]
    fn a_wide_gap_tolerance_does_not_swallow_the_gap_between_two_shapes() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 200.0, 150.0);
        let b = engine.add_rect(1.2, 1.2, 200.0, 150.0);
        for id in [a, b] {
            engine.scene.nodes.get_mut(&id).unwrap().style.corner_radius = 30.0;
        }
        let g = engine.group_nodes(&format!("[{a},{b}]"));
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);
        // Wider than the gap between the two outlines, as the reported file is.
        engine.set_gap_tolerance(2.0);
        engine.ensure_network_clean();

        // A point in the sliver: inside the first rect, outside the second.
        let sliver = engine.query_face_at(0.6, 75.0);
        let inside = engine.query_face_at(100.0, 75.0);
        assert!(sliver >= 0, "the region between the two outlines is unpaintable");
        assert!(inside >= 0, "the shared interior is unpaintable");
        assert_ne!(
            sliver, inside,
            "the tolerance merged the two outlines, so the sliver between them is gone"
        );

        // And the corner arcs still bound it: the sliver has to follow them
        // around the corner rather than being cut off at the tangent point.
        let corner_sliver = engine.query_face_at(9.0, 9.5);
        assert_eq!(
            corner_sliver, sliver,
            "the sliver stops at the corner instead of following the arc"
        );
    }

    /// A painted boundary sits ON the curve it borrows, not near it.
    ///
    /// Crossings are found between flattened chords, because that is the only
    /// representation two curves share — and a chord sits inside the curve it
    /// approximates. Left there, the vertex is a point the shape's own outline
    /// never passes through, and the region drawn through it cuts across the
    /// shape that bounds it: a fill that visibly leaves the artwork at a rounded
    /// corner, thickest a little before the corner and pinching to nothing at
    /// it. Refining the crossing onto the curves removes the disagreement rather
    /// than rendering over it.
    #[test]
    fn a_painted_boundary_sits_on_the_curve_it_borrows() {
        let mut e = Engine::new();
        let circle = e.add_ellipse(200.0, 200.0, 120.0, 120.0);
        // Two chords across it, so the disc is cut into regions whose boundaries
        // are part line, part arc.
        for (x1, y1, x2, y2) in [(40.0, 150.0, 360.0, 190.0), (150.0, 40.0, 210.0, 360.0)] {
            e.add_path(&format!(
                r#"[{{"points":[{{"x":{x1},"y":{y1},"cp1":[{x1},{y1}],"cp2":[{x1},{y1}]}},
                                {{"x":{x2},"y":{y2},"cp1":[{x2},{y2}],"cp2":[{x2},{y2}]}}],"closed":false}}]"#
            ));
        }
        let ids: Vec<u32> = e.scene.root_nodes.clone();
        let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let g = e.group_nodes(&format!("[{list}]"));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        e.ensure_network_clean();
        let _ = circle;

        // The artwork itself, densely sampled: what every boundary must lie on.
        let truth: Vec<Vec<Vec2>> = e
            .scene
            .vector_network
            .curves
            .iter()
            .map(|cv| (0..=256).map(|k| cv.point_at(k as f32 / 256.0)).collect())
            .collect();
        let distance_to_artwork = |q: Vec2| -> f32 {
            truth
                .iter()
                .flat_map(|poly| poly.windows(2))
                .map(|w| {
                    let (proj, _) = crate::vector_network::project_point_to_segment(q, w[0], w[1]);
                    (proj - q).length()
                })
                .fold(f32::MAX, f32::min)
        };

        let faces: Vec<crate::vector_network::PlanarFace> = e
            .scene
            .vector_network
            .faces
            .values()
            .filter(|f| !f.is_outer)
            .cloned()
            .collect();
        assert!(faces.len() >= 4, "two chords should cut the disc into several regions");

        let mut checked = 0;
        for face in &faces {
            let outline = e.scene.vector_network.face_outline(face);
            for i in 0..outline.len() {
                let (a, b) = (&outline[i], &outline[(i + 1) % outline.len()]);
                let (p0, p3) = (Vec2::new(a.x, a.y), Vec2::new(b.x, b.y));
                // Only the curved spans: a straight span may legitimately cut
                // across empty drawing when it closes a gap.
                if (a.cp2 - p0).length() < 0.01 && (b.cp1 - p3).length() < 0.01 {
                    continue;
                }
                checked += 1;
                let curve = [p0, a.cp2, b.cp1, p3];
                for k in 0..=32 {
                    let pt = crate::vector_network::cubic_point(&curve, k as f32 / 32.0);
                    let off = distance_to_artwork(pt);
                    assert!(off < 0.05, "a painted arc sits {off:.2} units off the circle");
                }
            }
        }
        assert!(checked > 0, "the regions should be bounded by arcs, not only chords");
    }

    /// A straight pen segment is a LINE, and its length maps to its parameter.
    ///
    /// Drawn without handles it is stored as the cubic [p0,p0,p3,p3]: still
    /// straight, but parametrised as 3t²−2t³, which eases in and out. Reading a
    /// position along it as a parameter is then wrong by up to an eighth of its
    /// length — 10.25 units on the reported drawing — and every fragment carved
    /// out of it claims a stretch of curve it does not occupy. What reaches the
    /// screen is a region boundary running alongside the line that defines it.
    #[test]
    fn a_straight_pen_segment_maps_length_to_parameter() {
        let mut e = Engine::new();
        // One long straight segment, no handles, crossed near its far end —
        // where the parameterisation error is at its worst.
        let line = e.add_path(
            r#"[{"points":[{"x":0.0,"y":0.0,"cp1":[0.0,0.0],"cp2":[0.0,0.0]},
                           {"x":400.0,"y":0.0,"cp1":[400.0,0.0],"cp2":[400.0,0.0]}],"closed":false}]"#,
        );
        // A second stroke ENDING on that line, three quarters along — the
        // T-junction a drawing is mostly made of, and the case that has to ask
        // the curve where that point falls rather than assume.
        let tee = e.add_path(
            r#"[{"points":[{"x":300.0,"y":-90.0,"cp1":[300.0,-90.0],"cp2":[300.0,-90.0]},
                           {"x":300.0,"y":0.0,"cp1":[300.0,0.0],"cp2":[300.0,0.0]}],"closed":false}]"#,
        );
        let box_ = e.add_rect(340.0, -60.0, 120.0, 120.0);
        let g = e.group_nodes(&format!("[{line},{tee},{box_}]"));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        e.ensure_network_clean();

        // Every fragment of the line must sit where its own parameters say.
        let vn = &e.scene.vector_network;
        let mut checked = 0;
        for edge in vn.edges.values() {
            let Some(frag) = edge.frag else { continue };
            let Some(curve) = vn.curves.get(frag.curve as usize) else { continue };
            let (from, to) = (
                vn.vertices[&edge.from_vertex].position,
                vn.vertices[&edge.to_vertex].position,
            );
            let (da, db) = (
                (curve.point_at(frag.ta) - from).length(),
                (curve.point_at(frag.tb) - to).length(),
            );
            checked += 1;
            assert!(
                da < 0.05 && db < 0.05,
                "a fragment claims t[{:.4},{:.4}] but sits {da:.2}/{db:.2} units from there",
                frag.ta,
                frag.tb
            );
        }
        assert!(checked > 0, "the crossing should have split the line into fragments");
    }

    /// The same drawing arranges the same way every time.
    ///
    /// It did not. Vertex merging took the first vertex it found within
    /// tolerance while walking a `HashMap`, whose order changes with the process
    /// hash seed, so where two junctions were both in range the winner was
    /// decided by the seed. The fuzz test below caught it as a shape centre that
    /// was paintable in two runs out of three and a dead zone in the third, with
    /// no code change in between — and it is the most likely reason a document
    /// would paint correctly once and wrongly after a reload.
    ///
    /// Rebuilding inside one process is a real test of it: the second build
    /// allocates its maps afresh and lands its keys in different slots, so an
    /// order-sensitive decision shows up as a different arrangement here.
    #[test]
    fn arranging_the_same_drawing_twice_gives_the_same_regions() {
        let build = || {
            let mut e = Engine::new();
            // Coincident and near-coincident junctions, which is where the
            // choice of which vertex absorbs a point actually matters.
            for i in 0..12 {
                let t = i as f32;
                e.add_rect(t * 7.0, t * 5.0, 90.0 + t, 70.0 + t * 2.0);
                e.add_ellipse(40.0 + t * 9.0, 60.0 + t * 4.0, 30.0 + t, 25.0 + t);
            }
            let ids: Vec<u32> = e.scene.root_nodes.clone();
            let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
            let g = e.group_nodes(&format!("[{list}]"));
            e.set_node_live_paint(g, true);
            e.set_live_paint_group(g);
            e.ensure_network_clean();

            let mut vertices: Vec<(i64, i64)> = e
                .scene
                .vector_network
                .vertices
                .values()
                .map(|v| ((v.position.x * 1000.0) as i64, (v.position.y * 1000.0) as i64))
                .collect();
            vertices.sort_unstable();
            let mut areas: Vec<i64> = e
                .scene
                .vector_network
                .faces
                .values()
                .filter(|f| !f.is_outer)
                .map(|f| (f.signed_area.abs() * 1000.0) as i64)
                .collect();
            areas.sort_unstable();
            (vertices, areas)
        };

        let first = build();
        assert!(first.1.len() > 30, "the fixture should produce plenty of regions");
        for _ in 0..4 {
            let again = build();
            assert_eq!(again.0, first.0, "the same drawing produced different vertices");
            assert_eq!(again.1, first.1, "the same drawing produced different regions");
        }
    }

    /// The reported drawing, in the shape that broke it: a skewed rounded
    /// rectangle crossed by a fan of straight pen lines.
    ///
    /// Three things have to hold at once, and each one was broken at some point
    /// by a fix for another:
    ///
    /// - every cell a person can see between those lines is paintable, so the
    ///   junction tolerance may not swallow the thin slivers between two lines
    ///   that nearly meet;
    /// - the corner radii survive the arrangement, rather than being squared off
    ///   the moment the group becomes a Live Paint group;
    /// - nothing invents geometry: away from those four corners the drawing is
    ///   made of straight lines, and the painted regions may not contain a curve
    ///   the drawing does not have.
    #[test]
    fn a_skewed_rounded_rect_crossed_by_pen_lines_paints_every_cell_it_shows() {
        let mut e = Engine::new();

        let rect = e.add_rect(0.0, 0.0, 400.0, 300.0);
        e.scene.nodes.get_mut(&rect).unwrap().style.corner_radius = 24.0;
        // Skew it, the way the reported document was drawn.
        e.set_node_transform_matrix(rect, "[1,0,0,0.18,1,0,0,0,1]");

        // Nine pen lines crossing the rectangle, none of them axis-aligned and
        // none of them meeting at a shared point — the case that has to be found
        // by intersection rather than by construction.
        let lines: [(f32, f32, f32, f32); 9] = [
            (-20.0, 40.0, 430.0, 95.0),
            (-20.0, 130.0, 430.0, 100.0),
            (-20.0, 220.0, 430.0, 265.0),
            (30.0, -20.0, 95.0, 380.0),
            (150.0, -20.0, 120.0, 380.0),
            (280.0, -20.0, 330.0, 380.0),
            (-20.0, 320.0, 430.0, 190.0),
            (60.0, -20.0, 380.0, 380.0),
            (380.0, -20.0, 40.0, 380.0),
        ];
        for (x1, y1, x2, y2) in lines {
            e.add_path(&format!(
                r#"[{{"points":[{{"x":{x1},"y":{y1},"cp1":[{x1},{y1}],"cp2":[{x1},{y1}]}},
                                {{"x":{x2},"y":{y2},"cp1":[{x2},{y2}],"cp2":[{x2},{y2}]}}],"closed":false}}]"#
            ));
        }

        let ids: Vec<u32> = e.scene.root_nodes.clone();
        let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let g = e.group_nodes(&format!("[{list}]"));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        e.ensure_network_clean();

        let (segments, _) = e.collect_segments();
        let faces: Vec<crate::vector_network::PlanarFace> = e
            .scene
            .vector_network
            .faces
            .values()
            .filter(|f| !f.is_outer)
            .cloned()
            .collect();

        // Nine mutually crossing lines over a rectangle cut it into far more
        // than a handful of cells; the number is only a floor, because what
        // matters is that the small ones are not being collapsed away.
        assert!(
            faces.len() >= 20,
            "nine crossing lines should leave many paintable cells, got {}",
            faces.len()
        );

        // A span counts as CURVED when it actually bends away from the straight
        // line between its own anchors — not merely because it carries handles.
        // A straight edge is legitimately expressed as a cubic with collinear
        // handles (that is what a rounded rect's flat sides are), and counting
        // those as curvature measures notation instead of geometry.
        let bend_of = |a: &PathPoint, b: &PathPoint| -> f32 {
            let (p0, p3) = (Vec2::new(a.x, a.y), Vec2::new(b.x, b.y));
            let curve = [p0, a.cp2, b.cp1, p3];
            (1..16)
                .map(|k| {
                    let pt = crate::vector_network::cubic_point(&curve, k as f32 / 16.0);
                    let (proj, _) = crate::vector_network::project_point_to_segment(pt, p0, p3);
                    (proj - pt).length()
                })
                .fold(0.0, f32::max)
        };

        let mut curved_spans = 0;
        let mut total_spans = 0;
        for face in &faces {
            let outline = e.scene.vector_network.face_outline(face);
            for i in 0..outline.len() {
                total_spans += 1;
                if bend_of(&outline[i], &outline[(i + 1) % outline.len()]) > 0.05 {
                    curved_spans += 1;
                }
            }
            for pt in &outline {
                let anchor = Vec2::new(pt.x, pt.y);
                // Whatever the outline is made of, it has to be geometry the
                // document actually contains.
                let stray = segments
                    .iter()
                    .map(|s| {
                        let (proj, _) =
                            crate::vector_network::project_point_to_segment(anchor, s.a, s.b);
                        (proj - anchor).length()
                    })
                    .fold(f32::MAX, f32::min);
                assert!(
                    stray < 1.0,
                    "a painted outline sits {stray:.2} units away from anything in the drawing"
                );
            }
        }

        // An anchor sitting on the drawing is not enough: a control point can
        // bulge a curve far away from geometry whose endpoints both check out,
        // which is exactly how the reported artefact looked. Sample the bodies.
        for face in &faces {
            let outline = e.scene.vector_network.face_outline(face);
            for i in 0..outline.len() {
                let (a, b) = (&outline[i], &outline[(i + 1) % outline.len()]);
                let (p0, p3) = (Vec2::new(a.x, a.y), Vec2::new(b.x, b.y));
                if (a.cp2 - p0).length() < 0.01 && (b.cp1 - p3).length() < 0.01 {
                    continue; // a straight run needs no sampling
                }
                let curve = [p0, a.cp2, b.cp1, p3];
                for k in 0..=24 {
                    let pt = crate::vector_network::cubic_point(&curve, k as f32 / 24.0);
                    let stray = segments
                        .iter()
                        .map(|s| {
                            let (proj, _) =
                                crate::vector_network::project_point_to_segment(pt, s.a, s.b);
                            (proj - pt).length()
                        })
                        .fold(f32::MAX, f32::min);
                    assert!(
                        stray < 1.0,
                        "a painted curve bulges {stray:.2} units off the drawing"
                    );
                }
            }
        }

        // The corners are the drawing's only curvature, and they are four small
        // arcs on one shape: a handful of spans, not a fifth of them.
        assert!(
            curved_spans > 0,
            "the rounded corners were squared off by the arrangement"
        );
        assert!(
            curved_spans * 5 < total_spans,
            "curvature has spread beyond the four corners: {curved_spans} of {total_spans} spans"
        );
    }
    /// Cutting a group takes its children along, and paste rebuilds the tree.
    #[test]
    fn cut_carries_the_whole_subtree() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let b = engine.add_rect(20.0, 0.0, 10.0, 10.0);
        let group = engine.group_nodes(&format!("[{a},{b}]"));

        engine.cut_nodes(&format!("[{group}]"));
        assert!(engine.scene.nodes.is_empty(), "children go with the group");

        let pasted = engine.paste_clipboard(0.0, 0.0);
        assert_eq!(pasted.len(), 1);
        let kids = &engine.scene.nodes.get(&pasted[0]).unwrap().children;
        assert_eq!(kids.len(), 2);
        for k in kids {
            assert_eq!(engine.scene.nodes.get(k).unwrap().parent, Some(pasted[0]));
        }
    }

    #[test]
    fn test_add_rect() {
        let mut engine = Engine::new();
        let id = engine.add_rect(10.0, 20.0, 100.0, 50.0);
        assert_eq!(id, 1);
        assert_eq!(engine.scene.nodes.len(), 1);
        
        let node = engine.scene.nodes.get(&id).unwrap();
        assert_eq!(node.name, "Rect 1");
        let transform = node.transform.to_mat3();
        assert_eq!(transform.z_axis.x, 10.0);
        assert_eq!(transform.z_axis.y, 20.0);
    }

    #[test]
    fn test_hierarchical_transforms() {
        let mut engine = Engine::new();
        let parent_id = engine.add_rect(100.0, 100.0, 200.0, 200.0);
        let child_id = engine.add_rect(10.0, 10.0, 50.0, 50.0);
        
        assert!(engine.set_parent(child_id, Some(parent_id)));
        
        // Verify internal column-major storage directly
        let global = engine.global_transforms.get(&child_id).unwrap();
        let mat = Mat3::from_cols_array(global);
        
        // Global position should be parent (100, 100) + child (10, 10) = (110, 110)
        assert_eq!(mat.z_axis.x, 110.0);
        assert_eq!(mat.z_axis.y, 110.0);

        // Also verify the JS-facing pointer returns row-major format
        let ptr = engine.get_node_transform_ptr(child_id);
        let row_major = unsafe { std::slice::from_raw_parts(ptr, 9) };
        // In row-major: [scaleX, skewX, transX, skewY, scaleY, transY, ...]
        assert_eq!(row_major[2], 110.0); // transX
        assert_eq!(row_major[5], 110.0); // transY
    }

    #[test]
    fn test_hit_test() {
        let mut engine = Engine::new();
        let rect_id = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        
        assert_eq!(engine.hit_test(50.0, 50.0), Some(rect_id));
        assert_eq!(engine.hit_test(150.0, 50.0), None);
        
        // Move and test again
        engine.move_node(rect_id, 100.0, 0.0);
        assert_eq!(engine.hit_test(50.0, 50.0), None);
        assert_eq!(engine.hit_test(150.0, 50.0), Some(rect_id));
    }

    #[test]
    fn test_hit_test_z_order() {
        let mut engine = Engine::new();
        // rect_a is added first → drawn first (bottom)
        let rect_a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        // rect_b is added second → drawn on top
        let rect_b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        
        // In the overlap region (50-100, 50-100), rect_b should win (it's on top)
        assert_eq!(engine.hit_test(75.0, 75.0), Some(rect_b));
        
        // In rect_a-only region, rect_a should be hit
        assert_eq!(engine.hit_test(25.0, 25.0), Some(rect_a));
        
        // In rect_b-only region, rect_b should be hit
        assert_eq!(engine.hit_test(125.0, 125.0), Some(rect_b));
        
        // After send_to_back(rect_b), rect_a should be on top in overlap
        engine.send_to_back(rect_b);
        assert_eq!(engine.hit_test(75.0, 75.0), Some(rect_a));
        
        // After bring_to_front(rect_b), rect_b should be on top again
        engine.bring_to_front(rect_b);
        assert_eq!(engine.hit_test(75.0, 75.0), Some(rect_b));
    }

    #[test]
    fn locking_a_group_protects_its_children() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(200.0, 0.0, 100.0, 100.0);
        let g = engine.group_nodes(&format!("[{a},{b}]"));
        assert_eq!(engine.hit_test(50.0, 50.0), Some(a));

        // Lock the GROUP, not the children — the children's own flags stay false.
        engine.set_node_locked(g, true);
        assert!(!engine.get_node_locked(a), "child's own flag is untouched");
        assert!(engine.is_locked_in_tree(a), "but it is locked through its parent");
        // Without inheritance this returned `a`, and hit_test_grouped promoted it
        // back to the locked group — so a locked group was selectable and draggable.
        assert_eq!(engine.hit_test(50.0, 50.0), None);
        assert_eq!(engine.hit_test_grouped(50.0, 50.0), None);

        engine.set_node_locked(g, false);
        assert_eq!(engine.hit_test(50.0, 50.0), Some(a));
    }

    #[test]
    fn hiding_a_group_hides_it_from_picking_and_marquee() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let g = engine.group_nodes(&format!("[{a}]"));
        engine.set_node_visible(g, false);

        assert!(engine.get_node_visible(a), "child's own flag is untouched");
        assert!(!engine.is_visible_in_tree(a), "but it is hidden through its parent");
        assert_eq!(engine.hit_test(50.0, 50.0), None);
        // The child stays in the R-tree, so the marquee query has to prune the
        // subtree itself — otherwise it swept up the hidden group.
        assert!(engine.get_visible_nodes(-10.0, -10.0, 110.0, 110.0).is_empty());
    }

    /// Two 200×200 rects offset by 100, intersected: only x 200..300 is painted.
    /// Returns (engine, group_id, operand_ids).
    fn intersect_boolean_group() -> (Engine, u32, [u32; 2]) {
        let mut engine = Engine::new();
        let r1 = engine.add_rect(100.0, 200.0, 200.0, 200.0); // 100..300
        let r2 = engine.add_rect(200.0, 200.0, 200.0, 200.0); // 200..400
        let gid = engine.group_nodes(&format!("[{r1},{r2}]"));
        engine.set_boolean_op(gid, 0);
        // A Boolean Group carries the bottom operand's style (makeBooleanGroup
        // does this). Without a fill it would only be pickable on its outline.
        let style = engine.get_node_style_json(r1);
        engine.set_node_style(gid, &style);

        // The outline JS would compute for the intersection. bool_cache is in the
        // group's LOCAL space, and group_nodes parks the group's origin on the
        // union's top-left, so shift the world rect by that origin.
        let m = engine.global_transforms[&gid];
        let (ox, oy) = (m[6], m[7]);
        let corner = |x: f32, y: f32| {
            format!(r#"{{"x":{},"y":{},"cp1":[{},{}],"cp2":[{},{}]}}"#,
                x - ox, y - oy, x - ox, y - oy, x - ox, y - oy)
        };
        engine.set_bool_cache(gid, &format!(
            r#"[{{"points":[{},{},{},{}],"closed":true}}]"#,
            corner(200.0, 200.0), corner(300.0, 200.0),
            corner(300.0, 400.0), corner(200.0, 400.0),
        ));
        assert!(!engine.scene.nodes[&gid].bool_cache.is_empty(), "bool_cache JSON must parse");
        (engine, gid, [r1, r2])
    }

    #[test]
    fn boolean_group_is_picked_through_its_outline() {
        let (mut engine, gid, _) = intersect_boolean_group();

        // Inside the painted intersection → the group itself.
        assert_eq!(engine.hit_test(250.0, 300.0), Some(gid));
        // Inside an operand but outside the paint → nothing. The operands are
        // never drawn, so they must not be clickable.
        assert_eq!(engine.hit_test(150.0, 300.0), None);
        assert_eq!(engine.hit_test(350.0, 300.0), None);
        // Well clear of everything.
        assert_eq!(engine.hit_test(700.0, 700.0), None);
    }

    #[test]
    fn boolean_group_marquee_ignores_operands() {
        let (engine, gid, _) = intersect_boolean_group();

        // A marquee over the painted band selects the group.
        assert_eq!(engine.get_visible_nodes(240.0, 280.0, 260.0, 320.0), vec![gid]);
        // A marquee over operand-only space selects nothing — and never an operand.
        assert!(engine.get_visible_nodes(120.0, 280.0, 180.0, 320.0).is_empty());
    }

    #[test]
    fn boolean_group_bounds_follow_the_outline() {
        let (mut engine, gid, ops) = intersect_boolean_group();

        // The painted intersection, not the operand union (100..400).
        assert_eq!(engine.get_node_bounds(gid), vec![200.0, 200.0, 300.0, 400.0]);
        // Same box in the group's own space (its origin sits at the union's
        // top-left, 100,200) — what the oriented selection frame is built from.
        assert_eq!(engine.get_boolean_local_bounds(gid), vec![100.0, 0.0, 200.0, 200.0]);

        // Releasing the boolean hands the box back to the operand union.
        engine.set_boolean_op(gid, -1);
        assert_eq!(engine.get_node_bounds(gid), vec![100.0, 200.0, 400.0, 400.0]);
        assert!(engine.get_boolean_local_bounds(gid).is_empty());
        // ...and the operands become pickable again.
        assert_eq!(engine.hit_test(150.0, 300.0), Some(ops[0]));
    }

    #[test]
    fn test_visible_nodes_z_order() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(10.0, 10.0, 50.0, 50.0);
        let c = engine.add_rect(20.0, 20.0, 50.0, 50.0);
        
        // All visible in a large viewport
        let visible = engine.get_visible_nodes(0.0, 0.0, 200.0, 200.0);
        // Must be in draw order: a first (bottom), c last (top)
        assert_eq!(visible, vec![a, b, c]);
        
        // After reordering, draw order changes
        engine.send_to_back(c);
        let visible2 = engine.get_visible_nodes(0.0, 0.0, 200.0, 200.0);
        assert_eq!(visible2, vec![c, a, b]);
    }

    #[test]
    fn test_history() {
        let mut engine = Engine::new();
        let mut history = History::new(10);
        
        let state0 = engine.serialize_scene();
        history.push_state(state0.clone());
        
        engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let state1 = engine.serialize_scene();
        
        let restored0 = history.undo(state1.clone()).unwrap();
        assert_eq!(restored0, state0);
        
        let restored1 = history.redo(restored0).unwrap();
        assert_eq!(restored1, state1);
    }

    #[test]
    fn test_cycle_prevention() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let b = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let c = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        
        assert!(engine.set_parent(b, Some(a)));
        assert!(engine.set_parent(c, Some(b)));
        assert!(!engine.set_parent(a, Some(c))); // Cycle!
    }

    #[test]
    fn test_reorder_node_roots() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let b = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let c = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        assert_eq!(engine.get_root_nodes(), vec![a, b, c]);

        // Move `a` to the top of the z-order (end of the root vec).
        assert!(engine.reorder_node(a, None, 3));
        assert_eq!(engine.get_root_nodes(), vec![b, c, a]);

        // Move `c` to the very back (index 0).
        assert!(engine.reorder_node(c, None, 0));
        assert_eq!(engine.get_root_nodes(), vec![c, b, a]);
    }

    #[test]
    fn test_reorder_node_into_and_out_of_group() {
        let mut engine = Engine::new();
        let p = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let q = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let g = engine.group_nodes(&format!("[{},{}]", p, q));
        let a = engine.add_rect(0.0, 0.0, 10.0, 10.0);

        // Nest `a` inside the group as its top child.
        assert!(engine.reorder_node(a, Some(g), 2));
        assert_eq!(engine.get_node_parent(a), g as i32);

        // Promote `a` back out to the root level.
        assert!(engine.reorder_node(a, None, 0));
        assert_eq!(engine.get_node_parent(a), -1);
        assert_eq!(engine.get_node_parent(p), g as i32);

        // A non-group node can't be used as a parent.
        assert!(!engine.reorder_node(a, Some(p), 0));
        // A group can't be moved inside its own subtree.
        assert!(!engine.reorder_node(g, Some(p), 0));
    }

    #[test]
    fn test_reorder_nodes_batch_contiguous() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let b = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let c = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let d = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        assert_eq!(engine.get_root_nodes(), vec![a, b, c, d]);

        // Move `a` and `c` to sit just below `d`. After removing a and c the vec
        // is [b, d]; inserting at index 1 places them before d, preserving order.
        let moved = engine.reorder_nodes(&format!("[{},{}]", a, c), None, 1);
        assert_eq!(moved, 2);
        assert_eq!(engine.get_root_nodes(), vec![b, a, c, d]);

        // Invalid ids in the batch are skipped, valid ones still move.
        let moved2 = engine.reorder_nodes(&format!("[{},99999]", d), None, 0);
        assert_eq!(moved2, 1);
        assert_eq!(engine.get_root_nodes(), vec![d, b, a, c]);
    }

    #[test]
    fn test_stress_and_consistency() {
        let mut engine = Engine::new();
        let mut history = History::new(100);
        let mut ids = Vec::new();
        
        use rand::Rng;
        let mut rng = rand::thread_rng();
        
        for i in 0..1000 {
            let op = rng.gen_range(0..6);
            match op {
                0 => { // Add
                    let id = engine.add_rect(rng.gen(), rng.gen(), rng.gen(), rng.gen());
                    ids.push(id);
                }
                1 => { // Move
                    if !ids.is_empty() {
                        let idx = rng.gen_range(0..ids.len());
                        engine.move_node(ids[idx], rng.gen(), rng.gen());
                    }
                }
                2 => { // Set Parent
                    if ids.len() >= 2 {
                        let c_idx = rng.gen_range(0..ids.len());
                        let p_idx = rng.gen_range(0..ids.len());
                        if c_idx != p_idx {
                            engine.set_parent(ids[c_idx], Some(ids[p_idx]));
                        }
                    }
                }
                3 => { // Remove
                    if !ids.is_empty() {
                        let idx = rng.gen_range(0..ids.len());
                        let id = ids.remove(idx);
                        engine.remove_node(id);
                    }
                }
                4 => { // History
                    let state = engine.serialize_scene();
                    history.push_state(state);
                }
                5 => { // Undo
                    let current = engine.serialize_scene();
                    if let Some(prev) = history.undo(current) {
                        engine.deserialize_scene(&prev);
                        // Re-sync ids list (simplification)
                        ids = engine.scene.nodes.keys().cloned().collect();
                    }
                }
                _ => {}
            }
            
            // Periodically check consistency
            if i % 100 == 0 {
                // All nodes in root_nodes or children must exist in nodes map
                for &id in &engine.scene.root_nodes {
                    assert!(engine.scene.nodes.contains_key(&id));
                }
                for node in engine.scene.nodes.values() {
                    for &child_id in &node.children {
                        assert!(engine.scene.nodes.contains_key(&child_id));
                        assert_eq!(engine.scene.nodes.get(&child_id).unwrap().parent, Some(node.id));
                    }
                }
            }
        }
    }

    #[test]
    fn test_visible_nodes_partial_overlap() {
        let mut engine = Engine::new();
        // Rect at (50, 50) with size 100x100 -> covers (50,50)-(150,150)
        let id = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        
        // Viewport (0,0)-(100,100) partially overlaps the rect
        let visible = engine.get_visible_nodes(0.0, 0.0, 100.0, 100.0);
        assert!(visible.contains(&id), "Partially visible nodes must be returned");
        
        // Viewport fully contains the rect
        let visible2 = engine.get_visible_nodes(0.0, 0.0, 200.0, 200.0);
        assert!(visible2.contains(&id));
        
        // Viewport doesn't overlap at all
        let visible3 = engine.get_visible_nodes(200.0, 200.0, 300.0, 300.0);
        assert!(!visible3.contains(&id), "Non-overlapping viewport should not contain node");
    }

    #[test]
    fn test_set_parent_updates_spatial_index() {
        let mut engine = Engine::new();
        let parent = engine.add_rect(100.0, 100.0, 50.0, 50.0);
        let child = engine.add_rect(10.0, 10.0, 20.0, 20.0);
        
        // Child is at (10,10) as root, hit test should work there
        assert_eq!(engine.hit_test(15.0, 15.0), Some(child));
        
        // After reparenting, child should be at (110,110) globally
        engine.set_parent(child, Some(parent));
        assert_eq!(engine.hit_test(15.0, 15.0), None, "Should not hit at old position");
        assert_eq!(engine.hit_test(115.0, 115.0), Some(child), "Should hit at new global position");
    }

    #[test]
    fn test_group_bounds_union() {
        let mut engine = Engine::new();
        // Rect A at (0,0) size 100x50 → covers (0,0)-(100,50)
        let a = engine.add_rect(0.0, 0.0, 100.0, 50.0);
        // Rect B at (200,100) size 60x80 → covers (200,100)-(260,180)
        let b = engine.add_rect(200.0, 100.0, 60.0, 80.0);

        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));
        assert!(group_id > 0);

        // Group AABB should be the union: (0,0)-(260,180)
        let bounds = engine.get_node_bounds(group_id);
        assert!(bounds[0] <= 0.1, "minX should be ~0, got {}", bounds[0]);
        assert!(bounds[1] <= 0.1, "minY should be ~0, got {}", bounds[1]);
        assert!((bounds[2] - 260.0).abs() < 1.0, "maxX should be ~260, got {}", bounds[2]);
        assert!((bounds[3] - 180.0).abs() < 1.0, "maxY should be ~180, got {}", bounds[3]);
    }

    #[test]
    fn test_duplicate_group_deep_copies() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(100.0, 0.0, 50.0, 50.0);

        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));
        let clone_id = engine.duplicate_node(group_id);

        // Clone should exist and be a Group
        let clone_node = engine.scene.nodes.get(&clone_id).unwrap();
        assert!(matches!(clone_node.node_type, NodeType::Group));

        // Clone should have 2 children, all with fresh IDs
        assert_eq!(clone_node.children.len(), 2, "Cloned group should have 2 children");
        for &child_id in &clone_node.children {
            assert_ne!(child_id, a, "Cloned child should have fresh ID");
            assert_ne!(child_id, b, "Cloned child should have fresh ID");
            assert!(engine.scene.nodes.contains_key(&child_id), "Cloned child must exist in nodes");
            let child = engine.scene.nodes.get(&child_id).unwrap();
            assert_eq!(child.parent, Some(clone_id), "Cloned child's parent should be clone");
        }

        // Original children should be unaffected
        assert_eq!(engine.scene.nodes.get(&a).unwrap().parent, Some(group_id));
        assert_eq!(engine.scene.nodes.get(&b).unwrap().parent, Some(group_id));
    }

    #[test]
    fn test_ungroup_nested_preserves_positions() {
        let mut engine = Engine::new();
        let a = engine.add_rect(50.0, 50.0, 30.0, 30.0);
        let b = engine.add_rect(150.0, 150.0, 30.0, 30.0);

        // Record global positions before grouping
        let a_global_before = engine.global_transforms.get(&a).cloned().unwrap();
        let b_global_before = engine.global_transforms.get(&b).cloned().unwrap();

        // Group them
        let inner = engine.group_nodes(&format!("[{},{}]", a, b));
        // Create an outer group containing the inner group
        let c = engine.add_rect(300.0, 300.0, 20.0, 20.0);
        let outer = engine.group_nodes(&format!("[{},{}]", inner, c));

        // Now ungroup the inner group (which is nested inside outer)
        engine.ungroup_node(inner);

        // a and b should have the same global positions as before
        let a_global_after = engine.global_transforms.get(&a).cloned().unwrap();
        let b_global_after = engine.global_transforms.get(&b).cloned().unwrap();

        let a_before = Mat3::from_cols_array(&a_global_before);
        let a_after = Mat3::from_cols_array(&a_global_after);
        assert!((a_before.z_axis.x - a_after.z_axis.x).abs() < 1.0,
            "a global X should be preserved: before={}, after={}", a_before.z_axis.x, a_after.z_axis.x);
        assert!((a_before.z_axis.y - a_after.z_axis.y).abs() < 1.0,
            "a global Y should be preserved: before={}, after={}", a_before.z_axis.y, a_after.z_axis.y);

        let b_before = Mat3::from_cols_array(&b_global_before);
        let b_after = Mat3::from_cols_array(&b_global_after);
        assert!((b_before.z_axis.x - b_after.z_axis.x).abs() < 1.0,
            "b global X should be preserved");
        assert!((b_before.z_axis.y - b_after.z_axis.y).abs() < 1.0,
            "b global Y should be preserved");

        // a and b should now be children of outer (not root)
        assert_eq!(engine.scene.nodes.get(&a).unwrap().parent, Some(outer));
        assert_eq!(engine.scene.nodes.get(&b).unwrap().parent, Some(outer));
    }

    #[test]
    fn test_group_children_of_group_preserves_positions() {
        let mut engine = Engine::new();
        let a = engine.add_rect(10.0, 10.0, 40.0, 40.0);
        let b = engine.add_rect(100.0, 100.0, 40.0, 40.0);
        let c = engine.add_rect(200.0, 200.0, 40.0, 40.0);

        // Group all three
        let outer = engine.group_nodes(&format!("[{},{},{}]", a, b, c));

        // Record global positions
        let a_global = Mat3::from_cols_array(&engine.global_transforms[&a]);
        let b_global = Mat3::from_cols_array(&engine.global_transforms[&b]);

        // Now group a and b (children of outer) into a sub-group
        let sub_group = engine.group_nodes(&format!("[{},{}]", a, b));

        // a and b should still be at the same global positions
        let a_after = Mat3::from_cols_array(&engine.global_transforms[&a]);
        let b_after = Mat3::from_cols_array(&engine.global_transforms[&b]);

        assert!((a_global.z_axis.x - a_after.z_axis.x).abs() < 1.0,
            "a global X should be preserved after sub-grouping");
        assert!((a_global.z_axis.y - a_after.z_axis.y).abs() < 1.0,
            "a global Y should be preserved after sub-grouping");
        assert!((b_global.z_axis.x - b_after.z_axis.x).abs() < 1.0,
            "b global X should be preserved after sub-grouping");

        // sub_group should be a child of outer
        assert_eq!(engine.scene.nodes.get(&sub_group).unwrap().parent, Some(outer));
    }

    #[test]
    fn test_hit_test_grouped() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(200.0, 0.0, 100.0, 100.0);

        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));

        // Raw hit_test should return the leaf (rect a)
        let raw_hit = engine.hit_test(50.0, 50.0);
        assert_eq!(raw_hit, Some(a), "Raw hit test should return leaf node");

        // hit_test_grouped should return the group
        let grouped_hit = engine.hit_test_grouped(50.0, 50.0);
        assert_eq!(grouped_hit, Some(group_id), "Grouped hit test should return group");

        // Hit on rect b should also return the group
        let grouped_hit_b = engine.hit_test_grouped(250.0, 50.0);
        assert_eq!(grouped_hit_b, Some(group_id), "Grouped hit on b should return group");

        // Miss should return None
        assert_eq!(engine.hit_test_grouped(500.0, 500.0), None);
    }

    #[test]
    fn test_dedup_selection() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(100.0, 0.0, 50.0, 50.0);

        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));

        // Selecting group and its child 'a': dedup should drop 'a'
        let deduped = engine.dedup_selection(&format!("[{},{}]", group_id, a));
        assert_eq!(deduped, vec![group_id], "Dedup should drop child when parent is selected");

        // Selecting only leaves: both should remain
        let deduped2 = engine.dedup_selection(&format!("[{},{}]", a, b));
        assert_eq!(deduped2.len(), 2, "Dedup should keep both when neither is ancestor");
    }

    #[test]
    fn test_path_hit_precise_triangle() {
        let mut engine = Engine::new();
        // Right triangle with vertices (0,0), (100,0), (0,100).
        // Its bbox is (0,0)-(100,100), but the region near (90,90) is OUTSIDE.
        let subpaths = r#"[{"points":[
            {"x":0,"y":0,"cp1":[0,0],"cp2":[0,0]},
            {"x":100,"y":0,"cp1":[100,0],"cp2":[100,0]},
            {"x":0,"y":100,"cp1":[0,100],"cp2":[0,100]}
        ],"closed":true}]"#;
        let id = engine.add_path(subpaths);

        assert_eq!(engine.hit_test(20.0, 20.0), Some(id), "inside the triangle");
        assert_eq!(engine.hit_test(90.0, 90.0), None, "bbox corner outside the triangle must miss");
        // On the hypotenuse (stroke) — should hit
        assert_eq!(engine.hit_test(50.0, 50.0), Some(id), "point on the hypotenuse stroke");
    }

    #[test]
    fn test_path_hit_open_stroke_only() {
        let mut engine = Engine::new();
        // Open diagonal line from (0,0) to (100,100), no fill.
        let subpaths = r#"[{"points":[
            {"x":0,"y":0,"cp1":[0,0],"cp2":[0,0]},
            {"x":100,"y":100,"cp1":[100,100],"cp2":[100,100]}
        ],"closed":false}]"#;
        let id = engine.add_path(subpaths);
        // Remove the fill so only the stroke hits
        let style = r#"{"fill":null,"stroke":{"r":0,"g":0,"b":0,"a":1},"stroke_width":2.0,
            "opacity":1.0,"stroke_cap":0,"stroke_join":0,"dash_array":[],"dash_offset":0,
            "corner_radius":0,"blend_mode":0,"fill_rule":0,"miter_limit":4.0,"fill_opacity":1.0}"#;
        engine.set_node_style(id, style);

        assert_eq!(engine.hit_test(50.0, 50.0), Some(id), "on the line");
        assert_eq!(engine.hit_test(50.0, 53.0), Some(id), "within tolerance of the line");
        assert_eq!(engine.hit_test(30.0, 70.0), None, "inside bbox but far from the line");
    }

    #[test]
    fn test_path_hit_donut_even_odd() {
        let mut engine = Engine::new();
        // Outer square (0,0)-(100,100) and inner square (30,30)-(70,70) hole.
        let subpaths = r#"[
            {"points":[
                {"x":0,"y":0,"cp1":[0,0],"cp2":[0,0]},
                {"x":100,"y":0,"cp1":[100,0],"cp2":[100,0]},
                {"x":100,"y":100,"cp1":[100,100],"cp2":[100,100]},
                {"x":0,"y":100,"cp1":[0,100],"cp2":[0,100]}
            ],"closed":true},
            {"points":[
                {"x":30,"y":30,"cp1":[30,30],"cp2":[30,30]},
                {"x":70,"y":30,"cp1":[70,30],"cp2":[70,30]},
                {"x":70,"y":70,"cp1":[70,70],"cp2":[70,70]},
                {"x":30,"y":70,"cp1":[30,70],"cp2":[30,70]}
            ],"closed":true}
        ]"#;
        let id = engine.add_path(subpaths);
        // Even-odd fill rule (fill_rule=1), a solid fill, and no stroke
        // (so the hole isn't hit via stroke reach).
        let style = r#"{"fills":[{"r":0,"g":0,"b":0,"a":1}],"strokes":[],
            "opacity":1.0,"corner_radius":0,"blend_mode":0,"fill_rule":1}"#;
        engine.set_node_style(id, style);

        assert_eq!(engine.hit_test(15.0, 50.0), Some(id), "in the ring");
        assert_eq!(engine.hit_test(50.0, 50.0), None, "center of the hole must miss");
    }

    #[test]
    fn test_group_resize_scales_children() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(150.0, 150.0, 50.0, 50.0);
        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));

        // Group bounds: (0,0)-(200,200). Resize to 100x100 → everything halves.
        engine.resize_node(group_id, 100.0, 100.0);

        let gb = engine.get_node_bounds(group_id);
        assert!((gb[0] - 0.0).abs() < 0.5 && (gb[1] - 0.0).abs() < 0.5,
            "anchor (top-left) stays fixed, got {:?}", gb);
        assert!((gb[2] - 100.0).abs() < 0.5 && (gb[3] - 100.0).abs() < 0.5,
            "new bounds must be 100x100, got {:?}", gb);

        // Child b was at (150,150)-(200,200) → now (75,75)-(100,100)
        let bb = engine.get_node_bounds(b);
        assert!((bb[0] - 75.0).abs() < 0.5 && (bb[2] - 100.0).abs() < 0.5,
            "child scales with the group, got {:?}", bb);

        // Hit-testing still works at the new positions
        assert_eq!(engine.hit_test_grouped(90.0, 90.0), Some(group_id));
        assert_eq!(engine.hit_test(150.0, 150.0), None, "old position must miss");
    }

    #[test]
    fn test_rotate_preserves_scale() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(150.0, 150.0, 50.0, 50.0);
        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));

        // Bake a 2x scale into the group transform, then rotate it.
        engine.resize_node(group_id, 400.0, 400.0);
        engine.set_node_rotation(group_id, 45.0);

        // The linear part must still have magnitude 2 on both axes —
        // rotation must not reset the scale that resize_group applied.
        let node = engine.scene.nodes.get(&group_id).unwrap();
        let m = node.transform.to_mat3();
        let sx = (m.x_axis.x * m.x_axis.x + m.x_axis.y * m.x_axis.y).sqrt();
        let sy = (m.y_axis.x * m.y_axis.x + m.y_axis.y * m.y_axis.y).sqrt();
        assert!((sx - 2.0).abs() < 1e-3, "x scale lost by rotate: {}", sx);
        assert!((sy - 2.0).abs() < 1e-3, "y scale lost by rotate: {}", sy);

        // Both children sit on the main diagonal, so at 45° they line up
        // along the y axis: the far corner of child b (local 200,200 →
        // scaled 400,400) rotates to (0, 400·√2). If the rotate had reset
        // the scale, this span would be 200·√2 instead.
        let gb = engine.get_node_bounds(group_id);
        let h = gb[3] - gb[1];
        assert!((h - 400.0 * std::f32::consts::SQRT_2).abs() < 1.0,
            "rotated bounds must reflect the preserved 2x scale, got {}", h);
    }

    #[test]
    fn test_snapshot_roundtrip_with_paths_and_fills() {
        // Snapshots (undo/drag) go through protobuf now. A Path node with a
        // live-painted face must survive serialize → mutate → deserialize with
        // its geometry and fill intact (fills remap from centroids on rebuild).
        let mut engine = Engine::new();
        let path_id = engine.add_path(
            r#"[{"closed":true,"points":[
                {"x":100.0,"y":100.0,"cp1":[100.0,100.0],"cp2":[100.0,100.0]},
                {"x":400.0,"y":100.0,"cp1":[400.0,100.0],"cp2":[400.0,100.0]},
                {"x":400.0,"y":400.0,"cp1":[400.0,400.0],"cp2":[400.0,400.0]}
            ]}]"#,
        );
        flag_scene_lp(&mut engine);
        // Compute faces and fill one, so the planar network has content too
        let face = engine.query_face_at(300.0, 200.0);
        assert!(face >= 0, "expected a face inside the triangle");
        engine.set_face_fill(face as u32, 1.0, 0.0, 0.0, 1.0);

        let snapshot = engine.serialize_scene();
        engine.move_node(path_id, 50.0, 50.0);
        engine.set_face_fill(face as u32, 0.0, 1.0, 0.0, 1.0);

        assert!(engine.deserialize_scene(&snapshot), "snapshot must decode");

        let b = engine.get_node_bounds(path_id);
        assert!((b[0] - 100.0).abs() < 0.5, "position must be restored, got {:?}", b);
        let filled = engine.get_filled_faces();
        assert!(filled.contains("\"r\":1.0"), "face fill must be restored, got {}", filled);
    }

    #[test]
    fn test_fill_survives_large_move_via_signature() {
        // The headline Live Paint behavior: painting a region, then moving the
        // bounding path far, must keep the fill attached. The move (300px) is well
        // beyond the centroid-fallback threshold (50px), so only signature matching
        // (same bounding node) can preserve it.
        let mut engine = Engine::new();
        let path_id = engine.add_path(
            r#"[{"closed":true,"points":[
                {"x":100.0,"y":100.0,"cp1":[100.0,100.0],"cp2":[100.0,100.0]},
                {"x":400.0,"y":100.0,"cp1":[400.0,100.0],"cp2":[400.0,100.0]},
                {"x":400.0,"y":400.0,"cp1":[400.0,400.0],"cp2":[400.0,400.0]}
            ]}]"#,
        );
        flag_scene_lp(&mut engine);
        let face = engine.query_face_at(300.0, 200.0);
        assert!(face >= 0, "expected a face inside the triangle");
        engine.set_face_fill(face as u32, 1.0, 0.0, 0.0, 1.0);

        engine.move_node(path_id, 300.0, 300.0);
        // get_filled_faces rebuilds the dirty network and remaps fills.
        let filled = engine.get_filled_faces();
        assert!(filled.contains("\"r\":1.0"),
            "fill must follow the region across a large move, got {}", filled);
        // And the filled region is now at the moved location, not the old one.
        assert!(engine.query_face_at(600.0, 500.0) >= 0, "moved region should exist");
    }

    /// A square cut by an L, drawn as separate OPEN strokes — the shape traced
    /// line art has. No closed source shape means no containment signature, so
    /// a fill is re-attached by its stored point alone. The L is concave and
    /// its centroid lands inside the region it wraps around.
    fn concave_l_fixture(engine: &mut Engine) -> u32 {
        let seg = |x0: i32, y0: i32, x1: i32, y1: i32| format!(
            r#"[{{"closed":false,"points":[
                {{"x":{x0}.0,"y":{y0}.0,"cp1":[{x0}.0,{y0}.0],"cp2":[{x0}.0,{y0}.0]}},
                {{"x":{x1}.0,"y":{y1}.0,"cp1":[{x1}.0,{y1}.0],"cp2":[{x1}.0,{y1}.0]}}
            ]}}]"#,
        );
        let first = engine.add_path(&seg(100, 100, 400, 100));
        engine.add_path(&seg(400, 100, 400, 400));
        engine.add_path(&seg(400, 400, 100, 400));
        engine.add_path(&seg(100, 400, 100, 100));
        engine.add_path(&seg(400, 200, 200, 200));
        engine.add_path(&seg(200, 200, 200, 400));
        flag_scene_lp(engine);
        first
    }

    #[test]
    fn test_concave_face_keeps_its_fill_across_a_rebuild() {
        // The stored point was the polygon CENTROID, which for a concave region
        // need not lie in the region at all — here it lands squarely inside the
        // region the L wraps around. The containment tier then handed the L's
        // colour to its neighbour, and the L came back bare.
        let mut engine = Engine::new();
        let first = concave_l_fixture(&mut engine);

        let l_face = engine.query_face_at(150.0, 150.0); // the concave L
        let notch = engine.query_face_at(300.0, 300.0);  // the square it wraps
        assert!(l_face >= 0 && notch >= 0, "expected both regions");
        assert_ne!(l_face, notch, "the cut must divide the square");

        // Paint ONLY the L, so nothing competes for a face and the outcome
        // cannot depend on which order the fills happen to be replaced in.
        engine.set_face_fill(l_face as u32, 1.0, 0.0, 0.0, 1.0);

        // A rebuild that changes no geometry whatsoever, as a style edit does.
        engine.move_node(first, 0.0, 0.0);
        let _ = engine.get_filled_faces();

        let l2 = engine.query_face_at(150.0, 150.0);
        let n2 = engine.query_face_at(300.0, 300.0);
        assert!(l2 >= 0 && n2 >= 0, "regions must still exist after the rebuild");
        assert!(
            engine.get_face_paint(l2 as u32).contains("\"r\":1.0"),
            "the L must keep its own fill, got {:?}", engine.get_face_paint(l2 as u32),
        );
        assert!(
            engine.get_face_paint(n2 as u32).is_empty(),
            "the fill must not jump to the region the L wraps, got {:?}",
            engine.get_face_paint(n2 as u32),
        );
    }

    #[test]
    fn test_overlapping_circle_fills_follow_separation() {
        // The hard case: two overlapping circles make three faces, all bounded by
        // BOTH arcs — so a "bounding paths" signature can't tell them apart. The
        // containment signature (which circle contains the face) can: left={a},
        // middle={a,b}, right={b}. Moving the circles apart must keep the left
        // fill on circle a and the right fill on circle b; the middle drops.
        let mut engine = Engine::new();
        let a = engine.add_ellipse(300.0, 300.0, 120.0, 120.0);
        let b = engine.add_ellipse(420.0, 300.0, 120.0, 120.0);
        let _ = a;
        flag_scene_lp(&mut engine);
        let left = engine.query_face_at(240.0, 300.0);
        let mid = engine.query_face_at(360.0, 300.0);
        let right = engine.query_face_at(480.0, 300.0);
        assert!(left >= 0 && mid >= 0 && right >= 0, "expected three faces");
        assert!(left != mid && mid != right && left != right, "faces must be distinct");
        engine.set_face_fill(left as u32, 1.0, 0.0, 0.0, 1.0);   // red → circle a
        engine.set_face_fill(mid as u32, 0.0, 1.0, 0.0, 1.0);    // green → overlap
        engine.set_face_fill(right as u32, 0.0, 0.0, 1.0, 1.0);  // blue → circle b

        // Separate the circles (b moves right by 200 → no overlap).
        engine.move_node(b, 200.0, 0.0);
        let filled = engine.get_filled_faces();

        assert!(filled.contains("\"r\":1.0"), "red must follow circle a, got {}", filled);
        assert!(filled.contains("\"b\":1.0"), "blue must follow circle b, got {}", filled);
        assert!(!filled.contains("\"g\":1.0"), "green (vanished overlap) must drop, got {}", filled);
    }

    #[test]
    fn test_deleted_shape_fill_does_not_bleed() {
        // Fill a triangle, delete it, then add an unrelated shape nearby. The old
        // fill must NOT re-attach to the new shape's region (its defining shape is
        // gone), even if their centroids are within the fallback threshold.
        let mut engine = Engine::new();
        let tri = engine.add_path(
            r#"[{"closed":true,"points":[
                {"x":100.0,"y":100.0,"cp1":[100.0,100.0],"cp2":[100.0,100.0]},
                {"x":300.0,"y":100.0,"cp1":[300.0,100.0],"cp2":[300.0,100.0]},
                {"x":200.0,"y":300.0,"cp1":[200.0,300.0],"cp2":[200.0,300.0]}
            ]}]"#,
        );
        let g = flag_scene_lp(&mut engine);
        let f = engine.query_face_at(200.0, 160.0);
        assert!(f >= 0);
        engine.set_face_fill(f as u32, 1.0, 0.0, 0.0, 1.0);
        assert!(engine.get_filled_faces().contains("\"r\":1.0"));

        engine.remove_node(tri);
        // A rectangle whose centroid sits near the deleted triangle's fill,
        // added into the same Live Paint group so it forms a real region.
        let rect = engine.add_rect(170.0, 140.0, 60.0, 60.0);
        engine.set_parent(rect, Some(g));
        let filled = engine.get_filled_faces();
        assert!(!filled.contains("\"r\":1.0"),
            "a deleted shape's fill must not bleed onto an unrelated region, got {}", filled);
    }

    #[test]
    fn test_edge_paint_follows_source_move() {
        // Paint the outline of a lone triangle (one logical edge, since there are
        // no crossings), then move the triangle. The edge paint is anchored in the
        // path's local space, so it must survive the move and re-attach.
        let mut engine = Engine::new();
        let tri = engine.add_path(
            r#"[{"closed":true,"points":[
                {"x":100.0,"y":100.0,"cp1":[100.0,100.0],"cp2":[100.0,100.0]},
                {"x":300.0,"y":100.0,"cp1":[300.0,100.0],"cp2":[300.0,100.0]},
                {"x":200.0,"y":260.0,"cp1":[200.0,260.0],"cp2":[200.0,260.0]}
            ]}]"#,
        );
        flag_scene_lp(&mut engine);
        // Hit the top edge of the triangle.
        let edge = engine.query_edge_at(200.0, 100.0, 8.0);
        assert!(edge >= 0, "expected a paintable edge on the triangle outline");
        engine.set_edge_paint(edge as u32, 1.0, 0.0, 0.0, 1.0, 3.0);
        assert!(engine.get_painted_edges().contains("\"r\":1.0"), "edge paint should render");

        // Move the whole triangle; the paint must follow.
        engine.move_node(tri, 400.0, 250.0);
        let painted = engine.get_painted_edges();
        assert!(painted.contains("\"r\":1.0"), "edge paint must survive the move, got {}", painted);
    }

    #[test]
    fn test_gap_closing_makes_open_region_fillable() {
        // An open square outline with a ~10px gap between its endpoints is not a
        // closed region — no face — until gap closing bridges the opening.
        let mut engine = Engine::new();
        engine.add_path(
            r#"[{"closed":false,"points":[
                {"x":100.0,"y":100.0,"cp1":[100.0,100.0],"cp2":[100.0,100.0]},
                {"x":300.0,"y":100.0,"cp1":[300.0,100.0],"cp2":[300.0,100.0]},
                {"x":300.0,"y":300.0,"cp1":[300.0,300.0],"cp2":[300.0,300.0]},
                {"x":100.0,"y":300.0,"cp1":[100.0,300.0],"cp2":[100.0,300.0]},
                {"x":100.0,"y":110.0,"cp1":[100.0,110.0],"cp2":[100.0,110.0]}
            ]}]"#,
        );
        flag_scene_lp(&mut engine);
        assert_eq!(engine.query_face_at(200.0, 200.0), -1,
            "open region must not be fillable without gap closing");

        engine.set_gap_bridge_distance(20.0);
        assert!(engine.query_face_at(200.0, 200.0) >= 0,
            "gap closing must bridge the 10px opening and make the region fillable");
    }

    /// The open square from the test above, with a `gap`-sized opening.

    #[test]
    fn test_a_wide_gap_tolerance_never_bridges_across_geometry() {
        // A gap bridge is a synthetic edge in a PLANAR graph, so it must not
        // cross anything — including another bridge. At the small tolerances
        // this feature launched with, greedy nearest-first picking made that
        // true by accident. It stops being true once the tolerance is wide
        // enough to reach past a neighbouring contour, and the faces carved
        // from a non-planar graph match nothing on screen.
        //
        // Random open polylines at a 150-unit tolerance: 400 scenes produced
        // ~150 crossings before the check went in.
        let mut crossings = 0;
        for seed in 0u64..400 {
            let mut s = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let mut rnd = || {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((s >> 33) as f32 / (u32::MAX as f32 / 2.0)) * 300.0
            };
            let mut engine = Engine::new();
            for _ in 0..4 {
                let pts: Vec<String> = (0..3).map(|_| {
                    let (x, y) = (rnd(), rnd());
                    format!("{{\"x\":{x},\"y\":{y},\"cp1\":[{x},{y}],\"cp2\":[{x},{y}]}}")
                }).collect();
                engine.add_path(&format!("[{{\"closed\":false,\"points\":[{}]}}]", pts.join(",")));
            }
            let g = flag_scene_lp(&mut engine);
            engine.set_node_gap_bridge_distance(g, 150.0);
            engine.query_face_at(1.0e9, 1.0e9); // force the rebuild

            let vn = &engine.scene.vector_network;
            for e in vn.edges.values().filter(|e| e.synthetic && e.id < e.twin) {
                let a = vn.vertices[&e.from_vertex].position;
                let b = vn.vertices[&e.to_vertex].position;
                for o in vn.edges.values().filter(|o| o.id < o.twin && o.id != e.id) {
                    // Sharing a vertex is touching, not crossing.
                    if [o.from_vertex, o.to_vertex].iter()
                        .any(|v| *v == e.from_vertex || *v == e.to_vertex) { continue; }
                    let p = vn.vertices[&o.from_vertex].position;
                    let q = vn.vertices[&o.to_vertex].position;
                    if vector_network::segment_intersection(a, b, p, q).is_some() {
                        crossings += 1;
                        eprintln!("seed {seed}: bridge {a:?}->{b:?} crosses {p:?}->{q:?}");
                    }
                }
            }
        }
        assert_eq!(crossings, 0, "gap bridges crossed existing geometry");
    }


    fn open_square(engine: &mut Engine, gap: f32) {
        engine.add_path(&format!(
            r#"[{{"closed":false,"points":[
                {{"x":100.0,"y":100.0,"cp1":[100.0,100.0],"cp2":[100.0,100.0]}},
                {{"x":300.0,"y":100.0,"cp1":[300.0,100.0],"cp2":[300.0,100.0]}},
                {{"x":300.0,"y":300.0,"cp1":[300.0,300.0],"cp2":[300.0,300.0]}},
                {{"x":100.0,"y":300.0,"cp1":[100.0,300.0],"cp2":[100.0,300.0]}},
                {{"x":100.0,"y":{gap},"cp1":[100.0,{gap}],"cp2":[100.0,{gap}]}}
            ]}}]"#,
            gap = 100.0 + gap,
        ));
    }

    #[test]
    fn test_gap_distance_is_per_group() {
        // Two identical open squares, each in its own Live Paint group. Widening
        // the tolerance on one must not make the other's gap close: the setting
        // belongs to the group, not the document.
        let mut engine = Engine::new();
        open_square(&mut engine, 40.0);
        let wide = flag_scene_lp(&mut engine);

        let before = engine.scene.root_nodes.clone();
        open_square(&mut engine, 40.0);
        let fresh: Vec<u32> = engine.scene.root_nodes.iter()
            .filter(|id| !before.contains(id)).copied().collect();
        engine.move_node(fresh[0], 500.0, 0.0);
        let narrow = engine.group_nodes(&format!("[{}]", fresh[0]));
        engine.set_node_live_paint(narrow, true);

        // Neither closes at the document default of 0.
        assert_eq!(engine.query_face_at(200.0, 200.0), -1);
        assert_eq!(engine.query_face_at(700.0, 200.0), -1);

        engine.set_node_gap_bridge_distance(wide, 60.0);
        assert!(engine.query_face_at(200.0, 200.0) >= 0,
            "the group with the wide tolerance must close its 40px gap");
        assert_eq!(engine.query_face_at(700.0, 200.0), -1,
            "the other group keeps the document default and stays open");

        // Clearing the override drops the group back to the default.
        engine.set_node_gap_bridge_distance(wide, -1.0);
        assert_eq!(engine.get_node_gap_bridge_distance(wide), -1.0);
        assert_eq!(engine.query_face_at(200.0, 200.0), -1);
    }

    #[test]
    fn test_per_group_gap_distance_survives_a_save_load_round_trip() {
        let mut engine = Engine::new();
        open_square(&mut engine, 40.0);
        let g = flag_scene_lp(&mut engine);
        engine.set_node_gap_bridge_distance(g, 60.0);

        let bytes = engine.serialize_proto();
        let mut reloaded = Engine::new();
        assert!(reloaded.deserialize_proto(&bytes), "document must reload");
        assert_eq!(reloaded.get_node_gap_bridge_distance(g), 60.0);
        assert!(reloaded.query_face_at(200.0, 200.0) >= 0,
            "the reloaded group must still close its gap");
    }


    // ─── Live Paint: systematic coverage ────────────────────────────────────
    // Deterministic geometry/group-model tests (the browser was only ever a
    // smoke check). Faces are counted directly off the planar network after a
    // query forces `ensure_network_clean`.

    /// Number of bounded (non-outer) faces in the current planar network.
    fn inner_faces(engine: &mut Engine) -> usize {
        engine.query_face_at(-1.0e9, -1.0e9); // force a clean rebuild
        engine.scene.vector_network.faces.values().filter(|f| !f.is_outer).count()
    }

    /// Wrap every current root node in one Live Paint–flagged group and make it
    /// the active group. Shapes only form a paint surface inside a flagged group,
    /// so tests that build a flat scene call this before painting/querying.
    fn flag_scene_lp(engine: &mut Engine) -> u32 {
        let roots = engine.scene.root_nodes.clone();
        let ids = format!("[{}]", roots.iter().map(|i| i.to_string())
            .collect::<Vec<_>>().join(","));
        let g = engine.group_nodes(&ids);
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);
        g
    }

    #[test]
    fn test_two_overlapping_rects_make_three_faces() {
        // The case the user hit: two overlapping axis-aligned rectangles must
        // split into exactly three fillable regions — A-only, overlap, B-only —
        // each a distinct face. (Guards the planar split at the crossing points.)
        let mut engine = Engine::new();
        engine.add_rect(0.0, 0.0, 100.0, 100.0);   // A: [0,100]²
        engine.add_rect(50.0, 50.0, 100.0, 100.0); // B: [50,150]²
        flag_scene_lp(&mut engine);

        let a_only = engine.query_face_at(25.0, 25.0);
        let overlap = engine.query_face_at(75.0, 75.0);
        let b_only = engine.query_face_at(125.0, 125.0);

        assert!(a_only >= 0 && overlap >= 0 && b_only >= 0,
            "each region must be fillable: {a_only},{overlap},{b_only}");
        assert!(a_only != overlap && overlap != b_only && a_only != b_only,
            "the three regions must be distinct faces");
        assert_eq!(inner_faces(&mut engine), 3, "exactly three bounded faces");
    }

    #[test]
    fn test_rect_region_paint_is_stored_and_returned() {
        // Painting a rectangle region stores the fill and get_filled_faces returns
        // it with the right color.
        let mut engine = Engine::new();
        engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.add_rect(50.0, 50.0, 100.0, 100.0);
        flag_scene_lp(&mut engine);
        let overlap = engine.query_face_at(75.0, 75.0);
        assert!(overlap >= 0);
        engine.set_face_fill(overlap as u32, 0.0, 1.0, 0.0, 1.0);
        let filled = engine.get_filled_faces();
        assert!(filled.contains("\"g\":1.0"), "painted region fill must be returned, got {filled}");
    }

    #[test]
    fn test_rect_fill_follows_move_via_signature() {
        // Paint A-only region, move rect A far; the fill must stay on A's region
        // (containment signature = {A}), not drift or vanish.
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.add_rect(50.0, 50.0, 100.0, 100.0);
        flag_scene_lp(&mut engine);
        let a_only = engine.query_face_at(25.0, 25.0);
        assert!(a_only >= 0);
        engine.set_face_fill(a_only as u32, 1.0, 0.0, 0.0, 1.0);
        engine.move_node(a, 400.0, 400.0); // separate the rects entirely
        let filled = engine.get_filled_faces();
        assert!(filled.contains("\"r\":1.0"), "A's fill must follow the moved rect, got {filled}");
    }

    #[test]
    fn test_duplicated_live_paint_group_carries_face_fills() {
        // Copy-paste (duplicate_node) of a Live Paint group must reproduce its
        // painted faces on the clone — not just the member strokes. Regression
        // for: pasted artwork showed only unpainted shapes.
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{},{}]", a, b));
        engine.set_node_live_paint(group, true);
        engine.set_live_paint_group(group);
        // Paint the A-only region red.
        let a_only = engine.query_face_at(25.0, 25.0);
        assert!(a_only >= 0);
        engine.set_face_fill(a_only as u32, 1.0, 0.0, 0.0, 1.0);

        let filled_before = engine.get_filled_faces();
        assert!(filled_before.matches("\"r\":1.0").count() >= 1);

        // Duplicate the whole group.
        let clone = engine.duplicate_node(group);
        assert_ne!(clone, group);

        // Both the original and the clone must now have a red-filled face.
        let filled_after = engine.get_filled_faces();
        assert!(
            filled_after.matches("\"r\":1.0").count() >= 2,
            "clone must carry the red fill onto its own face, got {filled_after}"
        );
    }

    #[test]
    fn test_live_paint_group_scopes_faces_to_members() {
        // Only shapes inside a Live Paint–flagged group form a paint surface;
        // shapes outside any flagged group are not paintable. A second flagged
        // group is an INDEPENDENT network, so both coexist.
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        let outside = engine.add_rect(500.0, 500.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{},{}]", a, b));
        engine.set_node_live_paint(group, true);

        assert!(engine.query_face_at(75.0, 75.0) >= 0, "in-group overlap must be paintable");
        assert_eq!(engine.query_face_at(550.0, 550.0), -1,
            "a shape outside any Live Paint group must not be paintable");
        assert_eq!(inner_faces(&mut engine), 3, "only the two grouped rects contribute (3 faces)");

        // Flagging the outside shape's group brings it in as its OWN network.
        let g2 = engine.group_nodes(&format!("[{}]", outside));
        engine.set_node_live_paint(g2, true);
        assert!(engine.query_face_at(550.0, 550.0) >= 0,
            "flagging its group makes the outside shape paintable");
        assert_eq!(inner_faces(&mut engine), 4, "3 from the pair + 1 lone rect");
    }

    #[test]
    fn test_unflagging_group_removes_its_faces() {
        // Un-flagging a Live Paint group removes it from the network — its faces
        // stop existing (the paint surface is gone).
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{}]", a));
        engine.set_node_live_paint(group, true);
        assert!(engine.query_face_at(25.0, 25.0) >= 0, "flagged group is paintable");
        engine.set_node_live_paint(group, false);
        assert_eq!(engine.query_face_at(25.0, 25.0), -1,
            "un-flagging the group removes its paint surface");
    }

    #[test]
    fn test_two_groups_paint_independently() {
        // Two separate Live Paint groups, each a lone rect. Painting a face in one
        // must not affect the other, and both fills render (distinct groups).
        let mut engine = Engine::new();
        let r1 = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let r2 = engine.add_rect(300.0, 0.0, 100.0, 100.0);
        let g1 = engine.group_nodes(&format!("[{}]", r1));
        let g2 = engine.group_nodes(&format!("[{}]", r2));
        engine.set_node_live_paint(g1, true);
        engine.set_node_live_paint(g2, true);

        let f1 = engine.query_face_at(50.0, 50.0);
        let f2 = engine.query_face_at(350.0, 50.0);
        assert!(f1 >= 0 && f2 >= 0 && f1 != f2, "each group has its own face: {f1},{f2}");
        engine.set_face_fill(f1 as u32, 1.0, 0.0, 0.0, 1.0);
        engine.set_face_fill(f2 as u32, 0.0, 0.0, 1.0, 1.0);
        let filled = engine.get_filled_faces();
        assert!(filled.contains("\"r\":1.0"), "group 1 fill present: {filled}");
        assert!(filled.contains("\"b\":1.0"), "group 2 fill present: {filled}");
        // Faces are tagged with their owning group.
        let vn = &engine.scene.vector_network;
        let groups: std::collections::HashSet<u32> =
            vn.faces.values().filter(|f| !f.is_outer).map(|f| f.group).collect();
        assert_eq!(groups.len(), 2, "faces are partitioned across the two groups");
        assert!(groups.contains(&g1) && groups.contains(&g2), "both group ids present");
    }

    #[test]
    fn test_live_paint_flag_and_group_survive_save_load() {
        // The Live Paint special-object flag + the active group id must persist
        // through the .vec (protobuf) format.
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{},{}]", a, b));
        engine.set_node_live_paint(group, true);
        engine.set_live_paint_group(group);
        assert!(engine.get_node_live_paint(group));
        assert_eq!(engine.get_live_paint_group(), group as i32);

        let bytes = engine.serialize_proto();
        let mut e2 = Engine::new();
        assert!(e2.deserialize_proto(&bytes), "must decode");
        assert!(e2.get_node_live_paint(group), "live_paint flag must survive save/load");
        assert_eq!(e2.get_live_paint_group(), group as i32,
            "active Live Paint group must survive save/load");
    }

    #[test]
    fn test_painted_edge_survives_save_load() {
        // A painted edge (stored by local-space identity) must round-trip through
        // the file format and re-attach after the network rebuilds.
        let mut engine = Engine::new();
        engine.add_rect(0.0, 0.0, 200.0, 200.0);
        flag_scene_lp(&mut engine);
        let edge = engine.query_edge_at(100.0, 0.0, 8.0); // on the top edge
        assert!(edge >= 0, "the rect outline is one paintable logical edge");
        engine.set_edge_paint(edge as u32, 1.0, 0.0, 0.0, 1.0, 4.0);
        assert!(engine.get_painted_edges().contains("\"r\":1.0"));

        let bytes = engine.serialize_proto();
        let mut e2 = Engine::new();
        assert!(e2.deserialize_proto(&bytes), "must decode");
        assert!(e2.get_painted_edges().contains("\"r\":1.0"),
            "edge paint must survive save/load, got {}", e2.get_painted_edges());
    }

    #[test]
    fn test_tjunction_line_splits_rectangle() {
        // A line whose endpoints land ON a rectangle's edges (T-junctions) must
        // split the rectangle into two fillable faces. This is the degenerate
        // case behind "some regions of aligned rectangles aren't clickable".
        let mut engine = Engine::new();
        engine.add_rect(0.0, 0.0, 200.0, 200.0);
        engine.add_path(
            r#"[{"closed":false,"points":[
                {"x":100.0,"y":0.0,"cp1":[100.0,0.0],"cp2":[100.0,0.0]},
                {"x":100.0,"y":200.0,"cp1":[100.0,200.0],"cp2":[100.0,200.0]}
            ]}]"#,
        );
        flag_scene_lp(&mut engine);
        let left = engine.query_face_at(50.0, 100.0);
        let right = engine.query_face_at(150.0, 100.0);
        assert!(left >= 0 && right >= 0, "both halves must be fillable: {left},{right}");
        assert!(left != right, "the dividing line must split the rect into two faces");
        assert_eq!(inner_faces(&mut engine), 2, "exactly two faces");
    }

    #[test]
    fn test_edge_aligned_rects_every_region_fillable() {
        // Three rectangles whose edges align (T-junctions everywhere). Every
        // strictly-interior point of the union must resolve to a face.
        let mut engine = Engine::new();
        let rects = [(150.0, 100.0, 200.0, 200.0),
                     (250.0, 150.0, 200.0, 200.0),
                     (200.0, 250.0, 200.0, 200.0)];
        for &(x, y, w, h) in &rects { engine.add_rect(x, y, w, h); }
        flag_scene_lp(&mut engine);
        // Avoid edge lines so we only probe true interiors.
        let edge_x = [150.0f32, 350.0, 250.0, 450.0, 200.0, 400.0];
        let edge_y = [100.0f32, 300.0, 150.0, 350.0, 250.0, 450.0];
        let mut checked = 0;
        let mut x = 157.0;
        while x < 450.0 {
            let mut y = 107.0;
            while y < 452.0 {
                let on_edge = edge_x.iter().any(|&e| (e - x).abs() < 1.0)
                    || edge_y.iter().any(|&e| (e - y).abs() < 1.0);
                let inside = rects.iter().any(|&(rx, ry, rw, rh)|
                    x > rx && x < rx + rw && y > ry && y < ry + rh);
                if inside && !on_edge {
                    assert!(engine.query_face_at(x, y) >= 0,
                        "interior point ({x},{y}) must be fillable");
                    checked += 1;
                }
                y += 11.0;
            }
            x += 11.0;
        }
        assert!(checked > 20, "sanity: probed a meaningful number of interior points");
    }

    #[test]
    fn test_stacked_rects_sharing_edge_are_both_paintable() {
        // The user's "T" layout: a wide rect on top and a narrow rect below that
        // share a horizontal edge line (the narrow rect's top corners are
        // T-junctions on the wide rect's bottom edge). Each rect is a closed
        // region, so both must be independently fillable as distinct faces.
        let mut engine = Engine::new();
        engine.add_rect(0.0, 0.0, 200.0, 100.0);    // top: [0,200]x[0,100]
        engine.add_rect(50.0, 100.0, 100.0, 200.0); // bottom: [50,150]x[100,300]
        flag_scene_lp(&mut engine);
        let top = engine.query_face_at(100.0, 50.0);
        let bottom = engine.query_face_at(100.0, 200.0);
        assert!(top >= 0, "the top rect must be fillable");
        assert!(bottom >= 0, "the bottom rect must be fillable");
        assert!(top != bottom, "top and bottom are distinct faces");
    }

    #[test]
    fn test_three_overlapping_rects_regions_are_distinct() {
        // Three mutually overlapping rects (like the reported screenshot): the
        // region centres must each resolve to a distinct, fillable face.
        let mut engine = Engine::new();
        engine.add_rect(150.0, 100.0, 240.0, 240.0);
        engine.add_rect(300.0, 150.0, 220.0, 170.0);
        engine.add_rect(220.0, 240.0, 200.0, 320.0);
        flag_scene_lp(&mut engine);
        let probes = [
            (200.0, 150.0), // rect 1 only
            (470.0, 200.0), // rect 2 only
            (250.0, 500.0), // rect 3 only
            (330.0, 250.0), // a multi-overlap cell
        ];
        let faces: Vec<i32> = probes.iter().map(|&(x, y)| engine.query_face_at(x, y)).collect();
        assert!(faces.iter().all(|&f| f >= 0), "every probed region is fillable: {faces:?}");
        let distinct: std::collections::HashSet<i32> = faces.iter().copied().collect();
        assert_eq!(distinct.len(), faces.len(), "each probed region is a distinct face: {faces:?}");
    }

    #[test]
    fn test_circle_face_outline_is_true_curve() {
        // A painted circle's face outline must be exact béziers (real handles),
        // not a polygon. Sampled points stay within 0.05px of the true r=100
        // circle (the old 32-gon deviated ~0.5px).
        use glam::Vec2;
        let mut engine = Engine::new();
        engine.add_ellipse(200.0, 200.0, 100.0, 100.0);
        flag_scene_lp(&mut engine);
        let f = engine.query_face_at(200.0, 200.0);
        assert!(f >= 0, "circle interior must be a face");
        let face = engine.scene.vector_network.faces.get(&(f as u32)).unwrap().clone();
        let outline = engine.scene.vector_network.face_outline(&face);
        assert!(outline.len() >= 3, "outline anchors: {}", outline.len());

        let curved = outline.iter().any(|p| (p.cp1 - Vec2::new(p.x, p.y)).length() > 1.0);
        assert!(curved, "outline must carry real bezier handles, not a polygon");

        let eval = |p: &[Vec2; 4], t: f32| {
            let mt = 1.0 - t;
            p[0] * (mt * mt * mt) + p[1] * (3.0 * mt * mt * t)
                + p[2] * (3.0 * mt * t * t) + p[3] * (t * t * t)
        };
        let n = outline.len();
        let mut maxdev = 0.0f32;
        for i in 0..n {
            let a = &outline[i];
            let b = &outline[(i + 1) % n];
            let cp = [Vec2::new(a.x, a.y), a.cp2, b.cp1, Vec2::new(b.x, b.y)];
            for k in 0..=12 {
                let t = k as f32 / 12.0;
                let dev = ((eval(&cp, t) - Vec2::new(200.0, 200.0)).length() - 100.0).abs();
                maxdev = maxdev.max(dev);
            }
        }
        assert!(maxdev < 0.05, "circle outline deviates {maxdev}px (want <0.05)");
    }

    #[test]
    #[ignore] // perf smoke — run with: cargo test --release -- --ignored perf_
    fn perf_100_overlapping_shapes_rebuild() {
        use std::time::Instant;
        let mut engine = Engine::new();
        for i in 0..100 {
            let x = (i % 10) as f32 * 35.0 + 60.0;
            let y = (i / 10) as f32 * 35.0 + 60.0;
            engine.add_ellipse(x, y, 45.0, 45.0); // heavy overlap
        }
        let t = Instant::now();
        let _ = engine.query_face_at(100.0, 100.0); // forces a full rebuild
        let ms = t.elapsed().as_millis();
        assert!(ms < 300, "100-shape rebuild took {ms}ms (want < 300ms in release)");
    }

    #[test]
    fn test_painted_edge_stays_on_span_when_crossing_moves() {
        // Paint the LEFT span of a horizontal line (split by a vertical crossing),
        // then slide the crossing right. Structural identity (source seg + t) must
        // keep the paint on the left span rather than drifting to the right one.
        let mut engine = Engine::new();
        engine.add_path(
            r#"[{"closed":false,"points":[
                {"x":0.0,"y":100.0,"cp1":[0.0,100.0],"cp2":[0.0,100.0]},
                {"x":400.0,"y":100.0,"cp1":[400.0,100.0],"cp2":[400.0,100.0]}
            ]}]"#,
        );
        let v = engine.add_path(
            r#"[{"closed":false,"points":[
                {"x":100.0,"y":0.0,"cp1":[100.0,0.0],"cp2":[100.0,0.0]},
                {"x":100.0,"y":200.0,"cp1":[100.0,200.0],"cp2":[100.0,200.0]}
            ]}]"#,
        );
        flag_scene_lp(&mut engine);
        let edge = engine.query_edge_at(50.0, 100.0, 8.0); // left span
        assert!(edge >= 0, "left span must be a paintable edge");
        engine.set_edge_paint(edge as u32, 1.0, 0.0, 0.0, 1.0, 3.0);

        engine.move_node(v, 150.0, 0.0); // crossing 100 → 250
        let painted: serde_json::Value = serde_json::from_str(&engine.get_painted_edges()).unwrap();
        let arr = painted.as_array().unwrap();
        assert_eq!(arr.len(), 1, "exactly one painted edge survives, got {}", arr.len());
        // Its polyline must lie on the LEFT span (all x < the new crossing at 250).
        let pl = arr[0]["polyline"].as_array().unwrap();
        let max_x = pl.iter().map(|p| p[0].as_f64().unwrap()).fold(f64::MIN, f64::max);
        assert!(max_x <= 251.0, "paint must stay on the left span (max x {max_x} should be ≤ 250)");
    }

    #[test]
    fn test_scoped_invalidation_ignores_outside_edits() {
        // With a Live Paint group, edits OUTSIDE it must not invalidate the
        // network (perf), while edits inside it must.
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        let outside = engine.add_rect(500.0, 500.0, 100.0, 100.0);
        let group = engine.group_nodes(&format!("[{},{}]", a, b));
        engine.set_node_live_paint(group, true);
        engine.query_face_at(75.0, 75.0); // force a clean rebuild
        assert!(!engine.is_vector_network_dirty(), "clean after rebuild");

        engine.move_node(outside, 10.0, 10.0);
        assert!(!engine.is_vector_network_dirty(), "edit outside the group must not invalidate");

        engine.move_node(a, 5.0, 5.0);
        assert!(engine.is_vector_network_dirty(), "edit inside the group must invalidate");
    }

    #[test]
    fn test_two_ellipses_three_faces() {
        // Curved crossings (not just straight edges): two overlapping ellipses
        // must split into left/overlap/right, each a distinct face.
        let mut engine = Engine::new();
        engine.add_ellipse(260.0, 300.0, 110.0, 90.0);
        engine.add_ellipse(380.0, 300.0, 110.0, 90.0);
        flag_scene_lp(&mut engine);
        let l = engine.query_face_at(190.0, 300.0);
        let m = engine.query_face_at(320.0, 300.0);
        let r = engine.query_face_at(450.0, 300.0);
        assert!(l >= 0 && m >= 0 && r >= 0, "ellipse regions: {l},{m},{r}");
        assert!(l != m && m != r && l != r, "three distinct faces");
    }

    #[test]
    fn test_curved_line_divides_rect_into_two_curved_faces() {
        // A cubic whose ends land on a rect's top/bottom edges must split it into
        // two faces whose shared boundary is a real curve (handles, not a polygon).
        let mut engine = Engine::new();
        engine.add_rect(0.0, 0.0, 200.0, 200.0);
        engine.add_path(
            r#"[{"closed":false,"points":[
                {"x":100.0,"y":0.0,"cp1":[100.0,0.0],"cp2":[160.0,66.0]},
                {"x":100.0,"y":200.0,"cp1":[40.0,133.0],"cp2":[100.0,200.0]}
            ]}]"#,
        );
        flag_scene_lp(&mut engine);
        let left = engine.query_face_at(30.0, 100.0);
        let right = engine.query_face_at(180.0, 100.0);
        assert!(left >= 0 && right >= 0 && left != right, "curved divider must split: {left},{right}");
        let face = engine.scene.vector_network.faces.get(&(left as u32)).unwrap().clone();
        let outline = engine.scene.vector_network.face_outline(&face);
        let curved = outline.iter().any(|p| (p.cp1 - glam::Vec2::new(p.x, p.y)).length() > 1.0);
        assert!(curved, "the dividing boundary must reconstruct as a curve");
    }

    #[test]
    fn test_self_intersecting_bowtie_no_panic_and_faces() {
        // A self-crossing (bowtie) closed path must not panic and yields faces.
        let mut engine = Engine::new();
        engine.add_path(
            r#"[{"closed":true,"points":[
                {"x":0.0,"y":0.0,"cp1":[0.0,0.0],"cp2":[0.0,0.0]},
                {"x":100.0,"y":100.0,"cp1":[100.0,100.0],"cp2":[100.0,100.0]},
                {"x":100.0,"y":0.0,"cp1":[100.0,0.0],"cp2":[100.0,0.0]},
                {"x":0.0,"y":100.0,"cp1":[0.0,100.0],"cp2":[0.0,100.0]}
            ]}]"#,
        );
        flag_scene_lp(&mut engine);
        // The diagonals cross at (50,50), so the two lobes are LEFT and RIGHT.
        // Must not panic; both lobes should be fillable.
        let left = engine.query_face_at(15.0, 50.0);
        let right = engine.query_face_at(85.0, 50.0);
        assert!(left >= 0 && right >= 0, "bowtie lobes fillable: {left},{right}");
        assert!(left != right, "the two lobes are distinct faces");
    }

    #[test]
    fn test_random_scenes_no_dead_zones_or_panics() {
        // Deterministic fuzz: random rects/ellipses. Every shape's centre must
        // resolve to a face (no unfillable "dead zones"), and nothing panics.
        use rand::{Rng, SeedableRng, rngs::StdRng};
        for seed in 0..60u64 {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut engine = Engine::new();
            let mut centers: Vec<(f32, f32)> = Vec::new();
            let k = rng.gen_range(2..7);
            for _ in 0..k {
                let x = rng.gen_range(60.0..440.0);
                let y = rng.gen_range(60.0..440.0);
                let w = rng.gen_range(50.0..170.0);
                let h = rng.gen_range(50.0..170.0);
                if rng.gen_bool(0.5) {
                    engine.add_rect(x, y, w, h);
                    centers.push((x + w / 2.0, y + h / 2.0));
                } else {
                    engine.add_ellipse(x, y, w / 2.0, h / 2.0);
                    centers.push((x, y)); // ellipse origin is its centre
                }
            }
            flag_scene_lp(&mut engine);
            for (cx, cy) in &centers {
                assert!(engine.query_face_at(*cx, *cy) >= 0,
                    "seed {seed}: shape centre ({cx},{cy}) is a dead zone");
            }
            // Rebuild is deterministic.
            let s1 = engine.serialize_scene();
            let s2 = engine.serialize_scene();
            assert_eq!(s1, s2, "seed {seed}: non-deterministic serialization");
        }
    }

    #[test]
    fn test_expand_faces_inherit_topmost_source_fill() {
        // Two overlapping filled rects, nothing painted. Expand's face list must
        // divide into 3 colored faces: A-only=A's fill, B-only=B's fill, overlap
        // = the TOPMOST source's fill (B, added later). So 1 red + 2 blue.
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0); // drawn on top
        engine.set_node_style(a, r#"{"fills":[{"r":1.0,"g":0.0,"b":0.0,"a":1.0}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0,"effects":[]}"#);
        engine.set_node_style(b, r#"{"fills":[{"r":0.0,"g":0.0,"b":1.0,"a":1.0}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0,"effects":[]}"#);
        flag_scene_lp(&mut engine);

        let json = engine.get_live_paint_faces();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 3, "3 colored faces, got {json}");
        let red = arr.iter().filter(|f| f["fill"]["r"].as_f64() == Some(1.0)).count();
        let blue = arr.iter().filter(|f| f["fill"]["b"].as_f64() == Some(1.0)).count();
        assert_eq!(red, 1, "A-only inherits red");
        assert_eq!(blue, 2, "B-only + overlap inherit blue (topmost)");
    }

    #[test]
    fn test_expand_edges_inherit_unpainted_source_strokes() {
        // The bug: a Live Paint group of STROKED shapes with a couple of painted
        // faces expanded to the faces only — every drawn line vanished, because
        // Expand baked painted edges and nothing else. Expand's edge list must
        // carry each edge's effective stroke: the paint if any, else the source
        // shape's own stroke.
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        let stroked = |hex: (f32, f32, f32)| format!(
            r#"{{"fills":[],"strokes":[{{"paint":{{"r":{},"g":{},"b":{},"a":1.0}},"width":3.0,"cap":0,"join":0,"dash_array":[],"dash_offset":0.0,"miter_limit":4.0,"alignment":"Center"}}],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0,"effects":[]}}"#,
            hex.0, hex.1, hex.2);
        engine.set_node_style(a, &stroked((1.0, 0.0, 0.0)));
        engine.set_node_style(b, &stroked((1.0, 0.0, 0.0)));
        flag_scene_lp(&mut engine);

        let json = engine.get_live_paint_expand_edges();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let arr = v.as_array().unwrap();
        assert!(!arr.is_empty(), "unpainted stroked shapes must still bake edges");
        assert!(arr.iter().all(|e| e["color"]["r"].as_f64() == Some(1.0)),
            "edges inherit the source stroke color, got {json}");
        assert!(arr.iter().all(|e| e["width"].as_f64() == Some(3.0)),
            "edges inherit the source stroke width, got {json}");
        // A painted edge overrides the inherited stroke.
        let edge = engine.query_edge_at(75.0, 50.0, 8.0);
        assert!(edge >= 0, "the crossing span must be paintable");
        engine.set_edge_paint(edge as u32, 0.0, 0.0, 1.0, 1.0, 9.0);
        let v2: serde_json::Value =
            serde_json::from_str(&engine.get_live_paint_expand_edges()).unwrap();
        let painted: Vec<_> = v2.as_array().unwrap().iter()
            .filter(|e| e["color"]["b"].as_f64() == Some(1.0)).collect();
        assert_eq!(painted.len(), 1, "exactly the painted edge is blue");
        assert_eq!(painted[0]["width"].as_f64(), Some(9.0), "painted width wins");
    }

    #[test]
    fn test_expand_edges_skip_unstroked_sources() {
        // Fill-only shapes contribute faces, not lines: their edges must not
        // become hairline strokes on Expand.
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.set_node_style(a, r#"{"fills":[{"r":1.0,"g":0.0,"b":0.0,"a":1.0}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0,"effects":[]}"#);
        flag_scene_lp(&mut engine);
        assert_eq!(engine.get_live_paint_expand_edges(), "[]",
            "an unstroked source contributes no expanded edges");
    }

    #[test]
    fn test_clear_live_paint_marks_removes_fills_and_edges() {
        // Expand bakes marks into real shapes, then calls clear_live_paint_marks
        // so nothing double-renders. After it, no faces are filled and no edges
        // are painted.
        let mut engine = Engine::new();
        engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.add_rect(50.0, 50.0, 100.0, 100.0);
        flag_scene_lp(&mut engine);
        let f = engine.query_face_at(75.0, 75.0);
        engine.set_face_fill(f as u32, 1.0, 0.0, 0.0, 1.0);
        let edge = engine.query_edge_at(75.0, 50.0, 8.0);
        if edge >= 0 { engine.set_edge_paint(edge as u32, 0.0, 0.0, 1.0, 1.0, 3.0); }
        assert!(engine.get_filled_faces().len() > 2, "precondition: something painted");

        engine.clear_live_paint_marks();
        assert_eq!(engine.get_filled_faces(), "[]", "all face fills cleared");
        assert_eq!(engine.get_painted_edges(), "[]", "all edge paints cleared");
    }

    #[test]
    fn test_set_node_live_paint_only_affects_groups() {
        // The flag is meaningful only on groups — setting it on a plain shape is
        // a no-op (so the context bar never treats a rectangle as Live Paint).
        let mut engine = Engine::new();
        let r = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.set_node_live_paint(r, true);
        assert!(!engine.get_node_live_paint(r), "a non-group can't be a Live Paint group");
    }

    #[test]
    fn test_transform2d_skew_roundtrip() {
        // Headline regression: applying skew then setting it back to 0 must restore
        // the exact original matrix. The old matrix-decompose path leaked skew into
        // scale and permanently deformed the shape.
        let original = Transform2D {
            x: 40.0, y: 15.0,
            rotation_deg: 25.0,
            skew_x_deg: 0.0, skew_y_deg: 0.0,
            scale_x: 1.5, scale_y: 0.8,
        };
        let before = original.to_mat3().to_cols_array();

        // Component edits leave scale/rotation untouched.
        let mut t = original;
        t.skew_x_deg = 30.0;
        t.skew_x_deg = 0.0;
        let after = t.to_mat3().to_cols_array();

        for i in 0..9 {
            assert!((before[i] - after[i]).abs() < 1e-5,
                "skew round-trip must be exact at {}: {} vs {}", i, before[i], after[i]);
        }
    }

    #[test]
    fn test_transform2d_from_mat3_exact() {
        // from_mat3(m).to_mat3() must reproduce m for any T·R·K·S, including flips.
        let cases = [
            Transform2D { x: 10.0, y: 20.0, rotation_deg: 33.0, skew_x_deg: 12.0, skew_y_deg: 0.0, scale_x: 2.0, scale_y: 1.3 },
            Transform2D { x: -5.0, y: 8.0, rotation_deg: -70.0, skew_x_deg: 0.0, skew_y_deg: 0.0, scale_x: 1.0, scale_y: -1.0 }, // vertical flip
            Transform2D { x: 0.0, y: 0.0, rotation_deg: 100.0, skew_x_deg: -20.0, skew_y_deg: 0.0, scale_x: 0.5, scale_y: 3.0 },
        ];
        for t in cases {
            let m = t.to_mat3().to_cols_array();
            let round = Transform2D::from_mat3(&t.to_mat3()).to_mat3().to_cols_array();
            for i in 0..9 {
                assert!((m[i] - round[i]).abs() < 1e-4,
                    "from_mat3 not exact at {}: {} vs {}", i, m[i], round[i]);
            }
        }
    }

    #[test]
    fn test_pure_skew_y_decomposition_and_duplication() {
        // Pure skew_y (e.g. skew_y = 30°, rotation = 0°) must decompose with rotation = 0° and skew_y = 30°.
        let t_orig = Transform2D {
            x: 100.0,
            y: 100.0,
            rotation_deg: 0.0,
            skew_x_deg: 0.0,
            skew_y_deg: 30.0,
            scale_x: 1.0,
            scale_y: 1.0,
        };
        let m = t_orig.to_mat3();
        let decomp = Transform2D::from_mat3(&m);
        assert!((decomp.rotation_deg - 0.0).abs() < 1e-3, "rotation must remain 0: got {}", decomp.rotation_deg);
        assert!((decomp.skew_x_deg - 0.0).abs() < 1e-3, "skew_x must remain 0: got {}", decomp.skew_x_deg);
        assert!((decomp.skew_y_deg - 30.0).abs() < 1e-3, "skew_y must remain 30: got {}", decomp.skew_y_deg);
        assert!((decomp.scale_x - 1.0).abs() < 1e-3, "scale_x must remain 1: got {}", decomp.scale_x);
        assert!((decomp.scale_y - 1.0).abs() < 1e-3, "scale_y must remain 1: got {}", decomp.scale_y);

        // Duplication with hint must preserve exact components
        let decomp_hint = Transform2D::from_mat3_hint(&m, Some(&t_orig));
        assert!((decomp_hint.rotation_deg - 0.0).abs() < 1e-3);
        assert!((decomp_hint.skew_x_deg - 0.0).abs() < 1e-3);
        assert!((decomp_hint.skew_y_deg - 30.0).abs() < 1e-3);

        // Test duplication in Engine
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.set_node_skew(id, 0.0, 30.0);
        let dup_id = engine.duplicate_node(id);
        let dup_t = engine.scene.nodes.get(&dup_id).unwrap().transform;
        assert!((dup_t.rotation_deg - 0.0).abs() < 1e-3, "duplicated rotation must be 0: got {}", dup_t.rotation_deg);
        assert!((dup_t.skew_y_deg - 30.0).abs() < 1e-3, "duplicated skew_y must be 30: got {}", dup_t.skew_y_deg);
    }

    #[test]
    fn test_snapshot_roundtrip_transform_components() {
        // Undo snapshots must carry the decomposed transform components.
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.set_node_rotation(id, 30.0);
        engine.set_node_skew(id, 15.0, 0.0);

        let snapshot = engine.serialize_scene();
        engine.set_node_rotation(id, 0.0);
        engine.set_node_skew(id, 0.0, 0.0);
        assert!(engine.deserialize_scene(&snapshot), "snapshot must decode");

        let t = engine.scene.nodes.get(&id).unwrap().transform;
        assert!((t.rotation_deg - 30.0).abs() < 1e-3, "rotation restored: {}", t.rotation_deg);
        assert!((t.skew_x_deg - 15.0).abs() < 1e-3, "skew restored: {}", t.skew_x_deg);
    }

    #[test]
    fn test_snapshot_is_deterministic() {
        // Byte-exact determinism is what makes "exactly one undo step" provable
        // in gesture_history.test.ts. Two serializations of the same scene — and
        // a serialize→deserialize→serialize round-trip — must be byte-identical,
        // even with many nodes (HashMap iteration order is not stable) and a
        // live-painted face (fill centroid ordering).
        let mut engine = Engine::new();
        for i in 0..12 {
            engine.add_rect(i as f32 * 10.0, 0.0, 20.0, 20.0);
        }
        let tri = engine.add_path(
            r#"[{"closed":true,"points":[
                {"x":500.0,"y":500.0,"cp1":[500.0,500.0],"cp2":[500.0,500.0]},
                {"x":800.0,"y":500.0,"cp1":[800.0,500.0],"cp2":[800.0,500.0]},
                {"x":800.0,"y":800.0,"cp1":[800.0,800.0],"cp2":[800.0,800.0]}
            ]}]"#,
        );
        let _ = tri;
        flag_scene_lp(&mut engine);
        let face = engine.query_face_at(700.0, 600.0);
        assert!(face >= 0);
        engine.set_face_fill(face as u32, 0.2, 0.4, 0.6, 1.0);

        let a = engine.serialize_scene();
        let b = engine.serialize_scene();
        assert_eq!(a, b, "two serializations of the same scene must be byte-identical");

        assert!(engine.deserialize_scene(&a), "snapshot must decode");
        let c = engine.serialize_scene();
        assert_eq!(a, c, "serialize→deserialize→serialize must be a byte-exact fixed point");
    }

    #[test]
    fn test_render_buffer_carries_the_whole_dash_array() {
        // A stroke's dash pattern goes onto the wire in full. It used to be
        // truncated to an on/off pair, so an SVG imported with
        // stroke-dasharray="10 5 2 5" drew as "10 5" while still saving back as
        // all four — the canvas and the file disagreeing about the same stroke.
        let mut engine = Engine::new();
        let r = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        engine.set_node_style(
            r,
            r#"{"fills":[],"strokes":[{"paint":{"r":0.0,"g":0.0,"b":0.0,"a":1.0},
                "width":3.0,"cap":0,"join":0,"dash_array":[10.0,5.0,2.0,5.0],
                "dash_offset":3.0,"miter_limit":4.0,"alignment":"Center"}],
                "opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0,"effects":[]}"#,
        );
        engine.update_render_buffer(vec![r], vec![]);

        // [count = 4][10.0][5.0][2.0][5.0][dash_offset = 3.0]
        let mut expected = Vec::new();
        expected.extend_from_slice(&4u32.to_le_bytes());
        for v in [10.0f32, 5.0, 2.0, 5.0, 3.0] {
            expected.extend_from_slice(&v.to_le_bytes());
        }
        assert!(
            engine.render_buffer.windows(expected.len()).any(|w| w == expected),
            "render buffer does not contain the full dash array"
        );
    }

    #[test]
    fn test_render_buffer_header_and_framing() {
        // The render buffer must start with magic + version, and every command
        // record's declared length must match the bytes actually written. This
        // is the guard that turns writer/reader skew into a loud, located error.
        let mut engine = Engine::new();
        let r = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let e = engine.add_ellipse(200.0, 50.0, 40.0, 30.0);
        let t = engine.add_text(0.0, 300.0, "hello", 24.0);
        let p = engine.add_path(
            r#"[{"closed":true,"points":[
                {"x":10.0,"y":10.0,"cp1":[10.0,10.0],"cp2":[10.0,10.0]},
                {"x":90.0,"y":10.0,"cp1":[90.0,10.0],"cp2":[90.0,10.0]},
                {"x":90.0,"y":90.0,"cp1":[90.0,90.0],"cp2":[90.0,90.0]}
            ]}]"#,
        );
        let g = engine.group_nodes(&format!("[{},{}]", r, e));
        let visible = vec![r, e, t, p, g];
        engine.update_render_buffer(visible, vec![]);

        let buf = &engine.render_buffer;
        assert!(buf.len() >= 12, "buffer must have a header");
        let rd_u32 = |off: usize| -> u32 {
            u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
        };
        assert_eq!(rd_u32(0), RENDER_PROTOCOL_MAGIC, "magic");
        assert_eq!(rd_u32(4), RENDER_PROTOCOL_VERSION, "version");
        let count = rd_u32(8);
        assert!(count >= 5, "expected group+children+text+path commands, got {}", count);

        // Walk every record and verify its declared length matches its span.
        let mut off = 12usize;
        for i in 0..count {
            let record_len = rd_u32(off) as usize;
            let start = off + 4;
            let end = start + record_len;
            assert!(end <= buf.len(), "record {} overruns buffer", i);
            // First field of every record is the command type (1/2/3).
            let cmd = rd_u32(start);
            assert!(cmd == 1 || cmd == 2 || cmd == 3, "record {} bad cmd {}", i, cmd);
            off = end;
        }
        assert_eq!(off, buf.len(), "records must tile the whole buffer exactly");
    }

    #[test]
    fn test_live_paint_render_commands_and_fill_suppression() {
        // An active Live Paint group must emit CMD_LP_FACES(7) right after its
        // START_GROUP(1), the records must tile the buffer exactly (framing), and
        // its member DRAW_NODE records must carry ZERO fills (faces provide them).
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        engine.set_node_style(a, r#"{"fills":[{"r":1.0,"g":0.0,"b":0.0,"a":1.0}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0,"effects":[]}"#);
        engine.set_node_style(b, r#"{"fills":[{"r":0.0,"g":0.0,"b":1.0,"a":1.0}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0,"effects":[]}"#);
        let g = engine.group_nodes(&format!("[{},{}]", a, b));
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);
        engine.update_render_buffer(vec![a, b, g], vec![]);

        let buf = &engine.render_buffer;
        let rd = |off: usize| u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);
        assert_eq!(rd(4), RENDER_PROTOCOL_VERSION, "version");
        let count = rd(8);
        let mut cmds = Vec::new();
        let mut fill_counts = Vec::new();
        let mut off = 12usize;
        for _ in 0..count {
            let len = rd(off) as usize;
            let start = off + 4;
            let cmd = rd(start);
            cmds.push(cmd);
            if cmd == 2 {
                // DRAW_NODE: cmd, nodeId, nodeType, 9×f32 transform, then fillCount.
                fill_counts.push(rd(start + 4 + 4 + 4 + 36));
            }
            off += 4 + len;
        }
        assert_eq!(off, buf.len(), "records must tile the buffer exactly");
        assert_eq!(cmds[0], 1, "group opens first");
        assert_eq!(cmds[1], 7, "faces emitted at group bottom, got {cmds:?}");
        assert!(cmds.contains(&3), "group closes");
        assert!(!fill_counts.is_empty(), "members were drawn");
        assert!(fill_counts.iter().all(|&fc| fc == 0), "member fills suppressed, got {fill_counts:?}");
    }

    #[test]
    fn test_two_live_paint_groups_render_simultaneously() {
        // Two independent Live Paint groups must BOTH emit their own faces at
        // their own group's z — not just the "active" one. Sequence per group:
        // START_GROUP(1), CMD_LP_FACES(7), member DRAW(2), END_GROUP(3).
        let mut engine = Engine::new();
        let r1 = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let r2 = engine.add_rect(300.0, 0.0, 100.0, 100.0);
        let g1 = engine.group_nodes(&format!("[{}]", r1));
        let g2 = engine.group_nodes(&format!("[{}]", r2));
        engine.set_node_live_paint(g1, true);
        engine.set_node_live_paint(g2, true);
        // Paint one face in each so CMD_LP_FACES has content for both.
        let f1 = engine.query_face_at(50.0, 50.0);
        let f2 = engine.query_face_at(350.0, 50.0);
        engine.set_face_fill(f1 as u32, 1.0, 0.0, 0.0, 1.0);
        engine.set_face_fill(f2 as u32, 0.0, 0.0, 1.0, 1.0);

        engine.update_render_buffer(vec![r1, r2, g1, g2], vec![]);
        let buf = &engine.render_buffer;
        let rd = |off: usize| u32::from_le_bytes([buf[off], buf[off+1], buf[off+2], buf[off+3]]);
        let count = rd(8);
        let mut cmds = Vec::new();
        let mut off = 12usize;
        for _ in 0..count {
            let len = rd(off) as usize;
            cmds.push(rd(off + 4));
            off += 4 + len;
        }
        assert_eq!(off, buf.len(), "records must tile the buffer exactly");
        // Two groups → two face passes, one inside each group bracket.
        let face_passes = cmds.iter().filter(|&&c| c == 7).count();
        assert_eq!(face_passes, 2, "each flagged group emits its own faces, got {cmds:?}");
        let starts = cmds.iter().filter(|&&c| c == 1).count();
        assert_eq!(starts, 2, "both groups open, got {cmds:?}");
    }

    #[test]
    fn test_mask_command_emission() {
        // A masked group [mask, content] must emit the bracketing commands
        // BEGIN_MASK, (mask draw), BEGIN_MASKED_CONTENT, (content draw),
        // END_MASK — and the mask must not be drawn as a normal node outside
        // that bracket.
        let mut engine = Engine::new();
        let mask = engine.add_ellipse(300.0, 300.0, 100.0, 100.0);
        let content = engine.add_rect(200.0, 200.0, 200.0, 200.0);
        let g = engine.group_nodes(&format!("[{},{}]", mask, content));
        engine.set_node_is_mask(mask, true);

        engine.update_render_buffer(vec![mask, content, g], vec![]);
        let buf = &engine.render_buffer;
        let rd = |off: usize| u32::from_le_bytes([buf[off], buf[off+1], buf[off+2], buf[off+3]]);

        // Walk records, collecting the command sequence.
        let count = rd(8);
        let mut cmds = Vec::new();
        let mut off = 12usize;
        for _ in 0..count {
            let len = rd(off) as usize;
            cmds.push(rd(off + 4));
            off += 4 + len;
        }
        // Expected: START_GROUP(1), BEGIN_MASK(4), DRAW(2 mask), BEGIN_CONTENT(5),
        // DRAW(2 content), END_MASK(6), END_GROUP(3).
        assert_eq!(cmds, vec![1, 4, 2, 5, 2, 6, 3], "mask bracket sequence, got {:?}", cmds);

        // Turning the mask off collapses back to two plain draws.
        engine.set_node_is_mask(mask, false);
        engine.update_render_buffer(vec![mask, content, g], vec![]);
        let buf = &engine.render_buffer;
        let rd = |off: usize| u32::from_le_bytes([buf[off], buf[off+1], buf[off+2], buf[off+3]]);
        let count = rd(8);
        let mut cmds = Vec::new();
        let mut off = 12usize;
        for _ in 0..count {
            let len = rd(off) as usize;
            cmds.push(rd(off + 4));
            off += 4 + len;
        }
        assert_eq!(cmds, vec![1, 2, 2, 3], "no-mask sequence, got {:?}", cmds);
    }

    #[test]
    fn test_mask_is_group_scoped_root_flag_is_inert() {
        // Masks are group-scoped: an is_mask flag on a ROOT node must not
        // bracket anything (otherwise a single mask could clip the entire
        // document). The node renders as a plain shape; the UI auto-creates a
        // wrapping group when the user applies a mask.
        let mut engine = Engine::new();
        let mask = engine.add_ellipse(300.0, 300.0, 100.0, 100.0); // bottom root
        let content = engine.add_rect(200.0, 200.0, 200.0, 200.0);  // above it
        engine.set_node_is_mask(mask, true);

        engine.update_render_buffer(vec![mask, content], vec![]);
        let buf = &engine.render_buffer;
        let rd = |off: usize| u32::from_le_bytes([buf[off], buf[off+1], buf[off+2], buf[off+3]]);
        let count = rd(8);
        let mut cmds = Vec::new();
        let mut off = 12usize;
        for _ in 0..count {
            let len = rd(off) as usize;
            cmds.push(rd(off + 4));
            off += 4 + len;
        }
        assert_eq!(cmds, vec![2, 2], "root nodes draw plainly, no mask bracket; got {:?}", cmds);
    }

    #[test]
    fn test_mask_with_no_content_renders_normally() {
        // A mask that is the topmost (last) child has nothing to mask; it must
        // render as a normal node rather than vanish.
        let mut engine = Engine::new();
        let content = engine.add_rect(200.0, 200.0, 100.0, 100.0);
        let mask = engine.add_ellipse(250.0, 250.0, 60.0, 60.0);
        let g = engine.group_nodes(&format!("[{},{}]", content, mask)); // mask is LAST → on top
        engine.set_node_is_mask(mask, true);

        engine.update_render_buffer(vec![mask, content, g], vec![]);
        let buf = &engine.render_buffer;
        let rd = |off: usize| u32::from_le_bytes([buf[off], buf[off+1], buf[off+2], buf[off+3]]);
        let count = rd(8);
        let mut cmds = Vec::new();
        let mut off = 12usize;
        for _ in 0..count {
            let len = rd(off) as usize;
            cmds.push(rd(off + 4));
            off += 4 + len;
        }
        // No BEGIN_MASK(4) — both nodes draw plainly inside the group.
        assert!(!cmds.contains(&4), "mask with no content above must not bracket, got {:?}", cmds);
        assert_eq!(cmds, vec![1, 2, 2, 3], "got {:?}", cmds);
    }

    #[test]
    fn test_image_register_dedup_and_snapshot_roundtrip() {
        let mut engine = Engine::new();
        // Tiny fake PNG-ish bytes.
        let bytes = vec![0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4];
        let img1 = engine.register_image(&bytes, "image/png");
        let img2 = engine.register_image(&bytes, "image/png");
        assert_eq!(img1, img2, "identical bytes must dedup to the same id");
        let img3 = engine.register_image(&[9, 9, 9], "image/png");
        assert_ne!(img1, img3, "different bytes get a new id");

        let node = engine.add_image(10.0, 20.0, 200.0, 150.0, img1);
        assert_eq!(engine.get_node_type(node), Some(5), "image node type");
        let b = engine.get_node_bounds(node);
        assert!((b[0] - 10.0).abs() < 0.5 && (b[2] - 210.0).abs() < 0.5, "image bounds, got {:?}", b);

        // Snapshot round-trip preserves the image bytes and the node.
        let snap = engine.serialize_scene();
        engine.move_node(node, 100.0, 0.0);
        assert!(engine.deserialize_scene(&snap), "snapshot decodes");
        assert_eq!(engine.get_image_bytes(img1), bytes, "image bytes survive snapshot");
        assert_eq!(engine.get_image_mime(img1), "image/png");
        let b2 = engine.get_node_bounds(node);
        assert!((b2[0] - 10.0).abs() < 0.5, "node position restored, got {:?}", b2);
    }

    #[test]
    fn test_pattern_fill_json_and_snapshot_roundtrip() {
        let mut engine = Engine::new();
        let img = engine.register_image(&[1, 2, 3, 4], "image/png");
        let rect = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        // Set a pattern fill via the JSON style path (as the UI/import would).
        let style = format!(
            r#"{{"fills":[{{"image_id":{},"width":20.0,"height":20.0,"transform":[1,0,0,1,5,5]}}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0}}"#,
            img
        );
        engine.set_node_style(rect, &style);
        match &engine.scene.nodes.get(&rect).unwrap().style.fills[0] {
            Paint::Pattern(p) => {
                assert_eq!(p.image_id, img);
                assert_eq!(p.width, 20.0);
                assert_eq!(p.transform, [1.0, 0.0, 0.0, 1.0, 5.0, 5.0]);
            }
            other => panic!("expected pattern fill, got {:?}", other),
        }

        // Snapshot round-trip must preserve the pattern.
        let snap = engine.serialize_scene();
        engine.set_node_style(rect, r#"{"fills":[{"r":1,"g":0,"b":0,"a":1}],"strokes":[],"opacity":1.0,"blend_mode":0,"fill_rule":0,"corner_radius":0.0}"#);
        assert!(engine.deserialize_scene(&snap), "snapshot decodes");
        match &engine.scene.nodes.get(&rect).unwrap().style.fills[0] {
            Paint::Pattern(p) => { assert_eq!(p.image_id, img); assert_eq!(p.transform[4], 5.0); }
            other => panic!("pattern must survive snapshot, got {:?}", other),
        }
    }

    #[test]
    fn test_color_matrix_effect_json_and_snapshot() {
        let mut engine = Engine::new();
        let rect = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        // Grayscale-ish matrix via the JSON effects path (as UI/import would send).
        let json = r#"[{"ColorMatrix":{"matrix":[0.3,0.6,0.1,0,0, 0.3,0.6,0.1,0,0, 0.3,0.6,0.1,0,0, 0,0,0,1,0]}}]"#;
        engine.set_node_effects(rect, json);
        match &engine.scene.nodes.get(&rect).unwrap().style.effects[0] {
            Effect::ColorMatrix { matrix, .. } => {
                assert_eq!(matrix[0], 0.3);
                assert_eq!(matrix[18], 1.0);
            }
            other => panic!("expected ColorMatrix, got {:?}", other),
        }
        // Snapshot round-trip preserves the matrix.
        let snap = engine.serialize_scene();
        engine.set_node_effects(rect, "[]");
        assert!(engine.deserialize_scene(&snap), "snapshot decodes");
        match &engine.scene.nodes.get(&rect).unwrap().style.effects[0] {
            Effect::ColorMatrix { matrix, .. } => assert_eq!(matrix[1], 0.6),
            other => panic!("ColorMatrix must survive snapshot, got {:?}", other),
        }
    }

    #[test]
    fn test_snapshot_restores_selection() {
        // Undo snapshots preserve the selection (ProtoDocument alone drops it).
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let b = engine.add_rect(20.0, 0.0, 10.0, 10.0);
        engine.scene.selection = vec![a, b];

        let snapshot = engine.serialize_scene();
        engine.scene.selection.clear();
        assert!(engine.deserialize_scene(&snapshot), "snapshot must decode");
        assert_eq!(engine.scene.selection, vec![a, b], "selection must be restored");
    }

    #[test]
    fn test_path_bounds_hug_rounded_outline() {
        // Regression: the resize/selection box must hug the resolved (rounded)
        // outline the renderer draws, not the sharp corner vertices. A large
        // corner radius on the acute apex sits far inside the sharp triangle.
        let mut engine = Engine::new();
        let id = engine.add_path(r#"[{"points":[
            {"x":100,"y":0,"cp1":[100,0],"cp2":[100,0],"corner_radius":40},
            {"x":200,"y":200,"cp1":[200,200],"cp2":[200,200],"corner_radius":0},
            {"x":0,"y":200,"cp1":[0,200],"cp2":[0,200],"corner_radius":0}
        ],"closed":true}]"#);

        let rounded = engine.get_node_bounds(id);

        // Sharp bounds: flatten the raw stored subpaths under the same transform
        // (this is what the box used to hug — the sharp corner vertices).
        let node = engine.scene.nodes.get(&id).unwrap();
        let m = node.transform.to_mat3();
        let subpaths = match &node.geometry {
            Geometry::Path { subpaths, .. } => subpaths,
            _ => unreachable!(),
        };
        let (mut sminx, mut sminy, mut smaxx, mut smaxy) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for sp in subpaths {
            for lp in flatten_subpath(sp) {
                let p = m.transform_point2(lp);
                sminx = sminx.min(p.x); sminy = sminy.min(p.y);
                smaxx = smaxx.max(p.x); smaxy = smaxy.max(p.y);
            }
        }

        // The rounded box must sit strictly inside the sharp box, and the acute
        // apex (sharp top) must be cut back — the whole point of the fix.
        assert!(rounded[1] > sminy + 1.0,
            "rounded top {} must be cut back below sharp apex {}", rounded[1], sminy);
        assert!(rounded[0] >= sminx - 0.01 && rounded[2] <= smaxx + 0.01 && rounded[3] <= smaxy + 0.01,
            "rounded bounds {:?} must be within sharp bounds [{},{},{},{}]",
            rounded, sminx, sminy, smaxx, smaxy);
    }

    #[test]
    fn test_resize_path_hits_resolved_bounds() {
        // resize_node on a Path must make the *visible* (rounded) bounds equal
        // the requested size — the resize drag maps handle positions in rounded-
        // bounds units, so any other semantics makes the box drift during drag.
        let mut engine = Engine::new();
        let id = engine.add_path(r#"[{"points":[
            {"x":100,"y":0,"cp1":[100,0],"cp2":[100,0],"corner_radius":40},
            {"x":200,"y":200,"cp1":[200,200],"cp2":[200,200],"corner_radius":15},
            {"x":0,"y":200,"cp1":[0,200],"cp2":[0,200],"corner_radius":15}
        ],"closed":true}]"#);

        for (w, h) in [(300.0f32, 150.0f32), (80.0, 220.0), (500.0, 500.0)] {
            engine.resize_node(id, w, h);
            let b = engine.get_node_bounds(id);
            let got_w = b[2] - b[0];
            let got_h = b[3] - b[1];
            assert!((got_w - w).abs() < 0.25 && (got_h - h).abs() < 0.25,
                "requested {}x{}, visible bounds came out {}x{}", w, h, got_w, got_h);
        }
    }

    #[test]
    fn test_isometric_cube_alignment() {
        // Isometric cube recipe with the edge-length-preserving skew model:
        //   Left:  skewY = +30°
        //   Right: skewY = -30°
        //   Top:   skewY = +30°, rotation = -60°
        //
        // With sin/cos skew, all edges have length 1.0 (times scale) and
        // the faces tile perfectly without any scaleY correction.
        let mut engine = Engine::new();

        let left_id  = engine.add_rect(300.0, 300.0, 200.0, 200.0);
        let right_id = engine.add_rect(300.0, 300.0, 200.0, 200.0);
        let top_id   = engine.add_rect(300.0, 300.0, 200.0, 200.0);

        engine.set_node_skew(left_id, 0.0, 30.0);
        engine.set_node_skew(right_id, 0.0, -30.0);
        // Top face: skewY=+30 then rotation=-60
        engine.set_node_skew(top_id, 0.0, 30.0);
        engine.set_node_rotation(top_id, -60.0);

        // Check that skew values are preserved
        let lt = engine.scene.nodes.get(&left_id).unwrap().transform;
        let rt = engine.scene.nodes.get(&right_id).unwrap().transform;
        let tt = engine.scene.nodes.get(&top_id).unwrap().transform;
        assert!((lt.skew_y_deg - 30.0).abs() < 1e-3);
        assert!((rt.skew_y_deg - (-30.0)).abs() < 1e-3);
        assert!((tt.skew_y_deg - 30.0).abs() < 1e-3);
        assert!((tt.rotation_deg - (-60.0)).abs() < 1e-3);

        // Check edge lengths: all four column vectors should have unit length
        let lm = lt.to_mat3();
        let rm = rt.to_mat3();
        let tm = tt.to_mat3();

        let len = |x: f32, y: f32| (x * x + y * y).sqrt();
        let l_col0_len = len(lm.x_axis.x, lm.x_axis.y);
        let l_col1_len = len(lm.y_axis.x, lm.y_axis.y);
        let r_col0_len = len(rm.x_axis.x, rm.x_axis.y);
        let t_col0_len = len(tm.x_axis.x, tm.x_axis.y);
        let t_col1_len = len(tm.y_axis.x, tm.y_axis.y);

        // All edge lengths must be 1.0 (edge-length-preserving property)
        assert!((l_col0_len - 1.0).abs() < 1e-3, "left col0 len {l_col0_len}");
        assert!((l_col1_len - 1.0).abs() < 1e-3, "left col1 len {l_col1_len}");
        assert!((r_col0_len - 1.0).abs() < 1e-3, "right col0 len {r_col0_len}");
        assert!((t_col0_len - 1.0).abs() < 1e-3, "top col0 len {t_col0_len}");
        assert!((t_col1_len - 1.0).abs() < 1e-3, "top col1 len {t_col1_len}");

        // Check tiling: top col0 ∥ right col0, top col1 ∥ left col0
        let angle = |x: f32, y: f32| y.atan2(x).to_degrees();
        let l_angle = angle(lm.x_axis.x, lm.x_axis.y);
        let r_angle = angle(rm.x_axis.x, rm.x_axis.y);
        let t_col0_angle = angle(tm.x_axis.x, tm.x_axis.y);
        let t_col1_angle = angle(tm.y_axis.x, tm.y_axis.y);

        // Left col0 at +30°, Right col0 at -30°
        assert!((l_angle - 30.0).abs() < 0.1, "left angle {l_angle}");
        assert!((r_angle - (-30.0)).abs() < 0.1, "right angle {r_angle}");
        // Top col0 at -30° (matches right), top col1 at +30° (matches left)
        assert!((t_col0_angle - (-30.0)).abs() < 0.1, "top col0 angle {t_col0_angle}");
        assert!((t_col1_angle - 30.0).abs() < 0.1, "top col1 angle {t_col1_angle}");
    }

    // ─── Flatten preserves rounded corners ──────────────────────────────
    //
    // `corner_radius` is a scalar and can only describe a circular fillet in the
    // node's own space. Baking a transform into the anchors without accounting
    // for it re-resolves the rounding against the new geometry, so the flattened
    // shape stops matching what was on screen.

    /// The node's outline in WORLD space with rounding resolved — what the
    /// canvas actually draws. Flatten must leave this untouched.
    fn resolved_world_outline(engine: &Engine, id: u32) -> Vec<(f32, f32)> {
        let node = engine.scene.nodes.get(&id).unwrap();
        let subpaths = match &node.geometry {
            Geometry::Path { subpaths, .. } => subpaths.clone(),
            _ => panic!("expected a path node"),
        };
        let m = Mat3::from_cols_array(engine.global_transforms.get(&id).unwrap());
        let mut out = Vec::new();
        for sp in round_subpaths(&subpaths) {
            for p in &sp.points {
                for v in [Vec2::new(p.x, p.y), p.cp1, p.cp2] {
                    let w = m.transform_point2(v);
                    out.push((w.x, w.y));
                }
            }
        }
        out
    }

    fn assert_same_outline(before: &[(f32, f32)], after: &[(f32, f32)]) {
        assert_eq!(before.len(), after.len(), "outline point count changed");
        for (i, (b, a)) in before.iter().zip(after).enumerate() {
            assert!(
                (b.0 - a.0).abs() < 0.01 && (b.1 - a.1).abs() < 0.01,
                "point {i} moved: {b:?} -> {a:?}"
            );
        }
    }

    /// A rounded rect under a skew: the corner arcs become elliptical, which no
    /// scalar radius can express, so flatten must bake them into real cubics.
    #[test]
    fn flatten_preserves_a_skewed_rounded_rect() {
        let mut engine = Engine::new();
        let id = engine.add_rect(10.0, 20.0, 100.0, 60.0);
        engine.scene.nodes.get_mut(&id).unwrap().style.corner_radius = 15.0;
        engine.set_node_skew(id, 30.0, 0.0);
        engine.convert_to_path(id); // radii move onto the vertices

        let before = resolved_world_outline(&engine, id);
        assert!(engine.flatten_transform(id));
        assert_same_outline(&before, &resolved_world_outline(&engine, id));

        // The rounding is baked, not carried as a radius that would re-resolve.
        let node = engine.scene.nodes.get(&id).unwrap();
        if let Geometry::Path { subpaths, .. } = &node.geometry {
            assert!(subpaths.iter().all(|sp| sp.points.iter().all(|p| p.corner_radius == 0.0)));
        }
    }

    /// Non-uniform scale is the other circle-breaking case.
    #[test]
    fn flatten_preserves_a_non_uniformly_scaled_rounded_rect() {
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, 80.0, 80.0);
        engine.scene.nodes.get_mut(&id).unwrap().style.corner_radius = 20.0;
        engine.set_node_scale(id, 3.0, 1.0);
        engine.convert_to_path(id);

        let before = resolved_world_outline(&engine, id);
        assert!(engine.flatten_transform(id));
        assert_same_outline(&before, &resolved_world_outline(&engine, id));
    }

    /// A similarity keeps circles circular, so the radius stays editable — but
    /// it has to be scaled with the geometry.
    #[test]
    fn flatten_scales_the_radius_under_rotate_plus_uniform_scale() {
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, 100.0, 60.0);
        engine.scene.nodes.get_mut(&id).unwrap().style.corner_radius = 10.0;
        engine.set_node_scale(id, 2.0, 2.0);
        engine.set_node_rotation(id, 35.0);
        engine.convert_to_path(id);

        let before = resolved_world_outline(&engine, id);
        assert!(engine.flatten_transform(id));
        assert_same_outline(&before, &resolved_world_outline(&engine, id));

        // Still a parametric radius, doubled with the geometry.
        let node = engine.scene.nodes.get(&id).unwrap();
        if let Geometry::Path { subpaths, .. } = &node.geometry {
            assert_eq!(subpaths[0].points.len(), 4, "corners should not be expanded");
            for p in &subpaths[0].points {
                assert!((p.corner_radius - 20.0).abs() < 0.01, "radius {}", p.corner_radius);
            }
        }
    }

    // ─── Rounded-rect bounds ────────────────────────────────────────────
    //
    // A rect's corner arcs are tangent to its edges, so in LOCAL space rounding
    // never changes the box. Under a rotation or skew it does: the arcs cut away
    // the acute corner tips, which is exactly where the extremes had been.

    /// World AABB of a node, as the spatial index stores it.
    fn world_box(engine: &Engine, id: u32) -> [f32; 4] {
        let b = engine.get_node_bounds(id);
        [b[0], b[1], b[2], b[3]]
    }

    /// Set the radius through the public style API — the path the app actually
    /// takes. Going in through the field directly would skip the cache
    /// invalidation and hide a stale-bounds bug.
    fn set_radius(engine: &mut Engine, id: u32, r: f32) {
        let mut style = engine.scene.nodes.get(&id).unwrap().style.clone();
        style.corner_radius = r;
        engine.set_node_style(id, &serde_json::to_string(&style).unwrap());
    }

    #[test]
    fn rounded_rect_bounds_are_unchanged_when_axis_aligned() {
        // The arcs stay tangent to the edges, so the box must NOT shrink here —
        // guards against over-correcting and making plain rects measure small.
        let mut engine = Engine::new();
        let id = engine.add_rect(10.0, 20.0, 200.0, 120.0);
        let sharp = world_box(&engine, id);
        set_radius(&mut engine, id, 40.0);
        let rounded = world_box(&engine, id);
        for i in 0..4 {
            assert!((sharp[i] - rounded[i]).abs() < 0.01, "axis-aligned box moved: {sharp:?} -> {rounded:?}");
        }
    }

    #[test]
    fn skewed_rounded_rect_bounds_hug_the_rounded_outline() {
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, 240.0, 160.0);
        engine.set_node_skew(id, 30.0, 0.0);

        let sharp = world_box(&engine, id);
        set_radius(&mut engine, id, 30.0);
        let rounded = world_box(&engine, id);

        // The skew makes two corners acute; rounding cuts their tips off, so the
        // box must be strictly narrower and sit inside the sharp one.
        assert!(rounded[0] > sharp[0] + 1.0, "left edge not pulled in: {sharp:?} -> {rounded:?}");
        assert!(rounded[2] < sharp[2] - 1.0, "right edge not pulled in: {sharp:?} -> {rounded:?}");
        assert!(rounded[1] >= sharp[1] - 0.01 && rounded[3] <= sharp[3] + 0.01,
            "rounded box escaped the sharp box: {sharp:?} -> {rounded:?}");
    }

    #[test]
    fn rounded_rect_bounds_match_the_same_shape_converted_to_a_path() {
        // Path bounds already resolve rounding. A rect and its convert_to_path
        // twin are the same shape, so they must measure identically — this is
        // the invariant that was broken.
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, 240.0, 160.0);
        engine.set_node_skew(id, 25.0, 10.0);
        engine.set_node_rotation(id, 15.0);
        set_radius(&mut engine, id, 35.0);

        let as_rect = world_box(&engine, id);
        assert!(engine.convert_to_path(id)); // re-indexes on its own
        let as_path = world_box(&engine, id);

        for i in 0..4 {
            assert!((as_rect[i] - as_path[i]).abs() < 0.5,
                "rect vs path bounds disagree at {i}: {as_rect:?} vs {as_path:?}");
        }
    }

    // ─── Live Paint: what is painted is what is clickable ───────────────────

    /// Build `bg` (a big rect at the bottom) + a Live Paint group of two
    /// overlapping unfilled squares over it. Nothing in the group is painted yet.
    fn lp_over_background() -> (Engine, u32, u32, Vec<u32>) {
        let mut engine = Engine::new();
        let bg = engine.add_rect(0.0, 0.0, 400.0, 400.0);
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        for id in [a, b] {
            engine.scene.nodes.get_mut(&id).unwrap().style.fills.clear();
        }
        let g = engine.group_nodes(&format!("[{a},{b}]"));
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);
        (engine, bg, g, vec![a, b])
    }

    #[test]
    fn an_unpainted_live_paint_region_lets_the_click_through() {
        // The bug as reported: a Live Paint group's members paint no fill of
        // their own, so an unpainted region shows whatever is behind it — but
        // the pick still went to the member, and the shape you could see could
        // not be clicked.
        let (mut engine, bg, _g, _members) = lp_over_background();
        assert_eq!(engine.hit_test(25.0, 25.0), Some(bg), "unpainted region is see-through");
        assert_eq!(engine.hit_test(75.0, 75.0), Some(bg), "the overlap too");
    }

    #[test]
    fn painting_a_region_makes_it_clickable_again() {
        let (mut engine, bg, g, members) = lp_over_background();
        let face = engine.query_face_at(25.0, 25.0);
        assert!(face >= 0);
        engine.set_face_fill(face as u32, 1.0, 0.0, 0.0, 1.0);

        assert_eq!(engine.hit_test(25.0, 25.0), Some(members[0]),
            "the painted region picks the member that bounds it");
        assert_eq!(engine.hit_test(75.0, 75.0), Some(bg),
            "its unpainted neighbour still lets the click through");
        assert_eq!(engine.hit_test_grouped(25.0, 25.0), Some(g), "and selects the group");
    }

    #[test]
    fn a_region_painted_between_bare_lines_is_clickable() {
        // A face is the GROUP's, not a member's: two crossing lines enclose a
        // region that lies inside no shape at all. Picking only ever looked at
        // the members, so the colour you had just bucketed on selected whatever
        // was behind the group.
        let mut engine = Engine::new();
        let bg = engine.add_rect(0.0, 0.0, 400.0, 400.0);
        let h = engine.add_path(r#"[{"points":[{"x":0,"y":100,"cp1":[0,100],"cp2":[0,100],"corner_radius":0},{"x":200,"y":100,"cp1":[200,100],"cp2":[200,100],"corner_radius":0}],"closed":false}]"#);
        let v = engine.add_path(r#"[{"points":[{"x":100,"y":0,"cp1":[100,0],"cp2":[100,0],"corner_radius":0},{"x":100,"y":200,"cp1":[100,0],"cp2":[100,0],"corner_radius":0}],"closed":false}]"#);
        let ring = engine.add_path(r#"[{"points":[{"x":0,"y":0,"cp1":[0,0],"cp2":[0,0],"corner_radius":0},{"x":200,"y":0,"cp1":[200,0],"cp2":[200,0],"corner_radius":0},{"x":200,"y":200,"cp1":[200,200],"cp2":[200,200],"corner_radius":0},{"x":0,"y":200,"cp1":[0,200],"cp2":[0,200],"corner_radius":0}],"closed":true}]"#);
        for id in [h, v, ring] {
            engine.scene.nodes.get_mut(&id).unwrap().style.fills.clear();
        }
        let g = engine.group_nodes(&format!("[{h},{v},{ring}]"));
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);

        let quadrant = engine.query_face_at(50.0, 50.0);
        assert!(quadrant >= 0, "the lines enclose a paintable region");
        engine.set_face_fill(quadrant as u32, 0.0, 0.0, 1.0, 1.0);

        assert_eq!(engine.hit_test(50.0, 50.0), Some(g),
            "the paint belongs to the group, so the group is what it picks");
        assert_eq!(engine.hit_test(150.0, 50.0), Some(bg),
            "the quadrant nobody painted is still see-through");
    }

    #[test]
    fn a_live_paint_member_is_still_picked_on_its_outline() {
        // Fill suppression is not invisibility: the members' strokes are drawn
        // over the faces, and clicking one has to select it however little of
        // the group is painted.
        let (mut engine, _bg, _g, members) = lp_over_background();
        assert_eq!(engine.hit_test(0.0, 50.0), Some(members[0]), "left edge of A");
        assert_eq!(engine.hit_test(150.0, 100.0), Some(members[1]), "right edge of B");
    }

    #[test]
    fn a_face_painted_transparent_paints_nothing_and_picks_nothing() {
        let (mut engine, bg, _g, _members) = lp_over_background();
        let face = engine.query_face_at(25.0, 25.0);
        engine.set_face_fill(face as u32, 1.0, 0.0, 0.0, 0.0);
        assert_eq!(engine.hit_test(25.0, 25.0), Some(bg),
            "a fully transparent region is not paint");
    }

    #[test]
    fn a_filled_shape_in_a_live_paint_group_is_picked_where_it_shows() {
        // The ordinary case has to be unchanged: a filled member's region
        // inherits its colour, so every point inside it is painted, and picks it.
        let mut engine = Engine::new();
        let bg = engine.add_rect(0.0, 0.0, 400.0, 400.0);
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let g = engine.group_nodes(&format!("[{a}]"));
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);
        assert_eq!(engine.hit_test(50.0, 50.0), Some(a));
        assert_eq!(engine.hit_test(200.0, 200.0), Some(bg));
    }

    #[test]
    fn text_in_a_live_paint_group_keeps_its_fill() {
        // Text contributes no contours to the surface (collect_segments skips
        // it), so no face stands in for its fill. Suppressing it anyway left the
        // words invisible — and still clickable, with the group's selection box
        // stretched around nothing.
        let mut engine = Engine::new();
        let r = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let t = engine.add_text(200.0, 200.0, "hello", 24.0);
        let g = engine.group_nodes(&format!("[{r},{t}]"));
        engine.set_node_live_paint(g, true);
        engine.set_live_paint_group(g);
        engine.update_render_buffer(vec![r, t, g], vec![]);

        let buf = &engine.render_buffer;
        let rd = |off: usize| u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);
        let count = rd(8);
        let mut off = 12usize;
        let mut fills_by_node = std::collections::HashMap::new();
        for _ in 0..count {
            let len = rd(off) as usize;
            let start = off + 4;
            if rd(start) == CMD_DRAW_NODE {
                // DRAW_NODE: cmd, nodeId, nodeType, 9×f32 transform, then fillCount.
                fills_by_node.insert(rd(start + 4), rd(start + 4 + 4 + 4 + 36));
            }
            off += 4 + len;
        }
        assert_eq!(fills_by_node.get(&r), Some(&0), "the surface member's fill is the face's job");
        assert_eq!(fills_by_node.get(&t), Some(&1), "the text still paints itself");
    }
}
