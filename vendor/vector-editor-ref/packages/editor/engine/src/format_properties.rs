//! Property and fuzz tests for the `.Editor` format.
//!
//! `format_tests.rs` pins specific behaviours with hand-picked inputs. This
//! module tests the *claims those examples generalize to*, because the load
//! path makes two promises that examples can only sample:
//!
//!   1. **Loading is total.** Any byte sequence either fails cleanly or
//!      produces a structurally coherent scene. Never a panic, never a hang,
//!      never a half-built document.
//!   2. **Saving is a fixed point.** serialize → deserialize → serialize is
//!      byte-exact, which is what undo coalescing relies on.
//!
//! Both are universally quantified, and both were false before the v1 work — a
//! cyclic graph stack-overflowed the wasm instance, and a truncated file opened
//! as a blank canvas. Examples proving the specific cases are fixed say nothing
//! about the next malformed file.
//!
//! Everything here is deterministic: seeded `StdRng`, fixed iteration counts,
//! and not one assertion that reads a clock — the scaling guards at the end
//! count allocations instead, for reasons written up there. Budgets are kept
//! tight so the suite stays fast — the whole module is a small fraction of a
//! second.

#![cfg(test)]

use crate::proto::{self, ProtoDocument};
use crate::{container, validate, Engine, Geometry, LoadError, Scene};
use prost::Message;
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::collections::{HashMap, HashSet};

// ─── Generators ─────────────────────────────────────────────────────────────────
//
// Two generators, because they answer different questions.
//
// `random_engine` builds through the public `Engine` API, so its output is
// reachable by a real user and structurally valid by construction — that is
// what makes "a file we wrote never needs repair" a claim about the writer
// rather than a tautology about the generator. But the API only produces
// default styling, so it exercises almost none of the format's variants.
//
// `rich_scene` fills that gap by assembling `Scene` directly, so it can reach
// **every** paint, geometry, effect, and node flag the format can encode —
// including the ones with the most fragile encodings (mesh handle arrays,
// pattern affines, variable-length effect records, vector networks). A
// round-trip claim that skipped those would be worth very little, since they
// are exactly where an encoding bug hides.

/// Build a valid, non-trivial scene: mixed geometry, nesting, and the
/// document-level collections that ride alongside the node tree.
///
/// Goes through the `Engine` API rather than assembling `Scene` by hand, so
/// whatever it produces is reachable by a real user and is valid by
/// construction — which is what makes "a file we wrote never needs repair" a
/// meaningful assertion rather than a tautology about the generator.
fn random_engine(seed: u64) -> Engine {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut engine = Engine::new();

    let leaf_count = rng.gen_range(3..14);
    let mut ids: Vec<u32> = Vec::new();
    for _ in 0..leaf_count {
        let x = rng.gen_range(-500.0..500.0f32);
        let y = rng.gen_range(-500.0..500.0f32);
        let id = match rng.gen_range(0..4) {
            0 => engine.add_rect(x, y, rng.gen_range(1.0..300.0), rng.gen_range(1.0..300.0)),
            1 => engine.add_ellipse(x, y, rng.gen_range(1.0..150.0), rng.gen_range(1.0..150.0)),
            2 => engine.add_text(x, y, "sample text", rng.gen_range(8.0..96.0)),
            _ => {
                let pts: Vec<String> = (0..rng.gen_range(2..6))
                    .map(|_| {
                        format!(
                            r#"{{"x":{:.2},"y":{:.2}}}"#,
                            rng.gen_range(-400.0..400.0f32),
                            rng.gen_range(-400.0..400.0f32)
                        )
                    })
                    .collect();
                engine.add_path(&format!("[{}]", pts.join(",")))
            }
        };
        ids.push(id);
    }

    // Nest a random subset, sometimes more than once, to get real depth.
    for _ in 0..rng.gen_range(0..3) {
        if ids.len() < 2 {
            break;
        }
        let take = rng.gen_range(2..=ids.len().min(4));
        let picked: Vec<u32> = ids.drain(..take).collect();
        let json = format!(
            "[{}]",
            picked.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")
        );
        ids.push(engine.group_nodes(&json));
    }

    if rng.gen_bool(0.5) {
        engine.set_swatches_json(r#"[{"r":1,"g":0.5,"b":0,"a":1}]"#.into());
    }
    if rng.gen_bool(0.5) {
        engine.set_markers_json(r#"{"1":{"start":"arrow","end":"circle"}}"#.into());
    }
    if rng.gen_bool(0.5) {
        engine.set_guide_locks_json(r#"{"x":[10,20],"y":[30]}"#.into());
    }
    if rng.gen_bool(0.5) {
        engine.set_document_meta("uuid-x".into(), 1000.0, 2000.0, "1.0.0".into(), "T".into());
    }
    if rng.gen_bool(0.4) {
        engine.embed_font("Inter".into(), 400, false, vec![7u8; 256], "test".into());
    }
    engine
}

/// Every paint kind the format can encode, chosen by index so a test can
/// enumerate them and be forced to update when a new one is added.
fn paint_variant(i: usize, rng: &mut StdRng) -> crate::Paint {
    use crate::{Color, Gradient, GradientFocal, GradientStop, GradientType, MeshGradient, MeshHandles, MeshVertex, Paint, Pattern};
    let c = |r: f32, g: f32, b: f32, a: f32| Color { r, g, b, a };
    match i % PAINT_KINDS {
        0 => Paint::Solid(c(rng.gen(), rng.gen(), rng.gen(), 1.0)),
        1 => Paint::Gradient(Gradient {
            gradient_type: GradientType::Linear,
            stops: vec![
                GradientStop { offset: 0.0, color: c(1.0, 0.0, 0.0, 1.0) },
                GradientStop { offset: 0.5, color: c(0.0, 1.0, 0.0, 0.5) },
                GradientStop { offset: 1.0, color: c(0.0, 0.0, 1.0, 1.0) },
            ],
            start_x: 0.0, start_y: 0.0, end_x: 100.0, end_y: 50.0,
            spread: (i % 3) as u8,
            focal: None,
            transform: None,
        }),
        // Radial with BOTH a focal point and an elliptical transform — the two
        // optional gradient extensions, which encode as separate flag+payload
        // pairs and so can each be dropped independently by a bad writer.
        2 => Paint::Gradient(Gradient {
            gradient_type: GradientType::Radial,
            stops: vec![
                GradientStop { offset: 0.0, color: c(1.0, 1.0, 1.0, 1.0) },
                GradientStop { offset: 1.0, color: c(0.0, 0.0, 0.0, 0.0) },
            ],
            start_x: 10.0, start_y: 20.0, end_x: 80.0, end_y: 90.0,
            spread: 2,
            focal: Some(GradientFocal { x: 15.0, y: 25.0, r: 3.0 }),
            transform: Some([1.5, 0.2, -0.3, 0.9, 4.0, -2.0]),
        }),
        3 => Paint::Pattern(Pattern {
            image_id: 1,
            width: 32.0,
            height: 24.0,
            transform: [0.8, 0.1, -0.1, 1.2, 5.0, 6.0],
        }),
        // 2x2 patch mesh: 3x3 = 9 vertices. Handles are per-direction Options,
        // and an empty handle list means "auto" — a distinction the encoding
        // has to preserve exactly or the surface changes shape.
        _ => Paint::Mesh(MeshGradient {
            rows: 2,
            cols: 2,
            vertices: (0..9)
                .map(|k| MeshVertex {
                    x: (k % 3) as f32 * 40.0,
                    y: (k / 3) as f32 * 40.0,
                    color: c(k as f32 / 9.0, 0.5, 1.0 - k as f32 / 9.0, 1.0),
                    handles: MeshHandles {
                        e: if k % 2 == 0 { Some([1.0, 2.0]) } else { None },
                        w: if k % 3 == 0 { Some([3.0, 4.0]) } else { None },
                        s: None,
                        n: if k == 4 { Some([5.5, 6.5]) } else { None },
                    },
                })
                .collect(),
        }),
    }
}

/// Number of distinct paint kinds `paint_variant` can produce.
const PAINT_KINDS: usize = 5;
/// Number of distinct geometry kinds `geometry_variant` can produce.
const GEOMETRY_KINDS: usize = 6;
/// Number of distinct effect kinds `effect_variant` can produce.
const EFFECT_KINDS: usize = 4;

fn geometry_variant(i: usize) -> Geometry {
    use crate::{PathPoint, Subpath};
    use crate::vector_network::{NetworkEdge, NetworkRegion, NetworkVertex, NodeVectorNetwork};
    use glam::Vec2;

    let pt = |x: f32, y: f32, r: f32| PathPoint {
        x, y,
        cp1: Vec2::new(x - 5.0, y - 3.0),
        cp2: Vec2::new(x + 5.0, y + 3.0),
        corner_radius: r,
    };
    match i % GEOMETRY_KINDS {
        0 => Geometry::Rect { width: 120.0, height: 80.0 },
        1 => Geometry::Ellipse { radius_x: 40.0, radius_y: 25.0 },
        2 => Geometry::Text {
            content: "Round-trip me — ünïcødé ✓".into(),
            font_size: 23.5,
            font_family: "Inter".into(),
            text_align: 2,
            line_height: 1.45,
            font_weight: 700,
            italic: true,
            letter_spacing: 1.25,
        },
        3 => Geometry::Image { width: 64.0, height: 48.0, image_id: 1, pixelated: i % 2 == 0 },
        // Multi-subpath with per-vertex corner radii, one open and one closed.
        4 => Geometry::Path {
            subpaths: vec![
                Subpath { points: vec![pt(0.0, 0.0, 4.0), pt(50.0, 0.0, 0.0), pt(50.0, 50.0, 8.0)], closed: true },
                Subpath { points: vec![pt(80.0, 10.0, 0.0), pt(120.0, 40.0, 2.5)], closed: false },
            ],
            network: None,
        },
        // A path carrying a vector network — vertices with optional handles,
        // edges, and a filled region.
        _ => Geometry::Path {
            subpaths: vec![Subpath { points: vec![pt(0.0, 0.0, 0.0), pt(30.0, 30.0, 0.0)], closed: false }],
            network: Some(NodeVectorNetwork {
                vertices: vec![
                    NetworkVertex { position: Vec2::new(0.0, 0.0), handle_in: None, handle_out: Some(Vec2::new(5.0, 5.0)), corner_radius: 1.5 },
                    NetworkVertex { position: Vec2::new(40.0, 0.0), handle_in: Some(Vec2::new(35.0, -5.0)), handle_out: None, corner_radius: 0.0 },
                    NetworkVertex { position: Vec2::new(40.0, 40.0), handle_in: None, handle_out: None, corner_radius: 3.0 },
                ],
                edges: vec![
                    NetworkEdge { start_vertex: 0, end_vertex: 1 },
                    NetworkEdge { start_vertex: 1, end_vertex: 2 },
                ],
                regions: vec![NetworkRegion {
                    edge_loop: vec![0, 1],
                    fill: Some(crate::Color { r: 0.1, g: 0.7, b: 0.3, a: 0.8 }),
                }],
            }),
        },
    }
}

fn effect_variant(i: usize) -> crate::Effect {
    use crate::{Color, Effect};
    match i % EFFECT_KINDS {
        0 => Effect::Blur { radius: 3.5, radius_y: None },
        // Anisotropic blur: radius_y is Option, and `None` vs `Some(0.0)` must
        // not be conflated by the encoding.
        1 => Effect::Blur { radius: 3.5, radius_y: Some(7.25) },
        2 => Effect::DropShadow { dx: 4.0, dy: -2.0, blur: 6.0, color: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.6 } },
        _ => Effect::ColorMatrix {
            matrix: {
                let mut m = [0.0f32; 20];
                for (k, v) in m.iter_mut().enumerate() { *v = k as f32 * 0.05 - 0.4; }
                m
            },
            linear_rgb: true,
        },
    }
}

/// A scene exercising every paint, geometry, effect and node flag the format
/// can encode — the variants `random_engine` cannot reach through the public
/// API, and the ones whose encodings are most fragile.
fn rich_scene(seed: u64) -> (Scene, u32) {
    use crate::{Artboard, Color, DocumentMeta, FontFace, ImageData, Node, NodeType, Stroke, StrokeAlignment, Style, Transform2D};

    let mut rng = StdRng::seed_from_u64(seed ^ 0x21C4);
    let mut nodes: HashMap<u32, Node> = HashMap::new();
    let mut roots: Vec<u32> = Vec::new();

    // One leaf per (geometry x paint) pairing, so no combination is skipped.
    let count = (GEOMETRY_KINDS * PAINT_KINDS) as u32;
    for k in 0..count {
        let i = k as usize;
        let id = k + 1;
        let style = Style {
            fills: vec![paint_variant(i, &mut rng)],
            // Multiple strokes, each with its own paint kind, alignment, caps
            // and dash pattern.
            strokes: (0..(i % 3))
                .map(|j| Stroke {
                    paint: Some(paint_variant(i + j + 1, &mut rng)),
                    width: 1.0 + j as f32,
                    cap: (j % 3) as u8,
                    join: ((j + 1) % 3) as u8,
                    dash_array: if j % 2 == 0 { vec![4.0, 2.0, 1.0] } else { Vec::new() },
                    dash_offset: j as f32 * 0.5,
                    miter_limit: 4.0 + j as f32,
                    alignment: match j % 3 {
                        0 => StrokeAlignment::Center,
                        1 => StrokeAlignment::Inner,
                        _ => StrokeAlignment::Outer,
                    },
                })
                .collect(),
            opacity: 0.25 + (i % 4) as f32 * 0.25,
            blend_mode: (i % 16) as u8,
            fill_rule: (i % 2) as u8,
            corner_radius: (i % 5) as f32 * 2.0,
            effects: (0..(i % 3)).map(|j| effect_variant(i + j)).collect(),
        };

        nodes.insert(id, Node {
            id,
            name: format!("node {id} \u{2713}"),
            node_type: match geometry_variant(i) {
                Geometry::Rect { .. } => NodeType::Rect,
                Geometry::Ellipse { .. } => NodeType::Ellipse,
                Geometry::Text { .. } => NodeType::Text,
                Geometry::Image { .. } => NodeType::Image,
                Geometry::Path { .. } => NodeType::Path,
            },
            transform: Transform2D {
                x: (i as f32) * 7.5 - 40.0,
                y: (i as f32) * -3.25 + 10.0,
                rotation_deg: (i as f32) * 11.0,
                skew_x_deg: if i % 4 == 0 { 12.0 } else { 0.0 },
                skew_y_deg: if i % 5 == 0 { -8.0 } else { 0.0 },
                scale_x: 1.0 + (i % 3) as f32 * 0.5,
                scale_y: 1.0 - (i % 4) as f32 * 0.15,
            },
            style,
            geometry: geometry_variant(i),
            children: Vec::new(),
            parent: None,
            visible: i % 7 != 0,
            locked: i % 6 == 0,
            is_mask: i % 8 == 0,
            mask_type: (i % 3) as u8,
            clip_content: i % 9 == 0,
            live_paint: false,
            boolean_op: if i % 11 == 0 { Some((i % 5) as u8) } else { None },
            gap_bridge_distance: None,
            bool_cache: Vec::new(),
        });
        roots.push(id);
    }

    // Wrap a slice of them in a group, and mark it Live Paint + a boolean op so
    // those node-level flags are exercised on a container too.
    let group_id = count + 1;
    let taken: Vec<u32> = roots.drain(..4).collect();
    for &c in &taken {
        nodes.get_mut(&c).unwrap().parent = Some(group_id);
    }
    nodes.insert(group_id, Node {
        id: group_id,
        name: "live paint group".into(),
        node_type: NodeType::Group,
        transform: Transform2D::IDENTITY,
        style: Style {
            fills: vec![paint_variant(0, &mut rng)],
            strokes: Vec::new(),
            opacity: 1.0, blend_mode: 0, fill_rule: 0, corner_radius: 0.0,
            effects: vec![effect_variant(3)],
        },
        geometry: Geometry::Rect { width: 0.0, height: 0.0 },
        children: taken,
        parent: None,
        visible: true,
        locked: false,
        is_mask: false,
        mask_type: 0,
        clip_content: true,
        live_paint: true,
        boolean_op: Some(2),
        gap_bridge_distance: None,
        bool_cache: Vec::new(),
    });
    roots.push(group_id);
    roots.sort_unstable();

    let scene = Scene {
        nodes,
        root_nodes: roots,
        selection: Vec::new(),
        vector_network: Default::default(),
        document_width: 1440.0,
        document_height: 900.0,
        images: [
            (1u32, ImageData { bytes: vec![0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4, 5], mime: "image/png".into() }),
            (2u32, ImageData { bytes: vec![0xFF, 0xD8, 0xFF, 9, 8, 7], mime: "image/jpeg".into() }),
        ].into_iter().collect(),
        artboards: vec![
            Artboard { id: 1, name: "Page one".into(), x: 0.0, y: 0.0, w: 1440.0, h: 900.0, background: Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 } },
            Artboard { id: 2, name: "Page två".into(), x: 1600.0, y: 0.0, w: 375.0, h: 812.0, background: Color { r: 0.1, g: 0.1, b: 0.12, a: 1.0 } },
        ],
        live_paint_group: Some(group_id),
        guides_x: vec![10.0, 250.5, -80.0],
        guides_y: vec![33.0, 700.25],
        swatches: vec![
            crate::Swatch { color: Color { r: 1.0, g: 0.5, b: 0.0, a: 1.0 }, name: "Brand".into() },
            crate::Swatch { color: Color { r: 0.0, g: 0.2, b: 0.9, a: 0.5 }, name: String::new() },
        ],
        text_paths: [(3u32, 5u32)].into_iter().collect(),
        markers: [(2u32, crate::NodeMarkers { start: 1, end: 3 })].into_iter().collect(),
        guide_locks: crate::GuideLocks { x: vec![10.0], y: vec![33.0] },
        meta: DocumentMeta {
            uuid: "11111111-2222-3333-4444-555555555555".into(),
            created_at_ms: 1_700_000_000_000,
            modified_at_ms: 1_700_000_999_000,
            app_version: "1.2.3-test".into(),
            title: "Rich document ✓".into(),
        },
        fonts: vec![
            FontFace { family: "Inter".into(), weight: 400, italic: false, bytes: vec![9u8; 128], source: "test".into() },
            FontFace { family: "Inter".into(), weight: 700, italic: true, bytes: vec![4u8; 96], source: "test".into() },
        ],
    };
    (scene, group_id + 1)
}

/// A document whose node graph is deliberately broken in a random way. These
/// are the shapes a corrupt or hostile file can encode.
fn malformed_document(seed: u64) -> ProtoDocument {
    let mut rng = StdRng::seed_from_u64(seed ^ 0xBAD_5EED);
    let n = rng.gen_range(1..12u32);

    let nodes: Vec<proto::ProtoNode> = (1..=n)
        .map(|id| proto::ProtoNode {
            id: if rng.gen_bool(0.15) { rng.gen_range(1..=n) } else { id }, // duplicates
            name: format!("n{id}"),
            node_type: rng.gen_range(0..7), // includes unknown types
            transform: Some(proto::ProtoTransform {
                x: 0.0, y: 0.0, rotation_deg: 0.0,
                skew_x_deg: 0.0, skew_y_deg: 0.0,
                scale_x: 1.0, scale_y: 1.0,
            }),
            geometry: Some(proto::ProtoGeometry::rect(10.0, 10.0)),
            // Children may name anything at all, including this node itself
            // and ids that were never defined.
            children: (0..rng.gen_range(0..4))
                .map(|_| rng.gen_range(1..=n + 3))
                .collect(),
            parent: if rng.gen_bool(0.5) { Some(rng.gen_range(1..=n + 3)) } else { None },
            visible: true,
            ..Default::default()
        })
        .collect();

    ProtoDocument {
        format_version: proto::FORMAT_VERSION,
        nodes,
        root_ids: (0..rng.gen_range(0..4)).map(|_| rng.gen_range(1..=n + 3)).collect(),
        next_id: rng.gen_range(0..3),
        ..Default::default()
    }
}

/// Wrap a payload in a valid envelope (correct length and checksum) so a
/// reader gets past the container and the *decoder* is what's under test.
fn envelope(payload: &[u8]) -> Vec<u8> {
    container::wrap(payload, 1)
}

// ─── Invariants ─────────────────────────────────────────────────────────────────

/// Everything `validate::repair` promises, checked directly against a scene.
///
/// Asserting these rather than "the repair counters look right" is deliberate:
/// the counters describe what the pass *did*, these describe what the caller
/// can now rely on — which is what the renderer and every traversal assume.
fn assert_scene_is_coherent(scene: &Scene, ctx: &str) {
    let known: HashSet<u32> = scene.nodes.keys().copied().collect();

    for root in &scene.root_nodes {
        assert!(known.contains(root), "{ctx}: root {root} does not exist");
    }
    assert_eq!(
        scene.root_nodes.len(),
        scene.root_nodes.iter().collect::<HashSet<_>>().len(),
        "{ctx}: a node is listed as a root twice, so it would be drawn twice",
    );

    let mut claimed: HashMap<u32, u32> = HashMap::new();
    for (&id, node) in &scene.nodes {
        for &child in &node.children {
            assert!(known.contains(&child), "{ctx}: node {id} has missing child {child}");
            assert!(
                claimed.insert(child, id).is_none(),
                "{ctx}: node {child} is claimed by two parents",
            );
        }
    }

    for (&id, node) in &scene.nodes {
        assert_eq!(
            node.parent,
            claimed.get(&id).copied(),
            "{ctx}: node {id} parent disagrees with the group listing it",
        );
    }

    // Every node reachable exactly once from the roots — which is both "no
    // cycles" and "nothing orphaned", the two properties that made traversal
    // unsafe before.
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack: Vec<u32> = scene.root_nodes.clone();
    let mut steps = 0usize;
    while let Some(id) = stack.pop() {
        steps += 1;
        assert!(
            steps <= scene.nodes.len() * 4 + 16,
            "{ctx}: traversal did not terminate — the graph still contains a cycle",
        );
        assert!(seen.insert(id), "{ctx}: node {id} reached twice");
        if let Some(node) = scene.nodes.get(&id) {
            stack.extend(node.children.iter().copied());
        }
    }
    assert_eq!(
        seen.len(),
        scene.nodes.len(),
        "{ctx}: {} node(s) unreachable from any root",
        scene.nodes.len() - seen.len(),
    );

    for node in scene.nodes.values() {
        let t = &node.transform;
        for (name, v) in [
            ("x", t.x), ("y", t.y), ("rotation", t.rotation_deg),
            ("scale_x", t.scale_x), ("scale_y", t.scale_y),
        ] {
            assert!(v.is_finite(), "{ctx}: node {} has non-finite {name}", node.id);
            assert!(v.abs() <= crate::MAX_COORD, "{ctx}: node {} {name} exceeds MAX_COORD", node.id);
        }
        if let Geometry::Path { subpaths, .. } = &node.geometry {
            for sp in subpaths {
                for p in &sp.points {
                    assert!(p.x.is_finite() && p.y.is_finite(), "{ctx}: non-finite path point");
                }
            }
        }
    }
}

// ─── Properties over valid documents ────────────────────────────────────────────

/// Saving must be a fixed point for *any* document, not just the fixtures.
/// Undo coalescing compares snapshots byte-for-byte, so a document shape that
/// re-serializes differently silently breaks history.
#[test]
fn any_document_round_trips_to_a_byte_exact_fixed_point() {
    for seed in 0..40u64 {
        let engine = random_engine(seed);
        let first = engine.serialize_proto();

        let mut reloaded = Engine::new();
        let status = reloaded.load_document(&first);
        assert!(status.contains(r#""ok":true"#), "seed {seed}: {status}");

        assert_eq!(
            reloaded.serialize_proto(),
            first,
            "seed {seed}: save→load→save is not byte-exact",
        );
    }
}

/// The same property for undo snapshots, which take the other serialization
/// path (bare, uncompressed, carries the selection).
#[test]
fn any_snapshot_round_trips_to_a_byte_exact_fixed_point() {
    for seed in 0..40u64 {
        let engine = random_engine(seed);
        let first = engine.serialize_scene();

        let mut reloaded = Engine::new();
        assert!(reloaded.deserialize_scene(&first), "seed {seed}: snapshot failed to load");
        assert_eq!(reloaded.serialize_scene(), first, "seed {seed}: snapshot is not a fixed point");
    }
}

/// A file this build wrote must never come back needing repair. If it does,
/// the writer is emitting something the validator considers damaged.
#[test]
fn a_document_we_wrote_never_needs_repair() {
    for seed in 0..40u64 {
        let engine = random_engine(seed);
        let (scene, _, report) = proto::deserialize_from_proto(&engine.serialize_proto())
            .unwrap_or_else(|e| panic!("seed {seed}: our own file failed to load: {e:?}"));
        assert!(
            report.is_clean(),
            "seed {seed}: we wrote a document that needed repair — {}",
            report.summary(),
        );
        assert_scene_is_coherent(&scene, &format!("seed {seed}"));
    }
}

/// No node may be lost or invented by a round trip.
#[test]
fn a_round_trip_preserves_every_node() {
    for seed in 0..40u64 {
        let engine = random_engine(seed);
        let before: HashSet<u32> = engine.get_root_nodes().into_iter().collect();
        let bytes = engine.serialize_proto();

        let mut reloaded = Engine::new();
        reloaded.load_document(&bytes);
        let after: HashSet<u32> = reloaded.get_root_nodes().into_iter().collect();
        assert_eq!(before, after, "seed {seed}: root set changed across a round trip");
    }
}

// ─── Totality under corruption ──────────────────────────────────────────────────

/// Truncation at *any* offset must be refused. The empty prefix is the case
/// that used to open as a blank document and then overwrite the original.
#[test]
fn no_truncation_of_any_document_is_ever_accepted() {
    for seed in 0..6u64 {
        let bytes = random_engine(seed).serialize_proto();
        for cut in 0..bytes.len() {
            assert!(
                proto::deserialize_from_proto(&bytes[..cut]).is_err(),
                "seed {seed}: a {cut}-byte prefix was accepted as a whole document",
            );
        }
        assert!(proto::deserialize_from_proto(&bytes).is_ok(), "seed {seed}: intact file rejected");
    }
}

/// Any single-byte corruption must be caught, or — if it lands somewhere the
/// checksum still covers consistently — must still yield a coherent scene.
/// What it must never do is panic or produce a half-built document.
#[test]
fn single_byte_corruption_never_panics_and_never_half_loads() {
    for seed in 0..4u64 {
        let bytes = random_engine(seed).serialize_proto();
        let mut rng = StdRng::seed_from_u64(seed);
        for _ in 0..150 {
            let mut corrupt = bytes.clone();
            let i = rng.gen_range(0..corrupt.len());
            corrupt[i] ^= 1 << rng.gen_range(0..8);

            match proto::deserialize_from_proto(&corrupt) {
                Err(_) => {}
                Ok((scene, _, _)) => assert_scene_is_coherent(&scene, "corrupted-but-accepted"),
            }
        }
    }
}

/// Arbitrary bytes behind a *valid* envelope. The container can't reject these
/// — length and checksum are correct — so this is what actually exercises the
/// protobuf decoder and everything downstream of it.
#[test]
fn arbitrary_payloads_behind_a_valid_envelope_are_total() {
    let mut rng = StdRng::seed_from_u64(0xF0_47);
    for _ in 0..300 {
        let len = rng.gen_range(0..400);
        let payload: Vec<u8> = (0..len).map(|_| rng.gen()).collect();
        match proto::deserialize_from_proto(&envelope(&payload)) {
            Err(LoadError::Unparseable) | Err(_) => {}
            Ok((scene, _, _)) => assert_scene_is_coherent(&scene, "random-payload"),
        }
    }
}

/// A well-formed protobuf document describing a broken graph — dangling ids,
/// cycles, self-references, duplicate ids, contradictory parents. The decoder
/// accepts it; `repair` must make it coherent.
#[test]
fn any_malformed_graph_is_repaired_into_a_coherent_scene() {
    for seed in 0..120u64 {
        let doc = malformed_document(seed);
        let bytes = envelope(&doc.encode_to_vec());

        let (scene, _, _) = proto::deserialize_from_proto(&bytes)
            .unwrap_or_else(|e| panic!("seed {seed}: malformed-but-decodable doc rejected: {e:?}"));
        assert_scene_is_coherent(&scene, &format!("malformed seed {seed}"));
    }
}

/// Repair must reach a fixed point in one pass. A second pass finding more to
/// fix would mean the first left the scene in a state it considers damaged.
#[test]
fn repair_is_idempotent_for_any_malformed_graph() {
    for seed in 0..120u64 {
        let doc = malformed_document(seed);
        let (scene, _) = doc.to_scene();
        let (once, first) = validate::repair(scene);
        let (_, second) = validate::repair(once);
        assert!(
            second.is_clean(),
            "seed {seed}: repair is not idempotent — first {}, second {}",
            first.summary(),
            second.summary(),
        );
    }
}

/// A repaired document must survive being saved and reloaded — the path a user
/// takes right after opening a damaged file.
#[test]
fn a_repaired_document_can_be_saved_and_reopened() {
    for seed in 0..40u64 {
        let doc = malformed_document(seed);
        let mut engine = Engine::new();
        let status = engine.load_document(&envelope(&doc.encode_to_vec()));
        assert!(status.contains(r#""ok":true"#), "seed {seed}: {status}");

        let saved = engine.serialize_proto();
        let (scene, _, report) = proto::deserialize_from_proto(&saved)
            .unwrap_or_else(|e| panic!("seed {seed}: re-save unreadable: {e:?}"));
        assert!(
            report.is_clean(),
            "seed {seed}: re-saving a repaired document still needs repair — {}",
            report.summary(),
        );
        assert_scene_is_coherent(&scene, &format!("re-saved seed {seed}"));
    }
}

/// Deeply nested and cyclic graphs must not exhaust the stack. The recursive
/// loader died here, and the failure mode was a wasm trap that takes the whole
/// editor down rather than an error the UI can report.
#[test]
fn pathological_depth_and_cycles_do_not_overflow_the_stack() {
    for (label, depth, cyclic) in [
        ("deep chain", 5_000u32, false),
        ("deep chain closing into a cycle", 5_000, true),
    ] {
        let mut nodes: Vec<proto::ProtoNode> = (1..=depth)
            .map(|id| proto::ProtoNode {
                id,
                name: String::new(),
                node_type: 3,
                transform: Some(proto::ProtoTransform {
                    x: 0.0, y: 0.0, rotation_deg: 0.0,
                    skew_x_deg: 0.0, skew_y_deg: 0.0,
                    scale_x: 1.0, scale_y: 1.0,
                }),
                children: if id < depth { vec![id + 1] } else { vec![] },
                visible: true,
                ..Default::default()
            })
            .collect();
        if cyclic {
            nodes[(depth - 1) as usize].children = vec![1];
        }

        let doc = ProtoDocument {
            format_version: proto::FORMAT_VERSION,
            nodes,
            root_ids: vec![1],
            next_id: depth + 1,
            ..Default::default()
        };

        let mut engine = Engine::new();
        let status = engine.load_document(&envelope(&doc.encode_to_vec()));
        assert!(status.contains(r#""ok":true"#), "{label}: {status}");

        // Still usable afterwards — the walks that overflowed run on every
        // edit and every frame, not just at load.
        engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let _ = engine.serialize_scene();
        let _ = engine.serialize_proto();
    }
}

// ─── Performance guards ─────────────────────────────────────────────────────────
//
// These protect the format's cost model, which is easy to wreck accidentally:
// autosave serializes on a timer and undo snapshots serialize on *every*
// mutation, so anything super-linear here shows up as the editor stalling on
// large documents. This project has already shipped one O(n²) of exactly that
// kind (a live-paint scan on insertion).
//
// They measure ALLOCATIONS, not milliseconds. The wall-clock version produced
// two false failures: once reporting a 36× blowup for work that is provably
// linear, once failing a single test in a run whose only unusual feature was a
// busy machine. Interleaving the samples and keeping each one's minimum
// reduced that flakiness without removing it, because no amount of sampling
// makes a shared CPU quiet — and a guard that fails at random teaches people
// to rerun until green, which is worse than not having the guard.
//
// An allocation count is deterministic: the same input gives the same number,
// on any machine, under any load. It is counted per-thread, so the rest of the
// suite running in parallel is invisible to it. And it is a real proxy for
// this work — serializing n nodes allocates in proportion to n.
//
// What they compare is cost PER NODE, not total cost. A ratio of totals sounds
// equivalent and is not: a quadratic is diluted by whatever linear work sits
// beside it, and a real injected O(n²) came to only 9.6× of an 8× baseline —
// under any threshold loose enough to be safe. Per node, a linear path is flat
// or falling as documents grow (buffer growth amortizes; measured 3.06 → 3.00
// allocations and 2394 → 1052 bytes per node from 250 to 8000 rects), while
// the same injected quadratic climbs to 3.4× its small-document cost. Flat
// versus climbing is a difference in kind, so the bound can be tight.
//
// What it cannot see is a quadratic that allocates nothing — a nested scan
// over data already in hand. `perf_saving_and_loading_stay_fast` still times
// that, and is `#[ignore]`d: run deliberately, on a quiet machine, rather than
// failing at random in everyone's default suite.

fn engine_with_rects(n: u32) -> Engine {
    let mut engine = Engine::new();
    // `add_rects` takes positional [x, y, w, h] tuples and silently yields
    // nothing on a shape it can't parse, so the count is asserted below —
    // otherwise a fixture typo turns every guard in this section into a
    // measurement of an empty document that passes for the wrong reason.
    let rects: Vec<String> = (0..n)
        .map(|i| format!("[{},{},24,18]", (i % 100) as f32 * 31.0, (i / 100) as f32 * 27.0))
        .collect();
    let ids = engine.add_rects(&format!("[{}]", rects.join(",")));
    assert_eq!(ids.len(), n as usize, "fixture failed to build {n} rects");
    engine
}

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    /// Allocations made by THIS thread. Per-thread so that a parallel test
    /// run — which is how `cargo test` always runs — cannot perturb a count.
    static ALLOC_CALLS: Cell<u64> = const { Cell::new(0) };
    /// Bytes requested by THIS thread. Counted alongside the calls because the
    /// two catch different quadratics: a nested loop allocating per element
    /// blows up the call count, while one that allocates an n-sized buffer per
    /// element keeps the count linear and blows up the bytes.
    static ALLOC_BYTES: Cell<u64> = const { Cell::new(0) };
}

/// The system allocator, counting calls on the way through.
///
/// `const { Cell::new(0) }` above matters: a lazily-initialized thread-local
/// allocates on first touch, from inside the allocator, which recurses.
struct CountingAllocator;

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_CALLS.with(|c| c.set(c.get() + 1));
        ALLOC_BYTES.with(|c| c.set(c.get() + layout.size() as u64));
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // A growing buffer reallocates, and that is real work worth seeing: a
        // quadratic that regrows one Vec repeatedly shows up here and nowhere
        // else.
        ALLOC_CALLS.with(|c| c.set(c.get() + 1));
        ALLOC_BYTES.with(|c| c.set(c.get() + new_size as u64));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

/// Allocation calls and bytes performed while running `f`.
fn allocations(mut f: impl FnMut()) -> (u64, u64) {
    let calls = ALLOC_CALLS.with(|c| c.get());
    let bytes = ALLOC_BYTES.with(|c| c.get());
    f();
    (
        ALLOC_CALLS.with(|c| c.get()) - calls,
        ALLOC_BYTES.with(|c| c.get()) - bytes,
    )
}

/// What one node costs: allocation calls and bytes, divided by node count.
///
/// Both, because a quadratic can hide in either alone. A nested loop that
/// allocates per pair blows up the call count; one that allocates an n-sized
/// buffer per node keeps the calls linear and blows up only the bytes. The
/// second shape passed a call-count-only guard when it was tried against it.
fn cost_per_node(n: u32, f: impl FnMut()) -> (f64, f64) {
    let (calls, bytes) = allocations(f);
    assert!(calls > 0, "measured zero allocations — the work under test did not run");
    (calls as f64 / n as f64, bytes as f64 / n as f64)
}

/// A bigger document must not cost MORE per node than a smaller one.
fn assert_stays_linear(what: &str, small: (f64, f64), large: (f64, f64)) {
    let calls = large.0 / small.0;
    assert!(
        calls < MAX_PER_NODE_GROWTH,
        "{what} looks super-linear: at {LARGE} nodes each one costs {calls:.2}× the \
         allocation calls it did at {SMALL} (a linear path stays at ~1×)",
    );
    let bytes = large.1 / small.1;
    assert!(
        bytes < MAX_PER_NODE_GROWTH,
        "{what} looks super-linear: at {LARGE} nodes each one allocates {bytes:.2}× the \
         bytes it did at {SMALL} (a linear path stays at ~1×)",
    );
}

const SMALL: u32 = 250;
/// 32× SMALL. Wide enough that a quadratic dominates the linear work beside it
/// rather than hiding inside it — at 8× it did hide.
const LARGE: u32 = 8_000;
/// Measured per-node growth is 0.98× at worst on a linear path and 3.4× for an
/// injected quadratic, so this sits with half again as much headroom as the
/// real code needs and still catches the thing it is for. The measurement does
/// not vary between runs, so the headroom is for honest changes to the writer,
/// not for machine noise.
const MAX_PER_NODE_GROWTH: f64 = 1.5;

/// Saving and loading must stay linear in document size.
///
/// Autosave serializes on a timer and undo snapshots serialize on *every*
/// mutation, so anything super-linear here surfaces as the editor stalling on
/// large documents. This project has already shipped one O(n²) of exactly that
/// shape — a live-paint scan that ran per insertion.
#[test]
fn saving_and_loading_scale_linearly_with_document_size() {
    let small = engine_with_rects(SMALL);
    let large = engine_with_rects(LARGE);
    let small_bytes = small.serialize_proto();
    let large_bytes = large.serialize_proto();

    assert_stays_linear(
        "saving",
        cost_per_node(SMALL, || { small.serialize_proto(); }),
        cost_per_node(LARGE, || { large.serialize_proto(); }),
    );

    assert_stays_linear(
        "loading",
        cost_per_node(SMALL, || { proto::deserialize_from_proto(&small_bytes).unwrap(); }),
        cost_per_node(LARGE, || { proto::deserialize_from_proto(&large_bytes).unwrap(); }),
    );

    // Output size must stay linear too — a different failure from the same
    // family, and the one that catches a writer which repeats itself.
    let bytes_per_node = |b: &Vec<u8>, n: u32| b.len() as f64 / n as f64;
    let size_growth =
        bytes_per_node(&large_bytes, LARGE) / bytes_per_node(&small_bytes, SMALL);
    assert!(
        size_growth < MAX_PER_NODE_GROWTH,
        "each node takes {size_growth:.2}× as many bytes on disk in a {LARGE}-node \
         document as in a {SMALL}-node one",
    );
}

/// The save path's cost model: snapshots are cheap, files are compressed.
///
/// Undo snapshots deliberately skip the envelope and the deflate pass because
/// they run on every mutation. If someone routes them through
/// `serialize_to_proto` for consistency, every keystroke starts paying
/// compression — this is the guard that notices.
#[test]
fn the_save_path_cost_model_holds() {
    let engine = engine_with_rects(LARGE);

    assert!(
        !container::has_envelope(&engine.serialize_scene()),
        "undo snapshots must not be enveloped",
    );

    // The snapshot IS the raw payload. Deflate shrinks that ~12×, so a real
    // compression pass moves this ratio far from 1 — which makes size a
    // stronger claim than speed was, as well as a deterministic one.
    let snapshot = engine.serialize_scene();
    let raw = proto::serialize_payload_only(&engine.scene_for_test(), LARGE + 1);
    let overhead = snapshot.len() as f64 / raw.len() as f64;
    assert!(
        (0.99..=1.01).contains(&overhead),
        "an undo snapshot should be the bare payload, but it is {overhead:.2}× that size \
         ({} vs {} bytes) — is it going through the file path?",
        snapshot.len(),
        raw.len(),
    );

    // Compression must earn the CPU it spends on every save.
    let saved = engine.serialize_proto();
    let gain = raw.len() as f64 / saved.len() as f64;
    assert!(
        gain > 3.0,
        "compression only achieved {gain:.1}× on {LARGE} rects — not worth the CPU",
    );
}

// ─── Full-variant round trip ────────────────────────────────────────────────────

/// Every paint, geometry, effect and node flag the format can encode must
/// survive a save/load cycle exactly.
///
/// The generator pairs each geometry kind with each paint kind, so no
/// combination is skipped, and asserts on the *decoded scene* rather than only
/// on bytes — byte equality alone would be satisfied by a writer that drops a
/// field consistently at both ends.
#[test]
fn every_encodable_variant_survives_a_round_trip() {
    for seed in 0..4u64 {
        let (scene, next_id) = rich_scene(seed);
        let bytes = proto::serialize_to_proto(&scene, next_id);

        let (back, _, report) = proto::deserialize_from_proto(&bytes)
            .unwrap_or_else(|e| panic!("seed {seed}: rich document failed to load: {e:?}"));
        assert!(
            report.is_clean(),
            "seed {seed}: rich document needed repair — {}",
            report.summary(),
        );

        assert_eq!(back.nodes.len(), scene.nodes.len(), "seed {seed}: node count changed");

        for (&id, before) in &scene.nodes {
            let after = back.nodes.get(&id).unwrap_or_else(|| panic!("seed {seed}: node {id} lost"));
            assert_eq!(format!("{:?}", after.geometry), format!("{:?}", before.geometry),
                "seed {seed}: node {id} geometry changed");
            assert_eq!(format!("{:?}", after.style), format!("{:?}", before.style),
                "seed {seed}: node {id} style changed");
            assert_eq!(after.transform, before.transform, "seed {seed}: node {id} transform changed");
            assert_eq!(
                (after.visible, after.locked, after.is_mask, after.mask_type, after.clip_content, after.live_paint, after.boolean_op),
                (before.visible, before.locked, before.is_mask, before.mask_type, before.clip_content, before.live_paint, before.boolean_op),
                "seed {seed}: node {id} flags changed",
            );
            assert_eq!(after.name, before.name, "seed {seed}: node {id} name changed");
        }

        // Document-level collections.
        assert_eq!(back.artboards.len(), scene.artboards.len(), "seed {seed}: artboards changed");
        for (a, b) in back.artboards.iter().zip(&scene.artboards) {
            assert_eq!((a.id, &a.name, a.x, a.y, a.w, a.h), (b.id, &b.name, b.x, b.y, b.w, b.h),
                "seed {seed}: artboard changed");
        }
        assert_eq!(back.images.len(), scene.images.len(), "seed {seed}: images changed");
        for (id, img) in &scene.images {
            let got = back.images.get(id).unwrap_or_else(|| panic!("seed {seed}: image {id} lost"));
            assert_eq!((&got.bytes, &got.mime), (&img.bytes, &img.mime), "seed {seed}: image {id} changed");
        }
        assert_eq!(back.fonts, scene.fonts, "seed {seed}: embedded fonts changed");
        assert_eq!(back.guides_x, scene.guides_x, "seed {seed}: vertical guides changed");
        assert_eq!(back.guides_y, scene.guides_y, "seed {seed}: horizontal guides changed");
        assert_eq!(back.meta, scene.meta, "seed {seed}: document metadata changed");
        assert_eq!(back.live_paint_group, scene.live_paint_group, "seed {seed}: live paint group changed");

        // And the fixed point still holds for a document this rich.
        assert_eq!(
            proto::serialize_to_proto(&back, next_id),
            bytes,
            "seed {seed}: rich document is not a byte-exact fixed point",
        );
    }
}

/// The undo path must preserve the same variants — it uses a different
/// serializer (`ProtoSnapshot`), so a field wired into one path and not the
/// other would be invisible to the file test above.
#[test]
fn every_encodable_variant_survives_an_undo_snapshot() {
    for seed in 0..4u64 {
        let (scene, next_id) = rich_scene(seed);
        let snap = proto::serialize_snapshot(&scene, next_id);
        let (back, _) = proto::deserialize_snapshot(&snap).expect("snapshot must decode");

        for (&id, before) in &scene.nodes {
            let after = back.nodes.get(&id).unwrap_or_else(|| panic!("seed {seed}: node {id} lost"));
            assert_eq!(format!("{:?}", after.style), format!("{:?}", before.style),
                "seed {seed}: node {id} style changed through a snapshot");
            assert_eq!(format!("{:?}", after.geometry), format!("{:?}", before.geometry),
                "seed {seed}: node {id} geometry changed through a snapshot");
        }
        assert_eq!(
            proto::serialize_snapshot(&back, next_id),
            snap,
            "seed {seed}: rich snapshot is not a byte-exact fixed point",
        );
    }
}

/// Guards the generator itself: if a new paint, geometry or effect kind is
/// added to the format without extending the generator, the round-trip tests
/// above would silently stop covering it. This fails loudly instead.
#[test]
fn the_generator_covers_every_variant_the_format_defines() {
    use crate::{Effect, Geometry, Paint};
    let mut rng = StdRng::seed_from_u64(1);

    let paints: HashSet<&'static str> = (0..PAINT_KINDS)
        .map(|i| match paint_variant(i, &mut rng) {
            Paint::Solid(_) => "solid",
            Paint::Gradient(g) => match g.gradient_type {
                crate::GradientType::Linear => "linear",
                crate::GradientType::Radial => "radial",
            },
            Paint::Pattern(_) => "pattern",
            Paint::Mesh(_) => "mesh",
        })
        .collect();
    assert_eq!(
        paints,
        ["solid", "linear", "radial", "pattern", "mesh"].into_iter().collect::<HashSet<_>>(),
        "a paint kind is missing from the generator",
    );

    let geoms: HashSet<&'static str> = (0..GEOMETRY_KINDS)
        .map(|i| match geometry_variant(i) {
            Geometry::Rect { .. } => "rect",
            Geometry::Ellipse { .. } => "ellipse",
            Geometry::Text { .. } => "text",
            Geometry::Image { .. } => "image",
            Geometry::Path { network: Some(_), .. } => "path+network",
            Geometry::Path { .. } => "path",
        })
        .collect();
    assert_eq!(
        geoms,
        ["rect", "ellipse", "text", "image", "path", "path+network"].into_iter().collect::<HashSet<_>>(),
        "a geometry kind is missing from the generator",
    );

    let effects: HashSet<&'static str> = (0..EFFECT_KINDS)
        .map(|i| match effect_variant(i) {
            Effect::Blur { radius_y: None, .. } => "blur",
            Effect::Blur { .. } => "blur-anisotropic",
            Effect::DropShadow { .. } => "drop-shadow",
            Effect::ColorMatrix { .. } => "color-matrix",
        })
        .collect();
    assert_eq!(
        effects,
        ["blur", "blur-anisotropic", "drop-shadow", "color-matrix"].into_iter().collect::<HashSet<_>>(),
        "an effect kind is missing from the generator",
    );
}

/// An undo snapshot's cost must not scale with the editor-owned collections.
///
/// Those four (swatches, text-path links, markers, guide locks) used to live on
/// the `Scene` as JSON *strings*, so every save parsed and re-rendered all four
/// — on every mutation, since undo snapshots take the same path. They are typed
/// values now and the JSON conversion happens only at the wasm boundary, where
/// the editor actually reads them. This guard fails if that moves back inward.
#[test]
fn snapshot_cost_does_not_scale_with_the_editor_owned_collections() {
    let bare = engine_with_rects(SMALL);

    let mut loaded = engine_with_rects(SMALL);
    let sw: Vec<String> = (0..40)
        .map(|i| format!(r#"{{"r":{},"g":0.5,"b":0,"a":1}}"#, i as f32 / 40.0))
        .collect();
    loaded.set_swatches_json(format!("[{}]", sw.join(",")));
    let mk: Vec<String> = (0..60)
        .map(|i| format!(r#""{i}":{{"start":"arrow","end":"circle"}}"#))
        .collect();
    loaded.set_markers_json(format!("{{{}}}", mk.join(",")));
    let tp: Vec<String> = (0..60).map(|i| format!(r#""{i}":{}"#, i + 1)).collect();
    loaded.set_text_paths_json(format!("{{{}}}", tp.join(",")));

    // Parsing 160 JSON entries per save would allocate hundreds of times; the
    // typed path costs three allocations more than the empty one. No machine
    // load can push a measurement across the gap between those two.
    // Both documents hold the same number of nodes, so a plain ratio is the
    // right comparison here — there is no size difference to normalize away.
    let (bare_calls, bare_bytes) = allocations(|| { bare.serialize_scene(); });
    let (full_calls, full_bytes) = allocations(|| { loaded.serialize_scene(); });
    let calls = full_calls as f64 / bare_calls as f64;
    let bytes = full_bytes as f64 / bare_bytes as f64;
    assert!(
        calls < 1.10 && bytes < 1.10,
        "populating the editor-owned collections made an undo snapshot allocate {calls:.3}× \
         the calls and {bytes:.3}× the bytes — they are probably being parsed or re-rendered \
         per save again",
    );
}

/// The wall-clock half of the guards above, kept for the one failure an
/// allocation count cannot see: a quadratic that allocates nothing.
///
/// `#[ignore]`d deliberately. Timing on a shared CPU is not reliable enough to
/// gate every run — that unreliability is what the guards above were rewritten
/// to escape — but it is worth having when someone is looking into performance
/// on a quiet machine:
///
///   cargo test --release -- --ignored perf_
#[test]
#[ignore]
fn perf_saving_and_loading_stay_fast() {
    /// Interleaved, so a contention spike cannot land on only one sample, and
    /// each side keeps its fastest run, so a spike is discarded rather than
    /// averaged in. Even then this is only trustworthy on an idle machine —
    /// which is the whole reason it no longer runs by default.
    fn time_ratio(runs: usize, mut a: impl FnMut(), mut b: impl FnMut()) -> f64 {
        let (mut ta, mut tb) = (std::time::Duration::MAX, std::time::Duration::MAX);
        for _ in 0..runs {
            let t = std::time::Instant::now();
            a();
            ta = ta.min(t.elapsed());

            let t = std::time::Instant::now();
            b();
            tb = tb.min(t.elapsed());
        }
        tb.as_secs_f64() / ta.as_secs_f64().max(1e-9)
    }

    let small = engine_with_rects(SMALL);
    let large = engine_with_rects(LARGE);
    let small_bytes = small.serialize_proto();
    let large_bytes = large.serialize_proto();

    // Derived from the sizes rather than hardcoded, so changing SMALL or LARGE
    // cannot silently decalibrate this the way a literal 24 did when LARGE grew.
    // Linear predicts the size ratio itself; quadratic predicts its square.
    let linear = LARGE as f64 / SMALL as f64;
    let limit = linear * 3.0;

    let save = time_ratio(4, || { small.serialize_proto(); }, || { large.serialize_proto(); });
    assert!(
        save < limit,
        "saving took {save:.1}× the time for {linear:.0}× the nodes \
         (linear ≈ {linear:.0}×, quadratic ≈ {:.0}×)",
        linear * linear,
    );

    let load = time_ratio(
        4,
        || { proto::deserialize_from_proto(&small_bytes).unwrap(); },
        || { proto::deserialize_from_proto(&large_bytes).unwrap(); },
    );
    assert!(
        load < limit,
        "loading took {load:.1}× the time for {linear:.0}× the nodes \
         (linear ≈ {linear:.0}×, quadratic ≈ {:.0}×)",
        linear * linear,
    );
}

