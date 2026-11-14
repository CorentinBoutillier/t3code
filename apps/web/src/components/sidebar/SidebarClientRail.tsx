import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import * as Schema from "effect/Schema";
import { useMessages } from "gt-react";
import { LayoutGridIcon } from "lucide-react";
import { memo, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildSidebarClientRailEntries,
  CLIENT_FOLDERS_ENABLED_KEY,
  CLIENT_RAIL_SELECTED_KEY,
  sidebarClientRailThreads,
  type SidebarClientRailEntry,
} from "./clientFolders";
import { resolveFolderDotWithVisits } from "./SidebarClientFolderHeader";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";

type RailEntry = SidebarClientRailEntry<SidebarProjectSnapshot>;
type FolderDot = ReturnType<typeof resolveFolderDotWithVisits>;

const ClientRailSelection = Schema.NullOr(Schema.String);

export function useSidebarClientRail(input: {
  readonly boringSidebarEnabled: boolean;
  readonly groups: readonly SidebarProjectSnapshot[];
}): {
  // null while the rail is off: boring sidebar or client folders disabled.
  readonly entries: readonly RailEntry[] | null;
  // null is "All"; a stored client that is gone reads as All and returns with its projects.
  readonly selected: RailEntry | null;
  readonly select: (id: string | null) => void;
} {
  const [clientFoldersEnabled] = useLocalStorage(CLIENT_FOLDERS_ENABLED_KEY, false, Schema.Boolean);
  const alphabetical = useClientSettings((s) => s.sidebarProjectSortOrder) !== "manual";
  const [storedId, setStoredId] = useLocalStorage(
    CLIENT_RAIL_SELECTED_KEY,
    null,
    ClientRailSelection,
  );
  const entries =
    input.boringSidebarEnabled && clientFoldersEnabled
      ? buildSidebarClientRailEntries({ groups: input.groups, alphabetical })
      : null;
  const selected = entries?.find((entry) => entry.id === storedId) ?? null;
  return { entries, selected, select: setStoredId };
}

/** The boring sidebar's column of clients: picking one scopes the list beside it. */
export const SidebarClientRail = memo(function SidebarClientRail(props: {
  entries: readonly RailEntry[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  // Unscoped, so every client's dot stays live while another client is picked.
  threads: readonly EnvironmentThreadShell[];
  delegatedUnderParent: ReadonlySet<string>;
  serverConfigs: ReadonlyMap<EnvironmentId, unknown>;
  now: string;
  routeRowThreadKey: string | null;
}) {
  const { entries, selectedId, onSelect, serverConfigs, now, routeRowThreadKey } = props;
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
  return (
    <div
      role="group"
      aria-label="Clients"
      data-testid="sidebar-client-rail"
      onKeyDown={onKeyDown}
      className="flex min-h-0 w-16 shrink-0 flex-col border-r border-sidebar-border"
    >
      <ScrollArea hideScrollbars scrollFade viewportTabIndex={-1}>
        <ul className="flex flex-col gap-1 px-1 py-2">
          <SidebarClientRailButton
            id={null}
            name="All"
            tooltip="All clients"
            logo={undefined}
            kind="client"
            selected={selectedId === null}
            dot={null}
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
              onSelect={onSelect}
            />
          ))}
        </ul>
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
  onSelect: (id: string | null) => void;
}) {
  const m = useMessages();
  const { id, name, logo, dot, onSelect } = props;
  return (
    <li className="list-none">
      <Tooltip>
        {/* Out of the list's arrow-key tree: Tab reaches the picked entry, Enter or Space picks. */}
        <TooltipTrigger
          render={
            <button
              type="button"
              data-rail-entry
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
