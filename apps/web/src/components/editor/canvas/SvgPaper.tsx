import { memo, type CSSProperties, ReactNode, Ref, type RefCallback } from 'react';

type SvgPaperProps = {
  paperRef: Ref<HTMLDivElement>;
  hostRef: Ref<HTMLDivElement>;
  width: number;
  height: number;
  background: string;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
  /**
   * shapes layer: no fixed paper size. Camera CSS on parent world
   * layer owns pan/zoom; SVG overflows visibly in scene coordinates.
   */
  infinite?: boolean;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') {
    (ref as RefCallback<T>)(value);
    return;
  }
  try {
    (ref as { current: T | null }).current = value;
  } catch {
    /* ignore */
  }
}

/**
 * Scene shapes host. Visual zoom/pan is owned by RcbCanvas world transform.
 * Infinite/Kit path: one anchor div (no nested empty host).
 */
function SvgPaper({
  paperRef,
  hostRef,
  width,
  height,
  background,
  children,
  style,
  className,
  infinite = false,
}: SvgPaperProps) {
  if (infinite) {
    const setAnchor = (el: HTMLDivElement | null) => {
      assignRef(paperRef, el);
      assignRef(hostRef, el);
    };
    return (
      <div
        ref={setAnchor}
        className={className || 'rcb-shapes relative overflow-visible'}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          overflow: 'visible',
          background: 'transparent',
          ...style,
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      ref={paperRef}
      className={className || 'rcb-canvas-paper relative overflow-visible'}
      data-doc-width={width}
      data-doc-height={height}
      style={{
        width,
        height,
        background,
        overflow: 'visible',
        ...style,
      }}
    >
      <div ref={hostRef} className="absolute inset-0 overflow-visible [&>svg]:h-full [&>svg]:w-full" />
      {children}
    </div>
  );
}

export default memo(SvgPaper);
