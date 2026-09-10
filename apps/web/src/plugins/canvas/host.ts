/**
 * Canvas plugin host (Phase B) — in-process toolbar / future export hooks.
 *
 * Packs live under ``plugins/canvas/<id>/`` and register at boot via
 * ``ensureCanvasPlugins()``. No browser sandbox yet — plugins share the editor
 * bundle (same trust as first-party UI code).
 */
import type { ReactNode } from 'react';
import type { RootState } from '@/store';
import { spawnCreatedNode } from '@/store/modules/editor';
import { createTextNode } from '@/components/rcb/scene/document/nodeFactories';
import {
  rcbCameraCssZoom,
  rcbDefaultPlaceFontSize,
  rcbScreenToScene,
  type RcbCamera,
} from '@/components/rcb';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { sceneToDocumentCoords } from '@/components/rcb/scene/layout/coords';

export type CanvasPluginManifest = {
  id: string;
  name: string;
  version?: string;
  author?: string;
  enabled?: boolean;
  mounts?: string[];
  permissions?: string[];
};

export type CanvasPluginRuntime = {
  getState: () => RootState;
  /** Place a text node near the stage center (document coords). */
  placeText: (opts: {
    text: string;
    x?: number;
    y?: number;
    fontSize?: number;
    opacity?: number;
  }) => void;
  /** Document-space point under the viewport center (fallback mid-board). */
  viewportCenterDoc: () => { x: number; y: number };
};

export type CanvasToolbarButton = {
  id: string;
  pluginId: string;
  tip: string;
  order?: number;
  iconSrc?: string;
  icon?: ReactNode;
  onClick: (runtime: CanvasPluginRuntime) => void;
};

export type CanvasPluginApi = {
  registerToolbarButton: (
    btn: Omit<CanvasToolbarButton, 'pluginId'> & { pluginId?: string }
  ) => void;
};

export type CanvasPluginModule = {
  manifest: CanvasPluginManifest;
  register: (api: CanvasPluginApi) => void;
};

const toolbarButtons = new Map<string, CanvasToolbarButton>();
const installed = new Set<string>();
let bootstrapped = false;

/** Test helper — clear registry between unit cases. */
export function __resetCanvasPluginsForTests(): void {
  toolbarButtons.clear();
  installed.clear();
  bootstrapped = false;
}

export function listCanvasToolbarButtons(): CanvasToolbarButton[] {
  return [...toolbarButtons.values()].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id)
  );
}

export function installCanvasPlugin(mod: CanvasPluginModule): void {
  const manifest = mod?.manifest;
  const id = String(manifest?.id || '').trim();
  if (!id || !mod?.register) return;
  if (manifest?.enabled === false) return;
  if (installed.has(id)) return;
  installed.add(id);
  const api: CanvasPluginApi = {
    registerToolbarButton(btn) {
      const bid = String(btn.id || '').trim();
      if (!bid) return;
      toolbarButtons.set(bid, {
        id: bid,
        pluginId: String(btn.pluginId || id),
        tip: String(btn.tip || manifest?.name || bid),
        order: Number.isFinite(btn.order) ? Number(btn.order) : 100,
        iconSrc: btn.iconSrc,
        icon: btn.icon,
        onClick: btn.onClick,
      });
    },
  };
  try {
    mod.register(api);
  } catch (err) {
    console.warn(`[canvas-plugin] ${id} register failed`, err);
  }
}

function readViewportCenterDoc(
  state: RootState,
  camera?: RcbCamera | null,
  stageEl?: HTMLElement | null
): { x: number; y: number } {
  const doc = state.editor?.document as SceneDocument | null | undefined;
  if (!doc) return { x: 40, y: 40 };
  if (camera && stageEl) {
    const view = stageEl.getBoundingClientRect();
    if (view.width > 0 && view.height > 0) {
      const scene = rcbScreenToScene(
        camera,
        stageEl,
        view.left + view.width / 2,
        view.top + view.height / 2
      );
      return sceneToDocumentCoords(doc, scene.x, scene.y);
    }
  }
  const w = Number(doc.width) || 800;
  const h = Number(doc.height) || 600;
  return { x: Math.max(40, w * 0.5 - 80), y: Math.max(40, h * 0.5 - 20) };
}

export function buildCanvasPluginRuntime(
  getState: () => RootState,
  opts?: { camera?: RcbCamera | null; stageEl?: HTMLElement | null }
): CanvasPluginRuntime {
  const camera = opts?.camera;
  const stageEl = opts?.stageEl;
  return {
    getState,
    viewportCenterDoc: () => readViewportCenterDoc(getState(), camera, stageEl),
    placeText(textOpts) {
      const text = String(textOpts.text || '').trim();
      if (!text) return;
      const center = readViewportCenterDoc(getState(), camera, stageEl);
      const x = textOpts.x ?? center.x;
      const y = textOpts.y ?? center.y;
      const z = camera ? rcbCameraCssZoom(camera) : 1;
      const fontSize =
        textOpts.fontSize != null && textOpts.fontSize > 0
          ? textOpts.fontSize
          : rcbDefaultPlaceFontSize(z);
      const { id, node } = createTextNode({
        x,
        y,
        text,
        fontSize,
        autoSize: true,
      });
      const opacity = textOpts.opacity;
      if (opacity != null && Number.isFinite(opacity)) {
        (node.attrs as Record<string, unknown>).opacity = String(
          Math.min(1, Math.max(0.05, Number(opacity)))
        );
      }
      spawnCreatedNode({ id, node });
    },
  };
}

/** Idempotent — import built-in packs once. */
export async function ensureCanvasPlugins(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  // Sample watermark toolbar button is a local demo only — never ship on Cloud / prod.
  if (import.meta.env.DEV) {
    try {
      const mod = await import('@canvas-plugins/watermark');
      const pack = (mod as { default?: unknown }).default as
        | CanvasPluginModule
        | undefined;
      if (pack?.manifest) installCanvasPlugin(pack);
    } catch (err) {
      console.warn('[canvas-plugin] builtin watermark failed to load', err);
    }
  }
  // Cloud-safe first-party packs can register below (unconditional).
}
