import { describe, expect, it } from "vite-plus/test";

import {
  moveSidebarOrderEntry,
  normalizeSidebarClientFolderOrder,
  pruneSidebarOrderLevels,
  resolveSidebarOrderDrop,
  stepSidebarOrderDrop,
} from "./clientFolderOrder";

const siblings = ["acme", "globex", "initech"];

describe("resolveSidebarOrderDrop", () => {
  it("lands after a later sibling, before an earlier one, and nowhere otherwise", () => {
    expect(
      [
        { activeId: "acme", overId: "initech" },
        { activeId: "initech", overId: "globex" },
        { activeId: "globex", overId: "globex" },
        { activeId: "globex", overId: "hooli" },
        { activeId: "hooli", overId: "globex" },
      ].map((input) => resolveSidebarOrderDrop({ siblings, ...input })),
    ).toEqual([
      { targetId: "initech", position: "after" },
      { targetId: "globex", position: "before" },
      null,
      null,
      null,
    ]);
  });
});

describe("stepSidebarOrderDrop", () => {
  it("steps one place within the level and stops at either end", () => {
    expect(
      [
        { activeId: "globex", direction: -1 as const },
        { activeId: "globex", direction: 1 as const },
        { activeId: "acme", direction: -1 as const },
        { activeId: "initech", direction: 1 as const },
        { activeId: "hooli", direction: 1 as const },
      ].map((input) => stepSidebarOrderDrop({ siblings, ...input })),
    ).toEqual([
      { targetId: "acme", position: "before" },
      { targetId: "initech", position: "after" },
      null,
      null,
      null,
    ]);
  });
});

describe("moveSidebarOrderEntry", () => {
  const other = ["x", "y"];
  const order = { other };

  it("writes the whole level on the first move and leaves other levels untouched", () => {
    const next = moveSidebarOrderEntry({
      order,
      level: "rail",
      present: siblings,
      activeId: "initech",
      drop: { targetId: "acme", position: "before" },
    });
    expect(next).toEqual({ other, rail: ["initech", "acme", "globex"] });
    expect(next.other).toBe(other);
  });

  it("places the entry before or after its target", () => {
    const move = (position: "before" | "after") =>
      moveSidebarOrderEntry({
        order,
        level: "rail",
        present: siblings,
        activeId: "acme",
        drop: { targetId: "globex", position },
      }).rail;
    expect(move("before")).toEqual(["acme", "globex", "initech"]);
    expect(move("after")).toEqual(["globex", "acme", "initech"]);
  });

  it("drops stale and repeated stored ids and appends present ids the stored list lacks", () => {
    expect(
      moveSidebarOrderEntry({
        order: { rail: ["initech", "gone", "acme", "initech"] },
        level: "rail",
        present: siblings,
        activeId: "globex",
        drop: { targetId: "initech", position: "before" },
      }).rail,
    ).toEqual(["globex", "initech", "acme"]);
  });

  it("returns the same order for an unknown entry or target, or a drop on itself", () => {
    const move = (activeId: string, targetId: string) =>
      moveSidebarOrderEntry({
        order,
        level: "rail",
        present: siblings,
        activeId,
        drop: { targetId, position: "after" },
      });
    expect(move("hooli", "acme")).toBe(order);
    expect(move("acme", "hooli")).toBe(order);
    expect(move("acme", "acme")).toBe(order);
  });
});

describe("normalizeSidebarClientFolderOrder", () => {
  it("keeps the good levels when another is corrupt, and each id once", () => {
    expect(
      normalizeSidebarClientFolderOrder({
        rail: ["client:Acme", "client:Globex", "client:Acme"],
        x: 5,
        "client:Acme": [1, "project:umbrella", null],
        "client:Globex": [],
      }),
    ).toEqual({ rail: ["client:Acme", "client:Globex"], "client:Acme": ["project:umbrella"] });
  });
});

describe("pruneSidebarOrderLevels", () => {
  it("drops the levels of clients that are gone, and keeps the order when none is", () => {
    const levels = new Map([
      ["rail", ["client:Acme"]],
      ["client:Acme", ["project:a"]],
    ]);
    const order = { rail: ["client:Acme"], "client:Acme": ["project:a"] };
    expect(pruneSidebarOrderLevels(order, levels)).toBe(order);
    expect(pruneSidebarOrderLevels({ ...order, "client:Hooli": ["project:h"] }, levels)).toEqual(
      order,
    );
  });
});
