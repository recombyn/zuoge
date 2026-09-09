import { describe, expect, it } from 'vitest';
import {
  NODE_TITLE_LABEL_GAP_PX,
  NODE_TITLE_LABEL_LINE_PX,
  SELECTION_HANDLE_CLEARANCE_PX,
  SELECTION_TOOLBAR_ABOVE_BOX_GAP_PX,
  SELECTION_TOOLBAR_ABOVE_LABEL_GAP_PX,
  SELECTION_TOOLBAR_BELOW_BOX_GAP_PX,
  selectionToolbarAboveAnchorScene,
  toolbarAboveClearancePx,
  toolbarAboveScreenGapPx,
} from '../chrome/SelectionToolbarShell';
import {
  nodeTitleLabelWorldPlacement,
  nodeTitleScreenGapPx,
} from '../chrome/NodeTitleLabel';
import { rcbScreenPxToScene } from '../../core/math';

const CANVAS_ZOOMS = [0.5, 1, 2.247, 10, 71.61, 80, 100] as const;
const VIEWPORT_SCALES = [0.75, 0.9, 1, 1.1, 1.25] as const;

describe('nodeTitleLabelWorldPlacement — title layout contract', () => {
  it('keeps icon left and size right flush with the plate when inset is 0', () => {
    const box = { left: 12, top: 40, width: 7, height: 6 };
    const place = nodeTitleLabelWorldPlacement(box, 48, { sizeText: '7 × 6' });
    expect(place.iconX).toBeCloseTo(box.left, 10);
    expect(place.sizeX).toBeCloseTo(box.left + box.width, 10);
    expect(place.hitLeft).toBeCloseTo(box.left, 10);
    expect(place.hitWidth).toBeCloseTo(box.width, 10);
  });

  it('clips the name so it cannot overlap the size column on a narrow plate', () => {
    const box = { left: 0, top: 10, width: 32, height: 32 };
    const zoom = 12.84;
    const place = nodeTitleLabelWorldPlacement(box, zoom, {
      sizeText: '32 × 32',
    });
    expect(place.nameMaxWidth).toBeGreaterThanOrEqual(0);
    expect(place.nameX + place.nameMaxWidth).toBeLessThanOrEqual(
      place.sizeX - place.sizeReserve + 1e-9
    );
    // eslint-disable-next-line no-console
    console.log('[test:title-overflow]', {
      zoom,
      nameMaxWidth: place.nameMaxWidth,
      sizeReserve: place.sizeReserve,
      boxWidth: box.width,
    });
  });

  it('uses scene = screenPx/zoom like selection handles (no CSS counter-scale)', () => {
    const box = { left: 2, top: 4, width: 11, height: 15 };
    const zoom = 80;
    const place = nodeTitleLabelWorldPlacement(box, zoom);
    const inv = 1 / zoom;

    expect(place.fontSize).toBeCloseTo(11 * inv, 10);
    expect(place.iconSize).toBeCloseTo(12 * inv, 10);
    expect(place.gapScene).toBeCloseTo(NODE_TITLE_LABEL_GAP_PX * inv, 10);
    expect(place.lineScene).toBeCloseTo(NODE_TITLE_LABEL_LINE_PX * inv, 10);
    expect(place.labelBottomScene).toBeLessThan(box.top);
    expect(place.labelTopScene).toBeLessThan(place.labelBottomScene);
    // Title lives fully above the plate.
    expect(place.labelTopScene + place.lineScene).toBeCloseTo(place.labelBottomScene, 10);
    // eslint-disable-next-line no-console
    console.log('[test:title-layout@8000%]', {
      zoom,
      fontSize: place.fontSize,
      handleVisLike: 8 * inv,
      labelTopScene: place.labelTopScene,
      boxTop: box.top,
      gapScreen: (box.top - place.labelBottomScene) * zoom,
    });
  });

  it.each([...CANVAS_ZOOMS])(
    'keeps a 10 screen-px gap above the control box at canvas zoom %s',
    (zoom) => {
      const box = { left: 0, top: 24, width: 15, height: 24 };
      const place = nodeTitleLabelWorldPlacement(box, zoom);
      const gap = nodeTitleScreenGapPx(place, box.top, zoom, 1);
      expect(gap).toBeCloseTo(NODE_TITLE_LABEL_GAP_PX, 6);
      expect(place.labelBottomScene).toBeLessThan(box.top);
      expect(place.labelTopScene).toBeLessThan(box.top);
      // Screen-constant type: font * zoom === 11
      expect(place.fontSize * zoom).toBeCloseTo(11, 6);
      // eslint-disable-next-line no-console
      console.log('[test:title-gap@canvas]', {
        zoom,
        gapLayoutPx: gap,
        fontScreenPx: place.fontSize * zoom,
      });
    }
  );

  it.each([...VIEWPORT_SCALES])(
    'scales the 10px title gap with viewportScale %s',
    (viewportScale) => {
      const box = { left: 0, top: 24, width: 15, height: 24 };
      const zoom = 71.61;
      const place = nodeTitleLabelWorldPlacement(box, zoom);
      const visual = nodeTitleScreenGapPx(place, box.top, zoom, viewportScale);
      expect(visual).toBeCloseTo(NODE_TITLE_LABEL_GAP_PX * viewportScale, 6);
      // eslint-disable-next-line no-console
      console.log('[test:title-gap@viewport]', {
        zoom,
        viewportScale,
        visualGapPx: visual,
      });
    }
  );
});

describe('toolbar 20px outside node @ canvas + browser zoom', () => {
  it('uses a 10px title gap and 20px toolbar gaps from the node', () => {
    expect(NODE_TITLE_LABEL_GAP_PX).toBe(10);
    expect(SELECTION_TOOLBAR_ABOVE_BOX_GAP_PX).toBe(20);
    expect(SELECTION_TOOLBAR_BELOW_BOX_GAP_PX).toBe(20);
    expect(toolbarAboveClearancePx(false)).toBe(20);
    expect(toolbarAboveClearancePx(true)).toBe(
      NODE_TITLE_LABEL_GAP_PX +
        NODE_TITLE_LABEL_LINE_PX +
        SELECTION_TOOLBAR_ABOVE_LABEL_GAP_PX
    );
  });

  it.each([...CANVAS_ZOOMS])(
    'untitled toolbar bottom stays 20px + handle clear above plate at zoom %s',
    (zoom) => {
      const boxTop = 40;
      const gap = toolbarAboveScreenGapPx(boxTop, zoom, false);
      expect(gap).toBeCloseTo(
        SELECTION_TOOLBAR_ABOVE_BOX_GAP_PX + SELECTION_HANDLE_CLEARANCE_PX,
        6
      );
      const anchor = selectionToolbarAboveAnchorScene(boxTop, zoom, false);
      expect(anchor).toBeLessThan(boxTop);
      expect(rcbScreenPxToScene(SELECTION_TOOLBAR_ABOVE_BOX_GAP_PX, zoom)).toBeCloseTo(
        SELECTION_TOOLBAR_ABOVE_BOX_GAP_PX / zoom,
        8
      );
      // Scene gap shrinks with zoom — at 10000% it is < 1 CSS px in world space.
      // Placement must apply that air as screen px inside scale(1/zoom), not as
      // world `top` alone (subpixel world offsets get eaten next to the stroke).
      expect((boxTop - anchor) * zoom).toBeCloseTo(gap, 6);
      // eslint-disable-next-line no-console
      console.log('[test:toolbar-gap@canvas]', { zoom, gapLayoutPx: gap, anchor });
    }
  );

  it.each([...CANVAS_ZOOMS])(
    'titled toolbar clears title stack (10+16+8) at zoom %s',
    (zoom) => {
      const boxTop = 40;
      const gap = toolbarAboveScreenGapPx(boxTop, zoom, true);
      expect(gap).toBeCloseTo(toolbarAboveClearancePx(true), 6);
      const box = { left: 0, top: boxTop, width: 15, height: 24 };
      const title = nodeTitleLabelWorldPlacement(box, zoom);
      const toolbarAnchor = selectionToolbarAboveAnchorScene(boxTop, zoom, true);
      expect(toolbarAnchor).toBeLessThan(title.labelTopScene);
      // eslint-disable-next-line no-console
      console.log('[test:toolbar-above-title@canvas]', {
        zoom,
        toolbarAnchor,
        titleTop: title.labelTopScene,
      });
    }
  );

  it.each([...VIEWPORT_SCALES])(
    'toolbar gap tracks viewportScale %s',
    (viewportScale) => {
      const boxTop = 40;
      const zoom = 2.247;
      const visual = toolbarAboveScreenGapPx(boxTop, zoom, true, 0, viewportScale);
      const expected = toolbarAboveClearancePx(true) * viewportScale;
      expect(visual).toBeCloseTo(expected, 6);
    }
  );
});
