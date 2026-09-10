//! Protobuf serialization for .vec file format.
//!
//! Uses prost derive macros — no protoc or build.rs needed.
//! Provides conversion between internal serde types and proto types.

use prost::Message;
use base64::{Engine as B64Engine, engine::general_purpose::STANDARD as BASE64};
use glam::Vec2;

use crate::{
    Color, Geometry, Gradient, GradientFocal, GradientStop, GradientType, Node, NodeType, Paint, PathPoint, Scene, Style,
    container::{self, ContainerError},
    validate::{self, RepairReport},
    vector_network::{VectorNetwork, NodeVectorNetwork, NetworkVertex, NetworkEdge, NetworkRegion},
};

/// Current file format version — the newest schema this build can *write*.
///
/// v1 is the launch format. Everything the editor can express today — paths and
/// vector networks, Live Paint, mesh gradients, multiple strokes, embedded
/// fonts, artboards — is part of it. Earlier numbers existed only during
/// development, were never released, and are not readable: there is no v0.
///
/// Bump this when the schema gains something, and see `required_reader_version`
/// for whether the new feature also raises the floor a *reader* must meet.
pub const FORMAT_VERSION: u32 = 1;

/// The floor for a document using nothing beyond the launch feature set.
///
/// Everything in v1 is readable by every build that will ever exist, so a plain
/// document should never lock itself to a newer editor.
const BASE_READER_VERSION: u32 = 1;

/// The oldest reader that can open `doc` **without silently losing anything**,
/// written into the container as `min_reader_version`.
///
/// This is what makes forward compatibility safe rather than merely detectable.
/// prost drops unknown fields, so an older reader *cannot* preserve what it does
/// not understand — the only way to protect the data is to decline to open the
/// file, which is what a floor above the reader's `FORMAT_VERSION` does.
///
/// Today every documented feature is v1, so the floor only rises for a construct
/// this build cannot name at all — a geometry or paint variant from a future
/// version. That case is the mechanism proving itself: such a file is refused
/// rather than opened with the unknown node degraded into a grey rectangle.
///
/// **When adding a feature**, raise the floor only if losing it would visibly
/// damage the artwork. A mesh gradient would qualify — dropping it changes a
/// shape's colour. The document title would not, and treating it as though it
/// did would lock every document to the newest build for no benefit. Add the
/// check here, and a case to `the_version_floor_tracks_the_features_actually_used`.
pub fn required_reader_version(doc: &ProtoDocument) -> u32 {
    let mut floor = BASE_READER_VERSION;
    let mut require = |v: u32| floor = floor.max(v);

    for node in &doc.nodes {
        if let Some(geo) = &node.geometry {
            // An unset oneof means a variant written by a newer build.
            if geo.kind.is_none() {
                require(FORMAT_VERSION + 1);
            }
        }
        let Some(style) = &node.style else { continue };
        for paint in style.fills.iter().chain(style.strokes.iter().filter_map(|s| s.paint.as_ref())) {
            if paint.kind.is_none() {
                require(FORMAT_VERSION + 1);
            }
        }
    }
    floor
}

// ─── Proto Message Types ────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Message)]
pub struct ProtoColor {
    #[prost(float, tag = "1")]
    pub r: f32,
    #[prost(float, tag = "2")]
    pub g: f32,
    #[prost(float, tag = "3")]
    pub b: f32,
    #[prost(float, tag = "4")]
    pub a: f32,
}

/// A paint. Exactly one variant is set.
///
/// This is a real `oneof`, which encodes on the wire byte-for-byte identically
/// to the four parallel `optional` fields it replaced (same tags, same order) —
/// so existing files read back unchanged — but makes "exactly one of these"
/// a property of the type instead of a convention the reader had to enforce by
/// checking the variants in the right order.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoPaint {
    #[prost(oneof = "proto_paint::Kind", tags = "1, 2, 3, 4")]
    pub kind: Option<proto_paint::Kind>,
}

pub mod proto_paint {
    use super::*;

    #[derive(Clone, PartialEq, ::prost::Oneof)]
    pub enum Kind {
        #[prost(message, tag = "1")]
        Solid(ProtoColor),
        #[prost(message, tag = "2")]
        Gradient(ProtoGradient),
        #[prost(message, tag = "3")]
        Pattern(ProtoPattern),
        /// Coons-patch mesh gradient.
        #[prost(message, tag = "4")]
        Mesh(ProtoMeshGradient),
    }
}

/// Constructors and accessors for the paint oneof. See `ProtoGeometry` above
/// for why these are `allow(dead_code)`.
#[allow(dead_code)]
impl ProtoPaint {
    pub fn solid(color: ProtoColor) -> Self {
        Self { kind: Some(proto_paint::Kind::Solid(color)) }
    }
    pub fn gradient(g: ProtoGradient) -> Self {
        Self { kind: Some(proto_paint::Kind::Gradient(g)) }
    }
    pub fn pattern(p: ProtoPattern) -> Self {
        Self { kind: Some(proto_paint::Kind::Pattern(p)) }
    }
    pub fn mesh(m: ProtoMeshGradient) -> Self {
        Self { kind: Some(proto_paint::Kind::Mesh(m)) }
    }
    /// The mesh gradient, if this paint is one.
    pub fn as_mesh(&self) -> Option<&ProtoMeshGradient> {
        match &self.kind {
            Some(proto_paint::Kind::Mesh(m)) => Some(m),
            _ => None,
        }
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoMeshVertex {
    #[prost(float, tag = "1")]
    pub x: f32,
    #[prost(float, tag = "2")]
    pub y: f32,
    #[prost(message, optional, tag = "3")]
    pub color: Option<ProtoColor>,
    /// Direction handles in absolute node-local coords: empty = auto (1/3
    /// toward the neighbor), else exactly [x, y].
    #[prost(float, repeated, tag = "4")]
    pub handle_e: Vec<f32>,
    #[prost(float, repeated, tag = "5")]
    pub handle_w: Vec<f32>,
    #[prost(float, repeated, tag = "6")]
    pub handle_s: Vec<f32>,
    #[prost(float, repeated, tag = "7")]
    pub handle_n: Vec<f32>,
}

/// Coons-patch mesh fill: rows×cols patches, (rows+1)*(cols+1) vertices
/// stored row-major.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoMeshGradient {
    #[prost(uint32, tag = "1")]
    pub rows: u32,
    #[prost(uint32, tag = "2")]
    pub cols: u32,
    #[prost(message, repeated, tag = "3")]
    pub vertices: Vec<ProtoMeshVertex>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoPattern {
    #[prost(uint32, tag = "1")]
    pub image_id: u32,
    #[prost(float, tag = "2")]
    pub width: f32,
    #[prost(float, tag = "3")]
    pub height: f32,
    /// Pattern→local affine, 6 floats [a,b,c,d,e,f].
    #[prost(float, repeated, tag = "4")]
    pub transform: Vec<f32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoStroke {
    #[prost(message, optional, tag = "1")]
    pub paint: Option<ProtoPaint>,
    #[prost(float, tag = "2")]
    pub width: f32,
    #[prost(uint32, tag = "3")]
    pub cap: u32,
    #[prost(uint32, tag = "4")]
    pub join: u32,
    #[prost(float, repeated, tag = "5")]
    pub dash_array: Vec<f32>,
    #[prost(float, tag = "6")]
    pub dash_offset: f32,
    #[prost(float, tag = "7")]
    pub miter_limit: f32,
    #[prost(uint32, tag = "8")]
    pub alignment: u32, // 0: Center, 1: Inner, 2: Outer
}



#[derive(Clone, PartialEq, Message)]
pub struct ProtoTransform {
    #[prost(float, tag = "1")]
    pub x: f32,
    #[prost(float, tag = "2")]
    pub y: f32,
    #[prost(float, tag = "3")]
    pub rotation_deg: f32,
    #[prost(float, tag = "4")]
    pub skew_x_deg: f32,
    #[prost(float, tag = "5")]
    pub skew_y_deg: f32,
    #[prost(float, tag = "6")]
    pub scale_x: f32,
    #[prost(float, tag = "7")]
    pub scale_y: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoEffect {
    /// 0 = blur, 1 = drop shadow.
    #[prost(uint32, tag = "1")]
    pub kind: u32,
    /// Blur sigma (kind 0) or shadow blur sigma (kind 1).
    #[prost(float, tag = "2")]
    pub radius: f32,
    #[prost(float, tag = "3")]
    pub dx: f32,
    #[prost(float, tag = "4")]
    pub dy: f32,
    #[prost(message, optional, tag = "5")]
    pub color: Option<ProtoColor>,
    /// 4×5 color matrix (kind 2 = ColorMatrix), row-major 20 floats.
    #[prost(float, repeated, tag = "6")]
    pub matrix: Vec<f32>,
    /// For ColorMatrix: true if the matrix should be applied in linearRGB space.
    #[prost(bool, tag = "7")]
    pub linear_rgb: bool,
    /// Blur (kind 0): y-axis sigma for anisotropic blur. 0 = isotropic (= radius).
    #[prost(float, tag = "8")]
    pub radius_y: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoStyle {
    #[prost(message, repeated, tag = "1")]
    pub fills: Vec<ProtoPaint>,
    #[prost(message, repeated, tag = "2")]
    pub strokes: Vec<ProtoStroke>,
    #[prost(float, optional, tag = "3")]
    pub opacity: Option<f32>,
    #[prost(float, tag = "4")]
    pub corner_radius: f32,
    #[prost(uint32, tag = "5")]
    pub blend_mode: u32,
    #[prost(uint32, tag = "6")]
    pub fill_rule: u32,
    #[prost(message, repeated, tag = "7")]
    pub effects: Vec<ProtoEffect>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoGradientStop {
    #[prost(float, tag = "1")]
    pub offset: f32,
    #[prost(message, optional, tag = "2")]
    pub color: Option<ProtoColor>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoGradient {
    #[prost(uint32, tag = "1")]
    pub gradient_type: u32,
    #[prost(message, repeated, tag = "2")]
    pub stops: Vec<ProtoGradientStop>,
    #[prost(float, tag = "3")]
    pub start_x: f32,
    #[prost(float, tag = "4")]
    pub start_y: f32,
    #[prost(float, tag = "5")]
    pub end_x: f32,
    #[prost(float, tag = "6")]
    pub end_y: f32,
    #[prost(uint32, tag = "7")]
    pub spread: u32,
    #[prost(bool, tag = "8")]
    pub has_focal: bool,
    #[prost(float, tag = "9")]
    pub focal_x: f32,
    #[prost(float, tag = "10")]
    pub focal_y: f32,
    #[prost(float, tag = "11")]
    pub focal_r: f32,
    /// True when `transform` carries a gradient→local affine (elliptical radial).
    #[prost(bool, tag = "12")]
    pub has_transform: bool,
    /// Gradient→local affine [a, b, c, d, e, f]; empty when `has_transform` false.
    #[prost(float, repeated, tag = "13")]
    pub transform: Vec<f32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoPathPoint {
    #[prost(float, tag = "1")]
    pub x: f32,
    #[prost(float, tag = "2")]
    pub y: f32,
    #[prost(float, tag = "3")]
    pub cp1_x: f32,
    #[prost(float, tag = "4")]
    pub cp1_y: f32,
    #[prost(float, tag = "5")]
    pub cp2_x: f32,
    #[prost(float, tag = "6")]
    pub cp2_y: f32,
    #[prost(float, tag = "7")]
    pub corner_radius: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoSubpath {
    #[prost(message, repeated, tag = "1")]
    pub points: Vec<ProtoPathPoint>,
    #[prost(bool, tag = "2")]
    pub closed: bool,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoRect {
    #[prost(float, tag = "1")]
    pub width: f32,
    #[prost(float, tag = "2")]
    pub height: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoEllipse {
    #[prost(float, tag = "1")]
    pub radius_x: f32,
    #[prost(float, tag = "2")]
    pub radius_y: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoPath {
    // Tag 1 is reserved: a pre-release build stored a flat point list there.
    // Never reuse it — a stray file from that era would decode as subpaths.
    /// The path's subpaths.
    #[prost(message, repeated, tag = "2")]
    pub subpaths: Vec<ProtoSubpath>,
    /// Per-node vector network, when the path has one.
    #[prost(message, optional, tag = "3")]
    pub network: Option<ProtoNodeNetwork>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNetworkVertex {
    #[prost(float, tag = "1")]
    pub x: f32,
    #[prost(float, tag = "2")]
    pub y: f32,
    #[prost(float, optional, tag = "3")]
    pub handle_in_x: Option<f32>,
    #[prost(float, optional, tag = "4")]
    pub handle_in_y: Option<f32>,
    #[prost(float, optional, tag = "5")]
    pub handle_out_x: Option<f32>,
    #[prost(float, optional, tag = "6")]
    pub handle_out_y: Option<f32>,
    #[prost(float, tag = "7")]
    pub corner_radius: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNetworkEdge {
    #[prost(uint32, tag = "1")]
    pub start_vertex: u32,
    #[prost(uint32, tag = "2")]
    pub end_vertex: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNetworkRegion {
    #[prost(uint32, repeated, tag = "1")]
    pub edge_loop: Vec<u32>,
    #[prost(message, optional, tag = "2")]
    pub fill: Option<ProtoColor>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNodeNetwork {
    #[prost(message, repeated, tag = "1")]
    pub vertices: Vec<ProtoNetworkVertex>,
    #[prost(message, repeated, tag = "2")]
    pub edges: Vec<ProtoNetworkEdge>,
    #[prost(message, repeated, tag = "3")]
    pub regions: Vec<ProtoNetworkRegion>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoText {
    #[prost(string, tag = "1")]
    pub content: String,
    #[prost(float, tag = "2")]
    pub font_size: f32,
    #[prost(string, tag = "3")]
    pub font_family: String,
    #[prost(uint32, tag = "4")]
    pub text_align: u32,
    #[prost(float, tag = "5")]
    pub line_height: f32,
    #[prost(uint32, tag = "6")]
    pub font_weight: u32,
    #[prost(bool, tag = "7")]
    pub italic: bool,
    #[prost(float, tag = "8")]
    pub letter_spacing: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoImage {
    #[prost(float, tag = "1")]
    pub width: f32,
    #[prost(float, tag = "2")]
    pub height: f32,
    #[prost(uint32, tag = "3")]
    pub image_id: u32,
    /// Sample with nearest-neighbour rather than smoothing when scaled — SVG's
    /// `image-rendering: optimizeSpeed | pixelated | crisp-edges`. Defaults to
    /// false, which is the smoothing every existing document already gets, so
    /// this is purely additive.
    #[prost(bool, tag = "4")]
    pub pixelated: bool,
}

/// A node's geometry. Exactly one variant is set.
///
/// Real `oneof`, wire-identical to the five parallel `optional` fields it
/// replaced. The important gain is at the *read* end: `kind: None` now means
/// unambiguously "a geometry written by a newer build", which
/// `required_reader_version` turns into a refusal to open. Previously that case
/// was indistinguishable from an absent field and fell through to a default
/// 100×100 rectangle — a future node type would open as a plausible-looking
/// grey box and then be saved that way.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoGeometry {
    #[prost(oneof = "proto_geometry::Kind", tags = "1, 2, 3, 4, 5")]
    pub kind: Option<proto_geometry::Kind>,
}

pub mod proto_geometry {
    use super::*;

    #[derive(Clone, PartialEq, ::prost::Oneof)]
    pub enum Kind {
        #[prost(message, tag = "1")]
        Rect(ProtoRect),
        #[prost(message, tag = "2")]
        Ellipse(ProtoEllipse),
        #[prost(message, tag = "3")]
        Path(ProtoPath),
        #[prost(message, tag = "4")]
        Text(ProtoText),
        #[prost(message, tag = "5")]
        Image(ProtoImage),
    }
}

/// Constructors and accessors for the geometry oneof.
///
/// `#[allow(dead_code)]` because the non-test build reaches geometry through
/// `geometry_to_proto`/`proto_to_geometry` and never names a variant directly;
/// these exist so tests and any future caller can build one without spelling
/// out the `Some(Kind::…)` wrapper.
#[allow(dead_code)]
impl ProtoGeometry {
    pub fn rect(width: f32, height: f32) -> Self {
        Self { kind: Some(proto_geometry::Kind::Rect(ProtoRect { width, height })) }
    }
    pub fn ellipse(radius_x: f32, radius_y: f32) -> Self {
        Self { kind: Some(proto_geometry::Kind::Ellipse(ProtoEllipse { radius_x, radius_y })) }
    }
    pub fn path(p: ProtoPath) -> Self {
        Self { kind: Some(proto_geometry::Kind::Path(p)) }
    }
    pub fn text(t: ProtoText) -> Self {
        Self { kind: Some(proto_geometry::Kind::Text(t)) }
    }
    pub fn image(i: ProtoImage) -> Self {
        Self { kind: Some(proto_geometry::Kind::Image(i)) }
    }
    /// The path geometry, if this node is one.
    pub fn as_path(&self) -> Option<&ProtoPath> {
        match &self.kind {
            Some(proto_geometry::Kind::Path(p)) => Some(p),
            _ => None,
        }
    }
}

/// Encoded raster image bytes stored at the document level.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoImageData {
    #[prost(uint32, tag = "1")]
    pub id: u32,
    #[prost(bytes = "vec", tag = "2")]
    pub bytes: Vec<u8>,
    #[prost(string, tag = "3")]
    pub mime: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNode {
    #[prost(uint32, tag = "1")]
    pub id: u32,
    #[prost(string, tag = "2")]
    pub name: String,
    /// NodeType as u32: 0=Path, 1=Rect, 2=Ellipse, 3=Group, 4=Text
    #[prost(uint32, tag = "3")]
    pub node_type: u32,
    /// 3x3 transform matrix (9 floats, column-major)
    #[prost(message, optional, tag = "4")]
    pub transform: Option<ProtoTransform>,
    #[prost(message, optional, tag = "5")]
    pub style: Option<ProtoStyle>,
    #[prost(message, optional, tag = "6")]
    pub geometry: Option<ProtoGeometry>,
    #[prost(uint32, repeated, tag = "7")]
    pub children: Vec<u32>,
    #[prost(uint32, optional, tag = "8")]
    pub parent: Option<u32>,
    #[prost(bool, tag = "9")]
    pub visible: bool,
    #[prost(bool, tag = "10")]
    pub locked: bool,
    /// Masking (Figma-style): this node masks the siblings painted above it.
    #[prost(bool, tag = "11")]
    pub is_mask: bool,
    /// 0 = alpha (default), 1 = luminance (reserved).
    #[prost(uint32, tag = "12")]
    pub mask_type: u32,
    /// Reserved: clip descendants to this node's bounds (frames — not yet wired).
    #[prost(bool, tag = "13")]
    pub clip_content: bool,
    /// This Group is a Live Paint group (special object).
    #[prost(bool, tag = "14")]
    pub live_paint: bool,
    /// Non-destructive Boolean Group, stored as op+1 so proto3's 0-default means
    /// "not a boolean group": 0 = none, 1 = union, 2 = subtract, 3 = intersect,
    /// 4 = exclude. The cached outline is not serialized (recomputed on load).
    #[prost(uint32, tag = "15")]
    pub boolean_op: u32,
    /// Per-group Live Paint gap-closing distance (world units). Absent means the
    /// group inherits the document default, which is not the same as 0 ("never
    /// bridge") — hence `optional` rather than a bare float.
    #[prost(float, optional, tag = "16")]
    pub gap_bridge_distance: Option<f32>,
}

/// A preserved face fill from the vector network.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoFaceFill {
    /// Centroid position for re-mapping after graph rebuild.
    #[prost(float, tag = "1")]
    pub centroid_x: f32,
    #[prost(float, tag = "2")]
    pub centroid_y: f32,
    /// Representative colour. Kept for files written before faces could hold a
    /// gradient, and still written (as the paint's first stop / mean) so an
    /// older reader gets a sane flat colour rather than nothing.
    #[prost(message, optional, tag = "3")]
    pub fill: Option<ProtoColor>,
    /// Sorted set of source-node ids bounding this face (the "signature").
    /// Lets fills re-attach to the same region after shapes move/reshape,
    /// independent of centroid drift. Empty in pre-v5 files (centroid-only).
    #[prost(uint32, repeated, tag = "4")]
    pub source_nodes: Vec<u32>,
    /// The face's actual paint. Preferred over `fill` when present.
    #[prost(message, optional, tag = "5")]
    pub paint: Option<ProtoPaint>,
}

/// A preserved painted edge from the vector network. Anchor is in the source
/// node's local space so it survives moves/transforms.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoPaintedEdge {
    #[prost(uint32, tag = "1")]
    pub source_node: u32,
    #[prost(float, tag = "2")]
    pub local_x: f32,
    #[prost(float, tag = "3")]
    pub local_y: f32,
    #[prost(message, optional, tag = "4")]
    pub color: Option<ProtoColor>,
    #[prost(float, tag = "5")]
    pub width: f32,
    /// Structural identity: source-segment ordinal (+1; 0 = none/legacy) + t.
    #[prost(uint32, tag = "6")]
    pub seg_plus1: u32,
    #[prost(float, tag = "7")]
    pub t: f32,
}

/// A named artboard (frame). See `crate::Artboard`.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoArtboard {
    #[prost(uint32, tag = "1")]
    pub id: u32,
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(float, tag = "3")]
    pub x: f32,
    #[prost(float, tag = "4")]
    pub y: f32,
    #[prost(float, tag = "5")]
    pub w: f32,
    #[prost(float, tag = "6")]
    pub h: f32,
    #[prost(message, optional, tag = "7")]
    pub background: Option<ProtoColor>,
}

/// Identity and provenance. See `crate::DocumentMeta`.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoDocumentMeta {
    #[prost(string, tag = "1")]
    pub uuid: String,
    #[prost(uint64, tag = "2")]
    pub created_at_ms: u64,
    #[prost(uint64, tag = "3")]
    pub modified_at_ms: u64,
    #[prost(string, tag = "4")]
    pub app_version: String,
    #[prost(string, tag = "5")]
    pub title: String,
}

/// An embedded font face. See `crate::FontFace`.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoFontFace {
    #[prost(string, tag = "1")]
    pub family: String,
    #[prost(uint32, tag = "2")]
    pub weight: u32,
    #[prost(bool, tag = "3")]
    pub italic: bool,
    #[prost(bytes = "vec", tag = "4")]
    pub bytes: Vec<u8>,
    #[prost(string, tag = "5")]
    pub source: String,
}

/// A document colour swatch. Replaces an entry of the `swatches_json` blob.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoSwatch {
    #[prost(message, optional, tag = "1")]
    pub color: Option<ProtoColor>,
    /// Optional swatch name — the JSON blob had nowhere to put one.
    #[prost(string, tag = "2")]
    pub name: String,
}

/// Binds a text node to the path its glyphs flow along. Replaces an entry of
/// the `text_paths_json` blob.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoTextPath {
    #[prost(uint32, tag = "1")]
    pub text_id: u32,
    #[prost(uint32, tag = "2")]
    pub path_id: u32,
}

/// Arrowheads / line endings on one node. Replaces an entry of the
/// `markers_json` blob. 0 = none, 1 = arrow, 2 = circle, 3 = square.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoNodeMarkers {
    #[prost(uint32, tag = "1")]
    pub node_id: u32,
    #[prost(uint32, tag = "2")]
    pub start: u32,
    #[prost(uint32, tag = "3")]
    pub end: u32,
}

/// Ruler guides that cannot be dragged. Replaces the `guide_locks_json` blob.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoGuideLocks {
    #[prost(float, repeated, tag = "1")]
    pub x: Vec<f32>,
    #[prost(float, repeated, tag = "2")]
    pub y: Vec<f32>,
}

/// The top-level document message.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoDocument {
    #[prost(uint32, tag = "1")]
    pub format_version: u32,
    #[prost(message, repeated, tag = "2")]
    pub nodes: Vec<ProtoNode>,
    #[prost(uint32, repeated, tag = "3")]
    pub root_ids: Vec<u32>,
    #[prost(uint32, tag = "4")]
    pub next_id: u32,
    /// Live Paint face fills (for preservation across saves).
    #[prost(message, repeated, tag = "5")]
    pub face_fills: Vec<ProtoFaceFill>,
    /// Gap tolerance for vector network.
    #[prost(float, tag = "6")]
    pub gap_tolerance: f32,
    /// Document dimensions (default 1000x1000).
    #[prost(float, optional, tag = "7")]
    pub document_width: Option<f32>,
    #[prost(float, optional, tag = "8")]
    pub document_height: Option<f32>,
    /// Encoded raster images referenced by Geometry::Image nodes.
    #[prost(message, repeated, tag = "9")]
    pub images: Vec<ProtoImageData>,
    /// Artboards (frames). Empty in pre-artboard files/snapshots — `to_scene`
    /// synthesizes a single "Artboard 1" from document_width/height in that case.
    #[prost(message, repeated, tag = "10")]
    pub artboards: Vec<ProtoArtboard>,
    /// Live Paint gap-closing distance in world units (0 = off).
    #[prost(float, tag = "11")]
    pub gap_bridge_distance: f32,
    /// Live Paint painted edge strokes.
    #[prost(message, repeated, tag = "12")]
    pub painted_edges: Vec<ProtoPaintedEdge>,
    /// Node id of the active Live Paint group (0 = none).
    #[prost(uint32, tag = "13")]
    pub live_paint_group: u32,
    /// Vertical ruler guides — world x positions.
    #[prost(float, repeated, tag = "14")]
    pub guides_x: Vec<f32>,
    /// Horizontal ruler guides — world y positions.
    #[prost(float, repeated, tag = "15")]
    pub guides_y: Vec<f32>,
    // Tags 16–19 are reserved: a pre-release build stored swatches, text-path
    // links, markers, and guide locks there as opaque JSON strings. Never reuse
    // them — the typed messages below replaced them outright.
    /// Identity and provenance.
    #[prost(message, optional, tag = "20")]
    pub meta: Option<ProtoDocumentMeta>,
    /// Font faces embedded so the document renders without a network fetch.
    #[prost(message, repeated, tag = "21")]
    pub fonts: Vec<ProtoFontFace>,
    /// Document colour swatches.
    #[prost(message, repeated, tag = "22")]
    pub swatches: Vec<ProtoSwatch>,
    /// Text nodes bound to a path they flow along.
    #[prost(message, repeated, tag = "23")]
    pub text_paths: Vec<ProtoTextPath>,
    /// Arrowheads / line endings, per node.
    #[prost(message, repeated, tag = "24")]
    pub markers: Vec<ProtoNodeMarkers>,
    /// Ruler guides that cannot be dragged.
    #[prost(message, optional, tag = "25")]
    pub guide_locks: Option<ProtoGuideLocks>,
}

/// A history/undo/drag snapshot. Wraps a full document plus the transient
/// selection (which `ProtoDocument` deliberately omits, since files shouldn't
/// carry selection but undo must restore it). This is the protobuf replacement
/// for the old positional-bincode `Scene` snapshot: tagged fields mean adding a
/// field can never corrupt an existing stream, so the "no skip_serializing_if"
/// bincode landmine is gone.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoSnapshot {
    #[prost(message, optional, tag = "1")]
    pub document: Option<ProtoDocument>,
    #[prost(uint32, repeated, tag = "2")]
    pub selection: Vec<u32>,
}

// ─── Conversion: Internal → Proto ───────────────────────────────────────────────

impl From<&Color> for ProtoColor {
    fn from(c: &Color) -> Self {
        ProtoColor { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

impl From<&ProtoColor> for Color {
    fn from(c: &ProtoColor) -> Self {
        Color { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

impl From<&Gradient> for ProtoGradient {
    fn from(g: &Gradient) -> Self {
        ProtoGradient {
            gradient_type: match g.gradient_type {
                GradientType::Linear => 0,
                GradientType::Radial => 1,
            },
            stops: g.stops.iter().map(|s| ProtoGradientStop {
                offset: s.offset,
                color: Some(ProtoColor { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a }),
            }).collect(),
            start_x: g.start_x,
            start_y: g.start_y,
            end_x: g.end_x,
            end_y: g.end_y,
            spread: g.spread as u32,
            has_focal: g.focal.is_some(),
            focal_x: g.focal.as_ref().map(|f| f.x).unwrap_or(0.0),
            focal_y: g.focal.as_ref().map(|f| f.y).unwrap_or(0.0),
            focal_r: g.focal.as_ref().map(|f| f.r).unwrap_or(0.0),
            has_transform: g.transform.is_some(),
            transform: g.transform.map(|t| t.to_vec()).unwrap_or_default(),
        }
    }
}

impl From<&ProtoGradient> for Gradient {
    fn from(g: &ProtoGradient) -> Self {
        Gradient {
            gradient_type: if g.gradient_type == 1 { GradientType::Radial } else { GradientType::Linear },
            stops: g.stops.iter().map(|s| {
                let c = s.color.as_ref().map(|c| Color { r: c.r, g: c.g, b: c.b, a: c.a })
                    .unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 });
                GradientStop { offset: s.offset, color: c }
            }).collect(),
            start_x: g.start_x,
            start_y: g.start_y,
            end_x: g.end_x,
            end_y: g.end_y,
            spread: g.spread as u8,
            focal: if g.has_focal {
                Some(GradientFocal { x: g.focal_x, y: g.focal_y, r: g.focal_r })
            } else {
                None
            },
            transform: if g.has_transform && g.transform.len() == 6 {
                let mut t = [0.0f32; 6];
                t.copy_from_slice(&g.transform);
                Some(t)
            } else {
                None
            },
        }
    }
}

impl From<&Style> for ProtoStyle {
    fn from(s: &Style) -> Self {
        ProtoStyle {
            fills: s.fills.iter().map(|f| f.into()).collect(),
            strokes: s.strokes.iter().map(|st| st.into()).collect(),
            opacity: Some(s.opacity),
            corner_radius: s.corner_radius,
            blend_mode: s.blend_mode as u32,
            fill_rule: s.fill_rule as u32,
            effects: s.effects.iter().map(effect_to_proto).collect(),
        }
    }
}

impl From<&ProtoStyle> for Style {
    fn from(s: &ProtoStyle) -> Self {
        Style {
            fills: s.fills.iter().map(|f| Paint::from(f)).collect(),
            strokes: s.strokes.iter().map(|st| crate::Stroke::from(st)).collect(),
            opacity: s.opacity.unwrap_or(1.0),
            blend_mode: s.blend_mode as u8,
            fill_rule: s.fill_rule as u8,
            corner_radius: s.corner_radius,
            effects: s.effects.iter().filter_map(proto_to_effect).collect(),
        }
    }
}

fn effect_to_proto(e: &crate::Effect) -> ProtoEffect {
    match e {
        crate::Effect::Blur { radius, radius_y } => ProtoEffect {
            kind: 0, radius: *radius, dx: 0.0, dy: 0.0, color: None, matrix: Vec::new(), linear_rgb: false,
            radius_y: radius_y.unwrap_or(0.0),
        },
        crate::Effect::DropShadow { dx, dy, blur, color } => ProtoEffect {
            kind: 1, radius: *blur, dx: *dx, dy: *dy, color: Some(color.into()), matrix: Vec::new(), linear_rgb: false,
            radius_y: 0.0,
        },
        crate::Effect::ColorMatrix { matrix, linear_rgb } => ProtoEffect {
            kind: 2, radius: 0.0, dx: 0.0, dy: 0.0, color: None, matrix: matrix.to_vec(), linear_rgb: *linear_rgb,
            radius_y: 0.0,
        },
    }
}

fn proto_to_effect(e: &ProtoEffect) -> Option<crate::Effect> {
    match e.kind {
        0 => Some(crate::Effect::Blur {
            radius: e.radius,
            radius_y: if e.radius_y > 0.0 { Some(e.radius_y) } else { None },
        }),
        1 => Some(crate::Effect::DropShadow {
            dx: e.dx, dy: e.dy, blur: e.radius,
            color: e.color.as_ref().map(Color::from).unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
        }),
        2 => {
            let mut m = [0.0f32; 20];
            if e.matrix.len() == 20 { m.copy_from_slice(&e.matrix); }
            Some(crate::Effect::ColorMatrix { matrix: m, linear_rgb: e.linear_rgb })
        }
        _ => None,
    }
}

impl From<&crate::Transform2D> for ProtoTransform {
    fn from(t: &crate::Transform2D) -> Self {
        ProtoTransform {
            x: t.x, y: t.y,
            rotation_deg: t.rotation_deg,
            skew_x_deg: t.skew_x_deg,
            skew_y_deg: t.skew_y_deg,
            scale_x: t.scale_x,
            scale_y: t.scale_y,
        }
    }
}

impl From<&ProtoTransform> for crate::Transform2D {
    fn from(pt: &ProtoTransform) -> Self {
        crate::Transform2D {
            x: pt.x, y: pt.y,
            rotation_deg: pt.rotation_deg,
            skew_x_deg: pt.skew_x_deg,
            skew_y_deg: pt.skew_y_deg,
            scale_x: if pt.scale_x == 0.0 { 1.0 } else { pt.scale_x },
            scale_y: if pt.scale_y == 0.0 { 1.0 } else { pt.scale_y },
        }
    }
}

impl From<&Paint> for ProtoPaint {
    fn from(p: &Paint) -> Self {
        let kind = match p {
            Paint::Solid(c) => proto_paint::Kind::Solid(c.into()),
            Paint::Gradient(g) => proto_paint::Kind::Gradient(g.into()),
            Paint::Pattern(pat) => proto_paint::Kind::Pattern(ProtoPattern {
                image_id: pat.image_id,
                width: pat.width,
                height: pat.height,
                transform: pat.transform.to_vec(),
            }),
            Paint::Mesh(m) => proto_paint::Kind::Mesh(ProtoMeshGradient {
                rows: m.rows,
                cols: m.cols,
                vertices: m
                    .vertices
                    .iter()
                    .map(|v| ProtoMeshVertex {
                        x: v.x,
                        y: v.y,
                        color: Some((&v.color).into()),
                        handle_e: v.handles.e.map_or_else(Vec::new, |h| h.to_vec()),
                        handle_w: v.handles.w.map_or_else(Vec::new, |h| h.to_vec()),
                        handle_s: v.handles.s.map_or_else(Vec::new, |h| h.to_vec()),
                        handle_n: v.handles.n.map_or_else(Vec::new, |h| h.to_vec()),
                    })
                    .collect(),
            }),
        };
        ProtoPaint { kind: Some(kind) }
    }
}

fn proto_handle(h: &[f32]) -> Option<[f32; 2]> {
    if h.len() == 2 { Some([h[0], h[1]]) } else { None }
}

impl From<&ProtoPaint> for Paint {
    fn from(p: &ProtoPaint) -> Self {
        match &p.kind {
            Some(proto_paint::Kind::Mesh(m)) => {
                let mesh = crate::MeshGradient {
                rows: m.rows,
                cols: m.cols,
                vertices: m
                    .vertices
                    .iter()
                    .map(|v| crate::MeshVertex {
                        x: v.x,
                        y: v.y,
                        color: v
                            .color
                            .as_ref()
                            .map(Color::from)
                            .unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
                        handles: crate::MeshHandles {
                            e: proto_handle(&v.handle_e),
                            w: proto_handle(&v.handle_w),
                            s: proto_handle(&v.handle_s),
                            n: proto_handle(&v.handle_n),
                        },
                    })
                    .collect(),
                };
                // Corrupt grid → solid black, same degradation as unknown paints.
                if mesh.is_valid() {
                    Paint::Mesh(mesh)
                } else {
                    Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })
                }
            }
            Some(proto_paint::Kind::Pattern(pat)) => {
                let t = &pat.transform;
                let transform = if t.len() == 6 {
                    [t[0], t[1], t[2], t[3], t[4], t[5]]
                } else {
                    [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
                };
                Paint::Pattern(crate::Pattern {
                    image_id: pat.image_id,
                    width: pat.width,
                    height: pat.height,
                    transform,
                })
            }
            Some(proto_paint::Kind::Gradient(g)) => Paint::Gradient(g.into()),
            Some(proto_paint::Kind::Solid(c)) => Paint::Solid(c.into()),
            // Unset, or a variant from a newer build. The container's
            // `min_reader_version` gate should have refused the file long
            // before this, so reaching here means a genuinely malformed paint.
            None => Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
        }
    }
}

impl From<&crate::StrokeAlignment> for u32 {
    fn from(a: &crate::StrokeAlignment) -> Self {
        match a {
            crate::StrokeAlignment::Center => 0,
            crate::StrokeAlignment::Inner => 1,
            crate::StrokeAlignment::Outer => 2,
        }
    }
}

impl From<u32> for crate::StrokeAlignment {
    fn from(v: u32) -> Self {
        match v {
            1 => crate::StrokeAlignment::Inner,
            2 => crate::StrokeAlignment::Outer,
            _ => crate::StrokeAlignment::Center,
        }
    }
}

impl From<&crate::Stroke> for ProtoStroke {
    fn from(s: &crate::Stroke) -> Self {
        ProtoStroke {
            paint: s.paint.as_ref().map(|p| p.into()),
            width: s.width,
            cap: s.cap as u32,
            join: s.join as u32,
            dash_array: s.dash_array.clone(),
            dash_offset: s.dash_offset,
            miter_limit: s.miter_limit,
            alignment: (&s.alignment).into(),
        }
    }
}

impl From<&ProtoStroke> for crate::Stroke {
    fn from(s: &ProtoStroke) -> Self {
        crate::Stroke {
            paint: s.paint.as_ref().map(|p| p.into()),
            width: s.width,
            cap: s.cap as u8,
            join: s.join as u8,
            dash_array: s.dash_array.clone(),
            dash_offset: s.dash_offset,
            miter_limit: s.miter_limit,
            alignment: s.alignment.into(),
        }
    }
}



impl From<&PathPoint> for ProtoPathPoint {
    fn from(p: &PathPoint) -> Self {
        ProtoPathPoint {
            x: p.x, y: p.y,
            cp1_x: p.cp1.x, cp1_y: p.cp1.y,
            cp2_x: p.cp2.x, cp2_y: p.cp2.y,
            corner_radius: p.corner_radius,
        }
    }
}

impl From<&ProtoPathPoint> for PathPoint {
    fn from(p: &ProtoPathPoint) -> Self {
        PathPoint {
            x: p.x, y: p.y,
            cp1: Vec2::new(p.cp1_x, p.cp1_y),
            cp2: Vec2::new(p.cp2_x, p.cp2_y),
            corner_radius: p.corner_radius,
        }
    }
}

fn node_type_to_u32(nt: NodeType) -> u32 {
    match nt {
        NodeType::Path => 0,
        NodeType::Rect => 1,
        NodeType::Ellipse => 2,
        NodeType::Group => 3,
        NodeType::Text => 4,
        NodeType::Image => 5,
    }
}

fn u32_to_node_type(v: u32) -> NodeType {
    match v {
        0 => NodeType::Path,
        1 => NodeType::Rect,
        2 => NodeType::Ellipse,
        3 => NodeType::Group,
        4 => NodeType::Text,
        5 => NodeType::Image,
        _ => NodeType::Rect,
    }
}

fn geometry_to_proto(g: &Geometry) -> ProtoGeometry {
    let kind = match g {
        Geometry::Rect { width, height } => {
            proto_geometry::Kind::Rect(ProtoRect { width: *width, height: *height })
        }
        Geometry::Ellipse { radius_x, radius_y } => {
            proto_geometry::Kind::Ellipse(ProtoEllipse { radius_x: *radius_x, radius_y: *radius_y })
        }
        Geometry::Path { ref subpaths, ref network } => proto_geometry::Kind::Path(ProtoPath {
            subpaths: subpaths.iter().map(|sp| ProtoSubpath {
                points: sp.points.iter().map(|p| p.into()).collect(),
                closed: sp.closed,
            }).collect(),
            network: network.as_ref().map(|n| network_to_proto(n)),
        }),
        Geometry::Text { content, font_size, ref font_family, text_align, line_height, font_weight, italic, letter_spacing } => {
            proto_geometry::Kind::Text(ProtoText {
                content: content.clone(),
                font_size: *font_size,
                font_family: font_family.clone(),
                text_align: *text_align as u32,
                line_height: *line_height,
                font_weight: *font_weight as u32,
                italic: *italic,
                letter_spacing: *letter_spacing,
            })
        }
        Geometry::Image { width, height, image_id, pixelated } => {
            proto_geometry::Kind::Image(ProtoImage {
                width: *width, height: *height, image_id: *image_id, pixelated: *pixelated,
            })
        }
    };
    ProtoGeometry { kind: Some(kind) }
}

fn proto_to_geometry(g: &ProtoGeometry) -> Geometry {
    match &g.kind {
        Some(proto_geometry::Kind::Image(img)) => {
            Geometry::Image { width: img.width, height: img.height, image_id: img.image_id, pixelated: img.pixelated }
        }
        Some(proto_geometry::Kind::Rect(r)) => Geometry::Rect { width: r.width, height: r.height },
        Some(proto_geometry::Kind::Ellipse(e)) => {
            Geometry::Ellipse { radius_x: e.radius_x, radius_y: e.radius_y }
        }
        Some(proto_geometry::Kind::Path(p)) => {
            Geometry::Path {
                subpaths: p.subpaths.iter().map(|sp| crate::Subpath {
                    points: sp.points.iter().map(|pp| pp.into()).collect(),
                    closed: sp.closed,
                }).collect(),
                network: p.network.as_ref().map(|n| proto_to_network(n)),
            }
        }
        Some(proto_geometry::Kind::Text(t)) => Geometry::Text {
            content: t.content.clone(),
            font_size: t.font_size,
            font_family: t.font_family.clone(),
            text_align: t.text_align as u8,
            line_height: if t.line_height > 0.0 { t.line_height } else { 1.2 },
            font_weight: if t.font_weight > 0 { t.font_weight as u16 } else { 400 },
            italic: t.italic,
            letter_spacing: t.letter_spacing,
        },
        // Unset, or a geometry from a newer build. `required_reader_version`
        // raises the floor to FORMAT_VERSION for this case, so a file that
        // reaches here has already been refused by the container gate; the
        // rectangle is a last-resort placeholder, not a supported degradation.
        None => Geometry::Rect { width: 100.0, height: 100.0 },
    }
}

fn network_to_proto(n: &NodeVectorNetwork) -> ProtoNodeNetwork {
    ProtoNodeNetwork {
        vertices: n.vertices.iter().map(|v| ProtoNetworkVertex {
            x: v.position.x,
            y: v.position.y,
            handle_in_x: v.handle_in.map(|h| h.x),
            handle_in_y: v.handle_in.map(|h| h.y),
            handle_out_x: v.handle_out.map(|h| h.x),
            handle_out_y: v.handle_out.map(|h| h.y),
            corner_radius: v.corner_radius,
        }).collect(),
        edges: n.edges.iter().map(|e| ProtoNetworkEdge {
            start_vertex: e.start_vertex,
            end_vertex: e.end_vertex,
        }).collect(),
        regions: n.regions.iter().map(|r| ProtoNetworkRegion {
            edge_loop: r.edge_loop.clone(),
            fill: r.fill.as_ref().map(|c| c.into()),
        }).collect(),
    }
}

fn proto_to_network(n: &ProtoNodeNetwork) -> NodeVectorNetwork {
    NodeVectorNetwork {
        vertices: n.vertices.iter().map(|v| NetworkVertex {
            position: Vec2::new(v.x, v.y),
            handle_in: match (v.handle_in_x, v.handle_in_y) {
                (Some(x), Some(y)) => Some(Vec2::new(x, y)),
                _ => None,
            },
            handle_out: match (v.handle_out_x, v.handle_out_y) {
                (Some(x), Some(y)) => Some(Vec2::new(x, y)),
                _ => None,
            },
            corner_radius: v.corner_radius,
        }).collect(),
        edges: n.edges.iter().map(|e| NetworkEdge {
            start_vertex: e.start_vertex,
            end_vertex: e.end_vertex,
        }).collect(),
        regions: n.regions.iter().map(|r| NetworkRegion {
            edge_loop: r.edge_loop.clone(),
            fill: r.fill.as_ref().map(|c| c.into()),
        }).collect(),
    }
}

fn node_to_proto(node: &Node) -> ProtoNode {
    ProtoNode {
        id: node.id,
        name: node.name.clone(),
        node_type: node_type_to_u32(node.node_type),
        transform: Some((&node.transform).into()),
        style: Some((&node.style).into()),
        geometry: Some(geometry_to_proto(&node.geometry)),
        children: node.children.clone(),
        parent: node.parent,
        visible: node.visible,
        locked: node.locked,
        is_mask: node.is_mask,
        mask_type: node.mask_type as u32,
        clip_content: node.clip_content,
        live_paint: node.live_paint,
        boolean_op: node.boolean_op.map(|op| op as u32 + 1).unwrap_or(0),
        gap_bridge_distance: node.gap_bridge_distance,
    }
}

fn proto_to_node(pn: &ProtoNode) -> Node {
    Node {
        id: pn.id,
        name: pn.name.clone(),
        node_type: u32_to_node_type(pn.node_type),
        transform: pn.transform.as_ref()
            .map(|t| crate::Transform2D::from(t))
            .unwrap_or(crate::Transform2D::IDENTITY),
        style: pn.style.as_ref().map(|s| s.into()).unwrap_or_else(|| Style {
            fills: vec![Paint::Solid(Color { r: 0.5, g: 0.5, b: 0.5, a: 1.0 })],
            strokes: Vec::new(),
            opacity: 1.0,
            blend_mode: 0,
            fill_rule: 0,
            corner_radius: 0.0,
            effects: Vec::new(),
        }),
        geometry: pn.geometry.as_ref().map(proto_to_geometry).unwrap_or(
            Geometry::Rect { width: 100.0, height: 100.0 }
        ),
        children: pn.children.clone(),
        parent: pn.parent,
        visible: pn.visible,
        locked: pn.locked,
        is_mask: pn.is_mask,
        mask_type: pn.mask_type as u8,
        clip_content: pn.clip_content,
        live_paint: pn.live_paint,
        boolean_op: if pn.boolean_op == 0 { None } else { Some((pn.boolean_op - 1) as u8) },
        // Negative values would mean "closer than not at all"; clamp rather than
        // trust a hand-edited file.
        gap_bridge_distance: pn.gap_bridge_distance.map(|d| d.max(0.0)),
        bool_cache: Vec::new(),
    }
}

// ─── Document-Level Conversion ──────────────────────────────────────────────────

impl ProtoDocument {
    /// Convert the current scene to a ProtoDocument.
    pub fn from_scene(scene: &Scene, next_id: u32) -> Self {
        // Deterministic node ordering (HashMap iteration order is not stable).
        // Undo relies on serialize→deserialize→serialize being a byte-exact
        // fixed point (see gesture_history.test.ts), which requires this.
        let mut nodes: Vec<ProtoNode> = scene.nodes.values().map(node_to_proto).collect();
        nodes.sort_by_key(|n| n.id);
        let root_ids = scene.root_nodes.clone();

        // Preserve face fills from the vector network as centroids (remapped on
        // the next rebuild). Include BOTH computed faces and not-yet-applied
        // `pending_fills` so a snapshot taken before a rebuild re-serializes
        // identically after a round-trip (deserialize leaves the network dirty
        // with pending fills; without this the fills would silently drop on
        // undo of a live-painted scene).
        let mut face_fills: Vec<ProtoFaceFill> = scene.vector_network.faces.values()
            .filter(|f| f.fill.is_some() && !f.is_outer)
            .map(|f| {
                let fill = f.fill.as_ref().unwrap();
                let centroid = crate::vector_network::face_centroid(f);
                ProtoFaceFill {
                    centroid_x: centroid.x,
                    centroid_y: centroid.y,
                    fill: crate::paint_color(fill).as_ref().map(Into::into),
                    source_nodes: f.signature.clone(),
                    paint: Some(fill.into()),
                }
            })
            .collect();
        for pf in &scene.vector_network.pending_fills {
            face_fills.push(ProtoFaceFill {
                centroid_x: pf.centroid.x,
                centroid_y: pf.centroid.y,
                fill: crate::paint_color(&pf.color).as_ref().map(Into::into),
                source_nodes: pf.signature.clone(),
                paint: Some((&pf.color).into()),
            });
        }
        // Deterministic fill ordering for byte-exact snapshots.
        face_fills.sort_by(|a, b| {
            a.centroid_x.partial_cmp(&b.centroid_x).unwrap_or(std::cmp::Ordering::Equal)
                .then(a.centroid_y.partial_cmp(&b.centroid_y).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.source_nodes.cmp(&b.source_nodes))
        });

        // Images, in deterministic id order (byte-exact snapshots).
        let mut images: Vec<ProtoImageData> = scene.images.iter()
            .map(|(&id, data)| ProtoImageData {
                id,
                bytes: data.bytes.clone(),
                mime: data.mime.clone(),
            })
            .collect();
        images.sort_by_key(|i| i.id);

        // Artboards, in declared order (already deterministic).
        let artboards: Vec<ProtoArtboard> = scene.artboards.iter().map(|a| ProtoArtboard {
            id: a.id,
            name: a.name.clone(),
            x: a.x,
            y: a.y,
            w: a.w,
            h: a.h,
            background: Some((&a.background).into()),
        }).collect();

        // Legacy document dims mirror the primary artboard so pre-artboard
        // readers still open the file with a sensible page size.
        let (doc_w, doc_h) = scene.artboards.first()
            .map(|a| (a.w, a.h))
            .unwrap_or((scene.document_width, scene.document_height));


        ProtoDocument {
            format_version: FORMAT_VERSION,
            nodes,
            root_ids,
            next_id,
            face_fills,
            gap_tolerance: scene.vector_network.gap_tolerance,
            document_width: Some(doc_w),
            document_height: Some(doc_h),
            images,
            artboards,
            gap_bridge_distance: scene.vector_network.gap_bridge_distance,
            painted_edges: {
                let mut pe: Vec<ProtoPaintedEdge> = scene.vector_network.painted_edges.iter()
                    .map(|p| ProtoPaintedEdge {
                        source_node: p.source_node,
                        local_x: p.local.x,
                        local_y: p.local.y,
                        color: Some((&p.color).into()),
                        width: p.width,
                        seg_plus1: (p.seg + 1).max(0) as u32,
                        t: p.t,
                    })
                    .collect();
                // Deterministic order for byte-exact snapshots.
                pe.sort_by(|a, b| a.source_node.cmp(&b.source_node)
                    .then(a.local_x.partial_cmp(&b.local_x).unwrap_or(std::cmp::Ordering::Equal))
                    .then(a.local_y.partial_cmp(&b.local_y).unwrap_or(std::cmp::Ordering::Equal)));
                pe
            },
            live_paint_group: scene.live_paint_group.unwrap_or(0),
            guides_x: scene.guides_x.clone(),
            guides_y: scene.guides_y.clone(),
            meta: Some(ProtoDocumentMeta {
                uuid: scene.meta.uuid.clone(),
                created_at_ms: scene.meta.created_at_ms,
                modified_at_ms: scene.meta.modified_at_ms,
                app_version: scene.meta.app_version.clone(),
                title: scene.meta.title.clone(),
            }),
            fonts: {
                let mut fonts: Vec<ProtoFontFace> = scene.fonts.iter().map(|f| ProtoFontFace {
                    family: f.family.clone(),
                    weight: f.weight as u32,
                    italic: f.italic,
                    bytes: f.bytes.clone(),
                    source: f.source.clone(),
                }).collect();
                // Deterministic order for byte-exact snapshots.
                fonts.sort_by(|a, b| a.family.cmp(&b.family)
                    .then(a.weight.cmp(&b.weight))
                    .then(a.italic.cmp(&b.italic)));
                fonts
            },
            swatches: scene.swatches.iter().map(|s| ProtoSwatch {
                color: Some((&s.color).into()),
                name: s.name.clone(),
            }).collect(),
            // BTreeMap iteration is ordered, so these are deterministic without
            // an explicit sort — required for byte-exact undo snapshots.
            text_paths: scene.text_paths.iter()
                .map(|(&text_id, &path_id)| ProtoTextPath { text_id, path_id })
                .collect(),
            markers: scene.markers.iter()
                .map(|(&node_id, m)| ProtoNodeMarkers {
                    node_id,
                    start: m.start as u32,
                    end: m.end as u32,
                })
                .collect(),
            guide_locks: if scene.guide_locks.x.is_empty() && scene.guide_locks.y.is_empty() {
                None
            } else {
                Some(ProtoGuideLocks {
                    x: scene.guide_locks.x.clone(),
                    y: scene.guide_locks.y.clone(),
                })
            },
        }
    }

    /// Convert a ProtoDocument back to a Scene + next_id.
    pub fn to_scene(&self) -> (Scene, u32) {
        let mut nodes = std::collections::HashMap::new();
        for pn in &self.nodes {
            let node = proto_to_node(pn);
            nodes.insert(node.id, node);
        }

        let mut vn = VectorNetwork::default();
        vn.gap_tolerance = if self.gap_tolerance > 0.0 {
            self.gap_tolerance
        } else {
            2.0
        };
        vn.gap_bridge_distance = self.gap_bridge_distance.max(0.0);
        // Face fills will be re-mapped after the first network rebuild. Stored as
        // pending on the network; signature (source_nodes) lets them re-attach to
        // the right region even if shapes moved between save and load.
        vn.pending_fills = self.face_fills.iter().filter_map(|ff| {
            // Files written before faces could hold a gradient carry only `fill`.
            let paint = match (&ff.paint, &ff.fill) {
                (Some(p), _) => Some(Paint::from(p)),
                (None, Some(c)) => Some(Paint::Solid(Color::from(c))),
                (None, None) => None,
            };
            paint.map(|paint| crate::vector_network::PendingFill {
                centroid: Vec2::new(ff.centroid_x, ff.centroid_y),
                signature: ff.source_nodes.clone(),
                color: paint,
            })
        }).collect();
        vn.painted_edges = self.painted_edges.iter().filter_map(|pe| {
            pe.color.as_ref().map(|c| crate::vector_network::PaintedEdge {
                source_node: pe.source_node,
                local: Vec2::new(pe.local_x, pe.local_y),
                color: Color::from(c),
                width: pe.width,
                seg: pe.seg_plus1 as i32 - 1,
                t: pe.t,
            })
        }).collect();

        let images = self.images.iter()
            .map(|img| (img.id, crate::ImageData { bytes: img.bytes.clone(), mime: img.mime.clone() }))
            .collect();

        let doc_w = self.document_width.unwrap_or(1000.0);
        let doc_h = self.document_height.unwrap_or(1000.0);

        // Artboards: use the stored list, or synthesize one from the legacy
        // document dims for pre-artboard files/snapshots. This single rule
        // migrates old .vec files, old IndexedDB autosaves, and old SVG payloads.
        let artboards: Vec<crate::Artboard> = if self.artboards.is_empty() {
            vec![crate::Artboard {
                id: 1,
                name: "Artwork 1".to_string(),
                x: 0.0,
                y: 0.0,
                w: doc_w,
                h: doc_h,
                background: crate::Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
            }]
        } else {
            self.artboards.iter().map(|a| crate::Artboard {
                id: a.id,
                name: a.name.clone(),
                x: a.x,
                y: a.y,
                w: a.w,
                h: a.h,
                background: a.background.as_ref().map(Color::from)
                    .unwrap_or(Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }),
            }).collect()
        };

        // Keep the legacy mirror in sync with the primary artboard.
        let (mirror_w, mirror_h) = artboards.first().map(|a| (a.w, a.h)).unwrap_or((doc_w, doc_h));

        let scene = Scene {
            nodes,
            root_nodes: self.root_ids.clone(),
            selection: Vec::new(),
            vector_network: vn,
            document_width: mirror_w,
            document_height: mirror_h,
            images,
            artboards,
            live_paint_group: if self.live_paint_group != 0 { Some(self.live_paint_group) } else { None },
            guides_x: self.guides_x.clone(),
            guides_y: self.guides_y.clone(),
            swatches: self.swatches.iter().map(|s| crate::Swatch {
                color: s.color.as_ref().map(Color::from)
                    .unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
                name: s.name.clone(),
            }).collect(),
            text_paths: self.text_paths.iter().map(|t| (t.text_id, t.path_id)).collect(),
            markers: self.markers.iter()
                .map(|m| (m.node_id, crate::NodeMarkers { start: m.start as u8, end: m.end as u8 }))
                .collect(),
            guide_locks: self.guide_locks.as_ref()
                .map(|l| crate::GuideLocks { x: l.x.clone(), y: l.y.clone() })
                .unwrap_or_default(),
            meta: self.meta.as_ref().map(|m| crate::DocumentMeta {
                uuid: m.uuid.clone(),
                created_at_ms: m.created_at_ms,
                modified_at_ms: m.modified_at_ms,
                app_version: m.app_version.clone(),
                title: m.title.clone(),
            }).unwrap_or_default(),
            fonts: self.fonts.iter().map(|f| crate::FontFace {
                family: f.family.clone(),
                weight: f.weight as u16,
                italic: f.italic,
                bytes: f.bytes.clone(),
                source: f.source.clone(),
            }).collect(),
        };

        let next_id = if self.next_id > 0 {
            self.next_id
        } else {
            // Compute from max node id
            scene.nodes.keys().copied().max().unwrap_or(0) + 1
        };

        (scene, next_id)
    }
}

// ─── Serialize / Deserialize ────────────────────────────────────────────────────
//
// Two distinct paths, deliberately:
//
//   * **Files** (`serialize_to_proto` / `deserialize_from_proto`) carry the
//     container envelope — magic, version floor, checksum, compression.
//   * **Undo snapshots** (`serialize_snapshot` / `deserialize_snapshot`) stay
//     bare protobuf. They are in-memory only, produced on every mutation, and
//     must be a byte-exact fixed point; compressing them would cost real time
//     on every edit to protect bytes that never reach a disk.

/// Serialize a scene to a complete `.Editor` file (enveloped, compressed).
pub fn serialize_to_proto(scene: &Scene, next_id: u32) -> Vec<u8> {
    let doc = ProtoDocument::from_scene(scene, next_id);
    let floor = required_reader_version(&doc);
    container::wrap(&doc.encode_to_vec(), floor)
}

/// Serialize the payload without the envelope. Test-only: it is what a
/// well-formed file looks like *inside* the container, and lets tests forge
/// header fields directly.
#[cfg(test)]
pub fn serialize_payload_only(scene: &Scene, next_id: u32) -> Vec<u8> {
    ProtoDocument::from_scene(scene, next_id).encode_to_vec()
}

/// Read a `.Editor` file.
///
/// The envelope is mandatory. Pre-release builds wrote bare protobuf with no
/// header, and that path is deliberately gone: accepting headerless input would
/// mean accepting the empty byte string as a valid empty document, which is
/// exactly how a truncated save used to open as a blank canvas and then
/// overwrite the original.
///
/// Returns the scene plus a report of anything that had to be repaired.
pub fn deserialize_from_proto(data: &[u8]) -> Result<(Scene, u32, RepairReport), LoadError> {
    if data.is_empty() {
        return Err(LoadError::Container(ContainerError::Empty));
    }
    if !container::has_envelope(data) {
        return Err(LoadError::Unparseable);
    }
    let payload = container::unwrap(data, FORMAT_VERSION).map_err(LoadError::Container)?;

    let doc = ProtoDocument::decode(&payload[..]).map_err(|_| LoadError::Unparseable)?;

    // Count duplicate ids before conversion: `to_scene` collapses them into a
    // `HashMap` where the last definition silently wins, so this is the only
    // point at which the collision is still visible.
    let duplicates = validate::count_duplicate_ids(doc.nodes.iter().map(|n| n.id));

    let (scene, next_id) = doc.to_scene();
    let (scene, mut report) = validate::repair(scene);
    report.duplicate_ids = duplicates;
    Ok((scene, next_id, report))
}

/// Serialize a full history/undo/drag snapshot (document + selection).
/// This is what `Engine::serialize_scene` stores on the undo stack.
pub fn serialize_snapshot(scene: &Scene, next_id: u32) -> Vec<u8> {
    let snap = ProtoSnapshot {
        document: Some(ProtoDocument::from_scene(scene, next_id)),
        selection: scene.selection.clone(),
    };
    snap.encode_to_vec()
}

/// Restore a scene + next_id from a snapshot produced by `serialize_snapshot`.
/// Restores selection (which the plain document path drops).
pub fn deserialize_snapshot(data: &[u8]) -> Option<(Scene, u32)> {
    let snap = ProtoSnapshot::decode(data).ok()?;
    let doc = snap.document?;
    let (mut scene, next_id) = doc.to_scene();
    scene.selection = snap.selection;
    Some((scene, next_id))
}

/// Serialize a scene to base64-encoded protobuf (for SVG embedding).
pub fn serialize_to_base64(scene: &Scene, next_id: u32) -> String {
    let bytes = serialize_to_proto(scene, next_id);
    BASE64.encode(&bytes)
}

/// Deserialize a scene from base64-encoded protobuf (from SVG metadata).
pub fn deserialize_from_base64(b64: &str) -> Result<(Scene, u32, RepairReport), LoadError> {
    let bytes = BASE64.decode(b64.trim()).map_err(|_| LoadError::Unparseable)?;
    deserialize_from_proto(&bytes)
}

/// Why a document could not be loaded.
#[derive(Debug, Clone, PartialEq)]
pub enum LoadError {
    /// The envelope rejected it — too new, truncated, or corrupt.
    Container(ContainerError),
    /// The payload is not a `ProtoDocument` at all.
    Unparseable,
}

impl LoadError {
    pub fn code(&self) -> &'static str {
        match self {
            LoadError::Container(e) => e.code(),
            LoadError::Unparseable => "unparseable",
        }
    }

    pub fn detail(&self) -> String {
        match self {
            LoadError::Container(e) => e.detail(),
            LoadError::Unparseable => "the file is not a supported document".into(),
        }
    }

    /// The format version this file needs, when that is why it was refused.
    pub fn required_version(&self) -> Option<u32> {
        match self {
            LoadError::Container(ContainerError::TooNew { required, .. }) => Some(*required),
            _ => None,
        }
    }
}

// No migrations exist. v1 is the first released format, and the container
// refuses anything a build cannot read losslessly, so there is no older shape
// to convert from. When v2 arrives, add the migration here and call it from
// `deserialize_from_proto` before `to_scene`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Transform2D, Stroke, StrokeAlignment};
    use std::collections::HashMap;

    fn make_style() -> ProtoStyle {
        ProtoStyle {
            fills: vec![ProtoPaint::solid(ProtoColor { r: 1.0, g: 0.0, b: 0.0, a: 1.0 })],
            strokes: Vec::new(),
            opacity: Some(1.0),
            corner_radius: 0.0,
            blend_mode: 0,
            fill_rule: 0,
            effects: Vec::new(),
        }
    }

    /// Identity transform for proto node fixtures.
    fn ident_transform() -> ProtoTransform {
        ProtoTransform {
            x: 0.0, y: 0.0,
            rotation_deg: 0.0,
            skew_x_deg: 0.0, skew_y_deg: 0.0,
            scale_x: 1.0, scale_y: 1.0,
        }
    }

    fn pp(x: f32, y: f32) -> ProtoPathPoint {
        ProtoPathPoint { x, y, cp1_x: x, cp1_y: y, cp2_x: x, cp2_y: y, corner_radius: 0.0 }
    }

    /// Round trip: subpaths, closed flags, and document size survive.
    #[test]
    fn test_round_trip() {
        let mut nodes = HashMap::new();
        nodes.insert(7, Node {
            id: 7,
            name: "Shape".into(),
            node_type: NodeType::Path,
            transform: Transform2D::from_translation(25.0, 30.0),
            style: Style {
                fills: vec![Paint::Solid(Color { r: 0.2, g: 0.4, b: 0.6, a: 0.75 })],
                strokes: vec![Stroke {
                    paint: Some(Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })),
                    width: 3.0,
                    cap: 1,
                    join: 2,
                    dash_array: vec![4.0, 2.0],
                    dash_offset: 1.0,
                    miter_limit: 4.0,
                    alignment: StrokeAlignment::Center,
                }],
                opacity: 0.5,
                corner_radius: 0.0,
                blend_mode: 0,
                fill_rule: 1,
                effects: Vec::new(),
            },
            geometry: Geometry::Path {
                subpaths: vec![
                    crate::Subpath {
                        points: vec![
                            PathPoint { x: 0.0, y: 0.0, cp1: Vec2::new(0.0, 0.0), cp2: Vec2::new(10.0, 0.0), corner_radius: 0.0 },
                            PathPoint { x: 50.0, y: 0.0, cp1: Vec2::new(40.0, 0.0), cp2: Vec2::new(50.0, 0.0), corner_radius: 0.0 },
                            PathPoint { x: 25.0, y: 40.0, cp1: Vec2::new(25.0, 40.0), cp2: Vec2::new(25.0, 40.0), corner_radius: 0.0 },
                        ],
                        closed: true,
                    },
                    crate::Subpath {
                        points: vec![
                            PathPoint { x: 10.0, y: 10.0, cp1: Vec2::new(10.0, 10.0), cp2: Vec2::new(10.0, 10.0), corner_radius: 0.0 },
                            PathPoint { x: 20.0, y: 20.0, cp1: Vec2::new(20.0, 20.0), cp2: Vec2::new(20.0, 20.0), corner_radius: 0.0 },
                        ],
                        closed: false,
                    },
                ],
                network: None,
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
        });

        let scene = Scene {
            nodes,
            root_nodes: vec![7],
            selection: Vec::new(),
            vector_network: VectorNetwork::default(),
            document_width: 800.0,
            document_height: 600.0,
            images: Default::default(),
            artboards: Vec::new(),
            live_paint_group: None,
            guides_x: Vec::new(),
            guides_y: Vec::new(),
            swatches: Vec::new(),
            text_paths: Default::default(),
            markers: Default::default(),
            guide_locks: Default::default(),
            meta: Default::default(),
            fonts: Vec::new(),
        };

        let bytes = serialize_to_proto(&scene, 8);
        let (scene2, next_id, _) = deserialize_from_proto(&bytes).unwrap();
        assert_eq!(next_id, 8);
        assert_eq!(scene2.document_width, 800.0);
        assert_eq!(scene2.document_height, 600.0);
        // An empty artboards list synthesizes a single Artboard 1 sized to the doc.
        assert_eq!(scene2.artboards.len(), 1);
        assert_eq!(scene2.artboards[0].w, 800.0);
        assert_eq!(scene2.artboards[0].h, 600.0);

        let node = scene2.nodes.get(&7).unwrap();
        assert_eq!(node.style.opacity, 0.5);
        // Fill opacity now lives in the fill paint's alpha channel.
        match &node.style.fills[0] {
            Paint::Solid(c) => assert_eq!(c.a, 0.75),
            other => panic!("expected solid fill, got {:?}", other),
        }
        assert_eq!(node.style.strokes.len(), 1);
        assert_eq!(node.style.strokes[0].width, 3.0);
        match &node.geometry {
            Geometry::Path { subpaths, .. } => {
                assert_eq!(subpaths.len(), 2);
                assert!(subpaths[0].closed);
                assert!(!subpaths[1].closed);
                assert_eq!(subpaths[0].points.len(), 3);
                assert_eq!(subpaths[0].points[0].cp2, Vec2::new(10.0, 0.0));
                assert_eq!(subpaths[1].points.len(), 2);
            }
            other => panic!("expected Path geometry, got {:?}", other),
        }
    }

    // ─── Artboards ──────────────────────────────────────────────────────────

    fn scene_with_artboards(artboards: Vec<crate::Artboard>) -> Scene {
        Scene {
            nodes: HashMap::new(),
            root_nodes: Vec::new(),
            selection: Vec::new(),
            vector_network: VectorNetwork::default(),
            document_width: 1000.0,
            document_height: 1000.0,
            images: Default::default(),
            artboards,
            live_paint_group: None,
            guides_x: Vec::new(),
            guides_y: Vec::new(),
            swatches: Vec::new(),
            text_paths: Default::default(),
            markers: Default::default(),
            guide_locks: Default::default(),
            meta: Default::default(),
            fonts: Vec::new(),
        }
    }

    fn ab(id: u32, name: &str, x: f32, y: f32, w: f32, h: f32) -> crate::Artboard {
        crate::Artboard {
            id, name: name.to_string(), x, y, w, h,
            background: Color { r: 0.2, g: 0.4, b: 0.6, a: 1.0 },
        }
    }

    #[test]
    fn test_artboards_round_trip() {
        let scene = scene_with_artboards(vec![
            ab(1, "Artboard 1", 0.0, 0.0, 800.0, 600.0),
            ab(2, "Hero", 900.0, 0.0, 1200.0, 400.0),
        ]);
        let bytes = serialize_to_proto(&scene, 3);
        let (scene2, _, _) = deserialize_from_proto(&bytes).unwrap();
        assert_eq!(scene2.artboards.len(), 2);
        assert_eq!(scene2.artboards[1].name, "Hero");
        assert_eq!(scene2.artboards[1].x, 900.0);
        assert_eq!(scene2.artboards[1].w, 1200.0);
        assert_eq!(scene2.artboards[0].background.b, 0.6);
        // Legacy dims mirror the primary artboard.
        assert_eq!(scene2.document_width, 800.0);
        assert_eq!(scene2.document_height, 600.0);
    }

    #[test]
    fn test_bytes_without_artboards_synthesize_one() {
        // A document carrying no `artboards` (tag 10) — only the legacy doc
        // dims. `to_scene` must synthesize a single artboard from them.
        let old = ProtoDocument {
            format_version: FORMAT_VERSION,
            nodes: Vec::new(),
            root_ids: Vec::new(),
            next_id: 1,
            face_fills: Vec::new(),
            gap_tolerance: 2.0,
            document_width: Some(1920.0),
            document_height: Some(1080.0),
            images: Vec::new(),
            artboards: Vec::new(),
            gap_bridge_distance: 0.0,
            painted_edges: Vec::new(),
            live_paint_group: 0,
            guides_x: Vec::new(),
            guides_y: Vec::new(),
            ..Default::default()
        };
        let bytes = container::wrap(&old.encode_to_vec(), required_reader_version(&old));
        let (scene, _, _) = deserialize_from_proto(&bytes).unwrap();
        assert_eq!(scene.artboards.len(), 1);
        assert_eq!(scene.artboards[0].name, "Artwork 1");
        assert_eq!(scene.artboards[0].w, 1920.0);
        assert_eq!(scene.artboards[0].h, 1080.0);
        assert_eq!(scene.artboards[0].x, 0.0);
    }

    #[test]
    fn test_artboards_survive_snapshot_round_trip() {
        // Undo snapshots must carry artboards (they wrap ProtoDocument).
        let scene = scene_with_artboards(vec![
            ab(1, "A", 0.0, 0.0, 500.0, 500.0),
            ab(2, "B", 600.0, 0.0, 300.0, 700.0),
        ]);
        let snap = serialize_snapshot(&scene, 3);
        let (scene2, next_id) = deserialize_snapshot(&snap).unwrap();
        assert_eq!(next_id, 3);
        assert_eq!(scene2.artboards.len(), 2);
        assert_eq!(scene2.artboards[1].h, 700.0);
    }

    #[test]
    fn test_snapshot_is_byte_exact_fixed_point_with_artboards() {
        // The gesture/undo contract: serialize → deserialize → serialize is a
        // byte-exact fixed point (artboards must not perturb determinism).
        let scene = scene_with_artboards(vec![
            ab(2, "Two", 10.0, 20.0, 640.0, 480.0),
            ab(5, "Five", 700.0, 0.0, 100.0, 100.0),
        ]);
        let snap1 = serialize_snapshot(&scene, 6);
        let (scene2, next_id) = deserialize_snapshot(&snap1).unwrap();
        let snap2 = serialize_snapshot(&scene2, next_id);
        assert_eq!(snap1, snap2);
    }

    // ─── Mesh gradients ─────────────────────────────────────────────────────

    fn sample_mesh() -> crate::MeshGradient {
        // 1×2 patch grid → 2×3 vertices, mixed auto/stored handles.
        let c = |r: f32| Color { r, g: 0.25, b: 0.5, a: 1.0 };
        let v = |x: f32, y: f32, r: f32| crate::MeshVertex {
            x, y, color: c(r), handles: crate::MeshHandles::default(),
        };
        let mut mesh = crate::MeshGradient {
            rows: 1,
            cols: 2,
            vertices: vec![
                v(0.0, 0.0, 0.0), v(50.0, -3.0, 0.2), v(100.0, 0.0, 0.4),
                v(0.0, 60.0, 0.6), v(50.0, 63.0, 0.8), v(100.0, 60.0, 1.0),
            ],
        };
        mesh.vertices[1].handles.e = Some([70.0, -8.0]);
        mesh.vertices[4].handles.n = Some([48.0, 40.0]);
        mesh
    }

    #[test]
    fn test_mesh_paint_proto_round_trip() {
        let paint = Paint::Mesh(sample_mesh());
        let proto: ProtoPaint = (&paint).into();
        let back: Paint = (&proto).into();
        match back {
            Paint::Mesh(m) => {
                assert_eq!(m.rows, 1);
                assert_eq!(m.cols, 2);
                assert_eq!(m.vertices.len(), 6);
                assert_eq!(m.vertices[1].handles.e, Some([70.0, -8.0]));
                assert_eq!(m.vertices[1].handles.w, None);
                assert_eq!(m.vertices[4].handles.n, Some([48.0, 40.0]));
                assert_eq!(m.vertices[5].color.r, 1.0);
            }
            other => panic!("expected mesh paint, got {:?}", other),
        }
    }

    #[test]
    fn test_mesh_paint_corrupt_grid_degrades_to_solid() {
        let mut proto: ProtoPaint = (&Paint::Mesh(sample_mesh())).into();
        match proto.kind.as_mut() {
            Some(proto_paint::Kind::Mesh(m)) => m.vertices.pop(), // count mismatch
            _ => panic!("expected a mesh paint"),
        };
        match Paint::from(&proto) {
            Paint::Solid(_) => {}
            other => panic!("expected solid degradation, got {:?}", other),
        }
    }

    #[test]
    fn test_mesh_paint_json_round_trip() {
        // The JS boundary (set_node_style) speaks serde JSON: the `vertices`
        // marker must select the Mesh variant and handles must survive.
        let json = serde_json::to_string(&Paint::Mesh(sample_mesh())).unwrap();
        let back: Paint = serde_json::from_str(&json).unwrap();
        match back {
            Paint::Mesh(m) => {
                assert_eq!(m.vertices.len(), 6);
                assert_eq!(m.vertices[1].handles.e, Some([70.0, -8.0]));
            }
            other => panic!("expected mesh paint, got {:?}", other),
        }
        // Invalid vertex count must be rejected, not silently accepted.
        let bad = r#"{"rows":2,"cols":2,"vertices":[{"x":0,"y":0,"color":{"r":0,"g":0,"b":0,"a":1}}]}"#;
        assert!(serde_json::from_str::<Paint>(bad).is_err());
    }

    #[test]
    fn test_mesh_effective_handle_defaults() {
        let mesh = sample_mesh();
        // Auto handle: vertex 0 (row 0, col 0) toward e = 1/3 to vertex 1.
        let h = mesh.effective_handle(0, 0);
        assert!((h[0] - (0.0 + 50.0 / 3.0)).abs() < 1e-5);
        // Outward boundary direction (w on col 0) → anchor itself.
        assert_eq!(mesh.effective_handle(0, 1), [0.0, 0.0]);
        // Stored handle wins.
        assert_eq!(mesh.effective_handle(1, 0), [70.0, -8.0]);
    }
}
