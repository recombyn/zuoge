import type { FC, ReactNode } from 'react';
import { useState, useCallback, useEffect, memo } from 'react';
import {
  autoUpdate,
  flip,
  offset as offsetMiddleware,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  FloatingPortal,
  type Placement,
  type Strategy,
} from '@floating-ui/react';
import { cn } from '@/utils/classnames';
import MenuItem, { type MenuItemType } from './MenuItem';
import { DropdownPanel } from './DropdownPanel';

function flipFallbackPlacements(placement: Placement): Placement[] | undefined {
  const side = placement.split('-')[0];
  switch (side) {
    case 'top':
      return ['top-start', 'top-end', 'bottom', 'bottom-start', 'bottom-end'];
    case 'bottom':
      return ['bottom-start', 'bottom-end', 'top', 'top-start', 'top-end'];
    case 'left':
      return ['left-start', 'left-end', 'right-start', 'right-end'];
    case 'right':
      return ['right-start', 'right-end', 'left-start', 'left-end'];
    default:
      return undefined;
  }
}

export type DropdownProps = {
  items: MenuItemType[];
  onClick?: (key: string, item: MenuItemType) => void;
  selectedKeys?: string[];
  trigger?: 'hover' | 'click';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  expandIcon?: ReactNode;
  popupRender?: (menu: ReactNode) => ReactNode;
  popupClassName?: string;
  itemClassName?: string;
  /** Gap between trigger and menu (px). @default 8 */
  offset?: number;
  /** Floating positioning strategy. @default 'absolute' */
  strategy?: Strategy;
  /** Portal root container. Defaults to document.body. */
  getPopupContainer?: () => HTMLElement;
  /** Extra classes for the trigger wrapper (e.g. `block w-full` for full-width triggers). */
  referenceClassName?: string;
  /** Extra classes for the floating menu layer (e.g. higher z-index when nested in modals). */
  floatingClassName?: string;
  /**
   * When false, clicking/focusing the reference does not toggle open.
   * Use with controlled `open` for a nested trigger (e.g. corner chevron).
   * @default true
   */
  referenceToggle?: boolean;
  /**
   * CSS selector for nested portaled menus (e.g. Popover). Clicks inside matching
   * nodes do not dismiss this dropdown — needed when level-2 floats outside the tree.
   */
  nestedDismissGuard?: string;
  /** When this value changes, re-measure anchor (e.g. sidebar expand/collapse). */
  layoutKey?: unknown;
  children: ReactNode;
};

/**
 * Dropdown menu with optional nested items.
 */
const Dropdown: FC<DropdownProps> = ({
  items,
  onClick,
  selectedKeys = [],
  trigger = 'hover',
  open: controlledOpen,
  onOpenChange,
  placement = 'bottom-start',
  expandIcon,
  popupRender,
  popupClassName,
  itemClassName,
  offset = 8,
  strategy = 'absolute',
  getPopupContainer,
  referenceClassName,
  floatingClassName,
  referenceToggle = true,
  nestedDismissGuard,
  layoutKey,
  children,
}) => {
  const [localOpen, setLocalOpen] = useState(false);
  const [activeSubMenuKey, setActiveSubMenuKey] = useState<string | null>(null);

  const isClickTrigger = trigger === 'click';
  const open = controlledOpen ?? localOpen;

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (controlledOpen === undefined) {
        setLocalOpen(newOpen);
      }
      onOpenChange?.(newOpen);
      if (!newOpen) {
        setActiveSubMenuKey(null);
      }
    },
    [controlledOpen, onOpenChange]
  );

  const { refs, floatingStyles, context, update } = useFloating({
    open,
    onOpenChange: handleOpenChange,
    placement,
    strategy,
    whileElementsMounted: autoUpdate,
    middleware: [
      offsetMiddleware(offset),
      flip({
        padding: 8,
        fallbackPlacements: flipFallbackPlacements(placement),
      }),
      shift({ padding: 8 }),
    ],
  });

  useEffect(() => {
    if (!open) return;
    void update();
  }, [open, layoutKey, update]);

  const hover = useHover(context, {
    enabled: trigger === 'hover',
    move: true,
    delay: {
      open: 80,
      close: 180,
    },
  });

  const focus = useFocus(context, {
    enabled: isClickTrigger && referenceToggle,
  });

  const dismiss = useDismiss(context, {
    outsidePress: nestedDismissGuard
      ? (event) => {
          const el = event.target as Element | null;
          if (el?.closest?.(nestedDismissGuard)) return false;
          return true;
        }
      : true,
  });
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

  const handleSubMenuOpenChange = useCallback((key: string, isOpen: boolean) => {
    if (isOpen) {
      setActiveSubMenuKey(key);
    } else {
      setActiveSubMenuKey((prev) => (prev === key ? null : prev));
    }
  }, []);

  const handleClick = useCallback(
    (key: string, item: MenuItemType) => {
      onClick?.(key, item);
      if (!item.children && !item.interactive) {
        handleOpenChange(false);
      }
    },
    [onClick, handleOpenChange]
  );

  const menuContent = (
    <DropdownPanel className={popupClassName}>
      {items.map((item) => (
        <MenuItem
          key={item.key}
          item={item}
          selectedKeys={selectedKeys}
          onClick={handleClick}
          expandIcon={expandIcon}
          itemClassName={itemClassName}
          onSubMenuOpenChange={handleSubMenuOpenChange}
          activeSubMenuKey={activeSubMenuKey}
        />
      ))}
    </DropdownPanel>
  );

  return (
    <>
      <div
        ref={refs.setReference}
        className={cn('inline-block', referenceClassName)}
        {...getReferenceProps({
          onClick: () => {
            if (isClickTrigger && referenceToggle) {
              handleOpenChange(!open);
            }
          },
        })}
      >
        {children}
      </div>
      {open ? (
        <FloatingPortal root={getPopupContainer?.()}>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={cn('z-[500]', floatingClassName)}
            {...getFloatingProps()}
          >
            <div className="translate-y-0 opacity-100">
              {popupRender ? popupRender(menuContent) : menuContent}
            </div>
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
};

Dropdown.displayName = 'Dropdown';

export default memo(Dropdown);
export type { MenuItemType } from './MenuItem';
export { DropdownPanel, DropdownPanelItem } from './DropdownPanel';
