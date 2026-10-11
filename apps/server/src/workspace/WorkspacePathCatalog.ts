// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import ignore, { type Ignore } from "ignore";

import type { ProjectEntry, ProjectListEntriesResult } from "@t3tools/contracts";

import type { VcsProcess } from "../vcs/VcsProcess.ts";

export const MAX_ENTRIES = 25_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_IGNORE_BYTES = 64 * 1024;
const SCAN_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 2_000;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
]);

export class WorkspacePathCatalogScanFailed extends Schema.TaggedError<WorkspacePathCatalogScanFailed>()(
  "WorkspacePathCatalogScanFailed",
  { cwd: Schema.String, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

function entryCollector() {
  const entries = new Map<string, ProjectEntry>();
  let truncated = false;
  return {
    add(path: string, kind: ProjectEntry["kind"]) {
      const parts = path.split("/");
      if (
        parts.some(
          (part) => !part || part === "." || part === ".." || EXCLUDED_DIRECTORIES.has(part),
        )
      )
        return;
      for (let index = 1; index <= parts.length; index++) {
        const entryPath = parts.slice(0, index).join("/");
        if (entries.has(entryPath)) continue;
        if (entries.size >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        entries.set(entryPath, {
          path: entryPath,
          kind: index === parts.length ? kind : "directory",
        });
      }
    },
    get full() {
      return entries.size >= MAX_ENTRIES;
    },
    finish(incomplete = false): ProjectListEntriesResult {
      return {
        entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
        truncated: truncated || incomplete,
      };
    },
  };
}

interface IgnoreFile {
  readonly directory: string;
  readonly matcher: Ignore;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function readIgnoreFile(directory: string, name: string): Promise<IgnoreFile | undefined> {
  const handle = await NodeFSP.open(NodePath.join(directory, name), "r").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    // Ignore metadata is the only file content this path catalog reads. Bound it,
    // including a concurrently growing file, rather than reading arbitrary blobs.
    const buffer = Buffer.alloc(MAX_IGNORE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_IGNORE_BYTES)
      throw new Error("Workspace ignore file exceeds the size limit.");
    return { directory, matcher: ignore().add(buffer.toString("utf8", 0, bytesRead)) };
  } finally {
    await handle.close();
  }
}

function ignoredBy(path: string, directory: boolean, rules: readonly IgnoreFile[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relative =
      NodePath.relative(rule.directory, path).split(NodePath.sep).join("/") +
      (directory ? "/" : "");
    const result = rule.matcher.test(relative);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function walkPaths(
  cwd: string,
  signal: AbortSignal,
  baseGitRules: readonly IgnoreFile[],
): Promise<ProjectListEntriesResult> {
  const collected = entryCollector();
  const deadline = performance.now() + SCAN_TIMEOUT_MS;
  let visited = 0;
  let incomplete = false;
  const parents: string[] = [];
  for (let parent = NodePath.dirname(cwd); ; parent = NodePath.dirname(parent)) {
    parents.unshift(parent);
    if (parent === NodePath.dirname(parent)) break;
  }
  const inheritedGit: IgnoreFile[] = [...baseGitRules];
  const inheritedIgnore: IgnoreFile[] = [];
  const inheritedRgIgnore: IgnoreFile[] = [];
  for (const directory of parents) {
    const gitRule = await readIgnoreFile(directory, ".gitignore");
    const ignoreRule = await readIgnoreFile(directory, ".ignore");
    const rgIgnoreRule = await readIgnoreFile(directory, ".rgignore");
    if (gitRule) inheritedGit.push(gitRule);
    if (ignoreRule) inheritedIgnore.push(ignoreRule);
    if (rgIgnoreRule) inheritedRgIgnore.push(rgIgnoreRule);
  }

  async function visit(
    directory: string,
    gitRules: readonly IgnoreFile[],
    ignoreRules: readonly IgnoreFile[],
    rgIgnoreRules: readonly IgnoreFile[],
    depth: number,
  ): Promise<void> {
    signal.throwIfAborted();
    if (collected.full || performance.now() >= deadline || visited >= 100_000 || depth > 64) {
      incomplete = true;
      return;
    }
    const gitRule = await readIgnoreFile(directory, ".gitignore");
    const ignoreRule = await readIgnoreFile(directory, ".ignore");
    const rgIgnoreRule = await readIgnoreFile(directory, ".rgignore");
    const nextGit = gitRule ? [...gitRules, gitRule] : gitRules;
    const nextIgnore = ignoreRule ? [...ignoreRules, ignoreRule] : ignoreRules;
    const nextRgIgnore = rgIgnoreRule ? [...rgIgnoreRules, rgIgnoreRule] : rgIgnoreRules;
    const rules = [...nextGit, ...nextIgnore, ...nextRgIgnore];
    const handle = await NodeFSP.opendir(directory);
    for await (const entry of handle) {
      signal.throwIfAborted();
      if (collected.full || performance.now() >= deadline || ++visited > 100_000) {
        incomplete = true;
        break;
      }
      if (EXCLUDED_DIRECTORIES.has(entry.name) || (!entry.isDirectory() && !entry.isFile()))
        continue;
      const absolute = NodePath.join(directory, entry.name);
      if (ignoredBy(absolute, entry.isDirectory(), rules)) continue;
      const relative = NodePath.relative(cwd, absolute).split(NodePath.sep).join("/");
      collected.add(relative, entry.isDirectory() ? "directory" : "file");
      if (entry.isDirectory()) await visit(absolute, nextGit, nextIgnore, nextRgIgnore, depth + 1);
    }
  }
  await visit(cwd, inheritedGit, inheritedIgnore, inheritedRgIgnore, 0);
  return collected.finish(incomplete);
}

/** Filename enumeration supplements fff's extension-filtered native index. */
export const scan = Effect.fn("WorkspacePathCatalog.scan")(function* (
  cwd: string,
  run: VcsProcess["Service"]["run"],
) {
  const result = yield* run({
    operation: "WorkspacePathCatalog.scan",
    command: "rg",
    args: [
      "--no-config",
      "--files",
      "--hidden",
      "--null",
      "--no-require-git",
      "--threads",
      "1",
      ...[...EXCLUDED_DIRECTORIES].flatMap((name) => ["--glob", `!${name}`]),
    ],
    cwd,
    timeoutMs: SCAN_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    allowNonZeroExit: true,
  }).pipe(Effect.catchTag("VcsProcessSpawnError", () => Effect.void));
  if (result === undefined) {
    // Git supplies the worktree-aware info/exclude path and global excludes
    // setting. Local/nested ignore rules still work without either executable.
    const gitMetadata = yield* run({
      operation: "WorkspacePathCatalog.gitIgnore",
      command: "git",
      args: [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-path",
        "info/exclude",
      ],
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 1_000,
      maxOutputBytes: 16_384,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const globalConfig = yield* run({
      operation: "WorkspacePathCatalog.gitIgnore",
      command: "git",
      args: ["config", "--path", "--get", "core.excludesfile"],
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 1_000,
      maxOutputBytes: 16_384,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const [gitRoot, excludePath] =
      gitMetadata?.exitCode === 0 ? gitMetadata.stdout.trim().split("\n") : [];
    const globalPath =
      globalConfig?.exitCode === 0
        ? globalConfig.stdout.trim()
        : NodePath.join(
            process.env.XDG_CONFIG_HOME || NodePath.join(NodeOS.homedir(), ".config"),
            "git",
            "ignore",
          );
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const rules: IgnoreFile[] = [];
        for (const path of [globalPath, excludePath]) {
          if (!path) continue;
          const absolute = NodePath.resolve(cwd, path);
          const rule = await readIgnoreFile(
            NodePath.dirname(absolute),
            NodePath.basename(absolute),
          );
          if (rule) rules.push({ ...rule, directory: gitRoot || cwd });
        }
        return walkPaths(cwd, signal, rules);
      },
      catch: (cause) =>
        new WorkspacePathCatalogScanFailed({
          cwd,
          reason: "Filename fallback scan failed.",
          cause,
        }),
    });
  }
  if ((result.exitCode !== 0 && result.exitCode !== 1) || result.stdoutInvalidUtf8) {
    return yield* new WorkspacePathCatalogScanFailed({
      cwd,
      reason: "Filename enumeration failed.",
    });
  }
  const collected = entryCollector();
  const paths = result.stdout.split("\0");
  // Discard the unfinished path if the bounded process output was truncated.
  paths.pop();
  for (const path of paths)
    collected.add(
      (path.startsWith("./") ? path.slice(2) : path).split(NodePath.sep).join("/"),
      "file",
    );
  return collected.finish(result.stdoutTruncated);
});

/** Shares one bounded scan; lazy expiry avoids an additional recursive watcher. */
export const make = Effect.fn("WorkspacePathCatalog.make")(function* (
  cwd: string,
  run: VcsProcess["Service"]["run"],
) {
  const semaphore = yield* Semaphore.make(1);
  let snapshot: ProjectListEntriesResult | undefined;
  let expiresAt = 0;
  let generation = 0;
  const read = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (snapshot !== undefined && now < expiresAt) return snapshot;
      const scanningGeneration = generation;
      const next = yield* scan(cwd, run);
      snapshot = next;
      expiresAt =
        scanningGeneration === generation ? (yield* Clock.currentTimeMillis) + CACHE_TTL_MS : 0;
      return next;
    }),
  );
  const invalidate = Effect.sync(() => {
    generation++;
    expiresAt = 0;
  });
  return { read, invalidate };
});

export type WorkspacePathCatalog = Effect.Success<ReturnType<typeof make>>;
