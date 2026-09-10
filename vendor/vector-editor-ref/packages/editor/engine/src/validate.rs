//! Structural validation and repair of a freshly-loaded `Scene`.
//!
//! The container envelope proves a file arrived *intact*; it says nothing about
//! whether the graph inside it makes sense. A `ProtoDocument` can be perfectly
//! well-formed protobuf and still describe:
//!
//!   * a `root_ids` entry naming a node that isn't in the file
//!   * a group whose `children` list names a node that isn't in the file
//!   * a parent/child **cycle**, which sent the loader into unbounded recursion
//!     and stack-overflowed the wasm instance — an unrecoverable crash from
//!     merely opening a file
//!   * a child whose `parent` disagrees with the group that lists it (the two
//!     fields are redundant and nothing kept them in step)
//!   * NaN or infinite coordinates, which silently poison every bounds
//!     computation they touch
//!
//! None of these were checked. This pass makes loading total: any byte sequence
//! that decodes produces a *coherent* scene, and anything that had to be
//! changed is reported rather than silently swallowed.
//!
//! Repair, not rejection. A damaged file usually still holds most of someone's
//! work, and dropping it on the floor for one bad edge would be the worse
//! failure. Nodes are only ever re-homed, never deleted.

use crate::{Geometry, Scene, MAX_COORD};
use std::collections::{HashMap, HashSet};

/// What `repair` had to change. Empty means the file was well-formed.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct RepairReport {
    /// Node ids listed twice in the file; later definitions won.
    pub duplicate_ids: u32,
    /// `root_ids` entries naming nodes that don't exist.
    pub dangling_roots: u32,
    /// `children` entries naming nodes that don't exist.
    pub dangling_children: u32,
    /// Child edges removed because following them formed a cycle.
    pub cycles_broken: u32,
    /// Nodes whose `parent` disagreed with the group listing them.
    pub reparented: u32,
    /// Nodes reachable from no root, re-attached at the top level.
    pub orphans_rehomed: u32,
    /// Image nodes referencing bytes that aren't in the file.
    pub missing_images: u32,
    /// Coordinates that were NaN, infinite, or beyond `MAX_COORD`.
    pub coords_clamped: u32,
}

impl RepairReport {
    pub fn is_clean(&self) -> bool {
        *self == RepairReport::default()
    }

    /// One-line summary for the console and the "document repaired" notice.
    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        let mut add = |n: u32, what: &str| {
            if n > 0 {
                parts.push(format!("{n} {what}"));
            }
        };
        add(self.duplicate_ids, "duplicate ids");
        add(self.dangling_roots, "dangling roots");
        add(self.dangling_children, "dangling children");
        add(self.cycles_broken, "cycles");
        add(self.reparented, "mismatched parents");
        add(self.orphans_rehomed, "orphans");
        add(self.missing_images, "missing images");
        add(self.coords_clamped, "bad coordinates");
        if parts.is_empty() { "no repairs".into() } else { parts.join(", ") }
    }
}

/// Make `scene` structurally coherent, reporting every change.
pub fn repair(mut scene: Scene) -> (Scene, RepairReport) {
    let mut report = RepairReport::default();

    sanitize_coordinates(&mut scene, &mut report);

    let known: HashSet<u32> = scene.nodes.keys().copied().collect();

    // 1. Drop child edges pointing at nodes that aren't in the file.
    for node in scene.nodes.values_mut() {
        let before = node.children.len();
        node.children.retain(|id| known.contains(id));
        report.dangling_children += (before - node.children.len()) as u32;
    }

    // 2. Drop root entries pointing at nodes that aren't in the file, and any
    //    duplicate root entry (a node listed twice would be drawn twice).
    let mut seen_roots = HashSet::new();
    let before_roots = scene.root_nodes.len();
    scene.root_nodes.retain(|id| known.contains(id) && seen_roots.insert(*id));
    report.dangling_roots += (before_roots - scene.root_nodes.len()) as u32;

    // 3. Break cycles. `children` is authoritative — walking it from the roots
    //    is exactly what the renderer and transform passes do, so a traversal
    //    that terminates here is one that terminates everywhere.
    break_cycles(&mut scene, &mut report);

    // 4. Rebuild `parent` from the (now acyclic) child lists, and re-home
    //    anything no root can reach.
    rebuild_parents(&mut scene, &mut report);

    // 5. Image nodes whose bytes are absent. Reported, not removed: the file
    //    may simply have been saved by a build that failed to embed them, and
    //    the node still carries its position, size, and name.
    for node in scene.nodes.values() {
        if let Geometry::Image { image_id, .. } = &node.geometry {
            if !scene.images.contains_key(image_id) {
                report.missing_images += 1;
            }
        }
    }

    (scene, report)
}

/// Replace NaN/infinite values and clamp anything past `MAX_COORD`.
///
/// A single NaN propagates through every bounds union and transform compose it
/// touches, so one bad point can make an entire document unselectable and
/// invisible. Catching it at the door is far cheaper than defending every
/// downstream computation.
fn sanitize_coordinates(scene: &mut Scene, report: &mut RepairReport) {
    let mut fixed = 0u32;

    /// Returns 1 when it had to change the value, so callers can accumulate.
    fn clamp(v: &mut f32, fallback: f32) -> u32 {
        if !v.is_finite() {
            *v = fallback;
            1
        } else if v.abs() > MAX_COORD {
            *v = v.signum() * MAX_COORD;
            1
        } else {
            0
        }
    }
    macro_rules! fix {
        ($v:expr, $fallback:expr) => {
            fixed += clamp($v, $fallback)
        };
    }

    for node in scene.nodes.values_mut() {
        let t = &mut node.transform;
        fix!(&mut t.x, 0.0);
        fix!(&mut t.y, 0.0);
        fix!(&mut t.rotation_deg, 0.0);
        fix!(&mut t.skew_x_deg, 0.0);
        fix!(&mut t.skew_y_deg, 0.0);
        // A zero scale collapses the node to nothing and is not invertible, so
        // it falls back to 1 rather than to 0 like the translation components.
        fix!(&mut t.scale_x, 1.0);
        fix!(&mut t.scale_y, 1.0);
        if t.scale_x == 0.0 {
            t.scale_x = 1.0;
            fixed += 1;
        }
        if t.scale_y == 0.0 {
            t.scale_y = 1.0;
            fixed += 1;
        }

        match &mut node.geometry {
            Geometry::Rect { width, height } => {
                fix!(width, 100.0);
                fix!(height, 100.0);
            }
            Geometry::Ellipse { radius_x, radius_y } => {
                fix!(radius_x, 50.0);
                fix!(radius_y, 50.0);
            }
            Geometry::Image { width, height, .. } => {
                fix!(width, 100.0);
                fix!(height, 100.0);
            }
            Geometry::Text { font_size, line_height, letter_spacing, .. } => {
                fix!(font_size, 16.0);
                fix!(line_height, 1.2);
                fix!(letter_spacing, 0.0);
            }
            Geometry::Path { subpaths, network } => {
                for sp in subpaths.iter_mut() {
                    for p in sp.points.iter_mut() {
                        fix!(&mut p.x, 0.0);
                        fix!(&mut p.y, 0.0);
                        fix!(&mut p.cp1.x, 0.0);
                        fix!(&mut p.cp1.y, 0.0);
                        fix!(&mut p.cp2.x, 0.0);
                        fix!(&mut p.cp2.y, 0.0);
                        fix!(&mut p.corner_radius, 0.0);
                    }
                }
                if let Some(n) = network {
                    for v in n.vertices.iter_mut() {
                        fix!(&mut v.position.x, 0.0);
                        fix!(&mut v.position.y, 0.0);
                        fix!(&mut v.corner_radius, 0.0);
                    }
                }
            }
        }
    }

    for a in scene.artboards.iter_mut() {
        fix!(&mut a.x, 0.0);
        fix!(&mut a.y, 0.0);
        fix!(&mut a.w, 1000.0);
        fix!(&mut a.h, 1000.0);
    }
    for g in scene.guides_x.iter_mut().chain(scene.guides_y.iter_mut()) {
        fix!(g, 0.0);
    }

    report.coords_clamped += fixed;
}

/// Remove the child edges that close a cycle, by depth-first walk over **every**
/// node. An edge to a node already on the current path is a back edge and is
/// dropped; an edge to a node visited on an earlier branch is legal sharing of
/// nothing (the graph is a forest) and is dropped too, since a node with two
/// parents would be drawn and transformed twice.
///
/// Walking from the roots alone is not enough, and getting that wrong is
/// exactly how a cycle survived repair: a component no root can reach is never
/// visited, so its cycles stay intact — and `rebuild_parents` then promotes
/// those very nodes to roots, publishing the cycle into the scene the renderer
/// walks. Starting a fresh DFS at every unvisited node closes that hole and
/// makes the "no cycles anywhere" guarantee actually hold.
fn break_cycles(scene: &mut Scene, report: &mut RepairReport) {
    let mut visited: HashSet<u32> = HashSet::new();
    let mut removals: Vec<(u32, u32)> = Vec::new();

    // Roots first so that when a cycle must be broken, the edge that survives
    // is the one reachable from a root — the arrangement closest to what the
    // file intended. Remaining nodes are taken in id order for determinism.
    let mut starts: Vec<u32> = scene.root_nodes.clone();
    let mut rest: Vec<u32> = scene.nodes.keys().copied().collect();
    rest.sort_unstable();
    starts.extend(rest);

    for root in starts {
        if visited.contains(&root) {
            continue;
        }
        // Explicit stack: the recursive form is what overflowed in the first
        // place, and a repair pass must survive input a naive walk cannot.
        let mut stack: Vec<(u32, usize)> = vec![(root, 0)];
        let mut on_path: HashSet<u32> = HashSet::new();
        visited.insert(root);
        on_path.insert(root);

        while let Some(&mut (node_id, ref mut cursor)) = stack.last_mut() {
            let child = scene
                .nodes
                .get(&node_id)
                .and_then(|n| n.children.get(*cursor))
                .copied();
            match child {
                Some(child_id) => {
                    *cursor += 1;
                    if on_path.contains(&child_id) || visited.contains(&child_id) {
                        removals.push((node_id, child_id));
                    } else {
                        visited.insert(child_id);
                        on_path.insert(child_id);
                        stack.push((child_id, 0));
                    }
                }
                None => {
                    on_path.remove(&node_id);
                    stack.pop();
                }
            }
        }
    }

    for (parent, child) in removals {
        if let Some(node) = scene.nodes.get_mut(&parent) {
            if let Some(pos) = node.children.iter().position(|&c| c == child) {
                node.children.remove(pos);
                report.cycles_broken += 1;
            }
        }
    }
}

/// Derive every node's `parent` from the child lists, then re-home whatever no
/// root can reach. Runs after `break_cycles`, so the walk is guaranteed finite.
fn rebuild_parents(scene: &mut Scene, report: &mut RepairReport) {
    let mut parent_of: HashMap<u32, u32> = HashMap::new();
    for (&id, node) in scene.nodes.iter() {
        for &child in &node.children {
            parent_of.insert(child, id);
        }
    }

    for (&id, node) in scene.nodes.iter_mut() {
        let expected = parent_of.get(&id).copied();
        if node.parent != expected {
            node.parent = expected;
            report.reparented += 1;
        }
    }

    // A node some group claims as a child cannot also be a root, however the
    // file listed it — it would be drawn once at the top level and again inside
    // its parent. `children` is authoritative, so the root entry loses.
    //
    // This is reachable through no fault of the root list: a file can name a
    // node as a root that another node also lists as a child, and cycle
    // breaking legitimately keeps the child edge when it meets that node
    // mid-descent. The node then has a parent while still sitting in
    // `root_nodes`. It is already counted by the reparent above, so no
    // additional bookkeeping is needed here.
    scene.root_nodes.retain(|id| !parent_of.contains_key(id));

    // Anything the roots can't reach is invisible and uneditable — effectively
    // deleted, but still taking up space in the file. Put it back at the top
    // level so the user can see and remove it deliberately.
    let mut reachable: HashSet<u32> = HashSet::new();
    let mut stack: Vec<u32> = scene.root_nodes.clone();
    while let Some(id) = stack.pop() {
        if !reachable.insert(id) {
            continue;
        }
        if let Some(node) = scene.nodes.get(&id) {
            stack.extend(node.children.iter().copied());
        }
    }

    // Re-home only the TOP of each unreachable subtree — a node no root can
    // reach and that no group claims as a child. Its descendants come back with
    // it and keep their parents.
    //
    // Promoting every unreachable node instead would detach children from
    // groups that legitimately own them: the node would be listed both as a
    // root and in its parent's `children`, with `parent` cleared — leaving the
    // scene inconsistent in exactly the way this pass exists to prevent, and
    // making repair non-idempotent. `break_cycles` has already run, so every
    // parent chain terminates and each unreachable component has such a top.
    let mut orphans: Vec<u32> = scene
        .nodes
        .keys()
        .copied()
        .filter(|id| !reachable.contains(id) && !parent_of.contains_key(id))
        .collect();
    orphans.sort_unstable(); // deterministic ordering for byte-exact snapshots
    for id in orphans {
        scene.root_nodes.push(id);
        report.orphans_rehomed += 1;
    }
}

/// Count node ids that appeared more than once in the encoded document.
/// Conversion into the scene's `HashMap` silently collapses them, so the
/// duplicate count has to come from the proto side.
pub fn count_duplicate_ids(encoded_ids: impl Iterator<Item = u32>) -> u32 {
    let mut seen = HashSet::new();
    encoded_ids.filter(|id| !seen.insert(*id)).count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Color, Node, Paint, Style, Transform2D};

    fn group(id: u32, children: Vec<u32>) -> Node {
        Node {
            id,
            name: format!("g{id}"),
            node_type: crate::NodeType::Group,
            transform: Transform2D::IDENTITY,
            style: style(),
            geometry: Geometry::Rect { width: 0.0, height: 0.0 },
            children,
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
        }
    }

    fn rect(id: u32) -> Node {
        Node {
            node_type: crate::NodeType::Rect,
            geometry: Geometry::Rect { width: 10.0, height: 10.0 },
            ..group(id, Vec::new())
        }
    }

    fn style() -> Style {
        Style {
            fills: vec![Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })],
            strokes: Vec::new(),
            opacity: 1.0,
            blend_mode: 0,
            fill_rule: 0,
            corner_radius: 0.0,
            effects: Vec::new(),
        }
    }

    /// Set each node's `parent` to match the group that lists it, so a fixture
    /// is genuinely well-formed. Without this every fixture would trip the
    /// parent-reconciliation repair and mask what the test is actually about.
    fn with_consistent_parents(mut nodes: Vec<Node>) -> Vec<Node> {
        let links: Vec<(u32, u32)> = nodes
            .iter()
            .flat_map(|n| n.children.iter().map(move |&c| (c, n.id)))
            .collect();
        for (child, parent) in links {
            if let Some(n) = nodes.iter_mut().find(|n| n.id == child) {
                n.parent = Some(parent);
            }
        }
        nodes
    }

    fn scene_of(nodes: Vec<Node>, roots: Vec<u32>) -> Scene {
        Scene {
            nodes: nodes.into_iter().map(|n| (n.id, n)).collect(),
            root_nodes: roots,
            selection: Vec::new(),
            vector_network: Default::default(),
            document_width: 1000.0,
            document_height: 1000.0,
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
        }
    }

    #[test]
    fn a_well_formed_scene_is_left_alone() {
        let scene = scene_of(with_consistent_parents(vec![group(1, vec![2]), rect(2)]), vec![1]);
        let (out, report) = repair(scene);
        assert!(report.is_clean(), "unexpected repairs: {}", report.summary());
        assert_eq!(out.root_nodes, vec![1]);
        assert_eq!(out.nodes[&2].parent, Some(1));
    }

    #[test]
    fn direct_cycle_is_broken_and_terminates() {
        // 1 → 2 → 1: the shape that stack-overflowed the loader.
        let scene = scene_of(vec![group(1, vec![2]), group(2, vec![1])], vec![1]);
        let (out, report) = repair(scene);
        assert_eq!(report.cycles_broken, 1);
        assert_eq!(out.nodes[&2].children, Vec::<u32>::new());
        assert_eq!(out.nodes[&1].children, vec![2]);
    }

    #[test]
    fn self_referencing_node_is_broken() {
        let scene = scene_of(vec![group(1, vec![1])], vec![1]);
        let (out, report) = repair(scene);
        assert_eq!(report.cycles_broken, 1);
        assert!(out.nodes[&1].children.is_empty());
    }

    #[test]
    fn long_cycle_is_broken() {
        let scene = scene_of(
            vec![group(1, vec![2]), group(2, vec![3]), group(3, vec![4]), group(4, vec![2])],
            vec![1],
        );
        let (out, report) = repair(scene);
        assert_eq!(report.cycles_broken, 1);
        assert!(out.nodes[&4].children.is_empty());
    }

    /// A cycle in a component **no root can reach**.
    ///
    /// Found by the format fuzzer. Cycle breaking used to walk only from the
    /// roots, so this component was never visited and kept its cycle — and then
    /// orphan re-homing promoted its nodes to roots, publishing the intact
    /// cycle into the scene. The engine's recursive bounds walks then
    /// stack-overflowed on load, which in wasm kills the editor outright.
    #[test]
    fn a_cycle_no_root_can_reach_is_still_broken() {
        // Root 1 is a lone node; 2 ↔ 3 form an island with a cycle.
        let scene = scene_of(vec![rect(1), group(2, vec![3]), group(3, vec![2])], vec![1]);
        let (out, report) = repair(scene);

        assert!(report.cycles_broken >= 1, "the unreachable cycle was not broken");
        assert_no_cycles(&out);
        // ...and the island is still present, not silently dropped.
        assert!(out.nodes.contains_key(&2) && out.nodes.contains_key(&3));
    }

    /// A node listed as a root that another group also claims as a child.
    ///
    /// Found by the format fuzzer. Cycle breaking can legitimately keep the
    /// child edge when it meets such a node mid-descent, which left it both a
    /// root and a child — so it was drawn twice and traversals reached it
    /// twice. `children` is authoritative, so the root entry must lose.
    #[test]
    fn a_node_that_is_both_a_root_and_a_child_stops_being_a_root() {
        let scene = scene_of(vec![group(1, vec![2]), rect(2)], vec![1, 2]);
        let (out, _) = repair(scene);

        assert_eq!(out.root_nodes, vec![1], "node 2 must not remain a root");
        assert_eq!(out.nodes[&2].parent, Some(1));
        assert_eq!(out.nodes[&1].children, vec![2]);
    }

    /// Re-homing must lift only the TOP of an unreachable subtree. Promoting
    /// every unreachable node detached children from groups that legitimately
    /// owned them, leaving `parent` cleared while the group still listed them —
    /// which also made repair non-idempotent.
    #[test]
    fn rehoming_lifts_the_subtree_top_and_keeps_its_children_attached() {
        // 5 → 6 → 7 is a valid subtree that simply has no root.
        let scene = scene_of(
            vec![rect(1), group(5, vec![6]), group(6, vec![7]), rect(7)],
            vec![1],
        );
        let (out, report) = repair(scene);

        assert_eq!(report.orphans_rehomed, 1, "only the subtree top should be re-homed");
        assert!(out.root_nodes.contains(&5));
        assert!(!out.root_nodes.contains(&6) && !out.root_nodes.contains(&7));
        assert_eq!(out.nodes[&6].parent, Some(5));
        assert_eq!(out.nodes[&7].parent, Some(6));
    }

    /// Walk from the roots and assert every node is reached exactly once —
    /// which is "no cycles" and "nothing orphaned" in one check.
    fn assert_no_cycles(scene: &Scene) {
        let mut seen = HashSet::new();
        let mut stack = scene.root_nodes.clone();
        let mut steps = 0;
        while let Some(id) = stack.pop() {
            steps += 1;
            assert!(steps <= scene.nodes.len() * 4 + 16, "traversal did not terminate");
            assert!(seen.insert(id), "node {id} reached twice");
            if let Some(n) = scene.nodes.get(&id) {
                stack.extend(n.children.iter().copied());
            }
        }
        assert_eq!(seen.len(), scene.nodes.len(), "some nodes are unreachable");
    }

    #[test]
    fn dangling_roots_and_children_are_dropped() {
        let scene = scene_of(vec![group(1, vec![2, 42]), rect(2)], vec![1, 777]);
        let (out, report) = repair(scene);
        assert_eq!(report.dangling_children, 1);
        assert_eq!(report.dangling_roots, 1);
        assert_eq!(out.root_nodes, vec![1]);
        assert_eq!(out.nodes[&1].children, vec![2]);
    }

    #[test]
    fn parent_is_rebuilt_from_the_authoritative_child_list() {
        let mut child = rect(2);
        child.parent = Some(999); // disagrees with the group that lists it
        let scene = scene_of(vec![group(1, vec![2]), child], vec![1]);
        let (out, report) = repair(scene);
        assert_eq!(report.reparented, 1);
        assert_eq!(out.nodes[&2].parent, Some(1));
    }

    #[test]
    fn a_node_claimed_by_two_parents_keeps_only_the_first() {
        let scene = scene_of(vec![group(1, vec![3]), group(2, vec![3]), rect(3)], vec![1, 2]);
        let (out, report) = repair(scene);
        assert_eq!(report.cycles_broken, 1);
        let total: usize = [1u32, 2].iter().map(|p| out.nodes[p].children.len()).sum();
        assert_eq!(total, 1, "node 3 must be claimed exactly once");
    }

    #[test]
    fn unreachable_nodes_are_rehomed_not_lost() {
        // Node 5 exists but no root and no group reference it.
        let scene = scene_of(vec![group(1, vec![2]), rect(2), rect(5)], vec![1]);
        let (out, report) = repair(scene);
        assert_eq!(report.orphans_rehomed, 1);
        assert!(out.root_nodes.contains(&5));
        assert!(out.nodes.contains_key(&5), "orphan must be kept, not deleted");
    }

    #[test]
    fn duplicate_root_entries_are_collapsed() {
        let scene = scene_of(vec![rect(1)], vec![1, 1, 1]);
        let (out, report) = repair(scene);
        assert_eq!(out.root_nodes, vec![1]);
        assert_eq!(report.dangling_roots, 2);
    }

    #[test]
    fn non_finite_and_oversized_coordinates_are_repaired() {
        let mut n = rect(1);
        n.transform.x = f32::NAN;
        n.transform.y = f32::INFINITY;
        n.transform.scale_x = 0.0;
        n.geometry = Geometry::Rect { width: MAX_COORD * 10.0, height: 50.0 };
        let (out, report) = repair(scene_of(vec![n], vec![1]));
        assert_eq!(report.coords_clamped, 4);
        let t = out.nodes[&1].transform;
        assert_eq!(t.x, 0.0);
        assert_eq!(t.y, 0.0);
        assert_eq!(t.scale_x, 1.0);
        match out.nodes[&1].geometry {
            Geometry::Rect { width, .. } => assert_eq!(width, MAX_COORD),
            _ => panic!("geometry changed kind"),
        }
    }

    #[test]
    fn missing_image_bytes_are_reported_but_the_node_survives() {
        let mut n = rect(1);
        n.geometry = Geometry::Image { width: 10.0, height: 10.0, image_id: 7, pixelated: false };
        let (out, report) = repair(scene_of(vec![n], vec![1]));
        assert_eq!(report.missing_images, 1);
        assert!(out.nodes.contains_key(&1));
    }

    #[test]
    fn repair_is_idempotent() {
        let scene = scene_of(
            vec![group(1, vec![2, 42]), group(2, vec![1]), rect(9)],
            vec![1, 777],
        );
        let (once, first) = repair(scene);
        assert!(!first.is_clean());
        let (_twice, second) = repair(once);
        assert!(second.is_clean(), "second pass still repairing: {}", second.summary());
    }

    #[test]
    fn deeply_nested_chain_does_not_overflow() {
        // 10k-deep nesting: legal, and the recursive walk would blow the stack.
        let depth = 10_000u32;
        let mut nodes: Vec<Node> = (1..depth).map(|i| group(i, vec![i + 1])).collect();
        nodes.push(rect(depth));
        let (_out, report) = repair(scene_of(with_consistent_parents(nodes), vec![1]));
        assert!(report.is_clean(), "unexpected repairs: {}", report.summary());
    }
}
