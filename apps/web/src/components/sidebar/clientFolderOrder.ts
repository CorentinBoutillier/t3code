import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export const CLIENT_FOLDER_ORDER_KEY = "t3code:sidebar:client-folder-order";
/** Entry ids by level: `"rail"`, or the row id of the client or project group they sit under. */
export const SidebarClientFolderOrder = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type SidebarClientFolderOrder = typeof SidebarClientFolderOrder.Type;
export const NO_CLIENT_FOLDER_ORDER: SidebarClientFolderOrder = {};
// Read loosely, so one bad level (an older or newer build, a hand edit) costs only that level.
const StoredSidebarClientFolderOrder = Schema.Record(Schema.String, Schema.Unknown);
export const SIDEBAR_RAIL_ORDER_LEVEL = "rail";

/** Keeps the levels that are lists of ids, each id once; drops the rest. */
export function normalizeSidebarClientFolderOrder(
  stored: Readonly<Record<string, unknown>>,
): SidebarClientFolderOrder {
  const order: Record<string, readonly string[]> = {};
  for (const [level, ids] of Object.entries(stored)) {
    if (!Array.isArray(ids)) continue;
    const kept = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
    if (kept.length > 0) order[level] = kept;
  }
  return order;
}

/** The device's stored order, and its setter; every reader goes through here. */
export function useSidebarClientFolderOrder() {
  const [stored, setOrder] = useLocalStorage(
    CLIENT_FOLDER_ORDER_KEY,
    NO_CLIENT_FOLDER_ORDER,
    StoredSidebarClientFolderOrder,
  );
  return [normalizeSidebarClientFolderOrder(stored), setOrder] as const;
}

/** Drops the levels of clients and project groups that no longer exist. */
export function pruneSidebarOrderLevels(
  order: SidebarClientFolderOrder,
  levels: ReadonlyMap<string, readonly string[]>,
): SidebarClientFolderOrder {
  const kept = Object.entries(order).filter(([level]) => levels.has(level));
  return kept.length === Object.keys(order).length ? order : Object.fromEntries(kept);
}

export interface SidebarOrderRef {
  readonly level: string;
  readonly id: string;
}

export interface SidebarOrderDrop {
  readonly targetId: string;
  readonly position: "before" | "after";
}

export function sidebarRepositoryOrderId(projectKey: string) {
  return `project:${projectKey}`;
}

/** Where a drag over `overId` lands among the level's shown entries; null when nothing would move. */
export function resolveSidebarOrderDrop(input: {
  readonly siblings: readonly string[];
  readonly activeId: string;
  readonly overId: string;
}): SidebarOrderDrop | null {
  const active = input.siblings.indexOf(input.activeId);
  const over = input.siblings.indexOf(input.overId);
  if (active === -1 || over === -1 || active === over) return null;
  return { targetId: input.overId, position: over > active ? "after" : "before" };
}

/**
 * One keyboard step among the shown siblings; null at either end or when `activeId` is not one.
 * Hidden entries of the level (a client the tree hides, still on the rail) keep their place, so
 * the entry passes them too: that is the smallest move that swaps the two shown rows.
 */
export function stepSidebarOrderDrop(input: {
  readonly siblings: readonly string[];
  readonly activeId: string;
  readonly direction: -1 | 1;
}): SidebarOrderDrop | null {
  const active = input.siblings.indexOf(input.activeId);
  const overId = active === -1 ? undefined : input.siblings[active + input.direction];
  if (overId === undefined) return null;
  return resolveSidebarOrderDrop({ siblings: input.siblings, activeId: input.activeId, overId });
}

/**
 * Rewrites one level, keeping only ids still present; returns `order` itself when the entry or
 * target is unknown.
 */
export function moveSidebarOrderEntry(input: {
  readonly order: SidebarClientFolderOrder;
  readonly level: string;
  /** Every existing entry of the level, shown or not, in resolved order. */
  readonly present: readonly string[];
  readonly activeId: string;
  readonly drop: SidebarOrderDrop;
}): SidebarClientFolderOrder {
  const { activeId, drop } = input;
  const stored = input.order[input.level] ?? [];
  const present = new Set(input.present);
  const kept = stored.filter((id) => present.has(id));
  const merged = [...new Set([...kept, ...input.present])];
  if (activeId === drop.targetId || !merged.includes(activeId) || !merged.includes(drop.targetId)) {
    return input.order;
  }
  const without = merged.filter((id) => id !== activeId);
  const at = without.indexOf(drop.targetId) + (drop.position === "after" ? 1 : 0);
  return {
    ...input.order,
    [input.level]: [...without.slice(0, at), activeId, ...without.slice(at)],
  };
}
