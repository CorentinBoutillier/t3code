import { describe, expect, it } from "vite-plus/test";

import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
  THREAD_SIDEBAR_CLIENT_RAIL_WIDTH,
} from "./threadSidebarWidth";

function renderedWidth(sidebarWidth: number, viewportWidth: number): number {
  const minimumWidth = resolveThreadSidebarMinimumWidth(0);
  return clampThreadSidebarWidth(
    sidebarWidth,
    minimumWidth,
    resolveThreadSidebarMaximumWidth(viewportWidth, minimumWidth),
  );
}

describe("thread sidebar width", () => {
  it("restores the stored width when the viewport widens after a narrow startup", () => {
    const sidebarWidth = resolveInitialThreadSidebarWidth(350);
    expect(renderedWidth(sidebarWidth, 840)).toBe(208);
    expect(renderedWidth(sidebarWidth, 1638)).toBe(350);
  });

  it("restores the default width when the viewport widens after a narrow startup", () => {
    const sidebarWidth = resolveInitialThreadSidebarWidth(null);
    expect(renderedWidth(sidebarWidth, 840)).toBe(208);
    expect(renderedWidth(sidebarWidth, 1638)).toBe(256);
  });
});

describe("resolveThreadSidebarMinimumWidth", () => {
  it("adds the client rail's column so the list keeps its own minimum", () => {
    expect(resolveThreadSidebarMinimumWidth(0)).toBe(208);
    expect(resolveThreadSidebarMinimumWidth(0, THREAD_SIDEBAR_CLIENT_RAIL_WIDTH)).toBe(272);
    expect(resolveThreadSidebarMinimumWidth(300, THREAD_SIDEBAR_CLIENT_RAIL_WIDTH)).toBe(300);
  });
});
