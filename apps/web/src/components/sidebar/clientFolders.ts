import type { ProjectIconOverride } from "@t3tools/contracts";

import { orderItemsByPreferredIds } from "../Sidebar.logic";
import {
  SIDEBAR_RAIL_ORDER_LEVEL,
  sidebarRepositoryOrderId,
  type SidebarClientFolderOrder,
  type SidebarOrderDrop,
  type SidebarOrderRef,
} from "./clientFolderOrder";

export const CLIENT_FOLDERS_ENABLED_KEY = "t3code:sidebar:client-folders";
const CLIENT_SEPARATOR = " · ";

export function splitClientPrefix(displayName: string): {
  readonly clientName: string;
  readonly projectName?: string;
  readonly label: string;
} | null {
  const [first = "", ...rest] = displayName.split(CLIENT_SEPARATOR);
  const clientName = first.trim();
  if (clientName.length === 0 || rest.length === 0) return null;
  const [second = "", ...repo] = rest;
  const projectName = second.trim();
  const repoLabel = repo.join(CLIENT_SEPARATOR).trim();
  if (projectName.length > 0 && repoLabel.length > 0) {
    return { clientName, projectName, label: repoLabel };
  }
  const label = rest.join(CLIENT_SEPARATOR).trim();
  return label.length > 0 ? { clientName, label } : null;
}

/** The client's sidebar tree row, and its key in `projectExpandedById`. */
function sidebarClientRowId(client: string) {
  return `client:${client}`;
}

// Trimmed names can still end or start with "·", so join them unambiguously.
function sidebarClientProjectRowId(client: string, project: string) {
  return `client-project:${JSON.stringify([client, project])}`;
}

type OrderedFolder = { readonly group: ClientFolderGroup & { readonly projectKey: string } };

interface ClientFolderGroup {
  readonly displayName: string;
  // A merged group whose checkouts carry different titles is labelled after its
  // repository, so the client is read back from a title.
  readonly title?: string | undefined;
  readonly memberProjects?: ReadonlyArray<{ readonly title: string }> | undefined;
  // An archived project keeps its own folder below the rest, out of any client.
  readonly archived?: boolean | undefined;
  readonly projectIcon?: ProjectIconOverride | null | undefined;
  readonly faviconPath?: string | null | undefined;
}

// A client shows the first icon the user chose for one of its projects.
function clientLogoOf<TGroup extends ClientFolderGroup>(groups: readonly TGroup[]) {
  return (
    groups.find((group) => group.projectIcon != null || group.faviconPath != null) ?? groups[0]
  );
}

function clientPrefixOf(group: ClientFolderGroup) {
  if (group.archived === true) return null;
  const names = [
    group.displayName,
    group.title,
    ...(group.memberProjects ?? []).map((m) => m.title),
  ];
  for (const name of names) {
    const prefix = name === undefined ? null : splitClientPrefix(name);
    if (prefix !== null) return prefix;
  }
  return null;
}

// Shared by every open client, so its memoised header sees unchanged props.
const NO_THREADS: readonly never[] = Object.freeze([]);

/** A client or project sits where its first member sat; members keep their order. */
export function groupSidebarFoldersByClient<TFolder extends { readonly group: ClientFolderGroup }>(
  folders: readonly TFolder[],
) {
  type Repo = { readonly folder: TFolder; readonly label: string };
  type Project = {
    readonly kind: "project";
    readonly projectName: string;
    readonly members: Repo[];
  };
  type Client = {
    readonly kind: "client";
    readonly clientName: string;
    readonly members: Array<({ readonly kind: "folder" } & Repo) | Project>;
  };
  const entries: Array<{ readonly kind: "project"; readonly folder: TFolder } | Client> = [];
  const clients = new Map<string, Client>();
  const projects = new Map<string, Project>();
  for (const folder of folders) {
    const prefix = clientPrefixOf(folder.group);
    if (prefix === null) {
      entries.push({ kind: "project", folder });
      continue;
    }
    let entry = clients.get(prefix.clientName);
    if (entry === undefined) {
      entry = { kind: "client", clientName: prefix.clientName, members: [] };
      clients.set(prefix.clientName, entry);
      entries.push(entry);
    }
    if (prefix.projectName === undefined) {
      entry.members.push({ kind: "folder", folder, label: prefix.label });
      continue;
    }
    const projectId = sidebarClientProjectRowId(prefix.clientName, prefix.projectName);
    let project = projects.get(projectId);
    if (project === undefined) {
      project = { kind: "project", projectName: prefix.projectName, members: [] };
      projects.set(projectId, project);
      entry.members.push(project);
    }
    project.members.push({ folder, label: prefix.label });
  }
  return entries;
}

const byName = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function sortedByName<T>(items: readonly T[], nameOf: (item: T) => string): T[] {
  return [...items].sort((left, right) => byName.compare(nameOf(left), nameOf(right)));
}

// Archived folders keep their place below the rest.
function sortClientEntriesByName<TFolder extends { readonly group: ClientFolderGroup }>(
  entries: ReturnType<typeof groupSidebarFoldersByClient<TFolder>>,
) {
  type Entry = (typeof entries)[number];
  const nameOf = (entry: Entry) =>
    entry.kind === "client" ? entry.clientName : entry.folder.group.displayName;
  const isArchived = (entry: Entry) =>
    entry.kind === "project" && entry.folder.group.archived === true;
  const sorted = sortedByName(
    entries.filter((entry) => !isArchived(entry)),
    nameOf,
  ).map((entry): Entry => {
    if (entry.kind === "project") return entry;
    const members = sortedByName(entry.members, (member) =>
      member.kind === "folder" ? member.label : member.projectName,
    ).map((member) =>
      member.kind === "folder"
        ? member
        : { ...member, members: sortedByName(member.members, (repo) => repo.label) },
    );
    return { ...entry, members };
  });
  return [...sorted, ...entries.filter(isArchived)];
}

// Entries missing from `order`, such as archived folders, keep their place after the rest.
function sortClientEntriesByOrder<TFolder extends { readonly group: ClientFolderGroup }>(
  entries: ReturnType<typeof groupSidebarFoldersByClient<TFolder>>,
  order: readonly ClientFolderGroup[],
) {
  const rankByKey = new Map<unknown, number>();
  for (const [index, group] of order.entries()) {
    const prefix = clientPrefixOf(group);
    const key = prefix === null ? group : sidebarClientRowId(prefix.clientName);
    if (!rankByKey.has(key)) rankByKey.set(key, index);
  }
  const rankOf = (entry: (typeof entries)[number]) =>
    rankByKey.get(
      entry.kind === "client" ? sidebarClientRowId(entry.clientName) : entry.folder.group,
    ) ?? order.length;
  return [...entries].sort((left, right) => rankOf(left) - rankOf(right));
}

type ClientEntries<TFolder extends { readonly group: ClientFolderGroup }> = ReturnType<
  typeof groupSidebarFoldersByClient<TFolder>
>;

function clientEntryOrderId(entry: ClientEntries<OrderedFolder>[number]) {
  return entry.kind === "client"
    ? sidebarClientRowId(entry.clientName)
    : sidebarRepositoryOrderId(entry.folder.group.projectKey);
}

function clientMemberOrderId(
  clientName: string,
  member: Extract<ClientEntries<OrderedFolder>[number], { kind: "client" }>["members"][number],
) {
  return member.kind === "folder"
    ? sidebarRepositoryOrderId(member.folder.group.projectKey)
    : sidebarClientProjectRowId(clientName, member.projectName);
}

// Each level follows its stored ids; the rest keep their place after them, archived folders last.
function sortClientEntriesByStoredOrder<TFolder extends OrderedFolder>(
  entries: ClientEntries<TFolder>,
  order: SidebarClientFolderOrder,
): ClientEntries<TFolder> {
  type Entry = (typeof entries)[number];
  const isArchived = (entry: Entry) =>
    entry.kind === "project" && entry.folder.group.archived === true;
  const top = orderItemsByPreferredIds({
    items: entries.filter((entry) => !isArchived(entry)),
    preferredIds: order[SIDEBAR_RAIL_ORDER_LEVEL] ?? [],
    getId: clientEntryOrderId,
  }).map((entry): Entry => {
    if (entry.kind === "project") return entry;
    const clientRowId = sidebarClientRowId(entry.clientName);
    const members = orderItemsByPreferredIds({
      items: entry.members,
      preferredIds: order[clientRowId] ?? [],
      getId: (member) => clientMemberOrderId(entry.clientName, member),
    }).map((member) => {
      if (member.kind === "folder") return member;
      const projectRowId = sidebarClientProjectRowId(entry.clientName, member.projectName);
      return {
        ...member,
        members: orderItemsByPreferredIds({
          items: member.members,
          preferredIds: order[projectRowId] ?? [],
          getId: (repo) => sidebarRepositoryOrderId(repo.folder.group.projectKey),
        }),
      };
    });
    return { ...entry, members };
  });
  return [...top, ...entries.filter(isArchived)];
}

function orderClientEntries<TFolder extends OrderedFolder>(
  entries: ClientEntries<TFolder>,
  input: {
    readonly alphabetical?: boolean | undefined;
    readonly clientOrder?: readonly ClientFolderGroup[] | undefined;
    readonly order?: SidebarClientFolderOrder | undefined;
  },
) {
  const sorted =
    input.alphabetical === true
      ? sortClientEntriesByName(entries)
      : input.clientOrder === undefined
        ? entries
        : sortClientEntriesByOrder(entries, input.clientOrder);
  return input.order === undefined ? sorted : sortClientEntriesByStoredOrder(sorted, input.order);
}

/** The folder's "Settled · n" row in the sidebar tree, and its key in `projectExpandedById`. */
export function sidebarFolderSettledRowId(projectKey: string) {
  return `folder-settled:${projectKey}`;
}

export interface SidebarFolderSettled<TThread> {
  readonly rowId: string;
  /** Every settled thread of the folder, loaded or not. */
  readonly count: number;
  readonly expanded: boolean;
  /** Rows drawn: a page of the list when open, else only the route thread. */
  readonly threads: readonly TThread[];
  /** Threads an open row does not list yet; 0 while closed. */
  readonly hiddenCount: number;
  /** Every settled thread the client holds for the folder, most recently settled first. */
  readonly loadedThreads: readonly TThread[];
}

export interface SidebarProjectFolder<TGroup, TThread> {
  readonly group: TGroup;
  readonly collapsed: boolean;
  readonly threads: readonly TThread[];
  readonly hiddenThreads: readonly TThread[];
  readonly settled?: SidebarFolderSettled<TThread> | undefined;
}

/**
 * Settled threads by the folder that lists them. An archived project's threads stay on the
 * shelf, so its folder never comes back for its history alone.
 */
export function splitSettledThreadsByFolder<
  TGroup extends {
    readonly projectKey: string;
    readonly archived?: boolean | undefined;
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: string;
      readonly projectId: string;
    }>;
  },
  TThread extends { readonly environmentId: string; readonly projectId: string },
>(input: {
  readonly groups: readonly TGroup[];
  readonly settledThreads: readonly TThread[];
  /** Older settled threads of the group that the client does not hold. */
  readonly unloadedCount: (group: TGroup) => number;
}) {
  const groupByProject = new Map<string, TGroup>();
  for (const group of input.groups) {
    if (group.archived === true) continue;
    for (const ref of group.memberProjectRefs) {
      groupByProject.set(`${ref.environmentId}:${ref.projectId}`, group);
    }
  }
  const threadsByGroup = new Map<TGroup, TThread[]>();
  const shelfThreads: TThread[] = [];
  for (const thread of input.settledThreads) {
    const group = groupByProject.get(`${thread.environmentId}:${thread.projectId}`);
    if (group === undefined) {
      shelfThreads.push(thread);
      continue;
    }
    const list = threadsByGroup.get(group);
    if (list === undefined) threadsByGroup.set(group, [thread]);
    else list.push(thread);
  }
  const byProjectKey = new Map<
    string,
    { readonly threads: readonly TThread[]; readonly unloadedCount: number }
  >();
  for (const group of new Set(groupByProject.values())) {
    const threads = threadsByGroup.get(group) ?? NO_THREADS;
    const unloadedCount = input.unloadedCount(group);
    if (threads.length + unloadedCount > 0) {
      byProjectKey.set(group.projectKey, { threads, unloadedCount });
    }
  }
  return { byProjectKey, shelfThreads, folderedProjectKeys: new Set(groupByProject.keys()) };
}

/** A folder's Settled row: closed unless `expandedById` says open, keeping the route thread. */
export function buildSidebarFolderSettled<TThread>(input: {
  readonly rowId: string;
  readonly threads: readonly TThread[];
  readonly unloadedCount: number;
  readonly visibleCount: number;
  readonly folderCollapsed: boolean;
  readonly expandedById: Readonly<Record<string, boolean>>;
  readonly isRouteThread: (thread: TThread) => boolean;
  /** The shelf's frontier rule: a row below the pages read so far waits for them. */
  readonly isListed: (thread: TThread) => boolean;
}): SidebarFolderSettled<TThread> {
  const expanded = input.expandedById[input.rowId] === true;
  const open = expanded && !input.folderCollapsed;
  const page = input.threads.filter(input.isListed).slice(0, input.visibleCount);
  const route = input.threads.find(input.isRouteThread);
  const visible = route === undefined || page.includes(route) ? page : [...page, route];
  const count = input.threads.length + input.unloadedCount;
  return {
    rowId: input.rowId,
    count,
    expanded,
    threads: open ? visible : route === undefined ? NO_THREADS : [route],
    hiddenCount: open ? Math.max(0, count - visible.length) : 0,
    loadedThreads: input.threads,
  };
}

export type SidebarFolderRow<TGroup, TThread> =
  | {
      // A client header, or one of its project groups when `parent` is the client.
      readonly kind: "client";
      readonly rowId: string;
      readonly name: string;
      readonly logo: TGroup | undefined;
      readonly collapsed: boolean;
      readonly threads: readonly TThread[];
      readonly hiddenThreads: readonly TThread[];
      readonly parent: string | undefined;
      readonly depth: 0 | 1;
    }
  | {
      readonly kind: "project";
      readonly folder: SidebarProjectFolder<TGroup, TThread>;
      readonly label: string | undefined;
      readonly parent: string | undefined;
      readonly depth: 0 | 1 | 2;
    };

/** The folder rows the sidebar draws, in order. Headers are closed unless `expandedById` says open. */
export function buildSidebarFolderRows<
  TGroup extends ClientFolderGroup & { readonly projectKey: string },
  TThread,
>(input: {
  readonly folders: ReadonlyArray<SidebarProjectFolder<TGroup, TThread>>;
  readonly groupByClient: boolean;
  // The rail already names the picked client, so its rows start one level up.
  readonly withoutClientHeader?: boolean;
  readonly alphabetical?: boolean;
  // Every project in manual order, shown or not: a client sits where its first one does,
  // as on the rail, even when that project's folder has nothing to show.
  readonly clientOrder?: readonly ClientFolderGroup[];
  readonly order?: SidebarClientFolderOrder | undefined;
  readonly expandedById: Readonly<Record<string, boolean>>;
  readonly isRouteThread: (thread: TThread) => boolean;
}): Array<SidebarFolderRow<TGroup, TThread>> {
  type Row = SidebarFolderRow<TGroup, TThread>;
  type Folder = SidebarProjectFolder<TGroup, TThread>;
  const topLevel = (folder: Folder): Row => ({
    kind: "project",
    folder,
    label: undefined,
    parent: undefined,
    depth: 0,
  });
  if (!input.groupByClient) return input.folders.map(topLevel);
  // A closed header keeps the route thread and counts the rest of what it folds.
  const header = (
    head: Omit<Extract<Row, { kind: "client" }>, "collapsed" | "threads" | "hiddenThreads">,
    folders: readonly Folder[],
    children: () => Row[],
  ): Row[] => {
    if (input.expandedById[head.rowId] === true) {
      return [
        { ...head, collapsed: false, threads: NO_THREADS, hiddenThreads: NO_THREADS },
        ...children(),
      ];
    }
    const threads = folders.flatMap((folder) => [...folder.threads, ...folder.hiddenThreads]);
    // Settled threads signal no work, so they stay out of the count but keep the route thread.
    const settledRoute = folders.flatMap<TThread>(
      (folder) => folder.settled?.threads.filter(input.isRouteThread) ?? NO_THREADS,
    );
    return [
      {
        ...head,
        collapsed: true,
        threads: [...threads.filter(input.isRouteThread), ...settledRoute],
        hiddenThreads: threads.filter((thread) => !input.isRouteThread(thread)),
      },
    ];
  };
  const entries = groupSidebarFoldersByClient(input.folders);
  type ClientEntry = Extract<(typeof entries)[number], { kind: "client" }>;
  const clientRows = (entry: ClientEntry, parent: string | undefined): Row[] => {
    const depth = parent === undefined ? 0 : 1;
    return entry.members.flatMap((member): Row[] => {
      if (member.kind === "folder") {
        return [{ kind: "project", folder: member.folder, label: member.label, parent, depth }];
      }
      const projectRowId = sidebarClientProjectRowId(entry.clientName, member.projectName);
      return header(
        {
          kind: "client",
          rowId: projectRowId,
          name: member.projectName,
          logo: clientLogoOf(member.members.map((repo) => repo.folder.group)),
          parent,
          depth,
        },
        member.members.map((repo) => repo.folder),
        () =>
          member.members.map((repo): Row => ({
            kind: "project",
            folder: repo.folder,
            label: repo.label,
            parent: projectRowId,
            depth: depth === 0 ? 1 : 2,
          })),
      );
    });
  };
  return orderClientEntries(entries, input).flatMap((entry): Row[] => {
    if (entry.kind === "project") return [topLevel(entry.folder)];
    if (input.withoutClientHeader === true) return clientRows(entry, undefined);
    const rowId = sidebarClientRowId(entry.clientName);
    const repos = entry.members.flatMap((member) =>
      member.kind === "folder" ? [member] : member.members,
    );
    return header(
      {
        kind: "client",
        rowId,
        name: entry.clientName,
        logo: clientLogoOf(repos.map((repo) => repo.folder.group)),
        parent: undefined,
        depth: 0,
      },
      repos.map((repo) => repo.folder),
      () => clientRows(entry, rowId),
    );
  });
}

export const CLIENT_RAIL_SELECTED_KEY = "t3code:sidebar:client-rail-selected";

export interface SidebarClientRailEntry<TGroup> {
  // Persisted as the selection: the client's tree row id, or `project:<projectKey>`.
  readonly id: string;
  readonly kind: "client" | "project";
  readonly name: string;
  readonly logo: TGroup | undefined;
  // The project groups the sidebar is scoped to while this entry is picked.
  readonly groups: readonly TGroup[];
}

function openClientEntries<
  TGroup extends ClientFolderGroup & { readonly projectKey: string },
>(input: {
  readonly groups: readonly TGroup[];
  readonly alphabetical: boolean;
  readonly order?: SidebarClientFolderOrder | undefined;
}) {
  const entries = groupSidebarFoldersByClient(
    input.groups.filter((group) => group.archived !== true).map((group) => ({ group })),
  );
  return orderClientEntries(entries, { alphabetical: input.alphabetical, order: input.order });
}

/** Each thread's project, as `environmentId:projectId`. */
export function sidebarThreadProjectRefs(
  threads: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>,
): Set<string> {
  return new Set(threads.map((thread) => `${thread.environmentId}:${thread.projectId}`));
}

/**
 * Pinning picks what the client folders show: a folder shows while its project is pinned or
 * has an active thread (active, working or pinned section), settled history alone is not enough.
 */
export function isSidebarFolderShown(
  group: {
    readonly pinned?: boolean | undefined;
    readonly archived?: boolean | undefined;
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: string;
      readonly projectId: string;
    }>;
  },
  activeProjectRefs: ReadonlySet<string>,
): boolean {
  return (
    (group.pinned === true && group.archived !== true) ||
    group.memberProjectRefs.some((ref) =>
      activeProjectRefs.has(`${ref.environmentId}:${ref.projectId}`),
    )
  );
}

/**
 * The rail lists clients in the tree's order; with `isShown`, only those with a shown project.
 * An entry keeps all its open projects, so picking it scopes the shelf to its whole history.
 */
export function buildSidebarClientRailEntries<
  TGroup extends ClientFolderGroup & { readonly projectKey: string },
>(input: {
  readonly groups: readonly TGroup[];
  readonly alphabetical: boolean;
  readonly order?: SidebarClientFolderOrder | undefined;
  readonly isShown?: ((group: TGroup) => boolean) | undefined;
}): Array<SidebarClientRailEntry<TGroup>> {
  const entries = openClientEntries(input).map((entry): SidebarClientRailEntry<TGroup> => {
    if (entry.kind === "project") {
      const { group } = entry.folder;
      return {
        id: sidebarRepositoryOrderId(group.projectKey),
        kind: "project",
        name: group.displayName,
        logo: group,
        groups: [group],
      };
    }
    const groups = entry.members.flatMap((member) =>
      member.kind === "folder"
        ? [member.folder.group]
        : member.members.map((repo) => repo.folder.group),
    );
    return {
      id: sidebarClientRowId(entry.clientName),
      kind: "client",
      name: entry.clientName,
      logo: clientLogoOf(groups),
      groups,
    };
  });
  const { isShown } = input;
  return isShown === undefined ? entries : entries.filter((entry) => entry.groups.some(isShown));
}

/**
 * Each entry's dot threads, by entry id; a thread of no listed project is left out.
 * The dot reads what the client header folds: pinned threads sit in their own section
 * and the open thread is already on screen, so neither lights it.
 */
export function sidebarClientRailThreads<
  TGroup extends {
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: string;
      readonly projectId: string;
    }>;
  },
  TThread extends {
    readonly environmentId: string;
    readonly projectId: string;
    readonly pinnedAt?: string | null | undefined;
  },
>(
  entries: ReadonlyArray<Pick<SidebarClientRailEntry<TGroup>, "id" | "groups">>,
  threads: readonly TThread[],
  isRouteThread: (thread: TThread) => boolean = () => false,
): Map<string, TThread[]> {
  const entryIdByProject = new Map<string, string>();
  for (const entry of entries) {
    for (const group of entry.groups) {
      for (const ref of group.memberProjectRefs) {
        entryIdByProject.set(`${ref.environmentId}:${ref.projectId}`, entry.id);
      }
    }
  }
  const threadsByEntry = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.pinnedAt != null || isRouteThread(thread)) continue;
    const entryId = entryIdByProject.get(`${thread.environmentId}:${thread.projectId}`);
    if (entryId === undefined) continue;
    const list = threadsByEntry.get(entryId);
    if (list === undefined) threadsByEntry.set(entryId, [thread]);
    else list.push(thread);
  }
  return threadsByEntry;
}

export function sidebarFolderRowThreads<TGroup, TThread>(
  row: SidebarFolderRow<TGroup, TThread>,
): readonly TThread[] {
  if (row.kind === "client") return row.threads;
  const settled = row.folder.settled?.threads ?? NO_THREADS;
  return settled.length === 0 ? row.folder.threads : [...row.folder.threads, ...settled];
}

/** Every level's entry ids in the order shown, from all open projects: what a move rewrites. */
export function sidebarClientFolderLevels<
  TGroup extends ClientFolderGroup & { readonly projectKey: string },
>(input: {
  readonly groups: readonly TGroup[];
  readonly alphabetical: boolean;
  readonly order: SidebarClientFolderOrder;
}): Map<string, string[]> {
  const entries = openClientEntries(input);
  const levels = new Map<string, string[]>([
    [SIDEBAR_RAIL_ORDER_LEVEL, entries.map(clientEntryOrderId)],
  ]);
  for (const entry of entries) {
    if (entry.kind === "project") continue;
    levels.set(
      sidebarClientRowId(entry.clientName),
      entry.members.map((member) => clientMemberOrderId(entry.clientName, member)),
    );
    for (const member of entry.members) {
      if (member.kind === "folder") continue;
      levels.set(
        sidebarClientProjectRowId(entry.clientName, member.projectName),
        member.members.map((repo) => sidebarRepositoryOrderId(repo.folder.group.projectKey)),
      );
    }
  }
  return levels;
}

type OrderRowGroup = { readonly projectKey: string; readonly archived?: boolean | undefined };

/** The level and id a row reorders under; null for an archived folder or ungrouped rows. */
export function sidebarFolderRowOrder<TGroup extends OrderRowGroup, TThread>(
  row: SidebarFolderRow<TGroup, TThread>,
  rootLevel: string | null,
): SidebarOrderRef | null {
  const level = row.parent ?? rootLevel;
  if (level === null) return null;
  if (row.kind === "client") return { level, id: row.rowId };
  if (row.folder.group.archived === true) return null;
  return { level, id: sidebarRepositoryOrderId(row.folder.group.projectKey) };
}

/**
 * The entry of `level` that a hit on `over` stands for: `over` itself, or the open client or
 * project group whose block it sits in; null when no such entry encloses it.
 */
export function sidebarOrderRefAtLevel<TGroup extends OrderRowGroup, TThread>(input: {
  readonly rows: ReadonlyArray<SidebarFolderRow<TGroup, TThread>>;
  readonly rootLevel: string | null;
  readonly over: SidebarOrderRef;
  readonly level: string;
}): SidebarOrderRef | null {
  let ref: SidebarOrderRef | null = input.over;
  // A parent sits one depth up, so the walk ends within the tree's three levels.
  for (let depth = 0; ref !== null && ref.level !== input.level && depth < 3; depth += 1) {
    const parentRowId: string = ref.level;
    const parent = input.rows.find((row) => row.kind === "client" && row.rowId === parentRowId);
    ref = parent === undefined ? null : sidebarFolderRowOrder(parent, input.rootLevel);
  }
  return ref?.level === input.level ? ref : null;
}

/** The row the drop line is drawn before (`rows.length` is after the last), and its indent. */
export function sidebarOrderDropLine<TGroup extends OrderRowGroup, TThread>(input: {
  readonly rows: ReadonlyArray<SidebarFolderRow<TGroup, TThread>>;
  readonly rootLevel: string | null;
  readonly level: string;
  readonly drop: SidebarOrderDrop;
}): { readonly index: number; readonly depth: 0 | 1 | 2 } | null {
  const { rows, drop } = input;
  const index = rows.findIndex((row) => {
    const ref = sidebarFolderRowOrder(row, input.rootLevel);
    return ref?.level === input.level && ref.id === drop.targetId;
  });
  const target = rows[index];
  if (target === undefined) return null;
  if (drop.position === "before") return { index, depth: target.depth };
  const end = rows.findIndex((row, at) => at > index && row.depth <= target.depth);
  return { index: end === -1 ? rows.length : end, depth: target.depth };
}
