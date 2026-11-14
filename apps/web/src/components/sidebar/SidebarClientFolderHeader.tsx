import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMessages } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";

export function resolveFolderDotWithVisits(
  threads: readonly EnvironmentThreadShell[],
  localLastVisitedAtById: Readonly<Record<string, string>>,
) {
  return resolveSidebarFolderDot(
    threads.map((thread) => ({
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      ),
    })),
  );
}

/** A client's header in the boring sidebar, or one of its projects': it folds the folders named "Client · …". */
export const SidebarClientFolderHeader = memo(function SidebarClientFolderHeader(props: {
  rowId: string;
  name: string;
  logo: SidebarProjectSnapshot | undefined;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (rowId: string) => void;
  navigationParent?: string | undefined;
}) {
  const m = useMessages();
  const { rowId, collapsed, hiddenThreads } = props;
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed ? resolveFolderDotWithVisits(hiddenThreads, localLastVisitedAtById) : null;
  return (
    <li
      data-testid="sidebar-client-folder"
      className={cn(
        "relative list-none",
        props.navigationParent === undefined && "mt-2 first:mt-0",
      )}
    >
      <button
        type="button"
        data-sidebar-row={rowId}
        data-sidebar-parent={props.navigationParent}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(rowId)}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.navigationParent !== undefined && "ps-9",
        )}
      >
        {props.logo ? (
          // The fallback monogram is derived from the title, so name it after the header.
          <ProjectFavicon
            project={{ ...props.logo, title: props.name }}
            className="size-4 shrink-0"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {props.name}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
    </li>
  );
});
