import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationV2OlderSettledCursor } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { memo, useEffect, type Dispatch, type SetStateAction } from "react";

import { cn } from "~/lib/utils";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";

// The folder's thread rows sit at these insets, so its Settled row lines up with them.
function threadInset(depth: 0 | 1 | 2) {
  return depth === 2 ? "ps-22" : depth === 1 ? "ps-15.5" : "ps-9";
}

/** A folder's "Settled · n" row: closed by default, with no dot, as settled work needs nothing. */
export const SidebarFolderSettledHeader = memo(function SidebarFolderSettledHeader(props: {
  rowId: string;
  count: number;
  expanded: boolean;
  onToggle: (rowId: string) => void;
  navigationParent: string;
  depth: 0 | 1 | 2;
}) {
  const gt = useGT();
  return (
    <li data-testid="sidebar-folder-settled" className="list-none">
      <button
        type="button"
        data-sidebar-row={props.rowId}
        data-sidebar-parent={props.navigationParent}
        aria-expanded={props.expanded}
        onClick={() => props.onToggle(props.rowId)}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) pe-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          threadInset(props.depth),
        )}
      >
        <span className="min-w-0 flex-1 truncate">{`${gt("Settled", { $context: "sidebar section" })} · ${props.count}`}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", !props.expanded && "-rotate-90")}
        />
      </button>
    </li>
  );
});

/** Each open Settled row's pager frontier, so the folder lists only what the shelf would. */
export type FolderSettledFrontiers = ReadonlyMap<string, OrchestrationV2OlderSettledCursor | null>;

function withFolderSettledFrontier(
  frontiers: FolderSettledFrontiers,
  rowId: string,
  frontier: OrchestrationV2OlderSettledCursor | null | undefined,
): FolderSettledFrontiers {
  if (
    frontier === undefined
      ? !frontiers.has(rowId)
      : frontiers.has(rowId) && JSON.stringify(frontiers.get(rowId)) === JSON.stringify(frontier)
  ) {
    return frontiers;
  }
  const next = new Map(frontiers);
  if (frontier === undefined) next.delete(rowId);
  else next.set(rowId, frontier);
  return next;
}

/**
 * Pages an open Settled row's older threads in, as the shelf does. It stays mounted while the
 * row is open even when it draws nothing: its pages are what keep those rows in the thread list.
 */
export function SidebarFolderSettledMore(props: {
  rowId: string;
  scopes: ReadonlyArray<OlderSettledScope>;
  threads: readonly EnvironmentThreadShell[];
  visibleCount: number;
  hiddenCount: number;
  /** Rows one "Show more" adds, as on the shelf. */
  pageCount: number;
  onShowMore: (rowId: string) => void;
  setFrontiers: Dispatch<SetStateAction<FolderSettledFrontiers>>;
  depth: 0 | 1 | 2;
}) {
  const gt = useGT();
  const shelf = useOlderSettledShelf({
    scopes: props.scopes,
    expanded: true,
    visibleCount: props.visibleCount,
  });
  useOlderSettledShelfGrowth(shelf, props.threads.filter(shelf.isListed));
  const { rowId, setFrontiers } = props;
  const frontierKey = JSON.stringify(shelf.frontier);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the folder lists its rows in the sidebar hook, which cannot read this pager's atoms
  useEffect(() => {
    const frontier = JSON.parse(frontierKey) as OrchestrationV2OlderSettledCursor | null;
    setFrontiers((frontiers) => withFolderSettledFrontier(frontiers, rowId, frontier));
    return () =>
      setFrontiers((frontiers) => withFolderSettledFrontier(frontiers, rowId, undefined));
  }, [frontierKey, rowId, setFrontiers]);
  if (props.hiddenCount === 0) return null;
  return (
    <li className="list-none">
      <button
        type="button"
        data-sidebar-row={`${props.rowId}:more`}
        data-sidebar-parent={props.rowId}
        aria-disabled={shelf.loading}
        onClick={() => {
          if (shelf.loading) return;
          shelf.retry();
          props.onShowMore(props.rowId);
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md pe-2.5 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground aria-disabled:cursor-default",
          threadInset(props.depth),
        )}
      >
        <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        {shelf.loading
          ? gt("Loading")
          : shelf.failed
            ? gt("Could not load older threads. Retry")
            : gt("{count, plural, one {Show {count} more} other {Show {count} more}}", {
                count: Math.min(props.hiddenCount, props.pageCount),
              })}
      </button>
    </li>
  );
}
