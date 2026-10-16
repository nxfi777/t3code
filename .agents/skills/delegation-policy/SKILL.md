---
name: delegation-policy
description: Inspect or update the user's Claude Code and Codex delegation models, reasoning effort, and advisor setting through t3-delegation. Use when the user wants to change or restore this policy, including adopting new models; ordinary task delegation does not require this skill.
---

# Delegation policy

Use the installed `t3-delegation` command, falling back to `~/.local/bin/t3-delegation`. The default source of truth is `~/.config/t3-delegation/policy.json`. Read the current file rather than assuming which models it contains. The helper updates native harness settings used by both T3 and direct CLI sessions.

If the command is missing, locate `scripts/delegation-policy.py` in the user's T3 checkout and follow its `docs/user/delegation-policy.md` installation instructions. If that source is unavailable, report the missing dependency; do not invent another updater.

## Inspect or explain

Run `t3-delegation show` and `t3-delegation check`. These do not change settings. `check` validates the schema and planned file updates; it does not prove that a model exists or is available to the user's account.

The roles are `scan` (read-only extraction), `work` (routine implementation) and `review` (expert advice **and difficult implementation**). Route by difficulty, uncertainty and risk. Claude's `advisor_model` is a separate native setting. The parent model stays selected by the user.

Do not promise every agent receives the whole chat. Fresh workers, including Codex's expert advisor, need a self-contained brief with relevant requirements, decisions, source paths, evidence and success criteria. Claude's native advisor receives its caller's conversation; that is the worker's context when a worker calls it. Full-history forks inherit the parent's model in these harnesses. None of these mechanisms guarantees that omitted or compacted information reaches another agent.

## Update the policy

A request to change the policy authorizes applying that change. A question about its behavior does not authorize unrelated model changes.

1. Read the current policy and run `check`. Use the same Codex and Claude homes as T3's provider settings; the helper respects `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Global options such as `--config`, `--codex-home` and `--claude-home` go **before** the subcommand.
2. Modify only the requested fields in a temporary JSON candidate. Save the exact original policy privately before replacing it: the helper's apply backup covers generated settings, **not the input policy**. Preserve unrelated user changes.
3. Run `t3-delegation --config /path/to/candidate.json check`. If valid, check that the original policy has not changed since reading it, then replace it atomically. If it changed, reread and reconcile rather than overwriting it.
4. Run `t3-delegation apply --dry-run`, inspect the target paths, then `t3-delegation apply`. If it fails, report the failure and any pending policy/settings mismatch. Restore the prior policy only if it still matches the candidate you wrote. Do not bypass the helper's conflict checks.
5. Run `t3-delegation check` and confirm a second dry run has no pending changes. Report the changed role/model/effort or advisor setting and the printed backup path. Distinguish configuration validation from a live model test.

Model and effort values live under each provider's `roles`; `default_role` chooses the fallback worker. An effort of `null` omits the explicit override. Claude's `advisor_model: null` removes this saved advisor default; project settings may still override it. Claude aliases can advance with provider releases; full model IDs pin a version. Preserve the user's preference for aliases or pins.

For a request to adopt the latest models, verify current official provider documentation and available native model listings. Do not guess model IDs or silently substitute an unavailable model. Avoid paid inference probes unless needed for the requested verification.

Do not edit generated agent definitions or managed instruction blocks directly: the next apply replaces them. Changes to handoff rules belong in the helper's instruction generator; model choices remain in the policy file. Do not alter the parent model, authentication, permissions or unrelated settings. Existing chats may keep loaded definitions; start a new chat to reliably load changes without restarting T3 or interrupting agents.

## Restore

Use `t3-delegation restore /path/printed/by/apply` for generated settings. It refuses to overwrite files changed since that application. Restore the matching saved policy too when undoing a policy edit, checking for intervening user changes first. Backups may contain private settings: keep them local and do not print their contents.
