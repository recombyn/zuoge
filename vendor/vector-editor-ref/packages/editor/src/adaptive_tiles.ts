/**
 * Zoom-adaptive re-rasterization sources for browser-rasterized filter tiles.
 *
 * Elements whose SVG filter can't be mapped to native effects are baked to a
 * fixed-resolution PNG at import time (see ui.ts rasterizeFilteredElements).
 * That bitmap pixelates once the view zooms past its bake scale. Each bake
 * also registers its standalone isolation-SVG source here (keyed by engine
 * image id) so the renderer can re-rasterize the tile at the current zoom on
 * demand — resolution independence without paying the native-filter GPU cost
 * on every frame.
 *
 * JS-only and session-scoped: documents reloaded from a saved snapshot carry
 * only the baked PNG (no source) and simply keep the fixed-resolution
 * behavior.
 */

export interface AdaptiveTileSource {
    /** Full inner markup of the isolation tile: `<defs>…</defs>` + element. */
    inner: string;
    /** Tile viewBox (already expanded for filter overflow). */
    x: number;
    y: number;
    w: number;
    h: number;
    /** Scale the engine-registered PNG was baked at (px per SVG unit). */
    baseScale: number;
}

/** Engine image id → re-bake source. Populated at import, cleared with the
 *  renderer's image cache when a different document is loaded. */
export const adaptiveTileSources = new Map<number, AdaptiveTileSource>();

/** Largest raster dimension we'll re-bake a tile to. */
const MAX_TILE_DIM = 4096;
/** Per-tile pixel budget (≈32 MB RGBA decoded). */
const MAX_TILE_PIXELS = 8_000_000;

/** Highest useful bake scale for a tile (px per SVG unit), bounded so a
 *  single tile can never blow the raster budget however far the user zooms. */
export function maxTileScale(src: AdaptiveTileSource): number {
    return Math.min(
        32,
        MAX_TILE_DIM / Math.max(src.w, src.h),
        Math.sqrt(MAX_TILE_PIXELS / (src.w * src.h)),
    );
}

/** Rasterize a tile at `scale` px/unit via the browser's SVG renderer.
 *  Resolves to a canvas ready for CanvasKit upload, or null on failure. */
export function rasterizeAdaptiveTile(
    src: AdaptiveTileSource,
    scale: number,
): Promise<HTMLCanvasElement | null> {
    const pxW = Math.max(1, Math.round(src.w * scale));
    const pxH = Math.max(1, Math.round(src.h * scale));
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="${pxW}" height="${pxH}" viewBox="${src.x} ${src.y} ${src.w} ${src.h}">${src.inner}</svg>`;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const c = document.createElement('canvas');
                c.width = pxW;
                c.height = pxH;
                const ctx = c.getContext('2d');
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, 0, 0, pxW, pxH);
                resolve(c);
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    });
}
