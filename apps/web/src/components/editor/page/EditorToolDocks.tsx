import { memo, type ReactNode } from 'react';
import { useSelector } from '@/store';

import PenStrokeToolbar from '@/components/editor/chrome/PenStrokeToolbar';
import BucketFillToolbar from '@/components/editor/chrome/BucketFillToolbar';

type Props = {
  isDevMode: boolean;
  activeTool: string;
  zoom?: number;
  viewportWidth?: number;
  docWidth?: number;
  /**
   * `float` — content only; parent places at page top-center (create options bar).
   * `inline` — bare body for embedding in the timeline top rail.
   */
  placement?: 'float' | 'inline';
};

function resolveCreateStrokeMode(
  activeTool: string,
  shapeKind: string
): 'pen' | 'pencil' | null {
  if (activeTool === 'pen') return 'pen';
  if (activeTool === 'pencil') return 'pencil';
  // Line / arrow share the stroke options bar (stroke-only = pencil chrome).
  if (activeTool === 'shape' && (shapeKind === 'line' || shapeKind === 'arrow')) {
    return 'pencil';
  }
  return null;
}

/** Pen / pencil / line / arrow / bucket create docks — top center or inline in rail. */
function EditorToolDocks({
  isDevMode,
  activeTool,
  zoom = 1,
  viewportWidth,
  docWidth,
  placement = 'float',
}: Props) {
  const shapeKind = useSelector((s: any) => String(s.editor.shapeKind || 'rect'));
  if (isDevMode) return null;

  const chrome = placement === 'inline' ? 'flat' : 'pill';
  const strokeMode = resolveCreateStrokeMode(activeTool, shapeKind);

  let body: ReactNode = null;
  if (strokeMode) {
    body = (
      <PenStrokeToolbar
        mode={strokeMode}
        placement="dock"
        chrome={chrome}
        zoom={zoom}
        viewportWidth={viewportWidth}
        docWidth={docWidth}
      />
    );
  } else if (activeTool === 'bucket') {
    body = <BucketFillToolbar chrome={chrome} />;
  }

  if (!body) return null;

  return (
    <div
      className="pointer-events-auto flex items-center"
      data-editor-tool-dock={placement === 'inline' ? 'inline' : ''}
    >
      {body}
    </div>
  );
}

export default memo(EditorToolDocks);
