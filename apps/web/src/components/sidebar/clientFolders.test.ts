import type { ProjectIconOverride } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { moveSidebarOrderEntry, stepSidebarOrderDrop } from "./clientFolderOrder";
import {
  buildSidebarClientRailEntries,
  buildSidebarFolderRows,
  buildSidebarFolderSettled,
  clientProjectScopeItems,
  groupSidebarFoldersByClient,
  isSidebarFolderShown,
  resolveSidebarInboxBadge,
  sidebarClientFolderLevels,
  sidebarClientRailThreads,
  sidebarFolderRowOrder,
  sidebarFolderRowThreads,
  sidebarOrderDropLine,
  sidebarOrderRefAtLevel,
  sidebarFolderSettledRowId,
  splitClientPrefix,
  sidebarThreadProjectRefs,
  splitSettledThreadsByFolder,
  type SidebarFolderSettled,
} from "./clientFolders";

describe("splitClientPrefix", () => {
  it("splits on spaced middle dots into client, optional project and label", () => {
    expect(
      [
        "Acme · App",
        "Umbrella",
        " · App",
        "Acme · ",
        "A · B · C",
        "Acme·App",
        "  Acme  ·  App  ",
        "Northwind · Atlas · Web · Old",
        "Globex ·  · Infra",
        "Globex · Orion · ",
        " · Orion · Infra",
      ].map(splitClientPrefix),
    ).toEqual([
      { clientName: "Acme", label: "App" },
      null,
      null,
      null,
      { clientName: "A", projectName: "B", label: "C" },
      null,
      { clientName: "Acme", label: "App" },
      { clientName: "Northwind", projectName: "Atlas", label: "Web · Old" },
      // An empty part drops the project level rather than the whole client.
      { clientName: "Globex", label: "· Infra" },
      { clientName: "Globex", label: "Orion ·" },
      null,
    ]);
  });
});

function folder(
  displayName: string,
  threads: readonly string[] = [],
  options: {
    readonly hiddenThreads?: readonly string[];
    readonly projectIcon?: ProjectIconOverride;
    readonly faviconPath?: string;
    readonly archived?: boolean;
    readonly pinned?: boolean;
    readonly title?: string;
    readonly settled?: SidebarFolderSettled<string>;
    readonly projectKey?: string;
  } = {},
) {
  return {
    group: {
      displayName,
      projectKey: options.projectKey ?? displayName,
      memberProjectRefs: [{ environmentId: "local", projectId: displayName }],
      title: options.title ?? displayName,
      archived: options.archived ?? false,
      pinned: options.pinned ?? false,
      projectIcon: options.projectIcon ?? null,
      faviconPath: options.faviconPath ?? null,
    },
    collapsed: options.hiddenThreads !== undefined,
    threads,
    hiddenThreads: options.hiddenThreads ?? [],
    settled: options.settled,
  };
}

function settledRow(projectKey: string, threads: readonly string[]): SidebarFolderSettled<string> {
  return {
    rowId: sidebarFolderSettledRowId(projectKey),
    count: threads.length,
    expanded: false,
    threads,
    hiddenCount: 0,
    loadedThreads: threads,
  };
}

type ClientEntry = ReturnType<
  typeof groupSidebarFoldersByClient<ReturnType<typeof folder>>
>[number];

const entryShape = (entry: ClientEntry) =>
  entry.kind === "project"
    ? entry.folder.group.displayName
    : {
        [entry.clientName]: entry.members.map((member) =>
          member.kind === "folder"
            ? member.label
            : { [member.projectName]: member.members.map((repo) => repo.label) },
        ),
      };

describe("groupSidebarFoldersByClient", () => {
  const shape = (names: readonly string[]) =>
    groupSidebarFoldersByClient(names.map((name) => folder(name))).map(entryShape);

  it("puts a client where its first member sits and leaves unprefixed projects top-level", () => {
    expect(
      shape([
        "Globex · Portal",
        "Initech",
        "Acme · App",
        "Umbrella",
        "Acme · Infra",
        "Hooli · Site",
        "Globex · Site",
      ]),
    ).toEqual([
      { Globex: ["Portal", "Site"] },
      "Initech",
      { Acme: ["App", "Infra"] },
      "Umbrella",
      { Hooli: ["Site"] },
    ]);
    // A project sits where its first repository sat, even with a single one.
    expect(
      shape([
        "Globex · Orion · Rewards",
        "Initech",
        "Globex · Portal",
        "Globex · Orion · Infra",
        "Northwind · Atlas · Web",
        "Globex · Vega · Site",
      ]),
    ).toEqual([
      { Globex: [{ Orion: ["Rewards", "Infra"] }, "Portal", { Vega: ["Site"] }] },
      "Initech",
      { Northwind: [{ Atlas: ["Web"] }] },
    ]);
    // A dot left next to a separator by trimming never merges two client+project pairs.
    expect(shape(["P · · Q · R", "P ·\t · Q · S"])).toEqual([
      { P: [{ "· Q": ["R"] }] },
      { "P ·": [{ Q: ["S"] }] },
    ]);
    // A pinned project comes first in the folder order, and its client rises with it.
    expect(shape(["Acme · Infra", "Globex · Site", "Acme · App"])).toEqual([
      { Acme: ["Infra", "App"] },
      { Globex: ["Site"] },
    ]);
  });

  it("leaves archived projects top-level, below the rest", () => {
    const entries = groupSidebarFoldersByClient([
      folder("Acme · App"),
      folder("Initech"),
      folder("Acme · Old", [], { archived: true }),
    ]);
    expect(
      entries.map((entry) =>
        entry.kind === "project" ? entry.folder.group.displayName : entry.clientName,
      ),
    ).toEqual(["Acme", "Initech", "Acme · Old"]);
  });

  it("reads the client from the project title when the merged group label lost it", () => {
    const entries = groupSidebarFoldersByClient([
      folder("acme/app", [], { title: "Acme · App" }),
      folder("Acme · Infra"),
    ]);
    expect(entries.map(entryShape)).toEqual([{ Acme: ["App", "Infra"] }]);
  });
});

describe("buildSidebarFolderRows", () => {
  const folders = [
    folder("Globex · Portal", ["m1"]),
    folder("Initech", ["p1"]),
    folder("Acme · App", ["a1", "a2"]),
    folder("Acme · Infra", [], {
      hiddenThreads: ["i1"],
      faviconPath: "/clients/acme/logo.png",
    }),
  ];
  const build = (expandedById: Record<string, boolean>, groupByClient = true) =>
    buildSidebarFolderRows({
      folders,
      groupByClient,
      expandedById,
      isRouteThread: (thread) => thread === "a2",
    });

  it("closes clients by default and keeps only the route thread", () => {
    const rows = build({});
    expect(rows).toEqual([
      {
        kind: "client",
        rowId: "client:Globex",
        name: "Globex",
        logo: folders[0]?.group,
        collapsed: true,
        threads: [],
        hiddenThreads: ["m1"],
        parent: undefined,
        depth: 0,
      },
      { kind: "project", folder: folders[1], label: undefined, parent: undefined, depth: 0 },
      {
        kind: "client",
        rowId: "client:Acme",
        name: "Acme",
        logo: folders[3]?.group,
        collapsed: true,
        threads: ["a2"],
        hiddenThreads: ["a1", "i1"],
        parent: undefined,
        depth: 0,
      },
    ]);
    expect(rows.flatMap(sidebarFolderRowThreads)).toEqual(["p1", "a2"]);
    expect(build({ "client:Acme": false })).toEqual(rows);
  });

  it("lists an open client's folders under it", () => {
    expect(build({ "client:Acme": true }).slice(2)).toEqual([
      {
        kind: "client",
        rowId: "client:Acme",
        name: "Acme",
        logo: folders[3]?.group,
        collapsed: false,
        threads: [],
        hiddenThreads: [],
        parent: undefined,
        depth: 0,
      },
      { kind: "project", folder: folders[2], label: "App", parent: "client:Acme", depth: 1 },
      { kind: "project", folder: folders[3], label: "Infra", parent: "client:Acme", depth: 1 },
    ]);
  });

  it("reuses the same empty lists for an open client across rebuilds", () => {
    const [first, second] = [build({ "client:Acme": true })[2], build({ "client:Acme": true })[2]];
    if (first?.kind !== "client" || second?.kind !== "client") throw new Error("expected a client");
    expect(second.threads).toBe(first.threads);
    expect(second.hiddenThreads).toBe(first.hiddenThreads);
  });

  it("leaves folders as they are when grouping is off", () => {
    expect(build({ "client:Acme": true }, false)).toEqual(
      folders.map((entry) => ({
        kind: "project",
        folder: entry,
        label: undefined,
        parent: undefined,
        depth: 0,
      })),
    );
  });

  it("orders clients, projects and repos by name, archived projects last, when alphabetical", () => {
    const scrambled = [
      folder("Vandelay", ["z1"]),
      folder("Globex · Lyra · Vitrine"),
      folder("Archived · Old", [], { archived: true }),
      folder("Globex · Orion · Infra"),
      folder("umbrella"),
      folder("Globex · Events"),
      folder("Globex · Orion · Rewards"),
      folder("Contoso · CRM"),
    ];
    const rows = buildSidebarFolderRows({
      folders: scrambled,
      groupByClient: true,
      alphabetical: true,
      expandedById: {
        "client:Contoso": true,
        "client:Globex": true,
        'client-project:["Globex","Orion"]': true,
        'client-project:["Globex","Lyra"]': true,
      },
      isRouteThread: () => false,
    });
    expect(
      rows.map((row) =>
        row.kind === "client" ? row.name : (row.label ?? row.folder.group.displayName),
      ),
    ).toEqual([
      "Contoso",
      "CRM",
      "Globex",
      "Events",
      "Lyra",
      "Vitrine",
      "Orion",
      "Infra",
      "Rewards",
      "umbrella",
      "Vandelay",
      "Archived · Old",
    ]);
  });

  it("nests project groups under their client, closed by default", () => {
    const orionId = 'client-project:["Globex","Orion"]';
    const projectFolders = [
      folder("Globex · Orion · Rewards", ["s1"], { hiddenThreads: ["s2"] }),
      folder("Globex · Portal", ["m1"]),
      folder("Globex · Orion · Infra", ["i1"], { faviconPath: "/infra.png" }),
    ];
    const buildNested = (expandedById: Record<string, boolean>) =>
      buildSidebarFolderRows({
        folders: projectFolders,
        groupByClient: true,
        expandedById,
        isRouteThread: (thread) => thread === "s1",
      });
    const client = {
      kind: "client",
      rowId: "client:Globex",
      name: "Globex",
      logo: projectFolders[2]?.group,
      parent: undefined,
      depth: 0,
    };
    const orion = {
      kind: "client",
      rowId: orionId,
      name: "Orion",
      logo: projectFolders[2]?.group,
      parent: "client:Globex",
      depth: 1,
    };
    const portal = {
      kind: "project",
      folder: projectFolders[1],
      label: "Portal",
      parent: "client:Globex",
      depth: 1,
    };

    // A closed client counts the threads of its project groups too.
    expect(buildNested({ [orionId]: true })).toEqual([
      { ...client, collapsed: true, threads: ["s1"], hiddenThreads: ["s2", "i1", "m1"] },
    ]);

    const closedGroup = buildNested({ "client:Globex": true });
    expect(closedGroup).toEqual([
      { ...client, collapsed: false, threads: [], hiddenThreads: [] },
      { ...orion, collapsed: true, threads: ["s1"], hiddenThreads: ["s2", "i1"] },
      portal,
    ]);
    expect(closedGroup.flatMap(sidebarFolderRowThreads)).toEqual(["s1", "m1"]);

    const openGroup = buildNested({
      "client:Globex": true,
      [orionId]: true,
    });
    expect(openGroup).toEqual([
      { ...client, collapsed: false, threads: [], hiddenThreads: [] },
      { ...orion, collapsed: false, threads: [], hiddenThreads: [] },
      {
        kind: "project",
        folder: projectFolders[0],
        label: "Rewards",
        parent: orionId,
        depth: 2,
      },
      {
        kind: "project",
        folder: projectFolders[2],
        label: "Infra",
        parent: orionId,
        depth: 2,
      },
      portal,
    ]);
    expect(openGroup.flatMap(sidebarFolderRowThreads)).toEqual(["s1", "i1", "m1"]);

    // A client picked in the rail lists its groups one level up, under the same row ids.
    const buildScoped = (expandedById: Record<string, boolean>) =>
      buildSidebarFolderRows({
        folders: projectFolders,
        groupByClient: true,
        withoutClientHeader: true,
        expandedById,
        isRouteThread: (thread) => thread === "s1",
      });
    const scopedOrion = { ...orion, parent: undefined, depth: 0 };
    const scopedPortal = { ...portal, parent: undefined, depth: 0 };
    const scopedClosed = buildScoped({});
    expect(scopedClosed).toEqual([
      { ...scopedOrion, collapsed: true, threads: ["s1"], hiddenThreads: ["s2", "i1"] },
      scopedPortal,
    ]);
    expect(scopedClosed.flatMap(sidebarFolderRowThreads)).toEqual(["s1", "m1"]);
    const scopedOpen = buildScoped({ [orionId]: true });
    expect(scopedOpen).toEqual([
      { ...scopedOrion, collapsed: false, threads: [], hiddenThreads: [] },
      { kind: "project", folder: projectFolders[0], label: "Rewards", parent: orionId, depth: 1 },
      { kind: "project", folder: projectFolders[2], label: "Infra", parent: orionId, depth: 1 },
      scopedPortal,
    ]);
    expect(scopedOpen.flatMap(sidebarFolderRowThreads)).toEqual(["s1", "i1", "m1"]);
  });

  it("keeps a settled route thread under a closed client, out of its count, unless it is departing", () => {
    const build = (isSettledRouteThread?: (thread: string) => boolean) =>
      buildSidebarFolderRows({
        folders: [
          folder("Acme · App", ["a1"], { settled: settledRow("Acme · App", ["s1"]) }),
          folder("Acme · Infra", [], { settled: settledRow("Acme · Infra", []) }),
        ],
        groupByClient: true,
        expandedById: {},
        isRouteThread: (thread) => thread === "s1",
        ...(isSettledRouteThread === undefined ? {} : { isSettledRouteThread }),
      });
    expect(build()).toMatchObject([{ kind: "client", threads: ["s1"], hiddenThreads: ["a1"] }]);
    expect(build(() => false)).toMatchObject([
      { kind: "client", threads: [], hiddenThreads: ["a1"] },
    ]);
  });

  it("lists a folder's shown settled threads after its active ones", () => {
    const rows = buildSidebarFolderRows({
      folders: [
        folder("Initech", ["p1"], { settled: settledRow("Initech", ["s1", "s2"]) }),
        folder("Vandelay", ["z1"], { settled: settledRow("Vandelay", []) }),
      ],
      groupByClient: true,
      expandedById: {},
      isRouteThread: () => false,
    });
    expect(rows.flatMap(sidebarFolderRowThreads)).toEqual(["p1", "s1", "s2", "z1"]);
  });
});

describe("splitSettledThreadsByFolder", () => {
  const groups = [
    folder("Acme · App").group,
    folder("Umbrella").group,
    folder("Initech").group,
    folder("Acme · Old", [], { archived: true }).group,
  ];
  const thread = (projectId: string, id: string) => ({ environmentId: "local", projectId, id });

  it("hands each folder its settled threads in order and leaves the rest to the shelf", () => {
    const threads = [
      thread("Acme · App", "a1"),
      thread("Gone", "g1"),
      thread("Acme · Old", "o1"),
      thread("Acme · App", "a2"),
    ];
    const split = splitSettledThreadsByFolder({
      groups,
      settledThreads: threads,
      unloadedCount: (group) => (group.projectKey === "Umbrella" ? 3 : 0),
    });
    expect([...split.byProjectKey]).toEqual([
      ["Acme · App", { threads: [threads[0], threads[3]], unloadedCount: 0 }],
      ["Umbrella", { threads: [], unloadedCount: 3 }],
    ]);
    expect(split.shelfThreads).toEqual([threads[1], threads[2]]);
    expect(split.folderedProjectKeys).toEqual(
      new Set(["local:Acme · App", "local:Umbrella", "local:Initech"]),
    );
  });
});

describe("buildSidebarFolderSettled", () => {
  const rowId = sidebarFolderSettledRowId("Vandelay");
  const threads = ["s1", "s2", "s3", "s4"];
  const build = (
    options: {
      readonly expanded?: boolean;
      readonly folderCollapsed?: boolean;
      readonly route?: string;
      readonly unlisted?: readonly string[];
    } = {},
  ) =>
    buildSidebarFolderSettled({
      rowId,
      threads,
      unloadedCount: 5,
      visibleCount: 2,
      folderCollapsed: options.folderCollapsed ?? false,
      expandedById: options.expanded === true ? { [rowId]: true } : {},
      isRouteThread: (thread) => thread === options.route,
      isListed: (thread) => !(options.unlisted ?? []).includes(thread),
    });

  it("stays closed by default and counts unloaded threads", () => {
    expect(rowId).toBe("folder-settled:Vandelay");
    expect(build()).toEqual({
      rowId,
      count: 9,
      expanded: false,
      threads: [],
      hiddenCount: 0,
      loadedThreads: threads,
    });
    expect(build({ route: "s3" }).threads).toEqual(["s3"]);
  });

  it("lists a page when open, plus the route thread past it", () => {
    expect(build({ expanded: true })).toMatchObject({
      expanded: true,
      threads: ["s1", "s2"],
      hiddenCount: 7,
    });
    expect(build({ expanded: true, route: "s4" })).toMatchObject({
      threads: ["s1", "s2", "s4"],
      hiddenCount: 6,
    });
    expect(build({ expanded: true, folderCollapsed: true, route: "s4" })).toMatchObject({
      expanded: true,
      threads: ["s4"],
      hiddenCount: 0,
    });
  });

  it("holds back rows below the frontier, as the shelf does, except the route thread", () => {
    expect(build({ expanded: true, unlisted: ["s1"] })).toMatchObject({
      threads: ["s2", "s3"],
      hiddenCount: 7,
    });
    expect(build({ expanded: true, unlisted: ["s1"], route: "s1" })).toMatchObject({
      threads: ["s2", "s3", "s1"],
      hiddenCount: 6,
    });
  });
});

describe("buildSidebarClientRailEntries", () => {
  const groups = [
    folder("Globex · Portal"),
    folder("Initech"),
    folder("Acme · App"),
    folder("Globex · Orion · Rewards"),
    folder("Acme · Infra", [], { faviconPath: "/clients/acme/logo.png" }),
    folder("Acme · Old", [], { archived: true }),
    folder("Umbrella", [], { archived: true }),
  ].map((entry) => entry.group);

  it("lists each client once, unprefixed projects on their own, and no archived project", () => {
    const entries = buildSidebarClientRailEntries({ groups, alphabetical: false });
    expect(entries.map((entry) => [entry.id, entry.kind, entry.name])).toEqual([
      ["client:Globex", "client", "Globex"],
      ["project:Initech", "project", "Initech"],
      ["client:Acme", "client", "Acme"],
    ]);
    expect(entries[0]?.groups).toEqual([groups[0], groups[3]]);
    expect(entries[1]?.groups).toEqual([groups[1]]);
    expect(entries[2]?.groups).toEqual([groups[2], groups[4]]);
    expect(
      buildSidebarClientRailEntries({ groups, alphabetical: true }).map((entry) => entry.name),
    ).toEqual(["Acme", "Globex", "Initech"]);
  });

  it("takes the first icon chosen among a client's projects, else its first project", () => {
    const entries = buildSidebarClientRailEntries({ groups, alphabetical: false });
    expect(entries.map((entry) => entry.logo)).toEqual([groups[0], groups[1], groups[4]]);
  });
});

describe("pinned or active projects only", () => {
  const groups = [
    folder("Acme · App", [], { pinned: true }),
    folder("Acme · Infra"),
    folder("Globex · Portal"),
    folder("Initech"),
    folder("Hooli", [], { pinned: true }),
    folder("Contoso", [], { pinned: true, archived: true }),
  ].map((entry) => entry.group);
  const thread = (projectId: string, id = projectId) => ({
    environmentId: "local",
    projectId,
    id,
  });

  it("shows a folder whose project is pinned or has an active thread", () => {
    const live = sidebarThreadProjectRefs([thread("Initech"), thread("Initech", "i2")]);
    expect(live).toEqual(new Set(["local:Initech"]));
    expect(groups.map((group) => isSidebarFolderShown(group, live))).toEqual([
      true,
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  it("lists in the rail only the clients with a shown project, keeping all their projects", () => {
    const rail = (activeProjects: readonly string[]) => {
      const live = sidebarThreadProjectRefs(activeProjects.map((projectId) => thread(projectId)));
      return buildSidebarClientRailEntries({
        groups,
        alphabetical: false,
        isShown: (group) => isSidebarFolderShown(group, live),
      });
    };
    const entries = rail([]);
    expect(entries.map((entry) => entry.id)).toEqual(["client:Acme", "project:Hooli"]);
    // Picking the client still scopes to every one of its projects, shown or not.
    expect(entries[0]?.groups).toEqual([groups[0], groups[1]]);
    expect(rail(["Globex · Portal", "Initech"]).map((entry) => entry.id)).toEqual([
      "client:Acme",
      "client:Globex",
      "project:Initech",
      "project:Hooli",
    ]);
  });

  it("hands a hidden folder's settled threads to the shelf", () => {
    const live = sidebarThreadProjectRefs([]);
    const settledThreads = [thread("Acme · App", "a1"), thread("Acme · Infra", "f1")];
    const split = splitSettledThreadsByFolder({
      groups: groups.filter((group) => isSidebarFolderShown(group, live)),
      settledThreads,
      unloadedCount: () => 0,
    });
    expect([...split.byProjectKey.keys()]).toEqual(["Acme · App"]);
    expect(split.shelfThreads).toEqual([settledThreads[1]]);
  });
});

describe("sidebarClientRailThreads", () => {
  it("hands each entry the threads of all its projects and drops unlisted ones", () => {
    const groups = [folder("Acme · App"), folder("Initech"), folder("Acme · Infra")].map(
      (entry) => entry.group,
    );
    const entries = buildSidebarClientRailEntries({ groups, alphabetical: false });
    const thread = (projectId: string) => ({ environmentId: "local", projectId });
    const threads = [
      thread("Acme · App"),
      thread("Initech"),
      thread("Gone"),
      thread("Acme · Infra"),
    ];
    expect(sidebarClientRailThreads(entries, threads)).toEqual(
      new Map([
        ["client:Acme", [threads[0], threads[3]]],
        ["project:Initech", [threads[1]]],
      ]),
    );
  });
});

describe("client order in manual mode", () => {
  it("puts a client where the rail does, even when its first project shows no folder", () => {
    const old = folder("Acme · Old");
    const vandelay = folder("Vandelay", ["z1"]);
    const app = folder("Acme · App", ["a1"]);
    const groups = [old, vandelay, app].map((entry) => entry.group);
    // The empty "Acme · Old" folder is left out of the tree, as the sidebar drops it.
    const rows = buildSidebarFolderRows({
      folders: [vandelay, app],
      groupByClient: true,
      alphabetical: false,
      clientOrder: groups,
      expandedById: {},
      isRouteThread: () => false,
    });
    const treeNames = rows.map((row) =>
      row.kind === "client" ? row.name : row.folder.group.displayName,
    );
    const railNames = buildSidebarClientRailEntries({ groups, alphabetical: false }).map(
      (entry) => entry.name,
    );
    expect(treeNames).toEqual(["Acme", "Vandelay"]);
    expect(railNames).toEqual(treeNames);
  });
});

describe("sidebarClientRailThreads dot input", () => {
  it("leaves out pinned threads and the open thread, as the client header does", () => {
    const groups = [folder("Acme · App")].map((entry) => entry.group);
    const entries = buildSidebarClientRailEntries({ groups, alphabetical: false });
    const threads = [
      { environmentId: "local", projectId: "Acme · App", id: "open", pinnedAt: null },
      { environmentId: "local", projectId: "Acme · App", id: "pinned", pinnedAt: "2026-03-09" },
      { environmentId: "local", projectId: "Acme · App", id: "folded", pinnedAt: null },
    ];
    expect(sidebarClientRailThreads(entries, threads, (thread) => thread.id === "open")).toEqual(
      new Map([["client:Acme", [threads[2]]]]),
    );
  });
});

describe("resolveSidebarInboxBadge", () => {
  it("counts the threads waiting on the user and skips working, quiet and open ones", () => {
    const threads = [
      { id: "approval", dot: "attention" },
      { id: "failed", dot: "failed" },
      { id: "done", dot: "unread" },
      { id: "running", dot: "working" },
      { id: "quiet", dot: null },
      { id: "open", dot: "failed" },
    ] as const;
    const badgeOf = (list: readonly (typeof threads)[number][]) =>
      resolveSidebarInboxBadge({
        threads: list,
        isRouteThread: (thread) => thread.id === "open",
        dotOf: (waiting) => waiting[0]?.dot ?? null,
      });
    expect(badgeOf(threads)?.count).toBe(3);
    expect(badgeOf(threads.slice(3))).toBeNull();
  });
});

describe("stored order", () => {
  const atlasId = 'client-project:["Acme","Atlas"]';
  const folders = [
    folder("Acme · App"),
    folder("Acme · Infra"),
    folder("Acme · Atlas · Web"),
    folder("Acme · Atlas · Site"),
    folder("Globex · Portal"),
    folder("Initech"),
  ];
  const groups = folders.map((entry) => entry.group);
  const allOpen = { "client:Acme": true, "client:Globex": true, [atlasId]: true };
  const nameOf = (row: ReturnType<typeof buildSidebarFolderRows<FolderGroup, string>>[number]) =>
    row.kind === "client" ? row.name : (row.label ?? row.folder.group.displayName);
  type FolderGroup = (typeof groups)[number];
  const rows = (
    input: {
      readonly order?: Record<string, readonly string[]>;
      readonly alphabetical?: boolean;
      readonly folders?: typeof folders;
      readonly withoutClientHeader?: boolean;
    } = {},
  ) =>
    buildSidebarFolderRows({
      folders: input.folders ?? folders,
      groupByClient: true,
      alphabetical: input.alphabetical ?? true,
      withoutClientHeader: input.withoutClientHeader ?? false,
      expandedById: allOpen,
      isRouteThread: () => false,
      ...(input.order === undefined ? {} : { order: input.order }),
    }).map(nameOf);
  const rail = (order: Record<string, readonly string[]>, from = groups) =>
    buildSidebarClientRailEntries({ groups: from, alphabetical: true, order }).map(
      (entry) => entry.name,
    );

  it("changes nothing while no order is stored, in both sort modes", () => {
    expect(rows({ order: {} })).toEqual(rows());
    expect(rows({ order: {}, alphabetical: false })).toEqual(rows({ alphabetical: false }));
    expect(rows()).toEqual([
      "Acme",
      "App",
      "Atlas",
      "Site",
      "Web",
      "Infra",
      "Globex",
      "Portal",
      "Initech",
    ]);
  });

  it("applies one stored order to the rail, the All view and a picked client", () => {
    const order = {
      rail: ["project:Initech", "client:Globex", "client:Acme"],
      "client:Acme": [atlasId, "project:Acme · Infra", "project:Acme · App"],
    };
    expect(rail(order)).toEqual(["Initech", "Globex", "Acme"]);
    expect(rows({ order })).toEqual([
      "Initech",
      "Globex",
      "Portal",
      "Acme",
      "Atlas",
      "Site",
      "Web",
      "Infra",
      "App",
    ]);
    expect(rows({ order, folders: folders.slice(0, 4), withoutClientHeader: true })).toEqual([
      "Atlas",
      "Site",
      "Web",
      "Infra",
      "App",
    ]);
  });

  it("keeps a hidden rail entry's stored place for when it returns", () => {
    const order = { rail: ["project:Initech", "client:Globex", "client:Acme"] };
    const shown = (hidden: string | null) =>
      buildSidebarClientRailEntries({
        groups,
        alphabetical: true,
        order,
        isShown: (group) => !group.displayName.startsWith(hidden ?? "\u0000"),
      }).map((entry) => entry.name);
    expect(shown("Globex")).toEqual(["Initech", "Acme"]);
    expect(shown(null)).toEqual(["Initech", "Globex", "Acme"]);
  });

  it("puts entries the order lacks last, in default order, and ignores stale ids", () => {
    const order = {
      rail: ["gone", "client:Globex"],
      "client:Acme": ["project:Acme · Infra", "project:Old"],
    };
    expect(rail(order)).toEqual(["Globex", "Acme", "Initech"]);
    expect(rows({ order })).toEqual([
      "Globex",
      "Portal",
      "Acme",
      "Infra",
      "App",
      "Atlas",
      "Site",
      "Web",
      "Initech",
    ]);
  });

  it("orders each level on its own", () => {
    const order = {
      rail: ["project:Initech", "client:Acme"],
      [atlasId]: ["project:Acme · Atlas · Web", "project:Acme · Atlas · Site"],
    };
    expect(rows({ order })).toEqual([
      "Initech",
      "Acme",
      "App",
      "Atlas",
      "Web",
      "Site",
      "Infra",
      "Globex",
      "Portal",
    ]);
  });

  it("keeps a renamed repository's place and sends a renamed client last", () => {
    const order = {
      rail: ["project:Initech", "client:Acme", "client:Globex"],
      "client:Acme": ["project:Acme · Infra", "project:Acme · App"],
    };
    const renamed = [
      folder("Acme · Platform", [], { projectKey: "Acme · Infra" }),
      ...folders.filter((entry) => entry.group.displayName !== "Acme · Infra"),
    ];
    expect(rows({ order, folders: renamed }).slice(0, 4)).toEqual([
      "Initech",
      "Acme",
      "Platform",
      "App",
    ]);
    const corp = folders.map((entry) =>
      entry.group.displayName.startsWith("Acme · ")
        ? folder(entry.group.displayName.replace("Acme", "Acme Corp"), [], {
            projectKey: entry.group.projectKey,
          })
        : entry,
    );
    expect(
      rail(
        order,
        corp.map((entry) => entry.group),
      ),
    ).toEqual(["Initech", "Globex", "Acme Corp"]);
  });

  it("keeps an archived folder last even when its id is stored", () => {
    const archived = [...folders, folder("Vandelay", [], { archived: true })];
    expect(
      rows({ order: { rail: ["project:Vandelay", "project:Initech"] }, folders: archived }),
    ).toEqual([
      "Initech",
      "Acme",
      "App",
      "Atlas",
      "Site",
      "Web",
      "Infra",
      "Globex",
      "Portal",
      "Vandelay",
    ]);
  });
});

describe("sidebarClientFolderLevels", () => {
  it("lists every level from all open projects, shown or not", () => {
    const groups = [
      folder("Globex · Portal"),
      folder("Acme · Atlas · Web"),
      folder("Acme · App"),
      folder("Initech"),
      folder("Vandelay", [], { archived: true }),
    ].map((entry) => entry.group);
    expect(
      sidebarClientFolderLevels({
        groups,
        alphabetical: true,
        order: { rail: ["project:Initech"] },
      }),
    ).toEqual(
      new Map([
        ["rail", ["project:Initech", "client:Acme", "client:Globex"]],
        ["client:Acme", ["project:Acme · App", 'client-project:["Acme","Atlas"]']],
        ['client-project:["Acme","Atlas"]', ["project:Acme · Atlas · Web"]],
        ["client:Globex", ["project:Globex · Portal"]],
      ]),
    );
  });
});

describe("sidebarFolderRowOrder and sidebarOrderDropLine", () => {
  const atlasId = 'client-project:["Acme","Atlas"]';
  const build = (withoutClientHeader: boolean) =>
    buildSidebarFolderRows({
      folders: [
        folder("Acme · App"),
        folder("Acme · Atlas · Web"),
        folder("Globex · Portal"),
        folder("Vandelay", [], { archived: true }),
      ],
      groupByClient: true,
      alphabetical: true,
      withoutClientHeader,
      expandedById: { "client:Acme": true, [atlasId]: true },
      isRouteThread: () => false,
    });
  const rows = build(false);

  it("reorders a row within its parent, or the rail or picked client at the top", () => {
    expect(rows.map((row) => sidebarFolderRowOrder(row, "rail"))).toEqual([
      { level: "rail", id: "client:Acme" },
      { level: "client:Acme", id: "project:Acme · App" },
      { level: "client:Acme", id: atlasId },
      { level: atlasId, id: "project:Acme · Atlas · Web" },
      { level: "rail", id: "client:Globex" },
      null,
    ]);
    expect(sidebarFolderRowOrder(build(true)[0]!, "client:Acme")).toEqual({
      level: "client:Acme",
      id: "project:Acme · App",
    });
    expect(sidebarFolderRowOrder(rows[0]!, null)).toBeNull();
  });

  it("draws the line before the target, or after its open block", () => {
    const line = (id: string, position: "before" | "after", level = "rail") =>
      sidebarOrderDropLine({ rows, rootLevel: "rail", level, drop: { targetId: id, position } });
    expect(line("client:Globex", "before")).toEqual({ index: 4, depth: 0 });
    expect(line("client:Acme", "after")).toEqual({ index: 4, depth: 0 });
    expect(line(atlasId, "before", "client:Acme")).toEqual({ index: 2, depth: 1 });
    expect(line("project:Acme · App", "after", "client:Acme")).toEqual({ index: 2, depth: 1 });
    const shown = rows.slice(0, 5);
    expect(
      sidebarOrderDropLine({
        rows: shown,
        rootLevel: "rail",
        level: "rail",
        drop: { targetId: "client:Globex", position: "after" },
      }),
    ).toEqual({ index: shown.length, depth: 0 });
    expect(line("client:Hooli", "after")).toBeNull();
  });
});

describe("sidebarOrderRefAtLevel", () => {
  const atlasId = 'client-project:["Acme","Atlas"]';
  const rows = buildSidebarFolderRows({
    folders: [folder("Acme · App"), folder("Acme · Atlas · Web"), folder("Globex · Portal")],
    groupByClient: true,
    alphabetical: true,
    expandedById: { "client:Acme": true, [atlasId]: true, "client:Globex": true },
    isRouteThread: () => false,
  });
  const at = (over: { level: string; id: string }, level: string) =>
    sidebarOrderRefAtLevel({ rows, rootLevel: "rail", over, level });

  it("reads a hit inside an open block as that block's entry, and nothing outside it", () => {
    const web = { level: atlasId, id: "project:Acme · Atlas · Web" };
    expect(at(web, atlasId)).toEqual(web);
    expect(at(web, "client:Acme")).toEqual({ level: "client:Acme", id: atlasId });
    expect(at(web, "rail")).toEqual({ level: "rail", id: "client:Acme" });
    expect(at({ level: "client:Globex", id: "project:Globex · Portal" }, "rail")).toEqual({
      level: "rail",
      id: "client:Globex",
    });
    expect(at({ level: "client:Globex", id: "project:Globex · Portal" }, "client:Acme")).toBe(null);
    expect(at({ level: "rail", id: "client:Globex" }, "client:Acme")).toBeNull();
  });
});

describe("a step on a level the tree shows only in part", () => {
  it("passes the hidden entries between the two shown rows, and moves nothing else", () => {
    const groups = [folder("Acme · App"), folder("Globex · Portal"), folder("Initech · Web")].map(
      (entry) => entry.group,
    );
    // The tree hides Globex (no active thread); the rail lists all three.
    const drop = stepSidebarOrderDrop({
      siblings: ["client:Acme", "client:Initech"],
      activeId: "client:Acme",
      direction: 1,
    });
    expect(drop).toEqual({ targetId: "client:Initech", position: "after" });
    const order = moveSidebarOrderEntry({
      order: {},
      level: "rail",
      present: sidebarClientFolderLevels({ groups, alphabetical: true, order: {} }).get("rail")!,
      activeId: "client:Acme",
      drop: drop!,
    });
    expect(
      buildSidebarClientRailEntries({ groups, alphabetical: true, order }).map(
        (entry) => entry.name,
      ),
    ).toEqual(["Globex", "Initech", "Acme"]);
  });
});

describe("clientProjectScopeItems", () => {
  it("keeps All, renamed for the client, Add project and the client's projects only", () => {
    const items = [
      { value: "add-project", label: "Add project" },
      { value: "all", label: "All projects" },
      { value: "acme-app", label: "Acme · App" },
      { value: "globex-app", label: "Globex · App" },
    ];
    expect(clientProjectScopeItems(items, new Set(["acme-app"]), "All Acme projects")).toEqual([
      { value: "add-project", label: "Add project" },
      { value: "all", label: "All Acme projects" },
      { value: "acme-app", label: "Acme · App" },
    ]);
  });
});
