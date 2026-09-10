use engine::*;

fn main() {
    let mut engine = Engine::new();
    
    // Create a path
    let subpaths = vec![Subpath {
        points: vec![
            PathPoint { x: 0.0, y: 0.0, cp1: glam::Vec2::new(0.0, 0.0), cp2: glam::Vec2::new(50.0, 50.0), corner_radius: 0.0 },
            PathPoint { x: 100.0, y: 0.0, cp1: glam::Vec2::new(50.0, 50.0), cp2: glam::Vec2::new(100.0, 0.0), corner_radius: 0.0 },
        ],
        closed: false,
    }];
    
    let json = serde_json::to_string(&subpaths).unwrap();
    let id = engine.add_path(&json);
    
    let bounds = engine.get_node_bounds(id);
    println!("Node Bounds: {:?}", bounds);
    
    let scene_json = engine.get_scene_json();
    let parsed: serde_json::Value = serde_json::from_str(&scene_json).unwrap();
    let node = &parsed["nodes"][id.to_string()];
    println!("Node: {}", serde_json::to_string_pretty(node).unwrap());
    
    // Now apply flatten
    engine.flatten_transform(id);
    
    let bounds2 = engine.get_node_bounds(id);
    println!("Node Bounds after flatten: {:?}", bounds2);
    
    let scene_json2 = engine.get_scene_json();
    let parsed2: serde_json::Value = serde_json::from_str(&scene_json2).unwrap();
    let node2 = &parsed2["nodes"][id.to_string()];
    println!("Node after flatten: {}", serde_json::to_string_pretty(node2).unwrap());
}
