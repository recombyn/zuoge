/**
 * Floating contextual action bar — Figma-style bottom bar that changes content
 * based on the current editor context (selection, tool, editing mode).
 *
 * The bar follows one strict grammar so every state reads the same way:
 *
 *   [what you're acting on] | [context-specific actions] | [flip/flatten] | [Duplicate · Delete]
 *
 * Rules:
 *  - The bar contains ACTIONS (verbs), never object properties. Fill, stroke,
 *    opacity, radius and typography live in the right-hand properties panel.
 *  - Tool states show a hint describing the gesture, plus tool options where
 *    they exist (the style a drawing tool / the paint bucket will apply).
 *  - Modal states (pen drawing, point editing) show progress + commit/cancel,
 *    with the committing action last.
 *  - Delete is always the last action and always styled as destructive.
 */

import type { AlignMode } from './align';
import { alignSelection, distributeSelection } from './align';
import { computeBlendSubpaths } from './blend';
import type { BoolOp } from './boolean_ops';
import { applyCrop, applyPathfinder, BOOL_OP_BY_INDEX, transformSubpaths } from './boolean_ops';
import { colorToHex, createColorSwatch, parseHex } from './color_picker';
import type { ContextInfo } from './context';
import { getEditorContext } from './context';
import {
    iconAlignBottom,
    iconAlignCenterH,
    iconAlignCenterV,
    iconAlignLeft,
    iconAlignRight,
    iconAlignTop,
    iconBoolExclude,
    iconBoolIntersect,
    iconBoolSubtract,
    iconBoolUnion,
    iconCopy,
    iconCornerDownRight,
    iconCreateOutlines,
    iconDistributeH,
    iconDistributeV,
    iconFlatten,
    iconFlipH,
    iconFlipV,
    iconGroup,
    iconLink,
    iconMeshGrid,
    iconMinusCircle,
    iconPaintBucket,
    iconPencil,
    iconPlusCircle,
    iconScissors,
    iconTrash,
    iconUngroup,
} from './icons';
import type { InputManager } from './input';
import { computeOffsetSubpaths } from './offset_path';
import type { Renderer } from './renderer';
import { computeSimplifiedSubpaths } from './simplify_path';
import type { Subpath } from './types';
import { isMeshGradient } from './types';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';
import type { WidthProfile } from './width_profile';

/** What each tool does, shown while the tool is armed and nothing is selected. */
const TOOL_HINTS: Record<string, string> = {
    direct: 'Click a shape to edit its anchor points',
    pen: 'Click to place the first point of a path',
    pencil: 'Drag to draw a freehand path',
    line: 'Drag to draw a line — Shift: constrain to 45°',
    rect: 'Drag to draw a rectangle — Shift: square, Alt: from center',
    ellipse: 'Drag to draw an ellipse — Shift: circle, Alt: from center',
    polygon: 'Drag to draw a polygon — Shift: constrain',
    star: 'Drag to draw a star — Shift: constrain',
    text: 'Click on the canvas to place text',
    scissors: 'Click a path segment or anchor point to cut the path there',
    'paint-bucket': 'Click a region to fill it, or a line to paint the edge',
    eyedropper: 'Click a shape to copy its appearance onto the selection',
};

/** Tools that draw vector geometry — the ones whose output is filed into the
 *  container you are inside. Mirrors `InputManager.DRAW_JOINING_TOOLS`; the bar
 *  only needs to know whether to say so. */
const CREATION_TOOLS = new Set(['line', 'rect', 'ellipse', 'polygon', 'star', 'pen', 'pencil']);

/** Tools whose next action applies the default style — they get style swatches. */
const TOOLS_WITH_FILL = new Set([
    'pen',
    'pencil',
    'rect',
    'ellipse',
    'polygon',
    'star',
    'paint-bucket',
]);
const TOOLS_WITH_STROKE = new Set([
    'pen',
    'pencil',
    'line',
    'rect',
    'ellipse',
    'polygon',
    'star',
    'paint-bucket',
]);

/** Hover descriptions for every action, keyed by its label/title. Applied
 *  centrally in createButton / createIconButton / createDropdown so nothing in the
 *  bar is a mystery. An unmapped action falls back to its own label. */
const ACTION_TOOLTIPS: Record<string, string> = {
    // Lifecycle + transform (always present)
    Duplicate: 'Make a copy of the selection.',
    Delete: 'Remove the selection.',
    'Flip Horizontal': 'Mirror the selection left ↔ right.',
    'Flip Vertical': 'Mirror the selection top ↕ bottom.',
    Flatten: 'Merge the selection into a single path.',
    // Single shape / path
    'Edit Path': 'Edit this path’s anchor points.',
    'Offset Copy…':
        'Create a new shape parallel to this path at a distance you set (negative = inset). The original is kept.',
    'Simplify…': 'Reduce the number of anchor points while keeping the shape.',
    'Reverse direction':
        'Flip the path’s direction — swaps start/end arrowheads, reverses text-on-path, and flips which subpaths are compound-path holes. No visible change on a plain shape.',
    'Outline: Taper': 'Convert the stroke into a filled shape that tapers to a point at the end.',
    'Outline: Taper both': 'Convert the stroke into a filled shape that tapers at both ends.',
    'Outline: Bulge': 'Convert the stroke into a filled shape that bulges in the middle.',
    'Release compound': 'Split a compound path back into separate paths.',
    // Text
    'Edit Text': 'Edit this text’s content.',
    'Create Outlines': 'Convert the text into editable vector paths (no longer editable as text).',
    'Detach from path': 'Stop this text from flowing along its path.',
    'On Path': 'Make the selected text flow along the selected path.',
    // Group / live paint
    Group: 'Group the selected objects together.',
    Ungroup: 'Break the group back into its objects.',
    Edit: 'Enter the group to edit its contents.',
    Expand: 'Expand into editable objects.',
    'Make Live Paint Group':
        'Turn the selection into a Live Paint group you can fill region by region.',
    Release: 'Release back into editable shapes.',
    // Combine (multi-select)
    Boolean: 'Combine the shapes into a non-destructive boolean group — children stay editable.',
    Union: 'Merge the shapes into one.',
    Subtract: 'Cut the upper shapes out of the bottom one.',
    Intersect: 'Keep only the region where the shapes overlap.',
    Exclude: 'Keep everything except the overlapping region.',
    More: 'More operations for this selection.',
    'Blend…': 'Generate a row of in-between shapes between the two selected objects.',
    'Compound path': 'Combine into one path where overlaps become holes (subpaths stay editable).',
    'Minus Back': 'Subtract everything behind the front shape from it.',
    'Join paths': 'Connect the endpoints of two open paths into one.',
    Join: 'Connect the endpoints of two open paths into one.',
    // Align / distribute
    'Align left': 'Align the left edges.',
    'Align center': 'Align horizontal centers.',
    'Align right': 'Align the right edges.',
    'Align top': 'Align the top edges.',
    'Align middle': 'Align vertical centers.',
    'Align bottom': 'Align the bottom edges.',
    'Distribute horizontally': 'Even out the horizontal gaps between objects.',
    'Distribute vertically': 'Even out the vertical gaps between objects.',
    // Path editing
    'Add Point': 'Click a segment to insert an anchor point where you click.',
    'Delete Point': 'Click an anchor point to remove it.',
    'Cut at Point': 'Split the path at the selected anchor point.',
    'Make Corner': 'Remove the selected point’s Bézier handles — its segments become straight.',
    'Edit Mesh': 'Edit this shape’s mesh fill — its points, colors and handles.',
    Done: 'Finish editing this path.',
    Finish: 'Finish and keep the path.',
    Cancel: 'Discard the path.',
    // Guides
    Lock: 'Lock this guide so it can’t be moved.',
    Unlock: 'Unlock this guide so it can be moved again.',
};

/** Node types the boolean operations can combine. */
const BOOLEAN_COMPATIBLE = new Set(['Path', 'Rect', 'Ellipse', 'Group']);

/** Label + icon for each boolean op, in the order shown in the dropdown. */
const BOOL_OP_ORDER: readonly BoolOp[] = ['union', 'subtract', 'intersect', 'exclude'];
const BOOL_OP_META: Record<BoolOp, { label: string; icon: () => string }> = {
    union: { label: 'Union', icon: () => iconBoolUnion(14) },
    subtract: { label: 'Subtract', icon: () => iconBoolSubtract(14) },
    intersect: { label: 'Intersect', icon: () => iconBoolIntersect(14) },
    exclude: { label: 'Exclude', icon: () => iconBoolExclude(14) },
};

export class ContextBar {
    private el: HTMLDivElement;
    private canvasContainer: HTMLElement;
    private ui: UIEngine;
    private input: InputManager;
    private scene: WasmScene;

    /** Cache key for the last render — avoids redundant DOM rebuilds. */
    private _lastSignature: string = '';

    constructor(
        canvasContainer: HTMLElement,
        ui: UIEngine,
        input: InputManager,
        scene: WasmScene,
        _renderer: Renderer,
    ) {
        this.canvasContainer = canvasContainer;
        this.ui = ui;
        this.input = input;
        this.scene = scene;

        // Create the bar element
        this.el = document.createElement('div');
        this.el.id = 'context-bar';
        canvasContainer.appendChild(this.el);

        // Initial render
        this.refresh();
    }

    /** Recompute context and update the bar. Called from syncWithSelection / setActiveTool / etc. */
    refresh() {
        const info = getEditorContext(this.ui, this.input, this.scene);

        // Toggle editing-mode class on canvas container
        const isEditing = info.context === 'path-editing' || info.context === 'pen-drawing';
        this.canvasContainer.classList.toggle('editing-mode', isEditing);

        // Build a signature from the context state that drives the bar's DOM.
        // If nothing relevant changed, skip the expensive innerHTML rebuild.
        const sig = this.buildSignature(info);
        if (sig === this._lastSignature) return;
        this._lastSignature = sig;

        this.render(info);
    }

    /** Build a cache key that captures everything affecting the bar's rendered output. */
    private buildSignature(info: ContextInfo): string {
        const types = info.selectedNodes.map((n) => n.node_type).join(',');
        const names = info.selectedNodes.map((n) => n.name).join(',');
        // Tool contexts render the default-style swatches, so their colors are
        // part of the signature; selection contexts don't show any properties.
        const styleSig =
            info.context === 'tool'
                ? `|${this.ui.rgbToHex(this.ui.getActiveFillColor())}|${this.ui.rgbToHex(this.ui.getActiveStrokeColor())}`
                : info.context === 'live-paint'
                  ? `|${this.ui.rgbToHex(this.ui.getLivePaintFill())}|${this.ui.rgbToHex(this.ui.getLivePaintStroke())}`
                  : '';
        // Live Paint bar depends on whether a group is active, on whether the
        // bucket is loaded with None (the swatch renders differently and the
        // hint changes), and on the gap distance in force — which is now a
        // property of the group, so switching groups can change it.
        const lpGroup = this.scene.getLivePaintGroup();
        // The bucket's gradient has to be in here, and was not: the bar renders
        // ENTIRELY different controls for solid vs gradient (stop swatches and a
        // type selector instead of one swatch), and `refresh()` returns early on
        // an unchanged signature. So Solid⇄Gradient set the mode and left the bar
        // showing the other mode's controls — the stop swatches were unreachable,
        // and the button looked dead.
        const grad = this.ui.getLivePaintGradient();
        const gradSig = grad
            ? `|grad${grad.gradient_type}:${grad.stops
                  .map((s) => `${colorToHex(s.color)}@${s.offset.toFixed(3)}`)
                  .join(',')}`
            : '|nograd';
        const lpSig =
            info.context === 'live-paint' || info.context === 'tool'
                ? `|lp${lpGroup}|gap${
                      lpGroup >= 0
                          ? this.scene.getEffectiveGapBridgeDistance(lpGroup)
                          : this.scene.getGapBridgeDistance()
                  }|none${this.ui.isLivePaintFillNone() ? 1 : 0}${
                      this.ui.isLivePaintStrokeNone() ? 1 : 0
                  }|w${this.ui.getLivePaintStrokeWidth()}${gradSig}`
                : '';
        // A selected Boolean Group's controls show its current op, so it's part
        // of the signature (switching the op must re-render the bar).
        const boolSig =
            info.context === 'group-selected' && info.selectedIds.length === 1
                ? `|bop${this.scene.getBooleanOp(info.selectedIds[0])}`
                : '';
        // Single-shape path controls (Simplify point-count gate, Outline Width
        // open-stroked-path gate) depend on the path's geometry and whether it has
        // a stroke, both of which in-place edits mutate — hash them so the bar
        // rebuilds after Simplify/Offset/adding or removing a stroke.
        let geoSig = '';
        if (info.context === 'single-shape' && info.selectedIds.length === 1) {
            const subs = this.scene.getNodeGeometry(info.selectedIds[0])?.Path?.subpaths;
            if (subs) {
                const pts = subs.reduce((n, s) => n + s.points.length, 0);
                const anyOpen = subs.some((s) => !s.closed) ? 'o' : 'c';
                const hasStroke =
                    (this.scene.getNodeStyle(info.selectedIds[0])?.strokes?.length ?? 0) > 0
                        ? 's'
                        : '';
                geoSig = `|geo${pts}${anyOpen}${hasStroke}`;
            }
        }
        // Guide selection (+ its lock state) drives the guide bar.
        const g = this.input.selectedGuide;
        const guideSig = g
            ? `|guide${g.axis}${g.index}${this.input.selectedGuideLocked() ? 'L' : ''}`
            : '';
        // "Make Corner" is enabled only while a selected anchor still has
        // handles; retracting them doesn't change any count, so hash the
        // handle-presence bit to force the bar to re-disable the button.
        const cornerSig =
            info.context === 'path-editing'
                ? `|corner${this.input.selectedPointsHaveHandles() ? 1 : 0}`
                : '';
        // Mesh bar shows grid dims + selected point count; both change without
        // any node-selection change, so they're part of the signature.
        const me = this.ui.meshEdit;
        const meshSig =
            info.context === 'mesh'
                ? me.isActive()
                    ? `|mesh${me.mesh()?.rows}x${me.mesh()?.cols}:${me.selectedVertices.size}`
                    : '|mesh-idle'
                : '';
        // The intruder hint appears and disappears with no selection or tool
        // change behind it, so without it here the bar keeps its old contents.
        const intruderSig = `|intr${this.input.livePaintIntruder ?? 0}`;
        return `${info.context}|${this.ui.activeTool}|${info.selectedIds.join(',')}|${types}|${names}|${info.pointCount}|${info.selectedPointCount}|${this.input.addPointMode ? 1 : 0}${styleSig}${lpSig}${boolSig}${geoSig}${guideSig}${cornerSig}${meshSig}${intruderSig}`;
    }

    /** Rebuild the bar DOM based on context info. */
    private render(info: ContextInfo) {
        this.el.innerHTML = '';

        switch (info.context) {
            case 'empty':
                break; // no selection, no armed tool — the bar hides itself (:empty)
            case 'tool':
                this.renderTool();
                break;
            case 'single-shape':
                this.renderSingleShape(info);
                break;
            case 'text-selected':
                this.renderTextSelected(info);
                break;
            case 'group-selected':
                this.renderGroupSelected(info);
                break;
            case 'multi-select':
                this.renderMultiSelect(info);
                break;
            case 'live-paint':
                this.renderLivePaint(info);
                break;
            case 'mesh':
                this.renderMesh();
                break;
            case 'live-paint-object':
                this.renderLivePaintObject(info);
                break;
            case 'pen-drawing':
                this.renderPenDrawing(info);
                break;
            case 'path-editing':
                this.renderPathEditing(info);
                break;
            case 'guide-selected':
                this.renderGuideSelected();
                break;
        }

        this.appendDrawContainerNotice();
    }

    /**
     * "Drawing into <container>", while the next shape drawn would be filed into
     * the group you are inside (Illustrator's isolation-mode rule).
     *
     * It goes here, after whichever bar rendered, rather than inside the tool
     * bar: the rule needs a selection to read the context from, and with a
     * selection the bar shows a SELECTION context, so a notice in the tool
     * branch would only ever appear when the rule did not apply. Illustrator can
     * leave this implicit because isolation mode dims the rest of the artwork;
     * with no such cue, saying it is what keeps the behaviour from being a
     * surprise that depends on invisible state.
     */
    private appendDrawContainerNotice() {
        if (!CREATION_TOOLS.has(this.ui.activeTool)) return;
        const target = this.input.drawContainerTarget();
        if (target === null) return;
        const name = this.scene.getNodeName(target) || 'Group';
        this.el.appendChild(this.createBadge(`Drawing into ${name}`));
    }

    /** A ruler guide is selected: lock/unlock it or delete it. */
    private renderGuideSelected() {
        const axis = this.input.selectedGuide?.axis;
        this.el.appendChild(this.createBadge(axis === 'x' ? 'Vertical guide' : 'Horizontal guide'));
        this.el.appendChild(this.createSeparator());

        const locked = this.input.selectedGuideLocked();
        const lockIcon = locked
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        this.el.appendChild(
            this.createButton(
                locked ? 'Unlock' : 'Lock',
                lockIcon,
                () => this.input.toggleSelectedGuideLock(),
                false,
                undefined,
                locked
                    ? 'Unlock this guide so it can be moved again.'
                    : 'Lock this guide in place so it can’t be moved by dragging.',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Delete',
                iconTrash(14),
                () => this.input.deleteSelectedGuide(),
                true,
                '⌫',
                'Delete this guide.',
            ),
        );
    }

    // ─── Context Renderers ──────────────────────────────────────────

    /** Armed tool, nothing selected: what the tool will do + the style it applies. */
    private renderTool() {
        const tool = this.ui.activeTool;

        if (TOOLS_WITH_FILL.has(tool)) {
            this.el.appendChild(
                this.createColorSwatch(
                    'fill',
                    this.ui.rgbToHex(this.ui.getActiveFillColor()),
                    (color) => {
                        this.ui.updateActiveFillColor(color);
                    },
                ),
            );
        }
        if (TOOLS_WITH_STROKE.has(tool)) {
            this.el.appendChild(
                this.createColorSwatch(
                    'stroke',
                    this.ui.rgbToHex(this.ui.getActiveStrokeColor()),
                    (color) => {
                        this.ui.updateActiveStrokeColor(color);
                    },
                ),
            );
        }
        if (TOOLS_WITH_FILL.has(tool)) {
            this.el.appendChild(this.createSeparator());
        }

        // Live Paint gap closing: bridge small openings so not-quite-closed
        // regions become fillable (Illustrator's Gap Options).
        if (tool === 'paint-bucket') {
            this.el.appendChild(this.createGapControl());
            this.el.appendChild(this.createSeparator());
        }

        this.el.appendChild(this.createHint(TOOL_HINTS[tool] || `${tool} tool`));
    }

    /** A Live Paint group selected with the Selection tool: it's a special
     *  object, so it gets Paint/Enter/Expand/Release rather than the plain
     *  group's Enter/Ungroup pair.
     *
     *  There are two things you can do to one of these and they used to share a
     *  single button labelled "Edit", which armed the paint bucket — so the one
     *  control that said "edit" was the one that did not let you edit anything,
     *  and the shapes inside had no button at all. They are separate verbs and
     *  they read as separate buttons: Paint changes the colours, Enter Group
     *  gets you to the geometry (as does double-clicking it, like any group). */
    private renderLivePaintObject(info: ContextInfo) {
        const id = info.selectedIds[0];
        this.el.appendChild(this.createBadge(this.scene.getNodeName(id) || 'Live Paint'));
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createButton(
                'Paint',
                iconPaintBucket(14),
                () => {
                    this.input.enterLivePaintGroup(id);
                },
                false,
                'B',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Enter Group',
                iconCornerDownRight(14),
                () => {
                    this.input.enterSelectedNode(id);
                },
                false,
                '⏎',
            ),
        );

        // Expand bakes the painted faces/edges into real, editable shapes;
        // Release drops them and hands back a plain group. Same pair, same order,
        // same icons as a Boolean Group's Flatten/Release — these are the two
        // special objects in the editor and they should not need learning twice.
        this.el.appendChild(
            this.createButton('Expand', iconCreateOutlines(14), () => {
                this.input.expandLivePaintGroup(id);
            }),
        );

        this.el.appendChild(
            this.createButton('Release', iconUngroup(14), () => {
                this.input.releaseLivePaintGroup(id);
            }),
        );

        this.appendTransformActions(info, { flatten: false });
        this.appendLifecycleActions();
    }

    /** Mesh tool bar: grid info, point actions, and a Done exit. Actions only
     *  (verbs) — the point COLOR lives in the Fill panel with the other
     *  appearance properties. */
    private renderMesh() {
        const me = this.ui.meshEdit;
        const mesh = me.isActive() ? me.mesh() : null;
        if (!mesh) {
            this.el.appendChild(
                this.createHint(
                    'Click a filled shape to turn its fill into a mesh — then click inside it to add lines.',
                ),
            );
            return;
        }

        const sel = me.selectedVertices.size;
        this.el.appendChild(this.createBadge(`${mesh.rows} × ${mesh.cols} mesh`));
        this.el.appendChild(this.createBadge(sel === 1 ? '1 point' : `${sel} points`));
        this.el.appendChild(this.createSeparator());

        const refreshAfter = () => {
            this.ui.syncWithSelection();
            this.refresh();
        };

        // Select every mesh point (handy before recoloring or nudging).
        this.el.appendChild(
            this.createButton(
                'Select all',
                iconGroup(14),
                () => {
                    const m = me.mesh();
                    if (!m) return;
                    me.selectedVertices.clear();
                    for (let vi = 0; vi < m.vertices.length; vi++) me.selectedVertices.add(vi);
                    this.input.renderer.requestRender();
                    refreshAfter();
                },
                false,
                undefined,
                'Select every mesh point.',
            ),
        );

        // Smooth: clear custom handles on the selected points.
        const smooth = this.createButton(
            'Smooth points',
            iconCornerDownRight(14),
            () => {
                if (me.resetHandles()) refreshAfter();
            },
            false,
            undefined,
            'Reset the selected points’ handles so their mesh lines curve smoothly.',
        );
        if (sel === 0) smooth.setAttribute('disabled', '');
        this.el.appendChild(smooth);

        // Delete the grid lines through the selected points (Delete key).
        const del = this.createButton(
            'Delete lines',
            iconTrash(14),
            () => {
                if (me.deleteLinesThroughSelection()) refreshAfter();
            },
            true,
            '⌫',
            'Remove the grid lines through the selected points.',
        );
        if (sel === 0) del.setAttribute('disabled', '');
        this.el.appendChild(del);

        this.el.appendChild(this.createSeparator());

        // Done: leave mesh editing (Escape does the same, in two steps).
        this.el.appendChild(
            this.createButton(
                'Done',
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
                () => {
                    this.ui.setActiveTool('selection');
                    this.ui.syncWithSelection();
                },
                false,
                'Esc',
                'Finish mesh editing and return to the Selection tool.',
            ),
        );
    }

    /**
     * Gap-closing control for the Live Paint tool: how far apart two open ends
     * may be and still count as a closed region.
     *
     * The value belongs to the GROUP being painted, not the document — one
     * sketch can need a wide tolerance without loosening every other group in
     * the file. With no group targeted the control edits the document default,
     * which is what a newly made group inherits.
     *
     * Presets cover the common cases; the number beside them is there because
     * "how big is the gap in my drawing" is a measurement, not a menu choice.
     */
    private createGapControl(): HTMLElement {
        const presets: Array<[string, number]> = [
            ['No gaps', 0],
            ['Small gaps', 4],
            ['Medium gaps', 12],
            ['Large gaps', 32],
            ['Huge gaps', 80],
            ['Enormous gaps', 200],
        ];
        // The group being painted, if any — otherwise this edits the default.
        const group = this.scene.getLivePaintGroup();
        const target = group >= 0 ? group : null;
        const read = () =>
            target === null
                ? this.scene.getGapBridgeDistance()
                : this.scene.getEffectiveGapBridgeDistance(target);
        const write = (d: number) => {
            if (target === null) this.scene.setGapBridgeDistance(d);
            else this.scene.setNodeGapBridgeDistance(target, d);
            this.input.renderer.requestRender();
        };

        const wrapper = document.createElement('div');
        wrapper.className = 'cb-swatch-wrapper';
        wrapper.setAttribute(
            'data-tooltip',
            target === null
                ? 'Close gaps up to this size — the default for new Live Paint groups'
                : 'Close gaps up to this size in this Live Paint group',
        );

        const row = document.createElement('div');
        row.className = 'cb-inline-row';

        const select = document.createElement('select');
        select.className = 'cb-select';
        const current = read();
        for (const [label, px] of presets) {
            const opt = document.createElement('option');
            opt.value = String(px);
            opt.textContent = label;
            if (px === current) opt.selected = true;
            select.appendChild(opt);
        }
        // A value between presets is legitimate (it came from the number field),
        // so name it rather than silently snapping the menu to a neighbour.
        if (!presets.some(([, px]) => px === current)) {
            const opt = document.createElement('option');
            opt.value = String(current);
            opt.textContent = `Custom (${current})`;
            opt.selected = true;
            select.insertBefore(opt, select.firstChild);
        }

        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'cb-number';
        num.min = '0';
        num.step = '1';
        num.value = String(current);
        num.title = 'Gap size in document units';

        select.addEventListener('change', () => {
            const d = parseFloat(select.value);
            num.value = String(d);
            write(d);
        });
        // Commit on change/blur, not on every keystroke: each write is an undo
        // step and forces a graph rebuild, and typing "120" would cost three.
        num.addEventListener('change', () => {
            const d = Math.max(0, parseFloat(num.value) || 0);
            num.value = String(d);
            write(d);
            this.refresh();
        });

        row.appendChild(select);
        row.appendChild(num);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'cb-swatch-label';
        labelSpan.textContent = target === null ? 'Gaps (default)' : 'Gaps';

        wrapper.appendChild(row);
        wrapper.appendChild(labelSpan);
        return wrapper;
    }

    /**
     * The bucket's fill/stroke swatch with a None state next to it.
     *
     * None is what un-paints a region: with it selected the bucket removes the
     * fill (or the edge's stroke) instead of replacing it. Modelled as a value
     * of the colour rather than a separate eraser tool, so there is no mode to
     * get stuck in and the swatch always shows what the next click will do.
     */
    private createLivePaintSwatch(
        kind: 'fill' | 'stroke',
        hex: string,
        onColor: (color: string) => void,
    ): HTMLElement {
        const isNone =
            kind === 'fill' ? this.ui.isLivePaintFillNone() : this.ui.isLivePaintStrokeNone();
        const setNone = (v: boolean) => {
            if (kind === 'fill') this.ui.setLivePaintFillNone(v);
            else this.ui.setLivePaintStrokeNone(v);
        };

        const wrapper = document.createElement('div');
        wrapper.className = 'cb-swatch-wrapper';
        wrapper.setAttribute('data-tooltip', `Live Paint ${kind}`);

        const row = document.createElement('div');
        row.className = 'cb-inline-row';

        const { el: swatch } = createColorSwatch({
            color: parseHex(hex) ?? { r: 0, g: 0, b: 0, a: 1 },
            alpha: false,
            title: `Live Paint ${kind}`,
            className: `cb-swatch${isNone ? ' cb-swatch-none' : ''}`,
            onInput: (c) => {
                onColor(colorToHex(c, false));
                // Choosing a colour is the way back from None. Restyled in
                // place rather than through refresh(): rebuilding the bar mid-
                // drag would tear out the very swatch the picker is anchored to.
                setNone(false);
                swatch.classList.remove('cb-swatch-none');
                none.classList.remove('active');
            },
        });
        row.appendChild(swatch);

        const none = document.createElement('button');
        none.type = 'button';
        none.className = `cb-none-toggle${isNone ? ' active' : ''}`;
        none.textContent = 'None';
        none.title =
            kind === 'fill'
                ? 'Paint nothing — click a region to clear its fill'
                : 'Paint nothing — ⇧-click a line to clear its stroke';
        none.addEventListener('click', (e) => {
            e.preventDefault();
            setNone(!isNone);
            this.refresh();
        });
        row.appendChild(none);
        wrapper.appendChild(row);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'cb-swatch-label';
        // "Line", not "Stroke": in this bar it is not the selected shape's stroke
        // (nothing is selected) — it is the colour a ⇧-click puts on one of the
        // group's lines. "Stroke" beside a Fill swatch reads as the usual pair
        // and gave no clue that it needed a modifier, or what it applied to.
        labelSpan.textContent = kind === 'fill' ? 'Fill' : 'Line (⇧-click)';
        wrapper.appendChild(labelSpan);
        return wrapper;
    }

    /** Thickness the bucket paints a line with. In the bar because that is where
     *  it is used — it used to be read off the default style set in another
     *  tool's bar, so the width you got was invisible from here. */
    private createLineWidthControl(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cb-swatch-wrapper';
        wrapper.setAttribute('data-tooltip', 'Thickness for ⇧-click line painting');

        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'cb-number';
        num.min = '0.1';
        num.step = '0.5';
        num.value = String(this.ui.getLivePaintStrokeWidth());
        num.addEventListener('change', () => {
            this.ui.setLivePaintStrokeWidth(parseFloat(num.value) || 1);
            num.value = String(this.ui.getLivePaintStrokeWidth());
            this.refresh();
        });

        const labelSpan = document.createElement('span');
        labelSpan.className = 'cb-swatch-label';
        labelSpan.textContent = 'Width';

        wrapper.appendChild(num);
        wrapper.appendChild(labelSpan);
        return wrapper;
    }

    /** Live Paint tool bar: colors, gaps, and Make/Release group. */
    private renderLivePaint(info: ContextInfo) {
        // Fill (regions) and Stroke (edges) colors. These set only the Live Paint
        // paint color — they do NOT modify the selected shapes.
        const grad = this.ui.getLivePaintGradient();
        if (grad) {
            // Gradient mode: one swatch per stop, plus the type. The gradient is
            // held in unit space and fitted to each region as it's painted, so
            // there are no endpoints to edit here — only what it is made of.
            grad.stops.forEach((stop, i) => {
                this.el.appendChild(
                    this.createColorSwatch(
                        i === 0 ? 'fill' : 'stroke',
                        colorToHex(stop.color),
                        (color) => {
                            const next = this.ui.getLivePaintGradient();
                            if (!next) return;
                            const parsed = parseHex(color);
                            if (!parsed) return;
                            next.stops[i].color = parsed;
                            this.ui.setLivePaintGradient(next);
                        },
                        i === 0 ? 'From' : 'To',
                    ),
                );
            });
            this.el.appendChild(this.createGradientTypeControl(grad.gradient_type));
        } else {
            this.el.appendChild(
                this.createLivePaintSwatch(
                    'fill',
                    this.ui.rgbToHex(this.ui.getLivePaintFill()),
                    (color) => {
                        this.ui.setLivePaintFill(color);
                    },
                ),
            );
        }
        // Solid ⇄ Gradient. Switching to gradient seeds it from the current
        // solid, so the first click paints something recognisably related to
        // what the swatch was already showing.
        this.el.appendChild(
            this.createButton(
                grad ? 'Solid' : 'Gradient',
                iconBoolUnion(14),
                () => {
                    this.ui.setLivePaintGradient(grad ? null : this.ui.defaultLivePaintGradient());
                    this.refresh();
                },
                false,
                undefined,
                grad ? 'Paint flat colour again' : 'Paint regions with a gradient',
            ),
        );
        this.el.appendChild(
            this.createLivePaintSwatch(
                'stroke',
                this.ui.rgbToHex(this.ui.getLivePaintStroke()),
                (color) => {
                    this.ui.setLivePaintStroke(color);
                },
            ),
        );
        this.el.appendChild(this.createLineWidthControl());
        this.el.appendChild(this.createSeparator());
        this.el.appendChild(this.createGapControl());
        this.el.appendChild(this.createSeparator());

        const group = this.scene.getLivePaintGroup();
        if (group >= 0) {
            this.el.appendChild(this.createBadge('Painting'));
            // The last clause is the way back to the geometry. Painting and
            // editing the shapes are different tools on the same object, and the
            // bar is the only place that says so while the bucket is in hand.
            this.el.appendChild(
                this.createHint(
                    'Click a region to fill · ⇧-click a line to paint its edge · ⌥-click to pick up a colour · ⌘-click to clear · V to edit the shapes',
                ),
            );
            // Why the fill went further than the lines suggested it would. A
            // shape that is not in the group contributes nothing to the surface,
            // so its edges divide nothing — the one failure of this tool that
            // looks exactly like a bug in it.
            const intruder = this.input.livePaintIntruder;
            if (intruder !== null) {
                const name = this.scene.getNodeName(intruder) || 'That shape';
                this.el.appendChild(this.createSeparator());
                this.el.appendChild(this.createBadge(`${name} isn't in this group`));
                this.el.appendChild(
                    this.createButton('Add it', iconPaintBucket(14), () => {
                        this.input.adoptLivePaintIntruder();
                    }),
                );
            }

            this.el.appendChild(this.createSeparator());
            this.el.appendChild(
                this.createButton(
                    'Done',
                    '✓',
                    () => {
                        this.input.exitLivePaintGroup();
                    },
                    false,
                    '⏎',
                ),
            );
        } else if (info.selectedIds.length > 0) {
            this.el.appendChild(
                this.createButton('Make Live Paint Group', iconGroup(14), () => {
                    this.input.makeLivePaintGroup();
                }),
            );
            this.el.appendChild(this.createSeparator());
            this.el.appendChild(
                this.createHint('Groups the selected shapes so you can paint inside them'),
            );
        } else {
            this.el.appendChild(
                this.createHint(
                    'Select shapes and click Live Paint to make a group, then fill its regions',
                ),
            );
        }
    }

    /** One Rect/Ellipse/Path selected. */
    private renderSingleShape(info: ContextInfo) {
        this.appendSelectionBadge(info);

        this.el.appendChild(
            this.createButton(
                'Edit Path',
                iconPencil(14),
                () => {
                    if (info.selectedIds.length === 1) {
                        this.ui.setActiveTool('direct');
                        this.input.enterPathEditMode(info.selectedIds[0]);
                    }
                },
                false,
                '⏎',
            ),
        );

        // Edit Path is the only path action important enough to sit inline. Every
        // occasional op is a command in the one "More" menu — including Offset Copy,
        // which (like Illustrator's Object › Path › Offset Path) opens a little value
        // popover when picked instead of parking a number field in the bar. So the
        // bar reads the same in every view: primary → More → transform → Dup/Delete.
        if (info.selectedNodes[0]?.node_type === 'Path') {
            this.el.appendChild(this.buildPathMoreMenu(info));
        }

        this.appendTransformActions(info, { flatten: true });
        this.appendLifecycleActions();
    }

    /** Hand a world-space ghost to the renderer (or clear it). */
    private setShapePreview(subpaths: Subpath[] | null, fillRule = 0) {
        this.input.shapePreview = subpaths?.length ? { subpaths, fillRule } : null;
        this.scene.renderer?.requestRender();
    }

    /** A small value dialog (Illustrator's Offset-Path model) that any customizable
     *  command opens: a scrub field + Apply, Enter to run, Esc/outside to cancel,
     *  with an optional live preview. Nothing happens until you confirm. */
    private openValuePopover(
        anchor: HTMLElement,
        opts: {
            label: string;
            value: number;
            min?: number;
            step?: number;
            title?: string;
            onPreview?: (value: number) => void;
            onClearPreview?: () => void;
            onApply: (value: number) => void;
        },
    ) {
        document.querySelector('.cb-value-popover')?.remove();

        const pop = document.createElement('div');
        pop.className = 'cb-value-popover';

        let input!: HTMLInputElement;
        const field = this.createScrubField(opts.label, opts.value, {
            min: opts.min,
            step: opts.step,
            title: opts.title,
            onChange: () => opts.onPreview?.(parseFloat(input.value)),
        });
        input = field.input;

        const close = () => {
            opts.onClearPreview?.();
            pop.remove();
            document.removeEventListener('pointerdown', onDoc, true);
        };
        const apply = () => {
            const v = parseFloat(input.value);
            close();
            if (Number.isFinite(v)) opts.onApply(v);
        };
        const onDoc = (e: PointerEvent) => {
            if (!pop.contains(e.target as Node)) close();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                apply();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
            }
        });

        const applyBtn = this.createButton(
            'Apply',
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>',
            apply,
        );

        pop.appendChild(field.wrap);
        pop.appendChild(applyBtn);
        pop.style.position = 'fixed';
        pop.style.visibility = 'hidden';
        document.body.appendChild(pop);

        const r = anchor.getBoundingClientRect();
        const h = pop.offsetHeight;
        pop.style.left = `${Math.round(r.left)}px`;
        pop.style.top = `${Math.round(r.top - h - 8)}px`;
        pop.style.visibility = 'visible';

        // Defer so the click that opened the popover doesn't immediately close it.
        setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
        input.focus();
        input.select();
        opts.onPreview?.(parseFloat(input.value)); // show the ghost immediately
    }

    /** The "More" overflow menu for a single Path — every occasional path op is a
     *  command here (Offset opens a value popover; the rest run immediately). */
    private buildPathMoreMenu(info: ContextInfo): HTMLElement {
        const id = info.selectedIds[0];
        type Item = { label: string; icon: string; onSelect: () => void; danger?: boolean };
        const items: Item[] = [];

        const offsetIcon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/></svg>';
        items.push({
            label: 'Offset Copy…',
            icon: offsetIcon,
            onSelect: () =>
                this.openValuePopover(this.el, {
                    label: 'Offset',
                    value: this.input.lastOffsetAmount,
                    title: 'Offset distance (negative = inset)',
                    onPreview: (v) => {
                        const local =
                            Number.isFinite(v) && v !== 0
                                ? computeOffsetSubpaths(this.ui.ck, this.scene, id, v)
                                : null;
                        this.setShapePreview(
                            local
                                ? transformSubpaths(local.subpaths, this.scene.getTransform(id))
                                : null,
                            local?.fillRule ?? 0,
                        );
                    },
                    onClearPreview: () => this.setShapePreview(null),
                    onApply: (v) => {
                        if (v !== 0) this.input.offsetSelectedPath(v);
                    },
                }),
        });

        // Simplify only when the path has enough points to be worth reducing.
        if (this.input.selectedPathPointCount() >= 6) {
            const simplifyIcon =
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c4 0 5-10 9-10s5 6 9 6"/></svg>';
            items.push({
                label: 'Simplify…',
                icon: simplifyIcon,
                onSelect: () =>
                    this.openValuePopover(this.el, {
                        label: 'Amount',
                        value: this.input.lastSimplifyTolerance,
                        min: 0,
                        title: 'Simplify tolerance (larger = fewer points)',
                        onPreview: (v) => {
                            const local =
                                Number.isFinite(v) && v >= 0
                                    ? computeSimplifiedSubpaths(this.scene, id, v)
                                    : null;
                            this.setShapePreview(
                                local
                                    ? transformSubpaths(local, this.scene.getTransform(id))
                                    : null,
                            );
                        },
                        onClearPreview: () => this.setShapePreview(null),
                        onApply: (v) => {
                            if (v >= 0) this.input.simplifySelectedPath(v);
                        },
                    }),
            });
        }

        const reverseIcon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h14"/><path d="M13 6l6 6-6 6"/><path d="M3 12V8"/></svg>';
        items.push({
            label: 'Reverse direction',
            icon: reverseIcon,
            onSelect: () => this.input.reverseSelectedPath(),
        });

        // Outline Width — destructive: replaces a stroked open path with a filled
        // tapered shape. Only for an open path that actually has a stroke.
        const openWithStroke =
            this.scene.getNodeGeometry(id)?.Path?.subpaths?.some((sp) => !sp.closed) &&
            (this.scene.getNodeStyle(id)?.strokes?.length ?? 0) > 0;
        if (openWithStroke) {
            const sw = (p: string) =>
                `<svg width="14" height="10" viewBox="0 0 28 20" fill="currentColor">${p}</svg>`;
            const profiles: Array<{ id: WidthProfile; label: string; icon: string }> = [
                {
                    id: 'taper-end',
                    label: 'Outline: Taper',
                    icon: sw('<path d="M2 6 L26 10 L2 14 Z"/>'),
                },
                {
                    id: 'taper-both',
                    label: 'Outline: Taper both',
                    icon: sw('<path d="M2 10 Q14 3 26 10 Q14 17 2 10 Z"/>'),
                },
                {
                    id: 'bulge',
                    label: 'Outline: Bulge',
                    icon: sw('<path d="M2 8 Q14 0 26 8 L26 12 Q14 20 2 12 Z"/>'),
                },
            ];
            for (const p of profiles) {
                items.push({
                    label: p.label,
                    icon: p.icon,
                    onSelect: () => this.input.applyWidthProfileToSelection(p.id),
                });
            }
        }

        // Release Compound — only when the path has 2+ subpaths.
        if ((this.scene.getNodeGeometry(id)?.Path?.subpaths?.length ?? 0) >= 2) {
            items.push({
                label: 'Release compound',
                icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="12" r="5"/><circle cx="17" cy="12" r="3"/></svg>',
                onSelect: () => this.input.releaseCompoundPath(),
            });
        }

        const moreIcon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
        return this.createDropdown('More', moreIcon, items, 'Path operations');
    }

    /** One Text node selected: text actions, not text properties (those are in the panel). */
    private renderTextSelected(info: ContextInfo) {
        this.appendSelectionBadge(info);

        const nodeId = info.selectedIds[0];

        this.el.appendChild(
            this.createButton(
                'Edit Text',
                iconPencil(14),
                () => {
                    this.input.editTextNode(nodeId);
                },
                false,
                '⏎',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Create Outlines',
                iconCreateOutlines(14),
                () => {
                    void this.input.createOutlines(nodeId);
                },
                false,
                '⌘⇧O',
            ),
        );

        // Detach — only when this text is flowing along a path.
        if (this.scene.getTextPath(nodeId) != null) {
            this.el.appendChild(
                this.createButton('Detach from path', iconLink(14), () => {
                    this.scene.clearTextPath(nodeId);
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                }),
            );
        }

        this.appendTransformActions(info, { flatten: false });
        this.appendLifecycleActions();
    }

    /** Exactly one Group selected. */
    private renderGroupSelected(info: ContextInfo) {
        this.appendSelectionBadge(info);

        const id = info.selectedIds[0];
        // A Boolean Group gets a dedicated control set: switch op, edit operands,
        // flatten to a path, or release back to a plain group.
        if (info.selectedIds.length === 1 && this.scene.isBooleanGroup(id)) {
            this.renderBooleanGroupControls(id, info);
            return;
        }

        this.el.appendChild(
            this.createButton(
                'Enter Group',
                iconCornerDownRight(14),
                () => {
                    if (info.selectedIds.length === 1) {
                        this.input.enterSelectedNode(info.selectedIds[0]);
                    }
                },
                false,
                '⏎',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Ungroup',
                iconUngroup(14),
                () => {
                    this.input.ungroupSelection();
                },
                false,
                '⌘⇧G',
            ),
        );

        this.appendTransformActions(info, { flatten: true });
        this.appendLifecycleActions();
    }

    /** Controls for a selected non-destructive Boolean Group. */
    private renderBooleanGroupControls(id: number, info: ContextInfo) {
        const curOp = BOOL_OP_BY_INDEX[this.scene.getBooleanOp(id)] ?? 'union';

        this.el.appendChild(
            this.createDropdown(
                `Boolean · ${BOOL_OP_META[curOp].label}`,
                BOOL_OP_META[curOp].icon(),
                BOOL_OP_ORDER.map((op) => ({
                    label: BOOL_OP_META[op].label,
                    icon: BOOL_OP_META[op].icon(),
                    active: op === curOp,
                    onSelect: () => {
                        this.scene.setBooleanOp(this.ui.ck, id, op);
                        this.ui.syncWithSelection();
                    },
                })),
            ),
        );

        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createButton(
                'Edit',
                iconCornerDownRight(14),
                () => {
                    this.input.enterSelectedNode(id);
                },
                false,
                '⏎',
            ),
        );

        this.el.appendChild(
            this.createButton('Flatten', iconCreateOutlines(14), () => {
                const pid = this.scene.flattenBoolean(this.ui.ck, id);
                if (pid >= 0) {
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                }
            }),
        );

        this.el.appendChild(
            this.createButton('Release', iconUngroup(14), () => {
                this.scene.releaseBoolean(id);
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
            }),
        );

        this.appendTransformActions(info, { flatten: true });
        this.appendLifecycleActions();
    }

    /** Two or more nodes selected. */
    private renderMultiSelect(info: ContextInfo) {
        this.el.appendChild(this.createBadge(`${info.selectedIds.length} selected`));
        this.el.appendChild(this.createSeparator());

        // Text on a path — exactly one Text + one Path selected.
        if (info.selectedIds.length === 2) {
            const types = info.selectedNodes.map((n) => n.node_type);
            const ti = types.indexOf('Text');
            const pi = types.indexOf('Path');
            if (ti >= 0 && pi >= 0) {
                const textId = info.selectedIds[ti];
                const pathId = info.selectedIds[pi];
                const icon =
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15c5 0 5-8 10-8s5 6 8 6"/><path d="M7 9V7h6M10 7v4"/></svg>';
                this.el.appendChild(
                    this.createButton('On Path', icon, () => {
                        this.scene.setTextPath(textId, pathId);
                        this.scene.engine?.clear_selection();
                        this.scene.selectNode(textId, false);
                        this.ui.syncWithSelection();
                        this.ui.updateLayerList();
                    }),
                );
                this.el.appendChild(this.createSeparator());
            }
        }

        // Align / distribute
        const alignActions: Array<[string, string, AlignMode]> = [
            ['Align left', iconAlignLeft(14), 'left'],
            ['Align center', iconAlignCenterH(14), 'hcenter'],
            ['Align right', iconAlignRight(14), 'right'],
            ['Align top', iconAlignTop(14), 'top'],
            ['Align middle', iconAlignCenterV(14), 'vcenter'],
            ['Align bottom', iconAlignBottom(14), 'bottom'],
        ];
        for (const [title, icon, mode] of alignActions) {
            this.el.appendChild(
                this.createIconButton(title, icon, () => {
                    alignSelection(this.scene, [...info.selectedIds], mode);
                    this.ui.syncWithSelection();
                }),
            );
        }
        if (info.selectedIds.length >= 3) {
            this.el.appendChild(
                this.createIconButton('Distribute horizontally', iconDistributeH(14), () => {
                    distributeSelection(this.scene, [...info.selectedIds], 'h');
                    this.ui.syncWithSelection();
                }),
            );
            this.el.appendChild(
                this.createIconButton('Distribute vertically', iconDistributeV(14), () => {
                    distributeSelection(this.scene, [...info.selectedIds], 'v');
                    this.ui.syncWithSelection();
                }),
            );
        }

        // Boolean — the one primary "combine" action: a dropdown that unites/
        // subtracts/intersects/excludes into a non-destructive Boolean Group
        // (children stay editable). The destructive/niche combine variants
        // (Compound, Minus Back, Crop, Blend, Join) live in the More menu, so the
        // bar isn't a wall of overlapping combine buttons.
        const allBoolCompatible =
            info.selectedNodes.length === info.selectedIds.length &&
            info.selectedNodes.every((n) => BOOLEAN_COMPATIBLE.has(n.node_type));
        if (allBoolCompatible) {
            this.el.appendChild(this.createSeparator());
            this.el.appendChild(
                this.createDropdown(
                    'Boolean',
                    iconBoolUnion(14),
                    BOOL_OP_ORDER.map((op) => ({
                        label: BOOL_OP_META[op].label,
                        icon: BOOL_OP_META[op].icon(),
                        onSelect: () => {
                            const gid = this.scene.makeBooleanGroup(
                                this.ui.ck,
                                [...info.selectedIds],
                                op,
                            );
                            if (gid >= 0) {
                                this.ui.syncWithSelection();
                                this.ui.updateLayerList();
                            }
                        },
                    })),
                    'Combine into a non-destructive boolean group — children stay editable.',
                ),
            );
        }

        const moreMenu = this.buildMultiMoreMenu(info, allBoolCompatible);
        if (moreMenu) this.el.appendChild(moreMenu);

        this.el.appendChild(
            this.createButton(
                'Group',
                iconGroup(14),
                () => {
                    this.input.groupSelection();
                },
                false,
                '⌘G',
            ),
        );

        this.appendTransformActions(info, { flatten: false });
        this.appendLifecycleActions();
    }

    /** "More" overflow for a multi-selection — the occasional combine/path ops that
     *  don't warrant their own top-level button (Compound, the destructive
     *  pathfinders, Blend, Join). Returns null when none apply. */
    private buildMultiMoreMenu(info: ContextInfo, allBoolCompatible: boolean): HTMLElement | null {
        type Item = { label: string; icon: string; onSelect: () => void };
        const items: Item[] = [];
        const ids = [...info.selectedIds];

        if (allBoolCompatible && info.selectedIds.length === 2) {
            const [idA, idB] = info.selectedIds;
            items.push({
                label: 'Blend…',
                icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.5 8.5l7 7" stroke-dasharray="2 2"/></svg>',
                onSelect: () =>
                    this.openValuePopover(this.el, {
                        label: 'Steps',
                        value: this.input.lastBlendSteps,
                        min: 1,
                        step: 1,
                        title: 'Number of in-between shapes',
                        onPreview: (v) =>
                            this.setShapePreview(
                                Number.isFinite(v)
                                    ? computeBlendSubpaths(
                                          this.ui.ck,
                                          this.scene,
                                          idA,
                                          idB,
                                          Math.max(1, Math.round(v)),
                                      )
                                    : null,
                            ),
                        onClearPreview: () => this.setShapePreview(null),
                        onApply: (v) => this.input.blendSelection(Math.max(1, Math.round(v))),
                    }),
            });
        }

        if (allBoolCompatible) {
            items.push({
                label: 'Compound path',
                icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>',
                onSelect: () => this.input.makeCompoundPath(),
            });
            // Minus Back = front shape minus everything behind it (the opposite
            // direction from Boolean › Subtract).
            items.push({
                label: 'Minus Back',
                icon: iconBoolSubtract(14),
                onSelect: () => {
                    if (applyPathfinder(this.ui.ck, this.scene, ids, 'minus-back') != null) {
                        this.ui.syncWithSelection();
                        this.ui.updateLayerList();
                    }
                },
            });
            // Crop = every shape clipped to the front one, each keeping its own
            // fill. Distinct from Boolean › Intersect, which answers the shared
            // area as ONE shape with one style. Only offered for 3+ because with
            // two shapes the two really are the same thing.
            if (info.selectedIds.length > 2) {
                items.push({
                    label: 'Crop to front shape',
                    icon: iconBoolIntersect(14),
                    onSelect: () => {
                        // null = nothing overlapped, and the document was left
                        // alone — the visible feedback is that nothing happened.
                        if (applyCrop(this.ui.ck, this.scene, ids) === null) return;
                        this.ui.syncWithSelection();
                        this.ui.updateLayerList();
                    },
                });
            }
        }

        const twoPaths =
            info.selectedIds.length === 2 &&
            info.selectedNodes.length === 2 &&
            info.selectedNodes.every((n) => n.node_type === 'Path');
        if (twoPaths) {
            items.push({
                label: 'Join paths',
                icon: iconLink(14),
                onSelect: () => this.input.joinSelectedPaths(),
            });
        }

        if (items.length === 0) return null;
        const moreIcon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
        return this.createDropdown('More', moreIcon, items, 'More combine & path operations');
    }

    /** Pen tool with a path in progress: progress + commit/cancel. */
    private renderPenDrawing(info: ContextInfo) {
        this.el.appendChild(this.createBadge(`${info.pointCount} pts`));
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createHint(
                'Click to add points · drag for curves · Enter or Esc to finish · click first point to close',
            ),
        );

        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createButton(
                'Finish',
                '✓',
                () => {
                    this.input.finalizePenPath();
                },
                false,
                '⏎',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Cancel',
                '✕',
                () => {
                    this.input.abandonPenPath();
                    this.refresh();
                },
                true,
            ),
        );
    }

    /** Node-editing mode: point counts + point actions + exit. */
    private renderPathEditing(info: ContextInfo) {
        const countText =
            info.selectedPointCount > 0
                ? `${info.selectedPointCount} / ${info.pointCount} points`
                : `${info.pointCount} points`;
        this.el.appendChild(this.createBadge(countText));

        this.el.appendChild(this.createSeparator());

        // Add Point (toggles; highlighted while armed)
        const addBtn = this.createIconButton(
            'Add Point',
            iconPlusCircle(14),
            () => {
                this.input.addPointMode = !this.input.addPointMode;
                this.refresh();
            },
            '+',
        );
        if (this.input.addPointMode) addBtn.classList.add('cb-btn-active');
        this.el.appendChild(addBtn);

        // Delete Point (needs a selection)
        const delBtn = this.createIconButton(
            'Delete Point',
            iconMinusCircle(14),
            () => {
                this.input.deleteSelectedPoints();
            },
            '⌫',
        );
        if (info.selectedPointCount === 0) delBtn.setAttribute('disabled', '');
        this.el.appendChild(delBtn);

        // Make Corner: retract the selected anchors' Bézier handles so the point
        // becomes a plain corner (its segments straighten). The multi-select,
        // discoverable form of the ⌥-click-to-collapse gesture. Only enabled when
        // at least one selected anchor still has handles to remove.
        if (info.selectedPointCount >= 1) {
            const cornerIcon =
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 L12 5 L20 20"/><rect x="9.5" y="2.5" width="5" height="5" rx="0.5" fill="currentColor" stroke="none"/></svg>';
            const cornerBtn = this.createButton('Make Corner', cornerIcon, () => {
                this.input.makeSelectedPointsCorner();
            });
            if (!this.input.selectedPointsHaveHandles()) cornerBtn.setAttribute('disabled', '');
            this.el.appendChild(cornerBtn);
        }

        // Cut at the selected anchor (scissors with zero aiming — the point is
        // already selected). Only offered for exactly one anchor.
        if (info.selectedPointCount === 1) {
            this.el.appendChild(
                this.createButton('Cut at Point', iconScissors(14), () => {
                    this.input.cutAtSelectedPoint();
                }),
            );
        }

        // Merge selected points into one (endpoints weld/close, adjacent collapse)
        if (info.selectedPointCount >= 2) {
            this.el.appendChild(
                this.createButton(
                    'Merge',
                    iconLink(14),
                    () => {
                        this.input.mergeSelectedPoints();
                    },
                    false,
                    '⌘J',
                ),
            );

            // Average the selected anchors onto a common line (Illustrator's Average).
            const avgIcon = (d: string) =>
                `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${d}</svg>`;
            this.el.appendChild(
                this.createDropdown(
                    'Average',
                    avgIcon(
                        '<circle cx="6" cy="8" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="16" r="1.6" fill="currentColor" stroke="none"/><path d="M4 12h16"/>',
                    ),
                    [
                        {
                            label: 'Horizontal',
                            icon: avgIcon('<path d="M4 12h16"/>'),
                            onSelect: () => this.input.averageSelectedPoints('h'),
                        },
                        {
                            label: 'Vertical',
                            icon: avgIcon('<path d="M12 4v16"/>'),
                            onSelect: () => this.input.averageSelectedPoints('v'),
                        },
                        {
                            label: 'Both',
                            icon: avgIcon('<circle cx="12" cy="12" r="4"/>'),
                            onSelect: () => this.input.averageSelectedPoints('both'),
                        },
                    ],
                ),
            );
        }

        // Edit Mesh: jump from editing the OUTLINE to editing the mesh fill's
        // points/colors. Only when the edited node actually carries a mesh.
        const editingId = info.editingNodeId;
        if (editingId !== null) {
            const meshIdx = (this.scene.getNodeStyle(editingId)?.fills ?? []).findIndex((f) =>
                isMeshGradient(f),
            );
            if (meshIdx >= 0) {
                this.el.appendChild(this.createSeparator());
                this.el.appendChild(
                    this.createButton(
                        'Edit Mesh',
                        iconMeshGrid(14),
                        () => {
                            this.input.exitEditMode();
                            this.scene.selectNode(editingId, false);
                            this.ui.setActiveTool('mesh');
                            this.ui.meshEdit.activate(editingId, meshIdx);
                            this.ui.syncWithSelection();
                        },
                        false,
                        'U',
                    ),
                );
            }
        }

        this.el.appendChild(this.createSeparator());

        // Hint tracks what the NEXT click will do
        let hint =
            'Drag points · ⌥drag an anchor for handles · ⇧click or marquee to multi-select · Esc to finish';
        if (this.input.addPointMode) hint = 'Click a segment to insert a point';
        else if (info.selectedPointCount === 1) hint = 'Cut splits the path at the selected point';
        else if (info.selectedPointCount >= 2) hint = '⌘J merges the selected points';
        this.el.appendChild(this.createHint(hint));

        this.el.appendChild(this.createSeparator());

        // Done (exit edit mode) — the committing action is always last
        this.el.appendChild(
            this.createButton(
                'Done',
                '✓',
                () => {
                    this.input.exitEditMode();
                    this.ui.setActiveTool('selection');
                },
                false,
                '⏎',
            ),
        );
    }

    // ─── Shared segments (keep every selection state on the same grammar) ──

    /** Leading "what you're acting on" badge for single-node selections. */
    private appendSelectionBadge(info: ContextInfo) {
        const node = info.selectedNodes[0];
        if (!node) return;
        this.el.appendChild(this.createBadge(node.name || `${node.node_type} ${node.id}`));
        this.el.appendChild(this.createSeparator());
    }

    /** Flip H / Flip V (+ optional Flatten), preceded by a separator. */
    private appendTransformActions(_info: ContextInfo, opts: { flatten: boolean }) {
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createIconButton(
                'Flip Horizontal',
                iconFlipH(),
                () => {
                    this.input.flipSelection('h');
                },
                '⇧H',
            ),
        );
        this.el.appendChild(
            this.createIconButton(
                'Flip Vertical',
                iconFlipV(),
                () => {
                    this.input.flipSelection('v');
                },
                '⇧V',
            ),
        );
        if (opts.flatten) {
            this.el.appendChild(
                this.createIconButton(
                    'Flatten',
                    iconFlatten(),
                    () => {
                        this.input.flattenSelection();
                    },
                    '⌘E',
                ),
            );
        }
    }

    /** Trailing Duplicate · Delete — identical in every selection state. */
    private appendLifecycleActions() {
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createButton(
                'Duplicate',
                iconCopy(14),
                () => {
                    this.input.duplicateSelection();
                },
                false,
                '⌘D',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Delete',
                iconTrash(14),
                () => {
                    this.input.deleteSelection();
                },
                true,
                '⌫',
            ),
        );
    }

    // ─── DOM Helpers ────────────────────────────────────────────────

    private createColorSwatch(
        label: string,
        currentValue: string,
        onChange: (color: string) => void,
        /** Shown under the swatch; defaults to `label`. Gradient stops want
         *  "From"/"To" while still styling as the fill/stroke swatch. */
        displayLabel?: string,
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cb-swatch-wrapper';
        wrapper.setAttribute('data-tooltip', `Default ${label}`);

        const initial = parseHex(currentValue) ?? { r: 0, g: 0, b: 0, a: 1 };
        const { el: swatch } = createColorSwatch({
            color: initial,
            alpha: false,
            title: `Default ${label}`,
            className: 'cb-swatch',
            onInput: (c) => onChange(colorToHex(c, false)),
        });

        wrapper.appendChild(swatch);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'cb-swatch-label';
        const text = displayLabel ?? label;
        labelSpan.textContent = text.charAt(0).toUpperCase() + text.slice(1);
        wrapper.appendChild(labelSpan);

        return wrapper;
    }

    /** Linear ⇄ Radial for the bucket's gradient. Styled like the Gaps control
     *  so the Live Paint bar keeps one visual language. */
    private createGradientTypeControl(current: 'Linear' | 'Radial'): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cb-swatch-wrapper';
        wrapper.setAttribute('data-tooltip', 'Gradient type');

        const select = document.createElement('select');
        select.className = 'cb-select';
        for (const value of ['Linear', 'Radial'] as const) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = value;
            opt.selected = value === current;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            const next = this.ui.getLivePaintGradient();
            if (!next) return;
            next.gradient_type = select.value as 'Linear' | 'Radial';
            this.ui.setLivePaintGradient(next);
        });

        const labelSpan = document.createElement('span');
        labelSpan.className = 'cb-swatch-label';
        labelSpan.textContent = 'Type';

        wrapper.appendChild(select);
        wrapper.appendChild(labelSpan);
        return wrapper;
    }

    private createSeparator(): HTMLElement {
        const sep = document.createElement('div');
        sep.className = 'cb-separator';
        return sep;
    }

    private createBadge(text: string): HTMLElement {
        const badge = document.createElement('span');
        badge.className = 'cb-badge';
        badge.textContent = text;
        return badge;
    }

    private createHint(text: string): HTMLElement {
        const hint = document.createElement('span');
        hint.className = 'cb-hint';
        hint.textContent = text;
        return hint;
    }

    /** A context-bar numeric field that matches the properties panel exactly: a
     *  `.dim-input` box with a draggable `.dim-label` handle (the Figma "slider" —
     *  drag = adjust, Shift = ×10) and a plain text input for typing. `onChange`
     *  fires on every value change (scrub or type). */
    private createScrubField(
        label: string,
        value: number,
        opts?: { min?: number; step?: number; title?: string; onChange?: () => void },
    ): { wrap: HTMLElement; input: HTMLInputElement } {
        const wrap = document.createElement('div');
        wrap.className = 'dim-input cb-dim-input';

        const handle = document.createElement('span');
        handle.className = 'dim-label';
        handle.textContent = label;
        if (opts?.title) handle.title = opts.title;

        const input = document.createElement('input');
        input.type = 'number';
        input.value = String(value);
        if (opts?.min !== undefined) input.min = String(opts.min);
        if (opts?.step !== undefined) input.step = String(opts.step);
        input.addEventListener('click', (e) => e.stopPropagation());
        if (opts?.onChange) input.addEventListener('input', opts.onChange);

        this.makeScrubbable(handle, input, opts?.onChange);

        wrap.appendChild(handle);
        wrap.appendChild(input);
        return { wrap, input };
    }

    /** Scrub `input`'s value by dragging `handle` (the `.dim-label`) — matches the
     *  properties panel: drag = adjust, Shift = ×10, plain click focuses the input
     *  to type. `onChange` fires on each change. */
    private makeScrubbable(handle: HTMLElement, input: HTMLInputElement, onChange?: () => void) {
        handle.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const startX = e.clientX;
            const startVal = parseFloat(input.value) || 0;
            const step = parseFloat(input.step) || 1;
            const min = input.min !== '' ? parseFloat(input.min) : Number.NEGATIVE_INFINITY;
            const max = input.max !== '' ? parseFloat(input.max) : Number.POSITIVE_INFINITY;
            let moved = false;
            try {
                handle.setPointerCapture(e.pointerId);
            } catch {}

            const onMove = (ev: PointerEvent) => {
                const dx = ev.clientX - startX;
                if (!moved && Math.abs(dx) < 3) return; // click-vs-drag threshold
                moved = true;
                document.body.classList.add('scrubbing');
                const mult = ev.shiftKey ? 10 : 1;
                const raw = startVal + Math.round(dx) * step * mult;
                const val = Math.max(min, Math.min(max, raw));
                const next = String(Math.round(val * 100) / 100);
                if (next !== input.value) {
                    input.value = next;
                    onChange?.();
                }
            };
            const onUp = () => {
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                document.body.classList.remove('scrubbing');
                try {
                    handle.releasePointerCapture(e.pointerId);
                } catch {}
                if (!moved) {
                    input.focus();
                    input.select();
                }
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
    }

    /** A labeled button that opens a small popup menu (Figma-style split control).
     *  The menu is appended to <body> with fixed positioning so it can't be
     *  clipped by the bar, and dismisses on any outside pointerdown. */
    private createDropdown(
        label: string,
        icon: string,
        items: Array<{
            label: string;
            icon: string;
            shortcut?: string;
            danger?: boolean;
            active?: boolean;
            tooltip?: string;
            onSelect: () => void;
        }>,
        tooltip?: string,
    ): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'cb-dropdown';

        const btn = document.createElement('button');
        btn.className = 'cb-btn cb-dropdown-btn';
        btn.setAttribute('data-tooltip', tooltip ?? ACTION_TOOLTIPS[label] ?? label);
        btn.innerHTML = `<span class="cb-btn-icon">${icon}</span><span class="cb-btn-text">${label}</span><span class="cb-caret">▾</span>`;
        wrap.appendChild(btn);

        let menu: HTMLElement | null = null;
        const onDoc = (e: PointerEvent) => {
            if (menu && !menu.contains(e.target as Node) && !wrap.contains(e.target as Node))
                close();
        };
        const close = () => {
            if (menu) {
                menu.remove();
                menu = null;
            }
            document.removeEventListener('pointerdown', onDoc, true);
        };
        const open = () => {
            menu = document.createElement('div');
            menu.className = 'cb-menu';
            for (const it of items) {
                const mi = document.createElement('button');
                mi.className =
                    'cb-menu-item' +
                    (it.danger ? ' cb-menu-item-danger' : '') +
                    (it.active ? ' cb-menu-item-active' : '');
                const desc = it.tooltip ?? ACTION_TOOLTIPS[it.label];
                mi.innerHTML =
                    `<span class="cb-btn-icon">${it.icon}</span>` +
                    `<span class="cb-menu-item-label">${it.label}</span>` +
                    (it.shortcut
                        ? `<span class="cb-menu-item-shortcut">${it.shortcut}</span>`
                        : '');
                // Menus sit outside #context-bar (custom tooltip CSS won't reach),
                // so use a native title for the description.
                if (desc && desc !== it.label) mi.title = desc;
                mi.addEventListener('click', (e) => {
                    e.stopPropagation();
                    close();
                    it.onSelect();
                });
                menu.appendChild(mi);
            }
            menu.style.position = 'fixed';
            menu.style.visibility = 'hidden';
            document.body.appendChild(menu);
            // The bar lives at the bottom of the screen, so open upward.
            const r = btn.getBoundingClientRect();
            const h = menu.offsetHeight;
            menu.style.left = `${Math.round(r.left)}px`;
            menu.style.top = `${Math.round(r.top - h - 4)}px`;
            menu.style.visibility = 'visible';
            document.addEventListener('pointerdown', onDoc, true);
        };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (menu) close();
            else open();
        });
        return wrap;
    }

    /** Compact icon-only button (align/boolean/flip rows). The label lives in
     *  the tooltip, with the shortcut appended when the action has one. */
    private createIconButton(
        title: string,
        icon: string,
        onClick: () => void,
        shortcut?: string,
    ): HTMLElement {
        const btn = document.createElement('button');
        btn.className = 'cb-btn cb-btn-icon-only';
        btn.setAttribute('data-tooltip', ACTION_TOOLTIPS[title] ?? title);
        if (shortcut) btn.setAttribute('data-shortcut', shortcut);
        btn.innerHTML = icon;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    /** Labeled button. Pass `tooltip` to explain what a non-obvious action does
     *  (shown on hover, wraps to a few lines). Shortcuts never appear in the label
     *  — only in the tooltip; a bare shortcut falls back to the label as tooltip. */
    private createButton(
        title: string,
        icon: string,
        onClick: () => void,
        danger = false,
        shortcut?: string,
        tooltip?: string,
    ): HTMLElement {
        const btn = document.createElement('button');
        btn.className = `cb-btn${danger ? ' cb-btn-danger' : ''}`;
        // Every action gets a hover tooltip: explicit > central description > label.
        const tip = tooltip ?? ACTION_TOOLTIPS[title] ?? title;
        btn.setAttribute('data-tooltip', tip);
        if (shortcut) btn.setAttribute('data-shortcut', shortcut);
        btn.innerHTML = `<span class="cb-btn-icon">${icon}</span><span class="cb-btn-text">${title}</span>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }
}
