import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig, isMacPlatform } from "@t3tools/shared/keybindings";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  removeLocalStorageItem,
  setLocalStorageItem,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useUiStateStore } from "../uiStateStore";
import { readLocalApi } from "../localApi";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { shortcutLabelForCommand } from "../keybindings";
import {
  CLIENT_FOLDERS_ENABLED_KEY,
  CLIENT_RAIL_SELECTED_KEY,
  SIDEBAR_INBOX_ID,
} from "./sidebar/clientFolders";
import {
  CLIENT_FOLDER_ORDER_KEY,
  SidebarClientFolderOrder,
  sidebarRepositoryOrderId,
} from "./sidebar/clientFolderOrder";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../hooks/useThreadActions", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    // A real wall-clock minute tick mid-test re-renders every row and reads as a leak.
    vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar thread menu", () => {
  it("tells the menu whether the keyboard opened it", async () => {
    const activeProject = project("active");
    const thread = threadShell(activeProject.id, 0);
    const threadRef = { environmentId: activeProject.environmentId, threadId: thread.id };
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const row = screen.getByText("Thread 0").first();
    await expect.element(row).toBeInTheDocument();
    row.element().closest<HTMLElement>("[data-sidebar-row]")!.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.lastCall?.[2]).toBe("keyboard");
    await userEvent.click(row, { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show.mock.lastCall?.[2]).toBe("mouse");
  });
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});

const JUMP_KEYBINDINGS = compileResolvedKeybindingsConfig([
  { key: "mod+1", command: "thread.jump.1" },
  { key: "mod+2", command: "thread.jump.2" },
]);
const JUMP_1_LABEL = shortcutLabelForCommand(JUMP_KEYBINDINGS, "thread.jump.1");
const JUMP_2_LABEL = shortcutLabelForCommand(JUMP_KEYBINDINGS, "thread.jump.2");

function settledShell(projectId: ProjectId, index: number, settledAt: string) {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
    settledOverride: "settled",
    settledAt,
  });
}

function setupClientFolders(
  stack: DisposableStack,
  options: { withProjectGroup?: boolean; settled?: boolean; umbrellaPinned?: boolean } = {},
) {
  const previousSettings = getClientSettings();
  stack.defer(() => __setClientSettingsForTests(previousSettings));
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: true });
  const { projectExpandedById: previousExpanded, sidebarProjectScopeKeys: previousScope } =
    useUiStateStore.getState();
  stack.defer(() =>
    useUiStateStore.setState({
      projectExpandedById: previousExpanded,
      sidebarProjectScopeKeys: previousScope,
    }),
  );
  stack.defer(() => removeLocalStorageItem(CLIENT_FOLDERS_ENABLED_KEY));
  stack.defer(() => removeLocalStorageItem(CLIENT_RAIL_SELECTED_KEY));
  stack.defer(() => removeLocalStorageItem(CLIENT_FOLDER_ORDER_KEY));
  setLocalStorageItem(CLIENT_FOLDERS_ENABLED_KEY, true, Schema.Boolean);
  // Earlier tests leave the settled shelf open and the local API's context menu stubbed.
  removeLocalStorageItem("t3code:sidebar:settled-expanded");
  vi.mocked(readLocalApi).mockReset();
  const app = { ...project("acme-app"), title: "Acme · App" };
  const infra = { ...project("acme-infra"), title: "Acme · Infra" };
  // Sorts after Acme, so only the closed client's wiring gives its thread a jump.
  const solo = { ...project("vandelay"), title: "Vandelay" };
  const web = { ...project("atlas-web"), title: "Northwind · Atlas · Web" };
  const site = { ...project("atlas-site"), title: "Northwind · Atlas · Site" };
  // Pinned, so its settled-only folder shows; unpinned, it leaves the rail and the tree.
  const umbrella = {
    ...project("umbrella"),
    title: "Umbrella",
    pinnedAt: options.umbrellaPinned === false ? null : "2026-01-02T00:00:00.000Z",
  };
  const nested = options.withProjectGroup === true;
  const settled = options.settled === true;
  // Partitioning settles threads only for an environment whose config has loaded.
  if (settled) {
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([[EnvironmentId.make("local"), { environment: { capabilities: {} } }]]) as never,
    );
    stack.defer(() => vi.mocked(useServerConfigs).mockReset());
  }
  const threads = [
    threadShell(app.id, 0),
    threadShell(app.id, 1),
    {
      ...threadShell(infra.id, 2),
      runtime: {
        status: "failed" as const,
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: null,
        updatedAt: "2026-03-09T10:00:00.000Z",
      },
    },
    threadShell(solo.id, 3),
    ...(nested ? [threadShell(web.id, 4), threadShell(web.id, 5), threadShell(site.id, 6)] : []),
    ...(settled
      ? [
          settledShell(solo.id, 10, "2026-03-01T10:00:00.000Z"),
          settledShell(solo.id, 11, "2026-03-02T10:00:00.000Z"),
          {
            ...settledShell(umbrella.id, 12, "2026-03-03T10:00:00.000Z"),
            runtime: {
              status: "failed" as const,
              activeRunId: null,
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerName: "Codex",
              lastError: null,
              updatedAt: "2026-03-09T10:00:00.000Z",
            },
          },
          settledShell(app.id, 13, "2026-03-04T10:00:00.000Z"),
          settledShell(ProjectId.make("gone"), 14, "2026-03-05T10:00:00.000Z"),
        ]
      : []),
  ];
  const routeThreadRef: ScopedThreadRef = {
    environmentId: app.environmentId,
    threadId: threads[0]!.id,
  };
  vi.mocked(useProjects).mockReturnValue([
    app,
    infra,
    solo,
    ...(nested ? [web, site] : []),
    ...(settled ? [umbrella] : []),
  ]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
  const startThread = vi.fn().mockResolvedValue(null);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId: app.environmentId, projectId: app.id },
    defaultProjectFallbackReady: true,
    handleNewThread: startThread,
    routeDraftId: null,
    routeThreadRef,
  });
  return { app, infra, solo, umbrella, threads, startThread };
}

async function jumpLabelsByThreadId() {
  using _timers = fakeTimers();
  const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
  const before = vi.mocked(SortableThreadRow).mock.calls.length;
  await userEvent.keyboard(`{${modifier}>}`);
  await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
  const jumpable = new Map(
    vi
      .mocked(SortableThreadRow)
      .mock.calls.slice(before)
      .filter(([props]) => props.jumpLabel !== null)
      .map(([props]) => [props.thread.id, props.jumpLabel] as const),
  );
  await userEvent.keyboard(`{/${modifier}}`);
  return jumpable;
}

function lastRowProps(threadId: string) {
  return vi
    .mocked(SortableThreadRow)
    .mock.calls.map(([props]) => props)
    .findLast((props) => props.thread.id === threadId);
}

describe("boring sidebar client folders", () => {
  it("groups folders under closed client headers that open on click", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const clientHeaders = screen.getByTestId("sidebar-client-folder");
    const client = clientHeaders.getByRole("button");
    await expect.element(client).toHaveAttribute("aria-expanded", "false");
    expect(clientHeaders.all()).toHaveLength(1);
    // Client monogram, then the failed Infra thread's dot; the count covers Thread 1 and Thread 2.
    expect(client.element().textContent).toBe("AEAcme, failed2");
    expect(screen.getByTestId("sidebar-project-folder").all()).toHaveLength(1);
    await expect.element(screen.getByText("Thread 0", { exact: true }).first()).toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 1", { exact: true }).first())
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 2", { exact: true }).first())
      .not.toBeInTheDocument();

    await userEvent.click(client);
    await expect.element(client).toHaveAttribute("aria-expanded", "true");
    expect(client.element().textContent).toBe("AEAcme");
    const appFolder = screen.getByRole("button", { name: /^App/ });
    await expect.element(appFolder).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^Infra/ })).toBeInTheDocument();
    await expect.element(screen.getByText("Thread 1", { exact: true }).first()).toBeInTheDocument();
    await expect.element(screen.getByText("Thread 2", { exact: true }).first()).toBeInTheDocument();

    await act(() => appFolder.element().focus());
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(client).toHaveFocus();

    await act(() =>
      writeLocalStorageValue(CLIENT_FOLDERS_ENABLED_KEY, false, false, Schema.Boolean),
    );
    await expect.element(screen.getByTestId("sidebar-client-folder")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-project-folder").all()).toHaveLength(3);
    await expect.element(screen.getByRole("button", { name: /^Acme · App/ })).toBeInTheDocument();
  });

  it("offers thread jumps only to rows a closed client still shows", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const before = vi.mocked(SortableThreadRow).mock.calls.length;
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    const jumpable = new Set(
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(before)
        .filter(([props]) => props.jumpLabel !== null)
        .map(([props]) => props.thread.id),
    );
    await userEvent.keyboard(`{/${modifier}}`);
    expect(jumpable).toEqual(new Set(["thread-0", "thread-3"]));
  });

  it("nests a closed project group under its client, walked up by ArrowLeft", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack, { withProjectGroup: true });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const header = (name: string) =>
      screen.getByTestId("sidebar-client-folder").filter({ hasText: name }).getByRole("button");
    const client = header("Northwind");
    await userEvent.click(client);
    await expect.element(client).toHaveAttribute("aria-expanded", "true");
    const group = header("Atlas");
    await expect.element(group).toHaveAttribute("aria-expanded", "false");
    // Its count covers both repositories' threads.
    expect(group.element().textContent).toMatch(/Atlas3$/);
    await expect.element(screen.getByRole("button", { name: /^Web/ })).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 4", { exact: true }).first())
      .not.toBeInTheDocument();

    await userEvent.click(group);
    await expect.element(group).toHaveAttribute("aria-expanded", "true");
    const webFolder = screen.getByRole("button", { name: /^Web/ });
    await expect.element(webFolder).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^Site/ })).toBeInTheDocument();
    await expect.element(screen.getByText("Thread 6", { exact: true }).first()).toBeInTheDocument();

    await act(() => webFolder.element().focus());
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(group).toHaveFocus();
    // Closing the group leaves its threads out of the jump targets below.
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(group).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(client).toHaveFocus();

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const before = vi.mocked(SortableThreadRow).mock.calls.length;
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    const jumpable = new Set(
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(before)
        .filter(([props]) => props.jumpLabel !== null)
        .map(([props]) => props.thread.id),
    );
    await userEvent.keyboard(`{/${modifier}}`);
    expect(jumpable).toEqual(new Set(["thread-0", "thread-3"]));
  });

  it("shows a filtered project's folder without its client header", async () => {
    using stack = new DisposableStack();
    const { app } = setupClientFolders(stack);
    useUiStateStore.setState({ sidebarProjectScopeKeys: [derivePhysicalProjectKey(app)] });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByRole("button", { name: /^Acme · App/ })).toBeInTheDocument();
    await expect.element(screen.getByText("Thread 1", { exact: true }).first()).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-client-folder").all()).toHaveLength(0);
  });

  it("scopes folders, pinned threads and jumps to the client picked in the rail", async () => {
    using stack = new DisposableStack();
    const { solo, threads } = setupClientFolders(stack, { withProjectGroup: true });
    vi.mocked(useQuietThreadShells).mockReturnValue([
      ...threads,
      { ...threadShell(solo.id, 7), pinnedAt: "2026-03-09T10:00:00.000Z" },
    ]);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    await expect.element(rail).toBeInTheDocument();
    const railButtons = rail.getByRole("button");
    expect(railButtons.all()).toHaveLength(5);
    // Thread 2's failure shows on Acme whatever the rail scopes the list to.
    const names = ["Inbox, 1 waiting", "All", "Acme, failed", "Northwind", "Vandelay"];
    for (const [index, name] of names.entries()) {
      await expect.element(railButtons.nth(index)).toHaveAccessibleName(name);
    }
    await expect.element(railButtons.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 7", { exact: true }).first()).toBeInTheDocument();

    const northwind = rail.getByRole("button", { name: /^Northwind/ });
    await userEvent.click(northwind);
    await expect.element(northwind).toHaveAttribute("aria-pressed", "true");
    for (const hidden of ["Thread 0", "Thread 3", "Thread 7"]) {
      await expect
        .element(screen.getByText(hidden, { exact: true }).first())
        .not.toBeInTheDocument();
    }
    const headers = screen.getByTestId("sidebar-client-folder");
    expect(headers.all()).toHaveLength(1);
    const group = headers.getByRole("button");
    await expect.element(group).toHaveAttribute("aria-expanded", "false");
    expect(group.element().textContent).toMatch(/Atlas3$/);

    await userEvent.click(group);
    await expect.element(screen.getByRole("button", { name: /^Web/ })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^Site/ })).toBeInTheDocument();
    for (const shown of ["Thread 4", "Thread 5", "Thread 6"]) {
      await expect.element(screen.getByText(shown, { exact: true }).first()).toBeInTheDocument();
    }

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const before = vi.mocked(SortableThreadRow).mock.calls.length;
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    const labelById = new Map(
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(before)
        .filter(([props]) => props.jumpLabel !== null)
        .map(([props]) => [props.thread.id, props.jumpLabel] as const),
    );
    await userEvent.keyboard(`{/${modifier}}`);
    // The first two visible rows take the first two jumps; a hidden thread takes none.
    expect([...labelById.values()].toSorted()).toEqual([JUMP_1_LABEL, JUMP_2_LABEL].toSorted());
    for (const id of labelById.keys()) expect(["thread-4", "thread-5", "thread-6"]).toContain(id);
  });

  it("keeps the picked client across a remount and returns to All when it is gone", async () => {
    using stack = new DisposableStack();
    const { solo, startThread } = setupClientFolders(stack);
    {
      await using screen = await render(
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>,
      );
      const acme = screen.getByTestId("sidebar-client-rail").getByRole("button", { name: /^Acme/ });
      await userEvent.click(acme);
      await expect.element(acme).toHaveAttribute("aria-pressed", "true");
    }

    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    await expect
      .element(rail.getByRole("button", { name: /^Acme/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sidebar-client-folder").all()).toHaveLength(0);
    await expect.element(screen.getByRole("button", { name: /^App/ })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^Infra/ })).toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 3", { exact: true }).first())
      .not.toBeInTheDocument();

    // A client with a single project leaves the new thread nothing to pick.
    await userEvent.click(rail.getByRole("button", { name: /^Vandelay/ }));
    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }));
    expect(startThread).toHaveBeenCalledExactlyOnceWith({
      environmentId: solo.environmentId,
      projectId: solo.id,
    });
    expect(openCommandPalette).not.toHaveBeenCalled();

    const all = rail.getByRole("button", { name: "All", exact: true });
    await userEvent.click(all);
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByTestId("sidebar-client-folder").filter({ hasText: "Acme" }))
      .toBeInTheDocument();
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();

    await act(() =>
      writeLocalStorageValue(
        CLIENT_RAIL_SELECTED_KEY,
        "client:Umbrella",
        null,
        Schema.NullOr(Schema.String),
      ),
    );
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-client-folder").all()).toHaveLength(1);
  });

  it("keeps the picked client when a reload reopens another client's thread", async () => {
    using stack = new DisposableStack();
    const { threads } = setupClientFolders(stack);
    {
      await using screen = await render(
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>,
      );
      const vandelay = screen
        .getByTestId("sidebar-client-rail")
        .getByRole("button", { name: /^Vandelay/ });
      await userEvent.click(vandelay);
      await expect.element(vandelay).toHaveAttribute("aria-pressed", "true");
    }

    // A fresh reveal is a reload, still on the Acme thread.
    const routeReveal = { observedKey: null, pendingKey: null };
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    await expect
      .element(rail.getByRole("button", { name: /^Vandelay/ }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 0", { exact: true }).first())
      .not.toBeInTheDocument();

    // Navigating to another client's thread brings the whole tree back.
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: threads[1]!.environmentId, threadId: threads[1]!.id },
    });
    await screen.rerender(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    await expect
      .element(rail.getByRole("button", { name: "All", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 1", { exact: true }).first()).toBeInTheDocument();
  });

  it("drops only the filter when a route opens a thread of the picked client", async () => {
    using stack = new DisposableStack();
    const { app, threads } = setupClientFolders(stack);
    const routeReveal = { observedKey: null, pendingKey: null };
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    const acme = rail.getByRole("button", { name: /^Acme/ });
    await userEvent.click(acme);
    await act(() =>
      useUiStateStore.setState({ sidebarProjectScopeKeys: [derivePhysicalProjectKey(app)] }),
    );
    await expect
      .element(screen.getByText("Thread 2", { exact: true }).first())
      .not.toBeInTheDocument();

    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: threads[2]!.environmentId, threadId: threads[2]!.id },
    });
    await screen.rerender(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 2", { exact: true }).first()).toBeInTheDocument();
    await expect.element(acme).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([]);
    await expect
      .element(screen.getByText("Thread 3", { exact: true }).first())
      .not.toBeInTheDocument();
  });

  it("keeps the user's filter when the rail pick still holds its project", async () => {
    using stack = new DisposableStack();
    const { app } = setupClientFolders(stack);
    const appKey = derivePhysicalProjectKey(app);
    useUiStateStore.setState({ sidebarProjectScopeKeys: [appKey] });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    await userEvent.click(rail.getByRole("button", { name: "All", exact: true }));
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([appKey]);
    const acme = rail.getByRole("button", { name: /^Acme/ });
    await userEvent.click(acme);
    await expect.element(acme).toHaveAttribute("aria-pressed", "true");
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([appKey]);
    await userEvent.click(acme);
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([appKey]);
    await expect
      .element(screen.getByLabelText("Filter threads by project: Acme · App", { exact: true }))
      .toBeInTheDocument();

    await userEvent.click(rail.getByRole("button", { name: /^Vandelay/ }));
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([]);
    await expect
      .element(screen.getByLabelText("Filter Vandelay threads by project", { exact: true }))
      .toBeInTheDocument();
  });

  it("offers a multi-project client's projects only to a new thread", async () => {
    using stack = new DisposableStack();
    const { app, startThread } = setupClientFolders(stack, { withProjectGroup: true });
    vi.mocked(useHandleNewThread).mockReturnValue({
      ...vi.mocked(useHandleNewThread)(),
      activeThread: makeThreadFixture({
        environmentId: app.environmentId,
        id: ThreadId.make("thread-0"),
        projectId: app.id,
      }),
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    await userEvent.click(rail.getByRole("button", { name: /^Northwind/ }));
    const newThread = screen.getByRole("button", { name: "New thread", exact: true });
    await userEvent.click(newThread);
    await userEvent.click(newThread, { modifiers: ["Shift"] });
    const northwindPicker = {
      open: "new-thread-in",
      projectKeys: ["local:atlas-web", "local:atlas-site"].toSorted(),
    };
    const calls = vi.mocked(openCommandPalette).mock.calls.map(([detail]) => ({
      ...detail,
      projectKeys: [...(detail?.projectKeys ?? [])].toSorted(),
    }));
    // Shift+click would start in the open Acme thread's project: the picker stays in Northwind.
    expect(calls).toEqual([northwindPicker, northwindPicker]);
    expect(startThread).not.toHaveBeenCalled();
  });

  it("gives the rail one Tab stop and moves between clients with the arrows", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const buttons = screen.getByTestId("sidebar-client-rail").getByRole("button");
    expect(buttons.all().map((button) => button.element().getAttribute("tabindex"))).toEqual([
      "-1",
      "0",
      "-1",
      "-1",
    ]);
    await act(() => (buttons.nth(1).element() as HTMLElement).focus());
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(buttons.nth(2)).toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect.element(buttons.nth(3)).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(buttons.nth(2)).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect.element(buttons.first()).toHaveAccessibleName(/^Inbox/);
    await expect.element(buttons.first()).toHaveFocus();
  });

  it("lists every client's threads flat under Inbox and keeps it picked when a thread opens", async () => {
    using stack = new DisposableStack();
    const { app, threads } = setupClientFolders(stack);
    const appKey = derivePhysicalProjectKey(app);
    useUiStateStore.setState({ sidebarProjectScopeKeys: [appKey] });
    const routeReveal = { observedKey: null, pendingKey: null };
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    const inbox = rail.getByRole("button", { name: /^Inbox/ });
    await userEvent.click(inbox);
    await expect.element(inbox).toHaveAttribute("aria-pressed", "true");
    for (const shown of ["Thread 0", "Thread 1", "Thread 2", "Thread 3"]) {
      await expect.element(screen.getByText(shown, { exact: true }).first()).toBeInTheDocument();
    }
    expect(screen.getByTestId("sidebar-client-folder").all()).toHaveLength(0);
    expect(screen.getByTestId("sidebar-project-folder").all()).toHaveLength(0);
    // The user's filter does not apply here, so no control shows it.
    expect(screen.getByLabelText(/Filter .*threads by project/).query()).toBeNull();
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([appKey]);

    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: threads[3]!.environmentId, threadId: threads[3]!.id },
    });
    await screen.rerender(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();
    await expect.element(inbox).toHaveAttribute("aria-pressed", "true");
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([appKey]);

    vi.mocked(openCommandPalette).mockClear();
    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }));
    expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });

    await userEvent.click(rail.getByRole("button", { name: "All", exact: true }));
    await expect
      .element(screen.getByLabelText("Filter threads by project: Acme · App", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 3", { exact: true }).first())
      .not.toBeInTheDocument();
  });

  it("keeps Inbox across a remount, with the Working shelf following its setting", async () => {
    using stack = new DisposableStack();
    const { solo, threads } = setupClientFolders(stack, { settled: true });
    vi.mocked(useQuietThreadShells).mockReturnValue([
      ...threads,
      {
        ...threadShell(solo.id, 5),
        runtime: {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-03-09T10:00:00.000Z",
        },
      },
    ]);
    {
      await using screen = await renderSidebar();
      const inbox = screen
        .getByTestId("sidebar-client-rail")
        .getByRole("button", { name: /^Inbox/ });
      await expect
        .element(screen.getByText("Thread 5", { exact: true }).first())
        .toBeInTheDocument();
      expect(screen.getByTestId("sidebar-working-header").query()).toBeNull();
      await userEvent.click(inbox);
      await expect.element(inbox).toHaveAttribute("aria-pressed", "true");
    }

    await using screen = await renderSidebar();
    await expect
      .element(screen.getByTestId("sidebar-client-rail").getByRole("button", { name: /^Inbox/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(CLIENT_RAIL_SELECTED_KEY)).toBe(JSON.stringify(SIDEBAR_INBOX_ID));
    await expect.element(screen.getByTestId("sidebar-working-header")).toBeInTheDocument();
  });

  it("badges Inbox with the threads waiting on the user, in the most urgent colour", async () => {
    using stack = new DisposableStack();
    const { app, solo, threads } = setupClientFolders(stack, { settled: true });
    const failedRuntime = threads[2]!.runtime;
    const unread = (projectId: ProjectId, index: number) => ({
      ...threadShell(projectId, index),
      latestRun: {
        runId: RunId.make(`run-${index}`),
        status: "completed" as const,
        requestedAt: "2026-03-09T09:00:00.000Z",
        startedAt: "2026-03-09T09:00:00.000Z",
        completedAt: "2026-03-09T10:00:00.000Z",
        assistantMessageId: null,
      },
      lastVisitedAt: "2026-03-09T08:00:00.000Z",
    });
    const approval = { ...threadShell(solo.id, 8), hasPendingApprovals: true };
    const waiting = [
      // The open thread waits on nobody.
      { ...threads[0]!, runtime: failedRuntime },
      ...threads.slice(1),
      unread(app.id, 9),
      { ...unread(solo.id, 7), pinnedAt: "2026-03-09T10:00:00.000Z" },
      {
        ...threadShell(solo.id, 5),
        runtime: { ...failedRuntime!, status: "running" as const },
      },
    ];
    vi.mocked(useQuietThreadShells).mockReturnValue([...waiting, approval]);
    await using screen = await renderSidebar();
    const rail = screen.getByTestId("sidebar-client-rail");
    const inbox = rail.getByRole("button", { name: /^Inbox/ });
    await expect.element(inbox).toHaveAccessibleName("Inbox, 4 waiting");
    const badge = rail.getByTestId("sidebar-inbox-badge");
    await expect.element(badge).toHaveTextContent("4");
    await expect.element(badge).toHaveClass("bg-warning");

    vi.mocked(useQuietThreadShells).mockReturnValue(waiting);
    await screen.rerender(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(inbox).toHaveAccessibleName("Inbox, 3 waiting");
    await expect.element(badge).toHaveClass("bg-error");

    vi.mocked(useQuietThreadShells).mockReturnValue([
      ...threads.slice(0, 2),
      threadShell(threads[2]!.projectId, 2),
      threads[3]!,
    ]);
    await screen.rerender(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(inbox).toHaveAccessibleName("Inbox");
    expect(badge.query()).toBeNull();
  });

  it("lists a folder's settled threads under a closed Settled row and out of the shelf", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack, { settled: true });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const vandelaySettled = screen.getByRole("button", { name: "Settled · 2", exact: true });
    await expect.element(vandelaySettled).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByText("Thread 10", { exact: true }).first())
      .not.toBeInTheDocument();
    // Umbrella has nothing but settled threads, and still shows while pinned.
    await expect
      .element(
        screen.getByTestId("sidebar-project-folder").getByRole("button", { name: /^Umbrella/ }),
      )
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Settled · 1", exact: true }))
      .toBeInTheDocument();
    // Settled threads light no dot and add to no count.
    expect(
      screen.getByTestId("sidebar-client-folder").getByRole("button").element().textContent,
    ).toBe("AEAcme, failed2");
    await expect
      .element(screen.getByTestId("sidebar-client-rail").getByRole("button", { name: /^Umbrella/ }))
      .toHaveAccessibleName("Umbrella");
    // Umbrella sorts before Vandelay: a hidden settled row would take jump 2.
    expect(await jumpLabelsByThreadId()).toEqual(
      new Map([
        ["thread-0", JUMP_1_LABEL],
        ["thread-3", JUMP_2_LABEL],
      ]),
    );
    // A closed folder's dot and count leave its settled threads out, even a failed one.
    const umbrellaHeader = screen
      .getByTestId("sidebar-project-folder")
      .getByRole("button", { name: /^Umbrella/ });
    await userEvent.click(umbrellaHeader);
    await expect.element(umbrellaHeader).toHaveAttribute("aria-expanded", "false");
    expect(umbrellaHeader.element().textContent).not.toMatch(/failed|\d/);
    await userEvent.click(umbrellaHeader);

    await userEvent.click(vandelaySettled);
    await expect.element(vandelaySettled).toHaveAttribute("aria-expanded", "true");
    const folderRows = (title: string) =>
      screen.getByTestId("sidebar-row-folder").filter({ hasText: title }).all();
    await expect
      .element(screen.getByText("Thread 11", { exact: true }).first())
      .toBeInTheDocument();
    expect(folderRows("Thread 11")).toHaveLength(1);
    expect(folderRows("Thread 10")).toHaveLength(1);
    // Most recently settled first, as on the shelf.
    expect(
      folderRows("Thread 1")
        .map((row) => row.element().textContent)
        .filter((text) => /Thread 1[01]/.test(text ?? "")),
    ).toEqual([expect.stringContaining("Thread 11"), expect.stringContaining("Thread 10")]);

    await act(() => vandelaySettled.element().focus());
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(vandelaySettled).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{ArrowLeft}");
    await expect
      .element(
        screen.getByTestId("sidebar-project-folder").getByRole("button", { name: /^Vandelay/ }),
      )
      .toHaveFocus();

    // Only the thread of no folder stays on the shelf.
    const shelf = screen.getByTestId("sidebar-settled-shelf-toggle");
    await expect.element(shelf).toBeInTheDocument();
    expect(shelf.element().textContent).toMatch(/1$/);
    await userEvent.click(shelf);
    await expect
      .element(screen.getByText("Thread 14", { exact: true }).first())
      .toBeInTheDocument();
    expect(screen.getByTestId("sidebar-row-slim").all()).toHaveLength(1);

    await act(() =>
      writeLocalStorageValue(CLIENT_FOLDERS_ENABLED_KEY, false, false, Schema.Boolean),
    );
    await expect.element(screen.getByTestId("sidebar-folder-settled")).not.toBeInTheDocument();
    // Pinned Umbrella keeps its empty folder, as any pinned project does.
    expect(screen.getByTestId("sidebar-project-folder").all()).toHaveLength(4);
    await vi.waitFor(() =>
      expect(screen.getByTestId("sidebar-settled-shelf-toggle").element().textContent).toMatch(
        /5$/,
      ),
    );
  });

  it("keeps a settled route thread visible and scopes Settled rows to the picked client", async () => {
    using stack = new DisposableStack();
    const { threads } = setupClientFolders(stack, { settled: true });
    const routeThread = threads.find((thread) => thread.id === "thread-10")!;
    const { useThreadActions: actualThreadActions } = await vi.importActual<
      typeof import("../hooks/useThreadActions")
    >("../hooks/useThreadActions");
    const unsettleThread = vi.fn().mockResolvedValue({ _tag: "Success" });
    vi.mocked(useThreadActions).mockImplementation(() => ({
      ...actualThreadActions(),
      unsettleThread,
    }));
    stack.defer(() => vi.mocked(useThreadActions).mockReset());
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: routeThread.environmentId, threadId: routeThread.id },
    });
    const routeReveal = { observedKey: null, pendingKey: null };
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    const vandelaySettled = screen.getByRole("button", { name: "Settled · 2", exact: true });
    await expect.element(vandelaySettled).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByText("Thread 10", { exact: true }).first())
      .toBeInTheDocument();
    expect(lastRowProps("thread-10")?.variantAction).toBe("unsettle");

    const rail = screen.getByTestId("sidebar-client-rail");
    await userEvent.click(rail.getByRole("button", { name: /^Vandelay/ }));
    await expect
      .element(screen.getByRole("button", { name: "Settled · 1", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(vandelaySettled).toBeInTheDocument();
    await expect.element(screen.getByTestId("sidebar-settled-header")).not.toBeInTheDocument();

    // Hover reveals the control; a direct click is what a hover then click sends.
    const unsettleButton = screen
      .getByTestId("sidebar-row-folder")
      .filter({ hasText: "Thread 10" })
      .getByRole("button", { name: "Un-settle thread" })
      .element() as HTMLElement;
    await act(() => unsettleButton.click());
    expect(unsettleThread).toHaveBeenCalledWith({
      environmentId: routeThread.environmentId,
      threadId: routeThread.id,
    });

    // Un-settling moves the thread back to its folder's active list.
    vi.mocked(useQuietThreadShells).mockReturnValue(
      threads.map((thread) =>
        thread.id === "thread-10" ? { ...thread, settledOverride: null, settledAt: null } : thread,
      ),
    );
    await screen.rerender(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    await expect
      .element(screen.getByRole("button", { name: "Settled · 1", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 10", { exact: true }).first())
      .toBeInTheDocument();
    expect(lastRowProps("thread-10")).toMatchObject({
      variantAction: "settle",
      navigationParent: expect.stringMatching(/^folder:/),
    });
  });

  it("hides an unpinned project with only settled threads, its history back on the shelf", async () => {
    using stack = new DisposableStack();
    const { app, infra, solo, umbrella, threads } = setupClientFolders(stack, {
      settled: true,
      umbrellaPinned: false,
    });
    const legacy = { ...project("acme-legacy"), title: "Acme · Legacy" };
    vi.mocked(useProjects).mockReturnValue([app, infra, solo, umbrella, legacy]);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      ...threads,
      settledShell(legacy.id, 15, "2026-03-06T10:00:00.000Z"),
    ]);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    await expect.element(rail.getByRole("button", { name: /^Acme/ })).toBeInTheDocument();
    // Inbox, All, Acme and Vandelay: Umbrella has nothing pinned and nothing active.
    expect(rail.getByRole("button").all()).toHaveLength(4);
    await expect.element(rail.getByRole("button", { name: /^Umbrella/ })).not.toBeInTheDocument();
    await expect
      .element(
        screen.getByTestId("sidebar-project-folder").getByRole("button", { name: /^Umbrella/ }),
      )
      .not.toBeInTheDocument();
    // Vandelay still has an active thread, so its folder keeps its Settled row.
    await expect
      .element(screen.getByRole("button", { name: "Settled · 2", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Settled · 1", exact: true }))
      .not.toBeInTheDocument();
    const shelf = screen.getByTestId("sidebar-settled-shelf-toggle");
    // Umbrella's, Legacy's and the projectless thread; Acme App's stays in its folder.
    await vi.waitFor(() => expect(shelf.element().textContent).toMatch(/(^|\D)3$/));

    // Inside the picked client, the hidden repository's thread stays on the shelf too.
    await userEvent.click(rail.getByRole("button", { name: /^Acme/ }));
    await expect.element(screen.getByRole("button", { name: /^App/ })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^Infra/ })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /^Legacy/ })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(shelf.element().textContent).toMatch(/(^|\D)1$/));
    // The shelf's open state is stored, so an earlier test may have left it open.
    if (shelf.element().getAttribute("aria-expanded") !== "true") await userEvent.click(shelf);
    await expect
      .element(screen.getByText("Thread 15", { exact: true }).first())
      .toBeInTheDocument();

    // Without client folders the sidebar is as before.
    await act(() =>
      writeLocalStorageValue(CLIENT_FOLDERS_ENABLED_KEY, false, false, Schema.Boolean),
    );
    await expect.element(rail).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-project-folder").all()).toHaveLength(3);
    await vi.waitFor(() =>
      expect(screen.getByTestId("sidebar-settled-shelf-toggle").element().textContent).toMatch(
        /(^|\D)6$/,
      ),
    );
  });

  it("shows an unpinned project in the rail and the tree while it has an active thread", async () => {
    using stack = new DisposableStack();
    const { umbrella, threads } = setupClientFolders(stack, {
      settled: true,
      umbrellaPinned: false,
    });
    vi.mocked(useQuietThreadShells).mockReturnValue([...threads, threadShell(umbrella.id, 16)]);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect
      .element(screen.getByTestId("sidebar-client-rail").getByRole("button", { name: /^Umbrella/ }))
      .toBeInTheDocument();
    await expect
      .element(
        screen.getByTestId("sidebar-project-folder").getByRole("button", { name: /^Umbrella/ }),
      )
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 16", { exact: true }).first())
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Settled · 1", exact: true }))
      .toBeInTheDocument();
  });

  it("drops an unpinned client from the rail live, falling back to All for good", async () => {
    using stack = new DisposableStack();
    const { app, infra, solo, umbrella, threads } = setupClientFolders(stack, { settled: true });
    const routeReveal = { observedKey: null, pendingKey: null };
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    const umbrellaEntry = rail.getByRole("button", { name: /^Umbrella/ });
    const all = rail.getByRole("button", { name: "All", exact: true });
    const umbrellaFolder = screen
      .getByTestId("sidebar-project-folder")
      .getByRole("button", { name: /^Umbrella/ });
    await userEvent.click(umbrellaEntry);
    await expect.element(umbrellaEntry).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByText("Thread 3", { exact: true }).first())
      .not.toBeInTheDocument();

    const rerenderWith = async (
      pinnedAt: string | null,
      extraThreads: readonly EnvironmentThreadShell[] = [],
    ) => {
      vi.mocked(useProjects).mockReturnValue([app, infra, solo, { ...umbrella, pinnedAt }]);
      vi.mocked(useQuietThreadShells).mockReturnValue([...threads, ...extraThreads]);
      await screen.rerender(
        <SidebarProvider>
          <Sidebar routeReveal={routeReveal} />
        </SidebarProvider>,
      );
    };
    await rerenderWith(null);
    await expect.element(umbrellaEntry).not.toBeInTheDocument();
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();
    await expect.element(umbrellaFolder).not.toBeInTheDocument();

    // Pinned back, it returns in its place without taking the view back.
    await rerenderWith("2026-01-03T00:00:00.000Z");
    await expect.element(umbrellaEntry).toBeInTheDocument();
    await expect.element(umbrellaFolder).toBeInTheDocument();
    await expect.element(umbrellaEntry).toHaveAttribute("aria-pressed", "false");
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();

    // An active thread brings it back too, and the view stays on All.
    await userEvent.click(umbrellaEntry);
    await expect.element(umbrellaEntry).toHaveAttribute("aria-pressed", "true");
    await rerenderWith(null);
    await expect.element(umbrellaEntry).not.toBeInTheDocument();
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await rerenderWith(null, [threadShell(umbrella.id, 16)]);
    await expect.element(umbrellaEntry).toBeInTheDocument();
    await expect.element(umbrellaEntry).toHaveAttribute("aria-pressed", "false");
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();
  });

  it("follows an unpinned client's threads as they settle, snooze and wake", async () => {
    using stack = new DisposableStack();
    const { umbrella, threads } = setupClientFolders(stack, {
      settled: true,
      umbrellaPinned: false,
    });
    const routeReveal = { observedKey: null, pendingKey: null };
    const rerenderWith = async (umbrellaThread: EnvironmentThreadShell) => {
      vi.mocked(useQuietThreadShells).mockReturnValue([...threads, umbrellaThread]);
      await screen.rerender(
        <SidebarProvider>
          <Sidebar routeReveal={routeReveal} />
        </SidebarProvider>,
      );
    };
    const active = threadShell(umbrella.id, 16);
    vi.mocked(useQuietThreadShells).mockReturnValue([...threads, active]);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    const umbrellaEntry = rail.getByRole("button", { name: /^Umbrella/ });
    const all = rail.getByRole("button", { name: "All", exact: true });
    const umbrellaFolder = screen
      .getByTestId("sidebar-project-folder")
      .getByRole("button", { name: /^Umbrella/ });
    await userEvent.click(umbrellaEntry);
    await expect.element(umbrellaEntry).toHaveAttribute("aria-pressed", "true");

    // Settled, its last active thread takes the client out of the rail; the view falls back.
    await rerenderWith({
      ...active,
      settledOverride: "settled",
      settledAt: "2026-03-07T10:00:00.000Z",
    });
    await expect.element(umbrellaEntry).not.toBeInTheDocument();
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await expect.element(umbrellaFolder).not.toBeInTheDocument();
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();

    // Snoozed is parked too.
    await rerenderWith({ ...active, snoozedUntil: "2099-01-01T00:00:00.000Z" });
    await expect.element(umbrellaEntry).not.toBeInTheDocument();
    await expect.element(umbrellaFolder).not.toBeInTheDocument();

    // Active again, it returns without taking the view back.
    await rerenderWith(active);
    await expect.element(umbrellaEntry).toBeInTheDocument();
    await expect.element(umbrellaFolder).toBeInTheDocument();
    await expect.element(umbrellaEntry).toHaveAttribute("aria-pressed", "false");
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
  });

  it("drops a vanished client's projects from the filter when the rail falls back to All", async () => {
    using stack = new DisposableStack();
    const { app, infra, solo, umbrella } = setupClientFolders(stack, { settled: true });
    const routeReveal = { observedKey: null, pendingKey: null };
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    await userEvent.click(rail.getByRole("button", { name: /^Umbrella/ }));
    await act(() =>
      useUiStateStore.setState({ sidebarProjectScopeKeys: [derivePhysicalProjectKey(umbrella)] }),
    );
    await expect
      .element(screen.getByText("Thread 3", { exact: true }).first())
      .not.toBeInTheDocument();

    vi.mocked(useProjects).mockReturnValue([app, infra, solo, { ...umbrella, pinnedAt: null }]);
    await screen.rerender(
      <SidebarProvider>
        <Sidebar routeReveal={routeReveal} />
      </SidebarProvider>,
    );
    await expect
      .element(rail.getByRole("button", { name: "All", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([]);
    await expect.element(screen.getByText("Thread 3", { exact: true }).first()).toBeInTheDocument();
    await expect
      .element(
        screen.getByTestId("sidebar-project-folder").getByRole("button", { name: /^Umbrella/ }),
      )
      .not.toBeInTheDocument();
  });

  it("keeps All in the rail while no project is pinned or active", async () => {
    using stack = new DisposableStack();
    const { threads } = setupClientFolders(stack, { settled: true, umbrellaPinned: false });
    vi.mocked(useQuietThreadShells).mockReturnValue(
      threads.filter((thread) => thread.settledOverride === "settled"),
    );
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    await expect.element(rail).toBeInTheDocument();
    await expect
      .element(rail.getByRole("button", { name: "All", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    expect(rail.getByRole("button").all()).toHaveLength(2);
    expect(screen.getByTestId("sidebar-project-folder").all()).toHaveLength(0);
  });

  it("shows the folder of an unpinned project whose only live thread is pinned", async () => {
    using stack = new DisposableStack();
    const { umbrella, threads } = setupClientFolders(stack, {
      settled: true,
      umbrellaPinned: false,
    });
    vi.mocked(useQuietThreadShells).mockReturnValue([
      ...threads.filter((thread) => thread.projectId !== umbrella.id),
      { ...threadShell(umbrella.id, 16), pinnedAt: "2026-03-08T10:00:00.000Z" },
    ]);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const rail = screen.getByTestId("sidebar-client-rail");
    const umbrellaFolder = screen
      .getByTestId("sidebar-project-folder")
      .getByRole("button", { name: /^Umbrella/ });
    await expect.element(rail.getByRole("button", { name: /^Umbrella/ })).toBeInTheDocument();
    await expect.element(umbrellaFolder).toBeInTheDocument();
    await userEvent.click(rail.getByRole("button", { name: /^Umbrella/ }));
    await expect.element(umbrellaFolder).toBeInTheDocument();
  });

  it("pages a folder's long settled list like the shelf", async () => {
    using stack = new DisposableStack();
    const { solo, threads } = setupClientFolders(stack, { settled: true });
    const many = Array.from({ length: 12 }, (_, index) =>
      settledShell(
        solo.id,
        20 + index,
        `2026-04-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      ),
    );
    vi.mocked(useQuietThreadShells).mockReturnValue([
      ...threads.filter(
        (thread) => thread.projectId !== solo.id || thread.settledOverride === null,
      ),
      ...many,
    ]);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const vandelaySettled = screen.getByRole("button", { name: "Settled · 12", exact: true });
    await userEvent.click(vandelaySettled);
    await expect
      .element(screen.getByText("Thread 31", { exact: true }).first())
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread 21", { exact: true }).first())
      .not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "Show 2 more", exact: true });
    await userEvent.click(more);
    await expect
      .element(screen.getByText("Thread 20", { exact: true }).first())
      .toBeInTheDocument();
    await expect.element(more).not.toBeInTheDocument();

    // A new scope starts the page over, as the shelf does.
    await userEvent.click(
      screen.getByTestId("sidebar-client-rail").getByRole("button", { name: /^Vandelay/ }),
    );
    await expect
      .element(screen.getByText("Thread 20", { exact: true }).first())
      .not.toBeInTheDocument();
    await expect.element(more).toBeInTheDocument();
  });

  // regression: #35522 a folder's pager dropped focus while its next page loaded
  it("keeps a folder's settled pager focused while its next page loads", async () => {
    using stack = new DisposableStack();
    const { solo, threads } = setupClientFolders(stack, { settled: true });
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const many = Array.from({ length: 40 }, (_, index) =>
      settledShell(solo.id, 20 + index, `2026-04-01T10:${String(index).padStart(2, "0")}:00.000Z`),
    );
    vi.mocked(useQuietThreadShells).mockReturnValue([
      ...threads.filter(
        (thread) => thread.projectId !== solo.id || thread.settledOverride === null,
      ),
      ...many,
    ]);
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Settled · 40", exact: true }));
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    moreButton.focus();
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    const listedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(listedRows);
  });
});

function pointer(type: string, x: number, y: number) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

function centreOf(element: Element) {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** Drags `source` onto `target`, checks the drop line shows, then releases. */
async function dragOnto(
  source: Element,
  target: Element,
  options: { readonly beforeRelease?: (point: { x: number; y: number }) => Promise<void> } = {},
) {
  const from = centreOf(source);
  const to = centreOf(target);
  let at = from;
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", at.x, at.y)),
  };
  await act(() => {
    source.dispatchEvent(pointer("pointerdown", from.x, from.y));
    document.dispatchEvent(pointer("pointermove", from.x, from.y + 10));
  });
  await act(() => {
    document.dispatchEvent(pointer("pointermove", to.x, to.y));
  });
  at = to;
  await expect.element(page.getByTestId("sidebar-order-drop-line")).toBeInTheDocument();
  if (options.beforeRelease) await options.beforeRelease(to);
}

// Inbox and All carry no order id: neither moves, and both read by their place.
const railOrderIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="sidebar-client-rail"] li')].map(
    (item) =>
      item.dataset.sidebarOrderId ??
      (item.querySelector("[data-rail-entry]")?.getAttribute("data-rail-entry") || "all"),
  );
const treeOrderIds = (level: string) =>
  [...document.querySelectorAll<HTMLElement>(`button[data-sidebar-order-level="${level}"]`)].map(
    (button) => button.dataset.sidebarOrderId,
  );

const renderSidebar = () =>
  render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );

describe("boring sidebar client folder order", () => {
  it("reorders rail entries by drag, keeping All first and the tree in step", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack, { withProjectGroup: true });
    await using screen = await renderSidebar();
    const rail = screen.getByTestId("sidebar-client-rail");
    const railButton = (name: RegExp) => rail.getByRole("button", { name });
    await expect.element(railButton(/^Vandelay/)).toBeInTheDocument();
    const [, , acmeId, northwindId, vandelayId] = railOrderIds();
    expect(treeOrderIds("rail")).toEqual([acmeId, northwindId, vandelayId]);

    await dragOnto(railButton(/^Vandelay/).element(), railButton(/^Acme/).element());
    await vi.waitFor(() =>
      expect(railOrderIds()).toEqual(["inbox", "all", vandelayId, acmeId, northwindId]),
    );
    await expect.element(railButton(/^All/)).toHaveAttribute("aria-pressed", "true");
    expect(treeOrderIds("rail")).toEqual([vandelayId, acmeId, northwindId]);

    // Neither "Inbox" nor "All" is a drag source.
    using _release = {
      [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", 0, 0)),
    };
    const acme = centreOf(railButton(/^Acme/).element());
    for (const fixed of [/^Inbox/, /^All/]) {
      const from = centreOf(railButton(fixed).element());
      await act(() => {
        railButton(fixed)
          .element()
          .dispatchEvent(pointer("pointerdown", from.x, from.y));
        document.dispatchEvent(pointer("pointermove", from.x, from.y + 10));
        document.dispatchEvent(pointer("pointermove", acme.x, acme.y));
      });
      await expect.element(page.getByTestId("sidebar-order-drop-line")).not.toBeInTheDocument();
      await act(() => document.dispatchEvent(pointer("pointerup", acme.x, acme.y)));
    }
    expect(railOrderIds()).toEqual(["inbox", "all", vandelayId, acmeId, northwindId]);
  });

  it("reorders repositories within their client only, without a composer ghost", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack, { withProjectGroup: true });
    await using screen = await renderSidebar();
    const acme = screen.getByTestId("sidebar-client-folder").filter({ hasText: "Acme" });
    await expect.element(acme.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(acme.getByRole("button"));
    await expect.element(acme.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    const app = screen.getByRole("button", { name: /^App/ });
    const infra = screen.getByRole("button", { name: /^Infra/ });
    await expect.element(infra).toBeInTheDocument();
    const [appId, infraId] = treeOrderIds("client:Acme");

    const listBounds = acme.element().closest("ul")!.getBoundingClientRect();
    await dragOnto(infra.element(), app.element(), {
      beforeRelease: async (point) => {
        await act(() =>
          document.dispatchEvent(pointer("pointermove", listBounds.right + 40, point.y)),
        );
        expect(
          document.querySelector('body > div[aria-hidden="true"].pointer-events-none'),
        ).toBeNull();
        await act(() => document.dispatchEvent(pointer("pointermove", point.x, point.y)));
      },
    });
    await vi.waitFor(() => expect(treeOrderIds("client:Acme")).toEqual([infraId, appId]));
    expect((await jumpLabelsByThreadId()).get(ThreadId.make("thread-2"))).toBe(JUMP_1_LABEL);

    // A repository never moves out of its client.
    const vandelay = screen.getByTestId("sidebar-project-folder").filter({ hasText: "Vandelay" });
    {
      const from = centreOf(infra.element());
      const to = centreOf(vandelay.getByRole("button").first().element());
      await act(() => {
        infra.element().dispatchEvent(pointer("pointerdown", from.x, from.y));
        document.dispatchEvent(pointer("pointermove", from.x, from.y + 10));
      });
      await act(() => document.dispatchEvent(pointer("pointermove", to.x, to.y)));
      // The drag is live, yet Vandelay offers no place to land.
      await expect
        .element(screen.getByTestId("sidebar-project-folder").filter({ hasText: "Infra" }))
        .toHaveClass("opacity-50");
      await expect.element(page.getByTestId("sidebar-order-drop-line")).not.toBeInTheDocument();
      await act(() => document.dispatchEvent(pointer("pointerup", to.x, to.y)));
    }
    expect(treeOrderIds("client:Acme")).toEqual([infraId, appId]);
    expect(readOrder()["rail"]).toBeUndefined();
  });

  it("moves the focused header or rail entry one step with Alt+Arrow", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack, { withProjectGroup: true });
    await using screen = await renderSidebar();
    const rail = screen.getByTestId("sidebar-client-rail");
    await expect.element(rail.getByRole("button", { name: /^Vandelay/ })).toBeInTheDocument();
    const [, , acmeId, northwindId, vandelayId] = railOrderIds();
    const acme = screen
      .getByTestId("sidebar-client-folder")
      .filter({ hasText: "Acme" })
      .getByRole("button");

    await act(() => acme.element().focus());
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await vi.waitFor(() => expect(treeOrderIds("rail")).toEqual([northwindId, acmeId, vandelayId]));
    await expect.element(acme).toHaveFocus();
    expect(railOrderIds()).toEqual(["inbox", "all", northwindId, acmeId, vandelayId]);

    const railAcme = rail.getByRole("button", { name: /^Acme/ });
    await act(() => railAcme.element().focus());
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await vi.waitFor(() =>
      expect(railOrderIds()).toEqual(["inbox", "all", northwindId, vandelayId, acmeId]),
    );
    await expect.element(railAcme).toHaveFocus();

    const railNorthwind = rail.getByRole("button", { name: /^Northwind/ });
    await act(() => railNorthwind.element().focus());
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(railOrderIds()).toEqual(["inbox", "all", northwindId, vandelayId, acmeId]);
    await expect.element(railNorthwind).toHaveFocus();

    const railInbox = rail.getByRole("button", { name: /^Inbox/ });
    await act(() => railInbox.element().focus());
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(railOrderIds()).toEqual(["inbox", "all", northwindId, vandelayId, acmeId]);
    await expect.element(railInbox).toHaveFocus();

    // A repository steps within its client.
    await userEvent.click(acme);
    await expect.element(acme).toHaveAttribute("aria-expanded", "true");
    const infra = screen.getByRole("button", { name: /^Infra/ });
    await expect.element(infra).toBeInTheDocument();
    const [appId, infraId] = treeOrderIds("client:Acme");
    await act(() => infra.element().focus());
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await vi.waitFor(() => expect(treeOrderIds("client:Acme")).toEqual([infraId, appId]));
    await expect.element(infra).toHaveFocus();
    expect(railOrderIds()).toEqual(["inbox", "all", northwindId, vandelayId, acmeId]);
  });

  it("drops a client over an open sibling's folders as after that sibling", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack, { withProjectGroup: true });
    await using screen = await renderSidebar();
    const header = (name: string) =>
      screen.getByTestId("sidebar-client-folder").filter({ hasText: name }).getByRole("button");
    const northwind = header("Northwind");
    await expect.element(northwind).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(northwind);
    await expect.element(northwind).toHaveAttribute("aria-expanded", "true");
    const atlas = header("Atlas");
    await expect.element(atlas).toBeInTheDocument();
    const [acmeId, northwindId, vandelayId] = treeOrderIds("rail");

    await dragOnto(header("Acme").element(), atlas.element());
    await vi.waitFor(() => expect(treeOrderIds("rail")).toEqual([northwindId, acmeId, vandelayId]));
    expect(railOrderIds()).toEqual(["inbox", "all", northwindId, acmeId, vandelayId]);
  });

  it("resets the order from the rail's context menu", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack, { withProjectGroup: true });
    setLocalStorageItem(
      CLIENT_FOLDER_ORDER_KEY,
      { rail: ["client:Northwind", "client:Acme"] },
      SidebarClientFolderOrder,
    );
    await using screen = await renderSidebar();
    const rail = screen.getByTestId("sidebar-client-rail");
    await expect.element(rail.getByRole("button", { name: /^Vandelay/ })).toBeInTheDocument();
    expect(railOrderIds().slice(2, 4)).toEqual(["client:Northwind", "client:Acme"]);

    await userEvent.click(rail.getByRole("button", { name: /^All/ }), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Reset order" }));
    await vi.waitFor(() =>
      expect(railOrderIds().slice(2, 4)).toEqual(["client:Acme", "client:Northwind"]),
    );
    expect(readOrder()).toEqual({});
  });

  it("keeps the order across a remount", async () => {
    using stack = new DisposableStack();
    setupClientFolders(stack, { withProjectGroup: true });
    {
      await using screen = await renderSidebar();
      const rail = screen.getByTestId("sidebar-client-rail");
      await expect.element(rail.getByRole("button", { name: /^Vandelay/ })).toBeInTheDocument();
      await dragOnto(
        rail.getByRole("button", { name: /^Northwind/ }).element(),
        rail.getByRole("button", { name: /^Acme/ }).element(),
      );
      await vi.waitFor(() =>
        expect(railOrderIds().slice(2, 4)).toEqual(["client:Northwind", "client:Acme"]),
      );
    }

    await using screen = await renderSidebar();
    await expect
      .element(screen.getByTestId("sidebar-client-rail").getByRole("button", { name: /^Vandelay/ }))
      .toBeInTheDocument();
    expect(railOrderIds().slice(2, 4)).toEqual(["client:Northwind", "client:Acme"]);
    expect(treeOrderIds("rail").slice(0, 2)).toEqual(["client:Northwind", "client:Acme"]);
  });

  it("leaves the sidebar unchanged while client folders are off", async () => {
    using stack = new DisposableStack();
    const { solo } = setupClientFolders(stack);
    setLocalStorageItem(CLIENT_FOLDERS_ENABLED_KEY, false, Schema.Boolean);
    setLocalStorageItem(CLIENT_RAIL_SELECTED_KEY, SIDEBAR_INBOX_ID, Schema.NullOr(Schema.String));
    // Vandelay first, by its real id: a leak of the stored order would reorder the folders.
    setLocalStorageItem(
      CLIENT_FOLDER_ORDER_KEY,
      { rail: [sidebarRepositoryOrderId(derivePhysicalProjectKey(solo)), "client:Acme"] },
      SidebarClientFolderOrder,
    );
    await using screen = await renderSidebar();
    const folders = screen.getByTestId("sidebar-project-folder");
    await expect.element(folders.first()).toBeInTheDocument();
    expect(folders.all().map((item) => item.element().textContent?.split(/\d/)[0])).toEqual([
      expect.stringContaining("Acme · App"),
      expect.stringContaining("Acme · Infra"),
      expect.stringContaining("Vandelay"),
    ]);
    expect(screen.getByTestId("sidebar-client-rail").query()).toBeNull();
    expect(document.querySelector("button[data-sidebar-order-level]")).toBeNull();
  });
});

function readOrder(): Record<string, readonly string[]> {
  const raw = localStorage.getItem(CLIENT_FOLDER_ORDER_KEY);
  return raw === null ? {} : JSON.parse(raw);
}
