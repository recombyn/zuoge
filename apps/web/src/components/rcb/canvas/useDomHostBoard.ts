import { useEffect, useRef, useState, type RefObject } from 'react';
import { createDomHostBoard } from '@/components/rcb/scene/dom/domHostBoard';
import { setDomHostBoard, type DomHostBoardHandle } from './domHostBoardRegistry';

/**
 * Mount DomHost board onto a host element and register it for export.
 */
export function useDomHostBoard(
  hostRef: RefObject<HTMLElement | null>,
  paperW: number,
  paperH: number,
  opts?: { infinite?: boolean; enabled?: boolean }
) {
  const boardRef = useRef<DomHostBoardHandle | null>(null);
  const [boardEpoch, setBoardEpoch] = useState(0);
  const infinite = Boolean(opts?.infinite);
  const enabled = opts?.enabled !== false;

  useEffect(() => {
    if (!enabled) {
      boardRef.current = null;
      setDomHostBoard(null);
      setBoardEpoch((n) => n + 1);
      return undefined;
    }
    const host = hostRef.current;
    if (!host) return undefined;
    const { root, layer } = createDomHostBoard(host, paperW, paperH, { infinite });
    const handle: DomHostBoardHandle = {
      root,
      layer,
      nodeEls: new Map(),
      getSvgElement: () => root,
      toSvgString: () => {
        const clone = root.cloneNode(true) as SVGSVGElement;
        return new XMLSerializer().serializeToString(clone);
      },
    };
    boardRef.current = handle;
    setDomHostBoard(handle);
    setBoardEpoch((n) => n + 1);

    return () => {
      if (boardRef.current === handle) {
        setDomHostBoard(null);
        boardRef.current = null;
      }
      root.remove();
    };
    // Remount when infinite mode flips; paper size for finite boards is applied elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infinite, enabled]);

  return { boardRef, boardEpoch };
}
