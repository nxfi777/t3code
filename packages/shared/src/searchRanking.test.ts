import { describe, expect, it } from "vite-plus/test";

import {
  insertRankedSearchResult,
  normalizeProjectPathSearchQuery,
  normalizeSearchQuery,
  scoreQueryMatch,
  scoreSubsequenceMatch,
} from "./searchRanking.ts";

describe("normalizeSearchQuery", () => {
  it("trims and lowercases queries", () => {
    expect(normalizeSearchQuery("  UI  ")).toBe("ui");
  });

  it("can strip leading trigger characters", () => {
    expect(normalizeSearchQuery("  $ui", { trimLeadingPattern: /^\$+/ })).toBe("ui");
  });
});

describe("normalizeProjectPathSearchQuery", () => {
  it.each([
    [".gitignore", ".gitignore"],
    ["@./.GitHub/Workflows", ".github/workflows"],
    ["./src/../.gitignore", ".gitignore"],
    ["src/../../other/README.md", "../other/readme.md"],
    ["../other/README.md", "../other/readme.md"],
    ["  @/src/ChatComposer.tsx  ", "/src/chatcomposer.tsx"],
  ])("preserves meaningful path characters in %s", (query, expected) => {
    expect(normalizeProjectPathSearchQuery(query, "/workspace/project")).toBe(expected);
  });

  it.each([
    ["/workspace/project/src/File.ts", "/workspace/project", "src/file.ts"],
    ["/src/File.ts", "/", "src/file.ts"],
    ["c:\\src\\File.ts", "C:\\", "src/file.ts"],
    ["/workspace/Project/src/File.ts", "/workspace/project", "/workspace/project/src/file.ts"],
    [
      "/workspace/project-other/src/File.ts",
      "/workspace/project",
      "/workspace/project-other/src/file.ts",
    ],
    ["C:\\Projects\\App\\src\\File.ts", "C:\\Projects\\App\\", "src/file.ts"],
    ["\\\\server\\share\\app\\.gitignore", "\\\\server\\share\\app", ".gitignore"],
  ])("relativizes only a matching workspace prefix: %s", (query, cwd, expected) => {
    expect(normalizeProjectPathSearchQuery(query, cwd)).toBe(expected);
  });
});

describe("scoreQueryMatch", () => {
  it("prefers exact matches over broader contains matches", () => {
    expect(
      scoreQueryMatch({
        value: "ui",
        query: "ui",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
      }),
    ).toBe(0);

    expect(
      scoreQueryMatch({
        value: "building native ui",
        query: "ui",
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 20,
        includesBase: 30,
      }),
    ).toBeGreaterThan(0);
  });

  it("treats boundary matches as stronger than generic contains matches", () => {
    const boundaryScore = scoreQueryMatch({
      value: "gh-fix-ci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });
    const containsScore = scoreQueryMatch({
      value: "highfixci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });

    expect(boundaryScore).not.toBeNull();
    expect(containsScore).not.toBeNull();
    expect(boundaryScore!).toBeLessThan(containsScore!);
  });
});

describe("scoreSubsequenceMatch", () => {
  it("scores tighter subsequences ahead of looser ones", () => {
    const compact = scoreSubsequenceMatch("ghfixci", "gfc");
    const spread = scoreSubsequenceMatch("github-fix-ci", "gfc");

    expect(compact).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(compact!).toBeLessThan(spread!);
  });
});

describe("insertRankedSearchResult", () => {
  it("keeps the best-ranked candidates within the limit", () => {
    const ranked = [
      { item: "b", score: 20, tieBreaker: "b" },
      { item: "d", score: 40, tieBreaker: "d" },
    ];

    insertRankedSearchResult(ranked, { item: "a", score: 10, tieBreaker: "a" }, 2);
    insertRankedSearchResult(ranked, { item: "c", score: 30, tieBreaker: "c" }, 2);

    expect(ranked.map((entry) => entry.item)).toEqual(["a", "b"]);
  });
});
