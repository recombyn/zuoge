/**
 * Live editor DomHost board handle (runtime only — not the editor store / document state).
 */
export type DomHostBoardHandle = {
  root: SVGSVGElement;
  /** Layer that holds DomHost anchors (excludes chrome). */
  layer: SVGGElement;
  /** nodeId → DomHost element */
  nodeEls: Map<string, SVGElement>;
  loadSeq?: number;
  getSvgElement: () => SVGSVGElement | null;
  /** Serialize DomHost layer for export (no UI chrome). */
  toSvgString: () => string;
};

let board: DomHostBoardHandle | null = null;

export function setDomHostBoard(next: DomHostBoardHandle | null) {
  board = next;
}

export function getDomHostBoard() {
  return board;
}
