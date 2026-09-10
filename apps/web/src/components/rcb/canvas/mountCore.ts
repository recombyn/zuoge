/**
 * Mount Rust/WASM + CanvasKit scene/renderer/input under the RCB stage.
 */
import type { CanvasKit } from 'canvaskit-wasm';
import { InputManager } from '@rcb-vector/input';
import { Renderer } from '@rcb-vector/renderer';
import { UIEngine } from '@rcb-vector/ui';
import { WasmScene } from '@rcb-vector/wasm_scene';
import { store } from '@/store';
import { setActiveTool as setEditorActiveTool } from '@/store/modules/editor';
import { KIT_CHROME_MINIMAL } from './kitChromeMinimal';
import { ensureKitAppTextFonts } from './kitTextFonts';
import {
  BUCKET_CURSOR,
  isPersistentDrawSessionTool,
  PENCIL_CURSOR,
  PEN_CURSOR,
  PERSISTENT_DRAW_TOOLS,
} from './toolMap';

/**
 * Engine::new + empty-artboards deserialize always mint "Artwork 1" at the origin.
 * Product must not promote that seed into SceneDocument (undo-to-empty / resize).
 */
export function isKitEngineSeedArtboard(ab: {
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}): boolean {
  const name = String(ab?.name || '').trim();
  if (!/^Artwork\s+1$/i.test(name)) return false;
  const x = Number(ab?.x) || 0;
  const y = Number(ab?.y) || 0;
  // Seed is always placed at the origin (size may follow document_width/height).
  return Math.abs(x) < 0.5 && Math.abs(y) < 0.5;
}

/**
 * Remove a Kit artboard without pushing undo (unlike WasmScene.removeArtboard).
 * Pass `invalidate: false` when batching removals (e.g. stripKitSeedArtboards).
 */
export function discardKitArtboardNoHistory(
  scene: WasmScene,
  artboardId: number,
  opts?: { invalidate?: boolean }
): void {
  try {
    scene.engine?.remove_artboard(artboardId);
  } catch {
    /* ignore */
  }
  if (opts?.invalidate === false) return;
  try {
    scene.invalidateCache?.(false);
  } catch {
    /* optional */
  }
}

/**
 * Engine::new seeds "Artwork 1". Strip it WITHOUT WasmScene.removeArtboard
 * (that saveHistory's the seed and Undo resurrects the board while resizing).
 * Also reset Kit history so the seed cannot come back via undo.
 */
export function stripKitSeedArtboards(scene: WasmScene, opts?: { resetHistory?: boolean }) {
  if (!scene.engine) return;
  for (const ab of [...scene.getArtboards()]) {
    discardKitArtboardNoHistory(scene, ab.id, { invalidate: false });
  }
  try {
    scene.invalidateCache?.(false);
  } catch {
    /* optional */
  }
  if (opts?.resetHistory === false) return;
  try {
    const max = Number((scene as { maxHistorySize?: number }).maxHistorySize) || 50;
    // History is a wasm class from the same package as Engine.
    const HistoryCtor = (scene.history as { constructor?: new (n: number) => unknown })
      ?.constructor;
    if (typeof HistoryCtor === 'function') {
      scene.history = new HistoryCtor(max) as typeof scene.history;
    }
  } catch {
    /* optional */
  }
}

export type CanvasEngineHandle = {
  /** CanvasKit instance (same as scene.ck / ui.ck). */
  ck: CanvasKit;
  scene: WasmScene;
  renderer: Renderer;
  input: InputManager;
  ui: UIEngine;
  setTool: (toolId: string) => void;
  /** When true, Kit owns Esc/Enter/Delete + modifiers (pen/shape gestures). */
  setDrawKeyboard: (enabled: boolean) => void;
  /** SnapEngine grid spacing in world units; 0 disables. */
  setGridSnap: (gridSize: number) => void;
  /** Push RCB fill/stroke into Kit "current appearance" for next create. */
  setCreateStyle: (style: {
    fill?: string | null;
    stroke?: string | null;
    strokeWidth?: number;
  }) => void;
  /** Kit path-edit: InputManager.enterPathEditMode / exitEditMode. */
  enterPathEdit: (kitId: number) => void;
  exitPathEdit: () => void;
  isPathEditing: () => boolean;
  getEditingKitId: () => number | null;
  /** Kit image place: WasmScene.placeImage. */
  placeImage: (
    bytes: Uint8Array,
    mime: string,
    cx: number,
    cy: number,
    w: number,
    h: number
  ) => number;
  /** Kit Live Paint fill color for paint-bucket. */
  setLivePaintFill: (hex: string) => void;
  setLivePaintFillNone?: (none: boolean) => void;
  /** Kit Live Paint gradient (unit-space 0..1), or null for solid. */
  setLivePaintGradient: (g: unknown | null) => void;
  /**
   * Kit PNG export (CanvasKit renderer.exportPNG).
   * Bounds are world/scene units; omit for full document size.
   */
  exportPNG: (
    scale?: number,
    bounds?: { x: number; y: number; w: number; h: number },
    background?: { r: number; g: number; b: number; a: number } | null,
    outSize?: { w: number; h: number }
  ) => Blob | null;
  destroy: () => void;
};

const HOST_CSS = `
.rcb-kit-host { position: absolute; inset: 0; overflow: hidden; }
/* Kit InputManager.spawnTextOverlay mounts into #canvas-container. */
.rcb-kit-host > #canvas-container {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  overflow: hidden;
}
.rcb-kit-host > #canvas-container > #editor-canvas {
  position: absolute !important;
  inset: 0 !important;
  display: block !important;
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
}
.rcb-kit-host > [data-rcb-kit-chrome-stub] {
  display: none !important;
}
/* Inline text caret — Kit style.css is not loaded in the product host. */
.rcb-kit-host .text-input-overlay {
  position: absolute;
  z-index: 200;
  margin: 0;
  box-sizing: content-box;
  caret-color: currentColor;
}
`;

function el<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const found = root.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`[rcb/canvas] missing #${id}`);
  return found;
}

/**
 * Product owns layers/properties chrome. Kit UIEngine still constructs
 * against stub ids — never rebuild layer rows or property panels into the DOM.
 */
function muteKitPanelDom(ui: UIEngine) {
  ui.updateLayerList = () => undefined;
  ui.updateLayerSelection = () => undefined;
  ui.refreshArtboardPanel = () => undefined;
  ui.clearPropertyPanel = () => undefined;
  ui.syncWithSelection = (opts: { interactive?: boolean; gesture?: boolean } = {}) => {
    // Keep engine selection side-effects that Kit tools need; skip DOM panel writes.
    const gesture = opts.gesture === true;
    ui.scene.renderer?.requestRender();
    ui.gradientEdit.syncSelection();
    ui.meshEdit.syncSelection();
    const selection = ui.scene.engine!.get_selection();
    ui.onSelectionChange?.(Array.from(selection));
    if (
      selection.length > 0 &&
      ui.scene.renderer &&
      ui.scene.renderer.selectedArtboardId !== null
    ) {
      ui.scene.renderer.selectedArtboardId = null;
    }
    // contextBar / fills / props stay product-side; gesture still needs render.
    void gesture;
  };
}

export async function createCanvasEngine(
  container: HTMLElement,
  canvasKit: CanvasKit,
): Promise<CanvasEngineHandle> {
  container.classList.add('rcb-kit-host');
  container.innerHTML = `${KIT_CHROME_MINIMAL}<style>${HOST_CSS}</style>`;

  const wasmScene = new WasmScene(canvasKit);
  await wasmScene.init();

  const canvas = el<HTMLCanvasElement>(container, 'editor-canvas');
  const renderer = new Renderer(canvasKit, canvas, wasmScene);
  wasmScene.renderer = renderer;

  // UIEngine resolves chrome via document.getElementById. Prefer ids inside
  // this host so product UI with colliding ids cannot bind Kit to the wrong DOM.
  const doc = container.ownerDocument;
  const prevGetById = doc.getElementById.bind(doc);
  doc.getElementById = ((id: string) => {
    const local = container.querySelector(`#${CSS.escape(id)}`);
    if (local) return local as HTMLElement;
    return prevGetById(id);
  }) as Document['getElementById'];
  let ui: UIEngine;
  try {
    ui = new UIEngine(canvasKit, wasmScene);
  } finally {
    doc.getElementById = prevGetById;
  }
  muteKitPanelDom(ui);
  const input = new InputManager(canvas, wasmScene, ui, renderer);
  renderer.inputManager = input;

  // Engine seeds "Artwork 1" on construct — strip without history (Undo-safe).
  stripKitSeedArtboards(wasmScene);

  // CJK text paint: register Alibaba PuHuiTi aliases before any text tool use.
  await ensureKitAppTextFonts();

  // Idle artboard hairline → Kit drawArtboards (dadaki). Kit still owns
  // fill, idle/selected border, resize handles, and the name+size label.
  // - Soft (non-selected) highlight edge may still use SVG when needed
  // - Stage theme background → RCB
  // - Vectors, text, static images, selection, grid → Kit
  // - SoftGlow process bloom → Kit overlay (processPlateKit, node local space)
  // - DomHost only for lottie/group + active video/audio HTML FO shells (no SVG ink)
  // Pixel grid: Kit renderer draws 1wu lattice only at ≥1000% zoom.
  // snap.gridSize only controls snap-to-grid — never gates the draw.

  type KitArtboard = {
    id: number;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    background: { r: number; g: number; b: number; a: number };
  };
  type KitLabelCanvas = {
    drawTextBlob: (blob: unknown, x: number, y: number, paint: unknown) => void;
    drawRect: (rect: unknown, paint: unknown) => void;
  };
  const anyAbRenderer = renderer as unknown as {
    zoom: number;
    selectedArtboardId: number | null;
    softArtboardId: number | null;
    scene: { getArtboards: () => KitArtboard[] };
    ensureOverlayPaints: () => {
      artboardFill: {
        setColor: (c: unknown) => void;
        setAntiAlias?: (v: boolean) => void;
      };
      selOutline: {
        setStrokeWidth: (w: number) => void;
        setAntiAlias: (v: boolean) => void;
      };
      artboardStroke: {
        setStrokeWidth: (w: number) => void;
        setAntiAlias: (v: boolean) => void;
      };
    };
    drawArtboards: (canvas: KitLabelCanvas) => void;
    drawArtboardLabel: (canvas: KitLabelCanvas, ab: KitArtboard, selected: boolean) => void;
    drawArtboardHandles: (canvas: KitLabelCanvas, ab: KitArtboard) => void;
    artboardLabelHitTest: (wx: number, wy: number) => number | null;
  };

  const measureLabelWidth = (font: unknown, text: string, fallbackSize: number) => {
    try {
      const f = font as {
        getGlyphIDs?: (t: string) => number[];
        getGlyphWidths?: (ids: number[]) => Float32Array | number[];
      };
      const ids = f.getGlyphIDs?.(text);
      if (!ids) return text.length * fallbackSize * 0.55;
      const widths = f.getGlyphWidths?.(ids);
      if (!widths) return text.length * fallbackSize * 0.55;
      let w = 0;
      for (let i = 0; i < widths.length; i += 1) w += Number(widths[i]) || 0;
      if (w > 0) return w;
    } catch {
      /* fall through */
    }
    return text.length * fallbackSize * 0.55;
  };

  // Name left / size right across the plate (NodeTitleLabel justify-between).
  anyAbRenderer.drawArtboardLabel = (canvas, ab, selected) => {
    const zoom = Math.max(0.05, Number(anyAbRenderer.zoom) || 1);
    const px = 11;
    const size = px / zoom;
    const font = new canvasKit.Font(null, size);
    const paint = new canvasKit.Paint();
    paint.setColor(
      selected
        ? canvasKit.Color(0, 162, 255, 1)
        : canvasKit.Color(150, 150, 150, 1)
    );
    paint.setAntiAlias(true);
    const name = String(ab.name || 'Frame');
    const dim = `${Math.round(ab.w)} × ${Math.round(ab.h)}`;
    const baseline = ab.y - 5 / zoom;
    const nameBlob = canvasKit.TextBlob.MakeFromText(name, font);
    if (nameBlob) {
      canvas.drawTextBlob(nameBlob, ab.x, baseline, paint);
      nameBlob.delete();
    }
    const dimW = measureLabelWidth(font, dim, size);
    const dimBlob = canvasKit.TextBlob.MakeFromText(dim, font);
    if (dimBlob) {
      canvas.drawTextBlob(dimBlob, ab.x + Math.max(0, ab.w - dimW), baseline, paint);
      dimBlob.delete();
    }
    font.delete();
    paint.delete();
  };

  // Full plate width hit strip (name left + size right).
  anyAbRenderer.artboardLabelHitTest = (wx, wy) => {
    const zoom = Math.max(0.05, Number(anyAbRenderer.zoom) || 1);
    const px = 11;
    const size = px / zoom;
    let hit: number | null = null;
    for (const ab of anyAbRenderer.scene.getArtboards()) {
      const labelTop = ab.y - 5 / zoom - size;
      const labelBottom = ab.y - 5 / zoom + size * 0.25;
      if (wx >= ab.x && wx <= ab.x + ab.w && wy >= labelTop && wy <= labelBottom) {
        hit = ab.id;
      }
    }
    return hit;
  };

  // Artboard chrome — Kit owns idle / soft / full plate stroke (same AABB).
  // Soft focus recolors the plate stroke blue (generator-parent style) — never
  // a second SVG edge that can drift from the Kit hairline.
  // Multi-frame full chrome: member plates stay accent-outlined; handles sit on
  // the union AABB (same as FrameMultiSelectionToolbar dock).
  anyAbRenderer.drawArtboards = (canvas) => {
    const op = anyAbRenderer.ensureOverlayPaints();
    const zoom = Math.max(0.05, Number(anyAbRenderer.zoom) || 1);
    const multiIds = (
      (anyAbRenderer as { rcbSelectedArtboardKitIds?: number[] }).rcbSelectedArtboardKitIds || []
    ).filter((id) => Number.isFinite(id));
    const multiSet = new Set(multiIds);
    const multiSelect = multiSet.size > 1;
    const artboards = anyAbRenderer.scene.getArtboards();
    // Same as node move: hide transform box + title/size while the plate is dragged.
    const artboardMoving = Boolean(
      (input as { isArtboardMoving?: () => boolean }).isArtboardMoving?.()
    );

    for (const ab of artboards) {
      const bg = ab.background;
      op.artboardFill.setColor(
        canvasKit.Color(
          Math.round(bg.r * 255),
          Math.round(bg.g * 255),
          Math.round(bg.b * 255),
          bg.a
        )
      );
      op.artboardFill.setAntiAlias?.(false);
      canvas.drawRect(
        canvasKit.LTRBRect(ab.x, ab.y, ab.x + ab.w, ab.y + ab.h),
        op.artboardFill
      );

      const soleSelected = !multiSelect && ab.id === anyAbRenderer.selectedArtboardId;
      const multiMember = multiSelect && multiSet.has(ab.id);
      const selected = soleSelected || multiMember;
      const soft =
        !selected && ab.id === anyAbRenderer.softArtboardId;
      // Mid-move: idle hairline only (no blue control box), like a dragging rect.
      const showSelectChrome = (selected || soft) && !artboardMoving;
      const border = showSelectChrome ? op.selOutline : op.artboardStroke;
      border.setStrokeWidth(1 / zoom);
      border.setAntiAlias(true);
      canvas.drawRect(
        canvasKit.LTRBRect(ab.x, ab.y, ab.x + ab.w, ab.y + ab.h),
        border
      );

      if (!artboardMoving) {
        anyAbRenderer.drawArtboardLabel(canvas, ab, selected || soft);
      }
      // Per-plate handles only for sole full chrome — multi uses the union box.
      if (soleSelected && !artboardMoving) {
        anyAbRenderer.drawArtboardHandles(canvas, ab);
      }
    }

    if (multiSelect && !artboardMoving) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const ab of artboards) {
        if (!multiSet.has(ab.id)) continue;
        minX = Math.min(minX, ab.x);
        minY = Math.min(minY, ab.y);
        maxX = Math.max(maxX, ab.x + ab.w);
        maxY = Math.max(maxY, ab.y + ab.h);
      }
      if (maxX > minX && maxY > minY) {
        op.selOutline.setStrokeWidth(1 / zoom);
        op.selOutline.setAntiAlias(true);
        canvas.drawRect(canvasKit.LTRBRect(minX, minY, maxX, maxY), op.selOutline);
        anyAbRenderer.drawArtboardHandles(canvas, {
          id: -1,
          name: '',
          x: minX,
          y: minY,
          w: maxX - minX,
          h: maxY - minY,
          background: { r: 1, g: 1, b: 1, a: 1 },
        });
      }
    }
  };

  const paint = renderer.render.bind(renderer);
  renderer.render = () => {
    const surface = (renderer as {
      surface?: { getCanvas: () => { clear: (c: unknown) => void } };
    }).surface;
    if (!surface) {
      paint();
      return;
    }
    const rawGet = surface.getCanvas.bind(surface);
    let firstClear = true;
    surface.getCanvas = () => {
      const c = rawGet();
      const rawClear = c.clear.bind(c);
      c.clear = (color: unknown) => {
        if (firstClear) {
          firstClear = false;
          rawClear(canvasKit.TRANSPARENT);
          return;
        }
        rawClear(color);
      };
      return c;
    };
    try {
      paint();
    } finally {
      surface.getCanvas = rawGet;
    }
  };

  // Pixel grid (1wu) only paints at ≥1000% — soft slate on light --canvas.
  const anyRenderer = renderer as unknown as {
    ensureOverlayPaints?: () => {
      gridPaint?: { setColor: (c: unknown) => void; setAntiAlias?: (v: boolean) => void };
    };
    _overlayPaints?: {
      gridPaint?: { setColor: (c: unknown) => void };
    };
  };
  const origEnsure = anyRenderer.ensureOverlayPaints?.bind(renderer);
  if (origEnsure) {
    anyRenderer.ensureOverlayPaints = () => {
      const op = origEnsure() as {
        gridPaint?: { setColor: (c: unknown) => void; setAntiAlias?: (v: boolean) => void };
        selOutline?: { setColor: (c: unknown) => void; setAntiAlias?: (v: boolean) => void };
        selHandleStroke?: { setColor: (c: unknown) => void };
        hoverOutline?: { setColor: (c: unknown) => void };
        artboardStroke?: { setColor: (c: unknown) => void; setAntiAlias?: (v: boolean) => void };
      };
      try {
        op?.gridPaint?.setAntiAlias?.(true);
        op?.gridPaint?.setColor(canvasKit.Color(15, 23, 42, 0.14));
        // Product selection chrome — #00A2FF (Kit accent).
        const accent = canvasKit.Color(0, 162, 255, 1);
        op?.selOutline?.setColor(accent);
        op?.selOutline?.setAntiAlias?.(true);
        op?.selHandleStroke?.setColor(accent);
        op?.hoverOutline?.setColor(canvasKit.Color(0, 162, 255, 0.55));
        // Dadaki idle plate hairline — Kit owns it (see drawArtboards).
        // Keep AA on (same as node Rect selection) — AA-off strokeRect drops
        // top/left edges after fractional zoom. Light cool gray (not near-black).
        op?.artboardStroke?.setColor(canvasKit.Color(197, 201, 210, 1));
        op?.artboardStroke?.setAntiAlias?.(true);
      } catch {
        /* ignore */
      }
      return op;
    };
  }

  // RCB toolbar picks the tool; Kit maybeRevertTool one-shots back to
  // selection after create unless toolLocked (pen/pencil via setTool lock=true).
  ui.toolLocked = false;

  // Product SVG cursors (not bare crosshair) for pen / pencil / bucket.
  ui.setToolCursor('pen', PEN_CURSOR);
  ui.setToolCursor('pencil', PENCIL_CURSOR);
  ui.setToolCursor('paint-bucket', BUCKET_CURSOR);
  ui.applyToolCursor();

  // Keep product toolbar in sync when Kit reverts to selection (create one-shot,
  // Esc, etc.). Otherwise store stays on shape/pen → React setTool fights Kit
  // and renderSelectionOverlay hides the control box (tool !== 'selection').
  const kitSetActiveTool = ui.setActiveTool.bind(ui);
  // Kit UIEngine.setActiveTool always exitEditMode — fine when leaving edit, but
  // RCB store↔Kit tool sync re-arms `direct` *after* enterPathEdit and would
  // immediately kill轮廓化 / double-click path-edit. Keep edit when the target
  // tool is still a node-edit tool (same set as InputManager.NODE_EDIT_TOOLS).
  const NODE_EDIT_TOOLS = new Set(['direct', 'selection', 'pen', 'scissors']);
  ui.setActiveTool = (toolId: string, lock = false) => {
    const keepPathEdit =
      input.editingNodeId != null && NODE_EDIT_TOOLS.has(String(toolId || ''));
    if (keepPathEdit) {
      ui.activeTool = toolId;
      ui.toolLocked = lock;
      try {
        ui.toolbar?.sync?.(toolId);
      } catch {
        /* optional chrome */
      }
      try {
        ui.applyToolCursor();
      } catch {
        /* optional cursor */
      }
    } else {
      kitSetActiveTool(toolId, lock);
    }
    if (toolId !== 'selection') return;
    const cur = String(store.getState().editor.activeTool || '').toLowerCase();
    // Don't steal pan / path-edit (direct) chrome — only unwind create tools.
    if (cur === 'select' || cur === 'selection' || cur === 'scale' || cur === 'pan') return;
    if (cur === 'direct') return;
    // Pen/pencil lock=true — maybeRevertTool must not flip the product toolbar.
    if (isPersistentDrawSessionTool(cur) && ui.toolLocked) return;
    setEditorActiveTool('select');
  };

  const kitKeyDown = input.onKeyDown.bind(input);
  const kitKeyUp = input.onKeyUp.bind(input);
  let drawKeyboard = false;
  input.onKeyDown = (e: KeyboardEvent) => {
    if (!drawKeyboard) return;
    // Product hotkeys own undo/redo/group via kitBridge — do not dual-mutate.
    // Clipboard (c/x/v/d) still runs here when kitOwnsStagePointer.
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y' || k === 'g') return;
    }
    // RCB owns frame (`f`) + generator (`a`/`shift+a`) — never let Kit steal
    // bare `a` into artboard tool (that leaves orphans named "Artwork N").
    if (!mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') return;
    kitKeyDown(e);
  };
  input.onKeyUp = (e: KeyboardEvent) => {
    if (!drawKeyboard) return;
    kitKeyUp(e);
  };
  // RCB owns wheel / pan-zoom.
  input.onWheel = () => undefined;

  renderer.start();
  try {
    anyRenderer.ensureOverlayPaints?.();
  } catch {
    /* optional */
  }

  let createStyleJson: string | null = null;

  const parseCss = (css: string | null | undefined) => {
    const s = String(css || '').trim();
    if (!s || s === 'transparent' || s === 'none') return null;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: 1,
      };
    }
    const rgba =
      /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
    if (rgba) {
      return {
        r: Number(rgba[1]) / 255,
        g: Number(rgba[2]) / 255,
        b: Number(rgba[3]) / 255,
        a: rgba[4] != null ? Number(rgba[4]) : 1,
      };
    }
    return null;
  };

  const applyCreateStyleJson = (json: string) => {
    createStyleJson = json;
    ui.setCurrentStyle(json);
  };

  // Default create style = Kit UIEngine buildCurrentStyleJson (grey fill +
  // 1px black stroke). Product pen* colors update via setCreateStyle →
  // ui.setCurrentStyle; InputManager applies getCurrentStyle / drawnPathStyle.
  applyCreateStyleJson(
    JSON.stringify({
      fills: [{ r: 0.8, g: 0.8, b: 0.8, a: 1 }],
      strokes: [
        {
          paint: { r: 0, g: 0, b: 0, a: 1 },
          width: 1,
          cap: 0,
          join: 0,
          dash_array: [],
          dash_offset: 0,
          miter_limit: 4,
          alignment: 'Center',
        },
      ],
      opacity: 1,
      blend_mode: 0,
      fill_rule: 0,
      corner_radius: 0,
      effects: [],
    })
  );

  return {
    ck: canvasKit,
    scene: wasmScene,
    renderer,
    input,
    ui,
    setTool: (toolId: string) => {
      // Pen/pencil lock until 退出编辑 — maybeRevertTool must not one-shot back
      // to selection. Other create tools stay lock=false (Figma one-shot).
      const lock = PERSISTENT_DRAW_TOOLS.has(toolId);
      ui.setActiveTool(toolId, lock);
      // Tool chrome must not reintroduce per-tool palette colors — re-assert
      // the single product create style after every tool switch.
      if (createStyleJson) ui.setCurrentStyle(createStyleJson);
      // Pen drop-marker / rubber-band need a hover sample even before first move.
      if (toolId === 'pen') {
        try {
          input.updatePenHover();
        } catch {
          /* ignore */
        }
      }
      renderer.requestRender();
    },
    setDrawKeyboard: (enabled: boolean) => {
      drawKeyboard = Boolean(enabled);
    },
    setGridSnap: (gridSize: number) => {
      const g = Number(gridSize);
      input.snap.gridSize = Number.isFinite(g) && g > 0 ? g : 0;
    },
    setCreateStyle: ({ fill, stroke, strokeWidth }) => {
      const strokeC = parseCss(stroke) ?? { r: 0, g: 0, b: 0, a: 1 };
      const fillC = parseCss(fill);
      const width = Number(strokeWidth);
      // Kit ui.setCurrentStyle — open path tools strip fill in drawnPathStyle
      // at commit; do not clear fills here or the next rect loses its fill.
      applyCreateStyleJson(
        JSON.stringify({
          fills: fillC ? [fillC] : [{ r: 0.8, g: 0.8, b: 0.8, a: 1 }],
          strokes: [
            {
              paint: strokeC,
              width: Number.isFinite(width) && width > 0 ? width : 1,
              cap: 0,
              join: 0,
              dash_array: [],
              dash_offset: 0,
              miter_limit: 4,
              alignment: 'Center',
            },
          ],
          opacity: 1,
          blend_mode: 0,
          fill_rule: 0,
          corner_radius: 0,
          effects: [],
        })
      );
    },
    enterPathEdit: (kitId: number) => {
      input.enterPathEditMode(kitId);
      renderer.requestRender();
    },
    exitPathEdit: () => {
      input.exitEditMode();
      renderer.requestRender();
    },
    isPathEditing: () => input.editingNodeId != null,
    getEditingKitId: () =>
      input.editingNodeId != null && Number.isFinite(input.editingNodeId)
        ? input.editingNodeId
        : null,
    placeImage: (bytes, mime, cx, cy, w, h) => {
      const id = wasmScene.placeImage(bytes, mime, cx, cy, w, h);
      renderer.requestRender();
      return id;
    },
    setLivePaintFill: (hex: string) => {
      ui.setLivePaintFill(hex);
    },
    setLivePaintFillNone: (none: boolean) => {
      ui.setLivePaintFillNone?.(none);
    },
    setLivePaintGradient: (g: unknown | null) => {
      ui.setLivePaintGradient?.(g as never);
    },
    exportPNG: (scale = 2, bounds, background, outSize) => {
      try {
        return renderer.exportPNG(
          scale,
          bounds,
          background ?? undefined,
          outSize
        );
      } catch (err) {
        console.warn('[rcb/canvas] exportPNG failed', err);
        return null;
      }
    },
    destroy: () => {
      try {
        (renderer as { isRunning?: boolean }).isRunning = false;
      } catch {
        /* ignore */
      }
      container.innerHTML = '';
      container.classList.remove('rcb-kit-host');
    },
  };
}

export async function loadCanvasKit(): Promise<CanvasKit> {
  const locateFile = (file: string) => {
    // Prefer app public/ copies (same origin, no node_modules path issues).
    if (file === 'canvaskit.wasm' || file.endsWith('/canvaskit.wasm')) {
      return '/canvaskit.wasm';
    }
    return `/${file.replace(/^\/+/, '')}`;
  };

  try {
  const CanvasKitInit = (await import('canvaskit-wasm')).default;
    return await CanvasKitInit({ locateFile });
  } catch (npmErr) {
    console.warn('[rcb/canvas] canvaskit-wasm import failed, trying /canvaskit.js', npmErr);
  }

  // Fallback: script-tag load of the vendored public build.
  const w = window as Window & { CanvasKitInit?: (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit> };
  if (!w.CanvasKitInit) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/canvaskit.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('[rcb/canvas] failed to load /canvaskit.js'));
      document.head.appendChild(s);
    });
  }
  if (!w.CanvasKitInit) {
    throw new Error('[rcb/canvas] CanvasKitInit missing after /canvaskit.js');
  }
  return w.CanvasKitInit({ locateFile });
}
