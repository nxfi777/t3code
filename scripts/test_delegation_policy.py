"""Focused, temporary-home tests for the standalone delegation command."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("delegation", Path(__file__).with_name("delegation-policy.py"))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)

POLICY = {
    "version": 1,
    "codex": {"default_role": "work", "roles": {
        "scan": {"model": "gpt-6-luna", "effort": "high"},
        "work": {"model": "gpt-6.1-sol", "effort": "medium"},
        "review": {"model": "gpt-6-astra", "effort": "high"}}},
    "claude": {"default_role": "work", "advisor_model": None, "roles": {
        "scan": {"model": "haiku", "effort": "low"},
        "work": {"model": "sonnet", "effort": "medium"},
        "review": {"model": "opus", "effort": "high"}}},
}


class DelegationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = self.root / "policy.json"
        self.codex = self.root / "codex"
        self.claude = self.root / "claude"
        self.policy = copy.deepcopy(POLICY)
        self.write_policy()

    def write_policy(self):
        self.config.write_text(json.dumps(self.policy))

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def command(self, *args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return cli.main(["--config", str(self.config), "--codex-home", str(self.codex),
                             "--claude-home", str(self.claude), *args])

    def planned(self):
        return cli.plan(cli.validate(self.policy), self.codex, self.claude)

    def backup(self):
        return next((self.root / "backups").iterdir())

    def files(self):
        return {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file() and "backups" not in p.parts}

    def test_malformed_policy_writes_nothing(self):
        invalid = []
        typo = copy.deepcopy(POLICY)
        typo["codex"]["roles"]["work"]["effrot"] = "low"
        invalid.append(typo)
        bad = copy.deepcopy(POLICY)
        bad["claude"]["advisor_model"] = "bad\nmodel"
        invalid.append(bad)
        bad = copy.deepcopy(POLICY)
        bad["version"] = True
        invalid.append(bad)
        bad = copy.deepcopy(POLICY)
        bad["claude"]["default_role"] = ["work"]
        invalid.append(bad)
        for policy in invalid:
            with self.subTest(policy=policy):
                self.config.write_text(json.dumps(policy))
                self.assertEqual(self.command("apply"), 1)
                self.assertFalse(self.codex.exists())
                self.assertFalse((self.root / "backups").exists())

    def test_quoted_models_and_null_effort(self):
        model = 'future/model:"quote"\\backslash: #value😀\u2028tail'
        for provider in ("codex", "claude"):
            self.policy[provider]["roles"]["work"] = {"model": model, "effort": None}
        self.write_policy()
        self.assertEqual(self.command("apply"), 0)
        native = tomllib.loads((self.codex / "agents/t3-work.toml").read_text())
        self.assertEqual(native["model"], model)
        self.assertNotIn("model_reasoning_effort", native)
        markdown = (self.claude / "agents/t3-work.md").read_text()
        front = dict(line.split(": ", 1) for line in markdown.split("---")[1].strip().splitlines())
        self.assertEqual(json.loads(front["model"]), model)
        self.assertNotIn("effort", front)
        config = tomllib.loads((self.codex / "config.toml").read_text())
        self.assertEqual(config["agents"]["default_subagent_model"], model)
        self.assertNotIn("default_subagent_reasoning_effort", config["agents"])

    def test_preserves_unrelated_settings_and_permissions(self):
        codex = ('# parent settings\nmodel = "keep-parent"\nmodel_reasoning_effort = "low"\n'
                 '[agents]\n# keep comment\nmax_threads = 2\ndefault_subagent_model = "old"\n'
                 'default_subagent_reasoning_effort = "low"\n'
                 'notes = """\n[agents]\ndefault_subagent_model = \'not-a-setting\'\n"""\n'
                 '[agents.existing]\nconfig_file = "custom.toml"\n'
                 '[mcp_servers.local]\ncommand = "keep-command"\n')
        self.write(self.codex / "config.toml", codex)
        (self.codex / "config.toml").chmod(0o640)
        self.write(self.claude / "settings.json", json.dumps({"model": "keep-parent", "advisorModel": "old",
                   "env": {"KEEP_TOKEN": "private"}, "permissions": {"allow": ["Read"]}}))
        self.write(self.codex / "AGENTS.md", "Existing guidance.\n")
        self.assertEqual(self.command("apply"), 0)
        parsed = tomllib.loads((self.codex / "config.toml").read_text())
        self.assertEqual(parsed["model"], "keep-parent")
        self.assertEqual(parsed["model_reasoning_effort"], "low")
        self.assertEqual(parsed["agents"]["max_threads"], 2)
        self.assertEqual(parsed["agents"]["existing"], {"config_file": "custom.toml"})
        self.assertIn("not-a-setting", parsed["agents"]["notes"])
        self.assertIn("# keep comment", (self.codex / "config.toml").read_text())
        self.assertEqual(stat.S_IMODE((self.codex / "config.toml").stat().st_mode), 0o640)
        settings = json.loads((self.claude / "settings.json").read_text())
        self.assertEqual(settings["model"], "keep-parent")
        self.assertEqual(settings["env"]["KEEP_TOKEN"], "private")
        self.assertEqual(settings["permissions"], {"allow": ["Read"]})
        self.assertNotIn("advisorModel", settings)
        self.assertTrue((self.codex / "AGENTS.md").read_text().startswith("Existing guidance."))
        self.assertEqual(stat.S_IMODE(self.backup().stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.backup() / "manifest.json").stat().st_mode), 0o600)

    def test_nested_table_without_agents_header(self):
        self.write(self.codex / "config.toml", 'model = "parent"\n[agents.old]\nconfig_file = "old.toml"\n')
        self.assertEqual(self.command("apply"), 0)
        self.assertEqual(tomllib.loads((self.codex / "config.toml").read_text())["agents"]["old"], {"config_file": "old.toml"})

    def test_idempotent_and_single_role_update(self):
        self.assertEqual(self.command("apply"), 0)
        before = self.files()
        self.assertEqual(self.command("apply"), 0)
        self.assertEqual(before, self.files())
        self.assertEqual(len(list((self.root / "backups").iterdir())), 1)
        self.policy["codex"]["roles"]["scan"]["model"] = "future-scan"
        self.write_policy()
        changes = self.planned()
        self.assertEqual(set(changes), {self.codex / "agents/t3-scan.toml", self.codex / "AGENTS.md"})
        self.assertEqual(self.command("apply"), 0)
        self.assertEqual((self.codex / "agents/t3-work.toml").read_bytes(), before[self.codex / "agents/t3-work.toml"])

    def test_unmanaged_agent_and_marker_conflicts(self):
        path = self.codex / "agents/t3-scan.toml"
        for existing in ("", 'model = "mine"\n'):
            self.write(path, existing)
            self.assertEqual(self.command("apply"), 1)
            self.assertEqual(path.read_text(), existing)
            self.assertFalse((self.root / "backups").exists())
        path.unlink()
        for markers in (cli.START, cli.START + cli.END + cli.START + cli.END, cli.END + cli.START):
            self.write(self.codex / "AGENTS.md", markers)
            self.assertEqual(self.command("apply"), 1)
            self.assertEqual((self.codex / "AGENTS.md").read_text(), markers)
            self.assertFalse((self.root / "backups").exists())

    def test_force_conflict_and_advisor_switch(self):
        for force in (True, "true", "1", 1):
            self.write(self.claude / "settings.json", json.dumps({"env": {"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": force}}))
            self.assertEqual(self.command("apply"), 1)
            self.assertFalse((self.root / "backups").exists())
        self.write(self.claude / "settings.json", '{}')
        self.policy["claude"]["advisor_model"] = "opus"
        self.write_policy()
        self.assertEqual(self.command("apply"), 0)
        self.assertEqual(json.loads((self.claude / "settings.json").read_text())["advisorModel"], "opus")

    def test_check_dry_run_and_show_write_nothing(self):
        before = self.files()
        for args in (("check",), ("show",), ("apply", "--dry-run")):
            self.assertEqual(self.command(*args), 0)
            self.assertEqual(self.files(), before)
            self.assertFalse((self.root / "backups").exists())

    def test_restore_refuses_all_if_any_file_changed(self):
        self.assertEqual(self.command("apply"), 0)
        self.write(self.claude / "settings.json", '{"later": true}\n')
        before = self.files()
        self.assertEqual(self.command("restore", str(self.backup())), 1)
        self.assertEqual(self.files(), before)

    def test_restore_exact_original_bytes_modes_and_missing_files(self):
        self.write(self.codex / "config.toml", '# original\nmodel = "parent"\n')
        (self.codex / "config.toml").chmod(0o644)
        before = self.files()
        self.assertEqual(self.command("apply"), 0)
        (self.codex / "config.toml").chmod(0o600)
        self.assertEqual(self.command("restore", str(self.backup())), 0)
        self.assertEqual(self.files(), before)
        self.assertEqual(stat.S_IMODE((self.codex / "config.toml").stat().st_mode), 0o644)

    def test_failed_apply_rolls_back(self):
        self.write(self.codex / "agents/t3-scan.toml", f'# {cli.MARKER}\nmodel = "old"\n')
        original = self.files()
        native_write = cli.atomic_write
        calls = 0
        def fail_once(path, data, mode=0o600):
            nonlocal calls
            if "backups" not in path.parts:
                calls += 1
                if calls == 2:
                    raise OSError("injected failure")
            return native_write(path, data, mode)
        with patch.object(cli, "atomic_write", fail_once):
            self.assertEqual(self.command("apply"), 1)
        self.assertEqual(self.files(), original)

    def test_preflight_race_and_symlink_refused(self):
        self.write(self.codex / "config.toml", 'model = "before"\n')
        changes = self.planned()
        self.write(self.codex / "config.toml", 'model = "after"\n')
        with self.assertRaisesRegex(ValueError, "changed after preflight"):
            cli.apply(changes, self.config)
        self.assertFalse((self.root / "backups").exists())
        target = self.root / "original"
        target.write_text("untouched")
        (self.codex / "config.toml").unlink()
        (self.codex / "config.toml").symlink_to(target)
        self.assertEqual(self.command("apply"), 1)
        self.assertEqual(target.read_text(), "untouched")


if __name__ == "__main__":
    unittest.main()
