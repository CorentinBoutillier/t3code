import {
  closestCenter,
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import * as Schema from "effect/Schema";
import { useMessages } from "gt-react";
import { LayoutGridIcon } from "lucide-react";
import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useClientSettings } from "../../hooks/useSettings";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { SIDEBAR_DRAG_DISTANCE, SidebarPointerSensor } from "../Sidebar.pointer";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildSidebarClientRailEntries,
  CLIENT_FOLDERS_ENABLED_KEY,
  CLIENT_RAIL_SELECTED_KEY,
  sidebarClientRailThreads,
  sidebarClientFolderLevels,
  type SidebarClientRailEntry,
} from "./clientFolders";
import {
  moveSidebarOrderEntry,
  NO_CLIENT_FOLDER_ORDER,
  pruneSidebarOrderLevels,
  resolveSidebarOrderDrop,
  SIDEBAR_RAIL_ORDER_LEVEL,
  stepSidebarOrderDrop,
  useSidebarClientFolderOrder,
  type SidebarClientFolderOrder,
  type SidebarOrderDrop,
} from "./clientFolderOrder";
import { sidebarOrderRefOf, useSidebarOrderRow } from "./clientFolderOrderDrag";
import { resolveFolderDotWithVisits } from "./SidebarClientFolderHeader";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";

type RailEntry = SidebarClientRailEntry<SidebarProjectSnapshot>;
type FolderDot = ReturnType<typeof resolveFolderDotWithVisits>;

const ClientRailSelection = Schema.NullOr(Schema.String);
const RAIL_MODIFIERS = [restrictToVerticalAxis];

export function useSidebarClientRail(input: {
  readonly boringSidebarEnabled: boolean;
  readonly groups: readonly SidebarProjectSnapshot[];
}): {
  // null while the rail is off: boring sidebar or client folders disabled.
  readonly entries: readonly RailEntry[] | null;
  // null is "All"; a stored client that is gone reads as All and returns with its projects.
  readonly selected: RailEntry | null;
  readonly select: (id: string | null) => void;
  // undefined while the rail is off, so the tree keeps its default order.
  readonly order: SidebarClientFolderOrder | undefined;
  readonly moveEntry: (level: string, activeId: string, drop: SidebarOrderDrop) => void;
  readonly resetOrder: () => void;
} {
  const [clientFoldersEnabled] = useLocalStorage(CLIENT_FOLDERS_ENABLED_KEY, false, Schema.Boolean);
  const alphabetical = useClientSettings((s) => s.sidebarProjectSortOrder) !== "manual";
  const [storedId, setStoredId] = useLocalStorage(
    CLIENT_RAIL_SELECTED_KEY,
    null,
    ClientRailSelection,
  );
  const [order, setOrder] = useSidebarClientFolderOrder();
  const enabled = input.boringSidebarEnabled && clientFoldersEnabled;
  const entries = enabled
    ? buildSidebarClientRailEntries({ groups: input.groups, alphabetical, order })
    : null;
  const selected = entries?.find((entry) => entry.id === storedId) ?? null;
  // Resolved against every open project, so entries the view hides keep their place.
  const moveEntry = (level: string, activeId: string, drop: SidebarOrderDrop) => {
    const levels = sidebarClientFolderLevels({ groups: input.groups, alphabetical, order });
    const present = levels.get(level) ?? [];
    const next = moveSidebarOrderEntry({ order, level, present, activeId, drop });
    if (next !== order) setOrder(pruneSidebarOrderLevels(next, levels));
  };
  return {
    entries,
    selected,
    select: setStoredId,
    order: enabled ? order : undefined,
    moveEntry,
    resetOrder: () => setOrder(NO_CLIENT_FOLDER_ORDER),
  };
}

/** The boring sidebar's column of clients: picking one scopes the list beside it. */
export const SidebarClientRail = memo(function SidebarClientRail(props: {
  entries: readonly RailEntry[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (level: string, activeId: string, drop: SidebarOrderDrop) => void;
  onResetOrder: () => void;
  // Unscoped, so every client's dot stays live while another client is picked.
  threads: readonly EnvironmentThreadShell[];
  delegatedUnderParent: ReadonlySet<string>;
  serverConfigs: ReadonlyMap<EnvironmentId, unknown>;
  now: string;
  routeRowThreadKey: string | null;
}) {
  const { entries, selectedId, onSelect, onMove, serverConfigs, now, routeRowThreadKey } = props;
  const [drag, setDrag] = useState<{
    readonly activeId: string;
    readonly drop: SidebarOrderDrop | null;
  } | null>(null);
  // The sidebar's own sensor: it cancels on a lost release, a window blur, pagehide or resize.
  const sensorOptions = {
    distance: SIDEBAR_DRAG_DISTANCE,
    onAttach: () => {},
    onFinish: () => setDrag(null),
  };
  const sensors = useSensors(useSensor(SidebarPointerSensor, sensorOptions));
  const siblings = entries.map((entry) => entry.id);
  const dropOf = (event: DragOverEvent | DragEndEvent) => {
    const active = sidebarOrderRefOf(event.active);
    const over = sidebarOrderRefOf(event.over);
    if (active === null) return null;
    return {
      activeId: active.id,
      drop:
        over === null
          ? null
          : resolveSidebarOrderDrop({ siblings, activeId: active.id, overId: over.id }),
    };
  };
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  // Settled and snoozed threads asked to be left alone, so they light no dot.
  const dotThreads = filterSidebarV2VisibleThreads(
    props.threads,
    null,
    props.delegatedUnderParent,
  ).filter(
    (thread) =>
      !serverConfigs.has(thread.environmentId) ||
      (thread.settledOverride !== "settled" && !effectiveSnoozed(thread, { now })),
  );
  // Pinned threads and the open one stay out, as on the client header.
  const threadsByEntry = sidebarClientRailThreads(
    entries,
    dotThreads,
    (thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey,
  );
  // One Tab stop, on the picked entry; arrows move between entries.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      const button = document.activeElement;
      if (!(button instanceof HTMLElement)) return;
      const activeId = button.dataset.railEntry;
      if (activeId === undefined || activeId === "") return;
      const drop = stepSidebarOrderDrop({
        siblings,
        activeId,
        direction: event.key === "ArrowUp" ? -1 : 1,
      });
      if (drop === null) return;
      // The moved entry re-mounts under its key, which blurs it; commit first, then refocus.
      flushSync(() => onMove(SIDEBAR_RAIL_ORDER_LEVEL, activeId, drop));
      button.focus();
      return;
    }
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-rail-entry]"),
    ];
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index === -1) return;
    const target =
      event.key === "ArrowDown"
        ? buttons[Math.min(index + 1, buttons.length - 1)]
        : event.key === "ArrowUp"
          ? buttons[Math.max(index - 1, 0)]
          : event.key === "Home"
            ? buttons[0]
            : event.key === "End"
              ? buttons.at(-1)
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const position = { x: event.clientX, y: event.clientY };
    const source = contextMenuSourceOf(event);
    const { onResetOrder } = props;
    void (async () => {
      const clicked = await settlePromise(() =>
        api.contextMenu.show([{ id: "reset-order", label: "Reset order" }], position, source),
      );
      if (clicked._tag === "Success" && clicked.value === "reset-order") onResetOrder();
    })();
  };
  return (
    <div
      role="group"
      aria-label="Clients"
      data-testid="sidebar-client-rail"
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      className="flex min-h-0 w-16 shrink-0 flex-col border-r border-sidebar-border"
    >
      <ScrollArea hideScrollbars scrollFade viewportTabIndex={-1}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={RAIL_MODIFIERS}
          onDragStart={(event) => {
            const active = sidebarOrderRefOf(event.active);
            setDrag(active === null ? null : { activeId: active.id, drop: null });
          }}
          onDragOver={(event) => setDrag(dropOf(event))}
          onDragEnd={(event) => {
            const next = dropOf(event);
            setDrag(null);
            if (next?.drop) onMove(SIDEBAR_RAIL_ORDER_LEVEL, next.activeId, next.drop);
          }}
          onDragCancel={() => setDrag(null)}
        >
          <ul className="flex flex-col gap-1 px-1 py-2">
            <SidebarClientRailButton
              id={null}
              name="All"
              tooltip="All clients"
              logo={undefined}
              kind="client"
              selected={selectedId === null}
              dot={null}
              dropEdge={null}
              onSelect={onSelect}
            />
            {entries.map((entry) => (
              <SidebarClientRailButton
                key={entry.id}
                id={entry.id}
                name={entry.name}
                tooltip={entry.name}
                logo={entry.logo}
                kind={entry.kind}
                selected={selectedId === entry.id}
                dot={resolveFolderDotWithVisits(
                  threadsByEntry.get(entry.id) ?? [],
                  localLastVisitedAtById,
                )}
                dropEdge={drag?.drop?.targetId === entry.id ? drag.drop.position : null}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </DndContext>
      </ScrollArea>
    </div>
  );
});

const SidebarClientRailButton = memo(function SidebarClientRailButton(props: {
  id: string | null;
  name: string;
  tooltip: string;
  logo: SidebarProjectSnapshot | undefined;
  kind: RailEntry["kind"];
  selected: boolean;
  dot: FolderDot;
  dropEdge: SidebarOrderDrop["position"] | null;
  onSelect: (id: string | null) => void;
}) {
  const m = useMessages();
  const { id, name, logo, dot, onSelect } = props;
  // "All" stays first: neither draggable nor a target.
  const order = useSidebarOrderRow({
    level: id === null ? undefined : SIDEBAR_RAIL_ORDER_LEVEL,
    id: id ?? "all",
  });
  return (
    <li {...order.rowProps} className={cn("relative list-none", order.isDragging && "opacity-50")}>
      {props.dropEdge === null ? null : (
        <span
          aria-hidden
          data-testid="sidebar-order-drop-line"
          className={cn(
            "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
            props.dropEdge === "before" ? "-top-0.5" : "-bottom-0.5",
          )}
        />
      )}
      <Tooltip>
        {/* Out of the list's arrow-key tree: Tab reaches the picked entry, Enter or Space picks. */}
        <TooltipTrigger
          render={
            <button
              type="button"
              data-rail-entry={id ?? ""}
              tabIndex={props.selected ? 0 : -1}
              aria-pressed={props.selected}
              onClick={() => onSelect(id)}
              className={cn(
                "flex w-full cursor-pointer flex-col items-center gap-1 rounded-(--control-radius) px-0.5 py-1.5 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                props.selected &&
                  "bg-sidebar-row-active light:ring-1 light:ring-inset light:ring-sidebar-border/70",
              )}
            />
          }
        >
          <span className="relative">
            {logo === undefined ? (
              <LayoutGridIcon aria-hidden className="size-6 text-sidebar-muted-foreground" />
            ) : (
              // The fallback monogram is derived from the title, so a client is named after itself.
              <ProjectFavicon
                project={props.kind === "client" ? { ...logo, title: name } : logo}
                className="size-6"
              />
            )}
            {dot ? (
              <span
                aria-hidden
                className={cn(
                  "absolute -end-0.5 -top-0.5 size-2 rounded-full ring-2 ring-sidebar",
                  FOLDER_DOT_CLASS_NAME[dot],
                )}
              />
            ) : null}
          </span>
          <span className="w-full truncate text-center text-2xs text-sidebar-foreground/90">
            {name}
          </span>
          {dot ? <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span> : null}
        </TooltipTrigger>
        <TooltipPopup side="right">{props.tooltip}</TooltipPopup>
      </Tooltip>
    </li>
  );
});
