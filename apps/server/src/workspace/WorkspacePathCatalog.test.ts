// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { VcsProcessSpawnError } from "@t3tools/contracts";
import type { VcsProcess, VcsProcessOutput } from "../vcs/VcsProcess.ts";
import * as WorkspacePathCatalog from "./WorkspacePathCatalog.ts";

function output(stdout: string, truncated = false): VcsProcessOutput {
  return {
    stdout,
    stderr: "",
    exitCode: 0 as VcsProcessOutput["exitCode"],
    stdoutTruncated: truncated,
    stderrTruncated: false,
  };
}

it.effect(
  "enumerates documents and PDF-only ancestors without content search or shell expansion",
  () =>
    Effect.gen(function* () {
      const run = vi.fn<VcsProcess["Service"]["run"]>(() =>
        Effect.succeed(
          output(
            "GraceMouzannar.pdf\0nested/only-pdfs/quote.pdf\0images/portrait.png\0node_modules/pkg/hidden.pdf\0../outside.pdf\0",
          ),
        ),
      );
      const result = yield* WorkspacePathCatalog.scan("/workspace/project", run);
      expect(result.entries).toContainEqual({ path: "GraceMouzannar.pdf", kind: "file" });
      expect(result.entries).toContainEqual({ path: "nested/only-pdfs", kind: "directory" });
      expect(result.entries).toContainEqual({ path: "images/portrait.png", kind: "file" });
      expect(
        result.entries.some(
          (entry) => entry.path.includes("node_modules") || entry.path.includes(".."),
        ),
      ).toBe(false);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        command: "rg",
        args: expect.arrayContaining(["--files", "--hidden", "--null", "--no-require-git"]),
        maxOutputBytes: 8 * 1024 * 1024,
        timeoutMs: 5_000,
      });
    }),
);

it.effect(
  "bounds retained paths and reports incomplete output without admitting a partial filename",
  () =>
    Effect.gen(function* () {
      const paths =
        Array.from(
          { length: WorkspacePathCatalog.MAX_ENTRIES + 1 },
          (_, index) => `doc-${index}.pdf`,
        ).join("\0") + "\0partial.pdf";
      const result = yield* WorkspacePathCatalog.scan("/workspace/project", () =>
        Effect.succeed(output(paths, true)),
      );
      expect(result.entries).toHaveLength(WorkspacePathCatalog.MAX_ENTRIES);
      expect(result.truncated).toBe(true);
      expect(result.entries.some((entry) => entry.path === "partial.pdf")).toBe(false);
    }),
);

it.effect(
  "shares scans and refreshes added/deleted documents on expiry and explicit invalidation",
  () =>
    Effect.gen(function* () {
      let paths = "original.pdf\0";
      const run = vi.fn<VcsProcess["Service"]["run"]>(() => Effect.succeed(output(paths)));
      const catalog = yield* WorkspacePathCatalog.make("/workspace/project", run);
      const first = yield* catalog.read;
      paths = "new.pdf\0";
      expect(yield* catalog.read).toBe(first);
      yield* TestClock.adjust("2 seconds");
      expect((yield* catalog.read).entries).toEqual([{ path: "new.pdf", kind: "file" }]);
      paths = "after-refresh.pdf\0";
      yield* catalog.invalidate;
      expect((yield* catalog.read).entries).toEqual([{ path: "after-refresh.pdf", kind: "file" }]);
      expect(run).toHaveBeenCalledTimes(3);
    }),
);

it.effect("reports enumeration failures rather than caching an empty successful listing", () =>
  Effect.gen(function* () {
    const result = yield* Effect.flip(
      WorkspacePathCatalog.scan("/workspace/project", () =>
        Effect.succeed({ ...output(""), exitCode: 2 as VcsProcessOutput["exitCode"] }),
      ),
    );
    expect(result._tag).toBe("WorkspacePathCatalogScanFailed");
  }),
);

it.effect(
  "falls back without rg, honoring parent/nested ignore rules and excluding dependencies and symlinks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-path-catalog-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const cwd = NodePath.join(root, "project");
        const files = new Map([
          [".gitignore", "parent-ignored.pdf\n"],
          ["project/.gitignore", "ignored/\n*.private.pdf\n"],
          ["project/.ignore", "ignore-only.pdf\n"],
          ["project/.rgignore", "rg-only.pdf\n"],
          ["project/docs/.gitignore", "!keep.private.pdf\n"],
          ["project/docs/keep.private.pdf", ""],
          ["project/docs/drop.private.pdf", ""],
          ["project/parent-ignored.pdf", ""],
          ["project/ignore-only.pdf", ""],
          ["project/rg-only.pdf", ""],
          ["project/ignored/nested/hidden.pdf", ""],
          ["project/only-pdfs/visible.pdf", ""],
          ["project/node_modules/pkg/hidden.pdf", ""],
          ["project/.git/hidden.pdf", ""],
        ]);
        yield* Effect.promise(async () => {
          for (const [path, content] of files) {
            await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
            await NodeFSP.writeFile(NodePath.join(root, path), content);
          }
          await NodeFSP.symlink(root, NodePath.join(cwd, "outside"));
        });
        const run: VcsProcess["Service"]["run"] = (input) =>
          input.command === "rg"
            ? Effect.fail(
                new VcsProcessSpawnError({
                  operation: input.operation,
                  command: input.command,
                  cwd,
                  cause: new Error("ENOENT"),
                }),
              )
            : Effect.succeed({ ...output(""), exitCode: 1 as VcsProcessOutput["exitCode"] });
        const result = yield* WorkspacePathCatalog.scan(cwd, run);
        expect(result.entries.filter((entry) => entry.path.endsWith(".pdf"))).toEqual([
          { path: "docs/keep.private.pdf", kind: "file" },
          { path: "only-pdfs/visible.pdf", kind: "file" },
        ]);
        expect(result.entries).toContainEqual({ path: "only-pdfs", kind: "directory" });
        expect(
          result.entries.some((entry) => /ignored|node_modules|outside|^\.git\//.test(entry.path)),
        ).toBe(false);
      }),
    ),
  10_000,
);
