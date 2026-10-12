# Choose models for delegated work

Keep model choices in `~/.config/t3-delegation/policy.json`. Edit that file when you want to change a model or its reasoning effort, then run:

```sh
t3-delegation apply --dry-run
t3-delegation apply
```

The command updates the native Claude Code and Codex settings that T3 uses. These settings also apply when you run those harnesses directly. Your main chat keeps its selected model. Start a new chat to load the new instructions and agent definitions; running agents are not restarted.

## The three roles

| Role     | Use                                                                   | Claude default        | Codex default              |
| -------- | --------------------------------------------------------------------- | --------------------- | -------------------------- |
| `scan`   | Find files, extract facts, make simple checks                         | Haiku, low effort     | GPT-6 Luna, high effort    |
| `work`   | Implement a scoped change and test it                                 | Sonnet, medium effort | GPT-6.1 Sol, medium effort |
| `review` | Diagnose difficult bugs, assess designs, review consequential changes | Opus, high effort     | GPT-6 Astra, high effort   |

The parent chooses a role based on the task and checks the result. It gives routine workers a focused brief. Forks that need the entire conversation can still inherit the parent's model. Tiny tasks should stay with the parent.

`default_role` supplies the model for a worker whose model was not specified. Explicit task choices can override it. This is a delegation policy, not a spending cap or a guarantee that every model decision follows the table.

## Change models

Change the `model` and `effort` fields under the role you want to update. Model IDs are not restricted to a fixed list, so a newly available model needs no script change. The model must be available to your account and support the selected effort. Use `null` for effort to omit an explicit effort setting; native inheritance rules can then apply.

Claude aliases such as `sonnet` follow the versions selected by Claude Code. Use a full model ID if you want a pinned version. Codex models use explicit IDs.

To see the current policy or validate it without writing settings:

```sh
t3-delegation show
t3-delegation check
```

## Claude's advisor

`claude.advisor_model` is separate from the worker roles. It starts as `null`, which removes the saved advisor setting. Set it to `"opus"` and apply to let compatible Claude sessions and subagents consult an Opus advisor at decision points. This does not switch your main model.

Advisor calls use additional tokens and receive the conversation so far. Claude decides when to consult it. The feature requires a supported Claude Code release, account access and a compatible model pairing. See [Claude's advisor documentation](https://code.claude.com/docs/en/advisor).

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
