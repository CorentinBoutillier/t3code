import type { ProjectIconOverride } from "@t3tools/contracts";

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

export interface SidebarProjectFolder<TGroup, TThread> {
  readonly group: TGroup;
  readonly collapsed: boolean;
  readonly threads: readonly TThread[];
  readonly hiddenThreads: readonly TThread[];
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
export function buildSidebarFolderRows<TGroup extends ClientFolderGroup, TThread>(input: {
  readonly folders: ReadonlyArray<SidebarProjectFolder<TGroup, TThread>>;
  readonly groupByClient: boolean;
  readonly alphabetical?: boolean;
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
    return [
      {
        ...head,
        collapsed: true,
        threads: threads.filter(input.isRouteThread),
        hiddenThreads: threads.filter((thread) => !input.isRouteThread(thread)),
      },
    ];
  };
  const entries = groupSidebarFoldersByClient(input.folders);
  return (input.alphabetical === true ? sortClientEntriesByName(entries) : entries).flatMap(
    (entry): Row[] => {
      if (entry.kind === "project") return [topLevel(entry.folder)];
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
        () =>
          entry.members.flatMap((member): Row[] => {
            if (member.kind === "folder") {
              return [
                {
                  kind: "project",
                  folder: member.folder,
                  label: member.label,
                  parent: rowId,
                  depth: 1,
                },
              ];
            }
            const projectRowId = sidebarClientProjectRowId(entry.clientName, member.projectName);
            return header(
              {
                kind: "client",
                rowId: projectRowId,
                name: member.projectName,
                logo: clientLogoOf(member.members.map((repo) => repo.folder.group)),
                parent: rowId,
                depth: 1,
              },
              member.members.map((repo) => repo.folder),
              () =>
                member.members.map((repo): Row => ({
                  kind: "project",
                  folder: repo.folder,
                  label: repo.label,
                  parent: projectRowId,
                  depth: 2,
                })),
            );
          }),
      );
    },
  );
}

export function sidebarFolderRowThreads<TGroup, TThread>(
  row: SidebarFolderRow<TGroup, TThread>,
): readonly TThread[] {
  return row.kind === "client" ? row.threads : row.folder.threads;
}
