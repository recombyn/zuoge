/**
 * Context model for the floating contextual action bar.
 * Determines the current editor state and provides metadata for the bar UI.
 */

import type { InputManager } from './input';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';

/** Possible editor contexts that drive the action bar content.
 *
 *  Detection is priority-ordered and mutually exclusive:
 *    1. Modal states win (path-editing, pen-drawing) — you're mid-gesture.
 *    2. A selection wins over the active tool — the bar acts on what you have.
 *    3. A non-selection tool with nothing selected shows what the tool will do.
 *    4. Otherwise the bar is hidden.
 */
export type EditorContext =
    | 'empty' // selection tool, nothing selected — bar hidden
    | 'tool' // any non-selection tool active, nothing selected/in progress
    | 'single-shape' // one Rect/Ellipse/Path selected
    | 'text-selected' // one Text node selected
    | 'group-selected' // exactly one Group node selected
    | 'multi-select' // 2+ nodes selected
    | 'live-paint-object' // a Live Paint group selected (Selection tool)
    | 'live-paint' // paint-bucket tool active (wins over selection)
    | 'mesh' // mesh tool active (wins over selection)
    | 'pen-drawing' // input.currentPathPoints.length > 0
    | 'path-editing' // input.editingNodeId != null
    | 'guide-selected'; // input.selectedGuide != null (a ruler guide is clicked)

/** Selected node summary for the bar. */
export interface SelectedNodeInfo {
    id: number;
    name: string;
    node_type: string;
}

/** A single breadcrumb segment with metadata for clickable navigation. */
export interface BreadcrumbItem {
    id: number;
    name: string;
    nodeType: string;
}

/** Full context info passed to the bar for rendering. */
export interface ContextInfo {
    context: EditorContext;
    selectedIds: number[];
    selectedNodes: SelectedNodeInfo[];
    /** Breadcrumb trail for nested selection — each item has an id for navigation. */
    breadcrumb: BreadcrumbItem[];
    editingNodeId: number | null;
    /** Path point count — for editing (editingPoints) or pen-drawing (currentPathPoints) */
    pointCount: number;
    /** Number of anchor points currently selected in node-editing mode. */
    selectedPointCount: number;
    /** The first selected node's type (for context-specific controls like corner radius) */
    primaryNodeType: string | null;
}

/** Every tool that isn't plain selection gets a 'tool' context (hint + tool
 *  options) while nothing is selected or in progress. */
const NON_SELECTION_TOOLS = new Set([
    'direct',
    'pen',
    'pencil',
    'line',
    'rect',
    'ellipse',
    'polygon',
    'star',
    'text',
    'scissors',
    'paint-bucket',
]);

/**
 * Compute the current editor context from the live state of ui, input, and scene.
 * Priority-ordered detection ensures unambiguous context.
 */
export function getEditorContext(ui: UIEngine, input: InputManager, scene: WasmScene): ContextInfo {
    const selection = scene.engine!.get_selection();
    const selectedIds = Array.from(selection);

    // Build selected node info
    const selectedNodes: SelectedNodeInfo[] = selectedIds
        .map((id) => {
            const node = scene.getNode(id);
            if (!node) return null;
            return { id, name: node.name, node_type: node.node_type };
        })
        .filter((n): n is SelectedNodeInfo => n !== null);

    // Compute breadcrumb for primary selection
    const breadcrumb = selectedIds.length > 0 ? buildBreadcrumb(selectedIds[0], scene) : [];

    const editingNodeId = input.editingNodeId;
    const activeTool = ui.activeTool;

    // Point count: editing mode uses editingPoints, pen mode uses currentPathPoints
    let pointCount = 0;
    if (editingNodeId !== null && input.editingPoints) {
        pointCount = input.editingPoints.reduce((sum, sp) => sum + sp.points.length, 0);
    } else if (input.currentPathPoints.length > 0) {
        pointCount = input.currentPathPoints.length;
    }

    const selectedPointCount = editingNodeId !== null ? input.selectedPoints.size : 0;

    const primaryNodeType = selectedNodes.length > 0 ? selectedNodes[0].node_type : null;

    // Priority-ordered context detection: modal gesture > selection > tool > hidden
    let context: EditorContext;

    if (editingNodeId !== null) {
        context = 'path-editing';
    } else if (input.currentPathPoints.length > 0) {
        context = 'pen-drawing';
    } else if (input.selectedGuide && selectedIds.length === 0) {
        context = 'guide-selected';
    } else if (activeTool === 'paint-bucket') {
        // Live Paint is a mode: the tool wins over the current selection so the
        // bar always shows paint options (color, gaps, Make Live Paint Group).
        context = 'live-paint';
    } else if (activeTool === 'mesh') {
        // Mesh editing is a mode too: the bar shows mesh point actions.
        context = 'mesh';
    } else if (
        selectedIds.length === 1 &&
        primaryNodeType === 'Group' &&
        scene.getNodeLivePaint(selectedIds[0])
    ) {
        context = 'live-paint-object';
    } else if (selectedIds.length === 1 && primaryNodeType === 'Group') {
        context = 'group-selected';
    } else if (selectedIds.length === 1 && primaryNodeType === 'Text') {
        context = 'text-selected';
    } else if (selectedIds.length === 1) {
        context = 'single-shape';
    } else if (selectedIds.length > 1) {
        context = 'multi-select';
    } else if (NON_SELECTION_TOOLS.has(activeTool)) {
        context = 'tool';
    } else {
        context = 'empty';
    }

    return {
        context,
        selectedIds,
        selectedNodes,
        breadcrumb,
        editingNodeId,
        pointCount,
        selectedPointCount,
        primaryNodeType,
    };
}

/**
 * Build a breadcrumb trail from a node up to the root.
 * Returns e.g. [{id: 2, name: "Group 2", nodeType: "Group"}, {id: 5, name: "Rect 5", nodeType: "Rect"}]
 * — ancestors first, leaf last.
 */
function buildBreadcrumb(nodeId: number, scene: WasmScene): BreadcrumbItem[] {
    const crumbs: BreadcrumbItem[] = [];
    let currentId = nodeId;
    const visited = new Set<number>(); // safety guard against cycles

    while (!visited.has(currentId)) {
        visited.add(currentId);
        const node = scene.getNode(currentId);
        if (!node) break;
        crumbs.unshift({
            id: currentId,
            name: node.name || `${node.node_type} ${currentId}`,
            nodeType: node.node_type,
        });

        const parentId = scene.getNodeParent(currentId);
        if (parentId < 0) break; // root reached
        currentId = parentId;
    }

    return crumbs;
}
