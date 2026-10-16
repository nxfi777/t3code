# Choose models for delegated work

Keep model choices in `~/.config/t3-delegation/policy.json`. Edit that file when you want to change a model or its reasoning effort, then run:

```sh
t3-delegation apply --dry-run
t3-delegation apply
```

The command updates the native Claude Code and Codex settings that T3 uses. These settings also apply when you run those harnesses directly. Your main chat keeps its selected model. Start a new chat to load the new instructions and agent definitions; running agents are not restarted.

With the `delegation-policy` skill installed, you can ask for a change in chat: `$delegation-policy use <model> for routine Codex implementation`. The skill reads the current policy, changes the requested fields, validates them and applies the native settings. Asking it to explain or show the policy makes no changes.

## The three roles

| Role     | Use                                                              | Claude default        | Codex default              |
| -------- | ---------------------------------------------------------------- | --------------------- | -------------------------- |
| `scan`   | Find files, extract facts, make simple checks                    | Haiku, low effort     | GPT-6 Luna, high effort    |
| `work`   | Routine implementation and focused tests                         | Sonnet, medium effort | GPT-6.1 Sol, medium effort |
| `review` | Expert advice, difficult implementation and consequential review | Opus, high effort     | GPT-6 Astra, high effort   |

The parent chooses by difficulty, uncertainty and risk. Sonnet and Sol handle well-understood implementation. Opus and Astra advise on substantial plans, architectural choices and persistent failures; they also implement changes that need deeper reasoning. The `review` key selects that expert model for both uses. An advice-only task stays read-only, while an implementation brief authorizes the expert to edit and test.

The parent checks the result and gives workers focused briefs. A parent already using the expert model can handle hard work directly. Forks that need the entire conversation can still inherit the parent's model. Tiny tasks should stay with the parent.

`default_role` supplies the model for a worker whose model was not specified. Explicit task choices can override it. This is a delegation policy, not a spending cap or a guarantee that every model decision follows the table.

## What context agents receive

A fresh agent receives a task brief and its applicable instructions, not an automatic copy of the parent chat or every file the parent has read. This includes the separate Codex `review` advisor. A full-history fork inherits the conversation so far, but also inherits the parent's model in the supported harnesses. It does not keep receiving later conversation updates automatically.

The policy tells the parent to hand over relevant requirements, decisions, file paths, evidence, known failures and success criteria. Implementation briefs also cover expected behavior and edit ownership; advice briefs cover the decision, alternatives and uncertainties. Workers should read the relevant sources, ask the parent about consequential gaps, and return evidence and unresolved assumptions. The parent must relay later corrections and verify the results.

Claude's native advisor receives the calling conversation, including tool calls and results. When a subagent consults it, that means the subagent's context. It cannot automatically know unread repository files or other conversations. Long conversations may have already been compacted, so preserve important requirements and decision records in files that agents can read. These handoff rules guide the models; they do not enforce or guarantee sufficient context.

## Change models

Change the `model` and `effort` fields under the role you want to update. Model IDs are not restricted to a fixed list, so a newly available model needs no script change. The model must be available to your account and support the selected effort. Use `null` for effort to omit an explicit effort setting; native inheritance rules can then apply.

Claude aliases such as `sonnet` follow the versions selected by Claude Code. Use a full model ID if you want a pinned version. Codex models use explicit IDs.

To see the current policy or validate it without writing settings:

```sh
t3-delegation show
t3-delegation check
```

## Claude's advisor

`claude.advisor_model` is separate from the worker roles. The supplied policy sets it to `"opus"`, so compatible Claude sessions and subagents can consult an Opus advisor at decision points. Set it to `null` and apply to remove that saved advisor setting. This does not switch your main model. Codex uses the configured `review` agent for expert advice.

Advisor calls use additional tokens and receive the conversation so far. Claude decides when to consult it. The feature requires a supported Claude Code release, account access and a compatible model pairing. See [Claude's advisor documentation](https://code.claude.com/docs/en/advisor) and [subagent context documentation](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup).

## Undo an application

Each application that changes files prints a private backup path. Restore it with:

```sh
t3-delegation restore /path/printed/by/apply
```

Restore refuses to overwrite files edited since that application. Backups contain your original settings; keep them private. Generated agent files and marked instruction sections belong to this command. Edit the policy file, then apply, rather than editing generated files.

## Install the command

Requires Python 3.11 or later. From this checkout, copy the command and example policy once:

```sh
mkdir -p ~/.local/bin ~/.config/t3-delegation
cp scripts/delegation-policy.py ~/.local/bin/t3-delegation
chmod +x ~/.local/bin/t3-delegation
test -e ~/.config/t3-delegation/policy.json || cp scripts/delegation-policy.example.json ~/.config/t3-delegation/policy.json
```

Use `~/.local/bin/t3-delegation` if `~/.local/bin` is not on your shell's PATH. The command respects `CODEX_HOME` and `CLAUDE_CONFIG_DIR`; `--codex-home`, `--claude-home` and `--config` can select other locations. Use the same homes as T3's provider settings.

The optional skill lives in `.agents/skills/delegation-policy`. Install that directory in your Codex and Claude user skill directories to use it across projects. It calls this command rather than maintaining another copy of the updater.
