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
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig, isMacPlatform } from "@t3tools/shared/keybindings";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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
import { CLIENT_FOLDERS_ENABLED_KEY, CLIENT_RAIL_SELECTED_KEY } from "./sidebar/clientFolders";
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

function setupClientFolders(stack: DisposableStack, options: { withProjectGroup?: boolean } = {}) {
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
  setLocalStorageItem(CLIENT_FOLDERS_ENABLED_KEY, true, Schema.Boolean);
  // Earlier tests leave the settled shelf open and the local API's context menu stubbed.
  removeLocalStorageItem("t3code:sidebar:settled-expanded");
  vi.mocked(readLocalApi).mockReset();
  const app = { ...project("acme-app"), title: "Acme · App" };
  const infra = { ...project("acme-infra"), title: "Acme · Infra" };
  // Sorts after Acme, so only the closed client's wiring gives its thread a jump.
  const solo = { ...project("zenith"), title: "Zenith" };
  const web = { ...project("atlas-web"), title: "Northwind · Atlas · Web" };
  const site = { ...project("atlas-site"), title: "Northwind · Atlas · Site" };
  const nested = options.withProjectGroup === true;
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
  ];
  const routeThreadRef: ScopedThreadRef = {
    environmentId: app.environmentId,
    threadId: threads[0]!.id,
  };
  vi.mocked(useProjects).mockReturnValue(
    nested ? [app, infra, solo, web, site] : [app, infra, solo],
  );
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
  return { app, solo, threads, startThread };
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
    expect(railButtons.all()).toHaveLength(4);
    // Thread 2's failure shows on Acme whatever the rail scopes the list to.
    for (const [index, name] of ["All", "Acme, failed", "Northwind", "Zenith"].entries()) {
      await expect.element(railButtons.nth(index)).toHaveAccessibleName(name);
    }
    await expect.element(railButtons.first()).toHaveAttribute("aria-pressed", "true");
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
    await userEvent.click(rail.getByRole("button", { name: /^Zenith/ }));
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
      const zenith = screen
        .getByTestId("sidebar-client-rail")
        .getByRole("button", { name: /^Zenith/ });
      await userEvent.click(zenith);
      await expect.element(zenith).toHaveAttribute("aria-pressed", "true");
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
      .element(rail.getByRole("button", { name: /^Zenith/ }))
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

    await userEvent.click(rail.getByRole("button", { name: /^Zenith/ }));
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([]);
    await expect
      .element(screen.getByLabelText("Filter Zenith threads by project", { exact: true }))
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
      "0",
      "-1",
      "-1",
    ]);
    await act(() => (buttons.first().element() as HTMLElement).focus());
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(buttons.nth(1)).toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect.element(buttons.nth(2)).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(buttons.nth(1)).toHaveFocus();
  });
});
