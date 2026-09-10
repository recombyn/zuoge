import React, { cloneElement, isValidElement, useRef, useState, useCallback, useEffect, memo } from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  FloatingPortal,
  type Placement,
} from '@floating-ui/react';
import { cn } from '@/utils/classnames';

export type HtmlContentProps = {
  open?: boolean;
  onClose?: () => void;
  onClick?: () => void;
};

export type ReferenceRect = { left: number; top: number; width?: number; height?: number };

type IPopover = {
  className?: string;
  htmlContent: React.ReactNode;
  popupClassName?: string;
  trigger?: 'click' | 'hover';
  position?: Placement | 'bottom' | 'br' | 'bl' | 'top' | 'tr' | 'tl' | 'left' | 'lt' | 'lb' | 'right' | 'rt' | 'rb';
  btnElement?: string | React.ReactNode;
  btnClassName?: string | ((open: boolean) => string);
  manualClose?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Virtual anchor: positions the popover against this screen rect and skips rendering a trigger button */
  referenceRect?: ReferenceRect | null;
};

const timeoutDuration = 100;

const positionMap: Record<string, Placement> = {
  bottom: 'bottom',
  br: 'bottom-end',
  bl: 'bottom-start',
  top: 'top',
  tr: 'top-end',
  tl: 'top-start',
  left: 'left',
  lt: 'left-start',
  lb: 'left-end',
  right: 'right',
  rt: 'right-start',
  rb: 'right-end',
};

const defaultRect = (): DOMRect => new DOMRect(0, 0, 0, 0);

const CustomPopover = ({
  trigger = 'hover',
  position = 'bottom',
  htmlContent,
  popupClassName,
  btnElement,
  className,
  btnClassName,
  manualClose,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  referenceRect,
}: IPopover) => {
  const [localOpen, setLocalOpen] = useState(false);
  const timeOutRef = useRef<number | null>(null);
  const virtualElRef = useRef({
    getBoundingClientRect: (): DOMRect => defaultRect(),
  });

  const open = controlledOpen ?? localOpen;
  const setOpen = useCallback((newOpen: boolean) => {
    if (controlledOpen === undefined) {
      setLocalOpen(newOpen);
    }
    onOpenChange?.(newOpen);
  }, [controlledOpen, onOpenChange]);

  const getPlacement = (): Placement => {
    if (position && positionMap[position]) {
      return positionMap[position];
    }
    // Already a Floating UI placement string
    if (position && typeof position === 'string' && position.includes('-')) {
      return position as Placement;
    }
    return 'bottom';
  };

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: getPlacement(),
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({
        padding: 5,
      }),
      shift({ padding: 5 }),
    ],
  });

  // Virtual reference element when `referenceRect` is set; otherwise the DOM trigger below is used
  useEffect(() => {
    if (referenceRect) {
      const { left, top, width = 0, height = 0 } = referenceRect;
      virtualElRef.current.getBoundingClientRect = () =>
        new DOMRect(left, top, width, height);
      refs.setReference(virtualElRef.current);
    }
  }, [referenceRect, refs]);

  // Mirror controlled `open` into local state
  useEffect(() => {
    if (controlledOpen !== undefined && controlledOpen !== localOpen) {
      setLocalOpen(controlledOpen);
    }
  }, [controlledOpen, localOpen]);

  const hover = useHover(context, {
    enabled: trigger === 'hover' && !disabled,
    move: true,
    delay: {
      open: 0,
      close: timeoutDuration,
    },
  });

  const focus = useFocus(context, {
    enabled: trigger === 'click' && !disabled,
  });

  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'tooltip' });

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

  const handleClose = useCallback(() => {
    if (manualClose) {
      setOpen(false);
    }
  }, [manualClose, setOpen]);

  const onMouseEnter = (isOpen: boolean) => {
    if (timeOutRef.current != null) window.clearTimeout(timeOutRef.current);
    if (!isOpen && trigger === 'hover' && !disabled) {
      setOpen(true);
    }
  };

  const onMouseLeave = (isOpen: boolean) => {
    if (trigger === 'hover' && !disabled) {
      timeOutRef.current = window.setTimeout(() => {
        if (isOpen) {
          setOpen(false);
        }
      }, timeoutDuration);
    }
  };

  const useVirtualRef = Boolean(referenceRect);

  return (
    <>
      {!useVirtualRef && (
        <div
          ref={refs.setReference}
          className={cn('inline-block', className)}
          {...getReferenceProps()}
          onClick={() => {
            if (trigger === 'click' && !disabled) {
              setOpen(!open);
            }
          }}
        >
          {btnElement ? (
            typeof btnElement === 'string' ? (
              <button
                type='button'
                disabled={disabled}
                className={cn(
                  'group inline-flex items-center rounded-lg border border-components-button-secondary-border bg-components-button-secondary-bg px-3 py-2 text-base font-medium hover:border-components-button-secondary-border-hover hover:bg-components-button-secondary-bg-hover focus:outline-none',
                  open && 'border-components-button-secondary-border bg-components-button-secondary-bg-hover',
                  btnClassName && typeof btnClassName === 'string' && btnClassName,
                  btnClassName && typeof btnClassName !== 'string' && btnClassName?.(open)
                )}
              >
                {btnElement}
              </button>
            ) : (
              btnElement
            )
          ) : null}
        </div>
      )}
      {open ? (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={cn('z-20', className)}
            {...getFloatingProps({
              ...(trigger === 'hover'
                ? {
                    onMouseLeave: () => onMouseLeave(open),
                    onMouseEnter: () => onMouseEnter(open),
                  }
                : {}),
            })}
          >
            <div
              className={cn(
                'w-fit min-w-[130px] overflow-hidden bg-[var(--color-background-default-base)] p-2 shadow-lg',
                'focus:outline-none focus-visible:outline-none',
                !popupClassName?.includes('rounded') && 'rounded-xl',
                popupClassName
              )}
              {...(trigger === 'hover'
                ? {
                    onMouseLeave: () => onMouseLeave(open),
                    onMouseEnter: () => onMouseEnter(open),
                  }
                : {})}
            >
              {isValidElement(htmlContent)
                ? cloneElement(htmlContent as React.ReactElement<HtmlContentProps>, {
                    open,
                    onClose: handleClose,
                    ...(manualClose
                      ? {
                          onClick: handleClose,
                        }
                      : {}),
                  })
                : htmlContent}
            </div>
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
};

export default memo(CustomPopover);