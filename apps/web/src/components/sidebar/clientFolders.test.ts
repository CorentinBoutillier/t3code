import type { ProjectIconOverride } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarFolderRows,
  groupSidebarFoldersByClient,
  sidebarFolderRowThreads,
  splitClientPrefix,
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
    readonly title?: string;
  } = {},
) {
  return {
    group: {
      displayName,
      title: options.title ?? displayName,
      archived: options.archived ?? false,
      projectIcon: options.projectIcon ?? null,
      faviconPath: options.faviconPath ?? null,
    },
    collapsed: options.hiddenThreads !== undefined,
    threads,
    hiddenThreads: options.hiddenThreads ?? [],
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
        "hooli · Site",
        "Globex · Site",
      ]),
    ).toEqual([
      { Globex: ["Portal", "Site"] },
      "Initech",
      { Acme: ["App", "Infra"] },
      "Umbrella",
      { hooli: ["Site"] },
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
      folder("Zenith", ["z1"]),
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
      "Zenith",
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
  });
});
