import { closestCenter, useDraggable, useDroppable, type CollisionDetection } from "@dnd-kit/core";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { SidebarOrderRef } from "./clientFolderOrder";

type DataHolder = { readonly data: { readonly current?: Record<string, unknown> | undefined } };

export function sidebarOrderRefOf(entry: DataHolder | null | undefined): SidebarOrderRef | null {
  const ref = entry?.data.current?.sidebarOrder;
  if (typeof ref !== "object" || ref === null) return null;
  const { level, id } = ref as { level?: unknown; id?: unknown };
  return typeof level === "string" && typeof id === "string" ? { level, id } : null;
}

/**
 * Order drags meet only order rows (a hit on another level's row stands for the sibling block it
 * sits in, or nothing); thread drags never meet an order row.
 */
export function withSidebarOrderCollisions(threads: CollisionDetection): CollisionDetection {
  return (args) => {
    const active = sidebarOrderRefOf(args.active);
    if (active === null) {
      return threads({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => sidebarOrderRefOf(container) === null,
        ),
      });
    }
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => sidebarOrderRefOf(container) !== null,
      ),
    });
  };
}

/**
 * A header or rail entry the user can drag within its level, and move with Alt+Arrow.
 * dnd-kit's `attributes` stay off: they would add a Tab stop and a role to every row.
 */
export function useSidebarOrderRow(input: {
  readonly level: string | undefined;
  readonly id: string;
  readonly onStep?:
    | ((ref: SidebarOrderRef, direction: -1 | 1, row: HTMLElement) => void)
    | undefined;
}) {
  const { level, id, onStep } = input;
  const dndId = `sidebar-order:${level ?? ""}\n${id}`;
  const data = { sidebarOrder: { level, id } };
  const disabled = level === undefined;
  const draggable = useDraggable({ id: dndId, data, disabled });
  const droppable = useDroppable({ id: dndId, data, disabled });
  const ref = (node: HTMLElement | null) => {
    draggable.setNodeRef(node);
    droppable.setNodeRef(node);
  };
  const onKeyDown =
    onStep === undefined || level === undefined
      ? undefined
      : (event: KeyboardEvent<HTMLElement>) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const direction =
            event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : undefined;
          if (direction === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          onStep({ level, id }, direction, event.currentTarget);
        };
  return {
    rowProps: {
      ref,
      ...draggable.listeners,
      "data-sidebar-order-level": level,
      "data-sidebar-order-id": level === undefined ? undefined : id,
      onKeyDown,
    },
    isDragging: draggable.isDragging,
  };
}

export interface SidebarOrderRowState {
  readonly rowProps: Partial<ReturnType<typeof useSidebarOrderRow>["rowProps"]>;
  readonly isDragging: boolean;
}

/** A header outside order mode: no drag wiring, and no subscription to any drag. */
export const NO_SIDEBAR_ORDER_ROW: SidebarOrderRowState = { rowProps: {}, isDragging: false };

/**
 * Mounted only for a header that can be reordered, so the others never subscribe to dnd-kit's
 * context and stay out of every drag's re-renders, thread drags included.
 */
export function SidebarOrderRow(props: {
  readonly level: string;
  readonly id: string;
  readonly onStep?:
    | ((ref: SidebarOrderRef, direction: -1 | 1, row: HTMLElement) => void)
    | undefined;
  readonly children: (order: SidebarOrderRowState) => ReactNode;
}) {
  const order = useSidebarOrderRow({ level: props.level, id: props.id, onStep: props.onStep });
  return props.children(order);
}

const DROP_LINE_INSET = { 0: "start-2", 1: "start-9", 2: "start-15.5" } as const;

/** Where a dragged header lands; zero height, so the list does not shift. */
export function SidebarOrderDropLine(props: { depth: 0 | 1 | 2 }) {
  return (
    <li
      aria-hidden
      data-testid="sidebar-order-drop-line"
      className="pointer-events-none relative -mb-px h-0 list-none"
    >
      <span
        className={cn(
          "absolute end-2 -top-px h-0.5 rounded-full bg-primary",
          DROP_LINE_INSET[props.depth],
        )}
      />
    </li>
  );
}
