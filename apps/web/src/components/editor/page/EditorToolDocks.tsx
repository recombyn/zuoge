import { memo, useEffect, useState, type ReactNode } from 'react';
import { useSelector } from '@/store';

import PenStrokeToolbar from '@/components/editor/chrome/PenStrokeToolbar';
import BucketFillToolbar from '@/components/editor/chrome/BucketFillToolbar';
import PathEditToolbar, {
  type PathEditSubtool,
} from '@/components/editor/chrome/PathEditToolbar';

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

/** Pen / pencil / line / arrow / bucket / path-edit docks — top center or inline in rail. */
function EditorToolDocks({
  isDevMode,
  activeTool,
  zoom = 1,
  viewportWidth,
  docWidth,
  placement = 'float',
}: Props) {
  const shapeKind = useSelector((s: any) => String(s.editor.shapeKind || 'rect'));
  const [pathEditActive, setPathEditActive] = useState(false);
  const [pathEditSubtool, setPathEditSubtool] = useState<PathEditSubtool>('select');

  // Kit path-edit chrome: follow resume:path-edit (not only store tool), so a
  // Kit-native exit that clears editing without resetting activeTool cannot
  // leave an orphan top dock.
  useEffect(() => {
    const onChrome = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const active = Boolean(d.active);
      setPathEditActive(active);
      if (!active) setPathEditSubtool('select');
    };
    const onSubtool = (e: Event) => {
      const s = (e as CustomEvent).detail?.subtool;
      if (s === 'pen' || s === 'add-anchor' || s === 'curve') setPathEditSubtool(s);
      else setPathEditSubtool('select');
    };
    window.addEventListener('resume:path-edit', onChrome);
    window.addEventListener('resume:path-edit-subtool', onSubtool);
    return () => {
      window.removeEventListener('resume:path-edit', onChrome);
      window.removeEventListener('resume:path-edit-subtool', onSubtool);
    };
  }, []);

  if (isDevMode) return null;

  const chrome = placement === 'inline' ? 'flat' : 'pill';
  const strokeMode = resolveCreateStrokeMode(activeTool, shapeKind);

  let body: ReactNode = null;
  if (pathEditActive) {
    body = (
      <PathEditToolbar
        chrome={chrome}
        subtool={pathEditSubtool}
        onSubtoolChange={(s) => {
          setPathEditSubtool(s);
          window.dispatchEvent(
            new CustomEvent('resume:path-edit-subtool', { detail: { subtool: s } })
          );
        }}
        onExit={() => {
          window.dispatchEvent(new Event('resume:exit-path-edit'));
        }}
      />
    );
  } else if (strokeMode) {
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
