"""Congela o catálogo executando a implementação Python do commit de origem."""
import argparse
import ast
import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel
import yaml


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--source-files", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("catalog.json"))
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[5]
    if args.source_files:
        origin = args.source
        source = (args.source_files / "commands.py").read_text(encoding="utf-8")
        models = (args.source_files / "models.py").read_text(encoding="utf-8")
    else:
        origin = subprocess.run(["git", "rev-parse", args.source], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
        source = subprocess.run(["git", "show", f"{origin}:backend/app/commands.py"], cwd=repo, check=True, capture_output=True, text=True).stdout
        models = subprocess.run(["git", "show", f"{origin}:backend/app/models.py"], cwd=repo, check=True, capture_output=True, text=True).stdout
    implementation = types.ModuleType("commands_characterization")
    implementation.__dict__.update(BaseModel=BaseModel, Optional=Optional, Literal=Literal)
    schema = next(node for node in ast.parse(models).body if isinstance(node, ast.ClassDef) and node.name == "CommandInfo")
    exec(compile(ast.fix_missing_locations(ast.Module(body=[schema], type_ignores=[])), "commands_schema_characterization.py", "exec"), implementation.__dict__)
    composition_source = source.replace("from app.models import CommandInfo\n", "").replace("from app import atomico, procinfo\n", "")
    exec(compile(composition_source, "commands_characterization.py", "exec"), implementation.__dict__)
    cases = []

    def record(name, files=None, cli=None, project=False, terminal=True, excluded=None):
        files = files or {}
        with tempfile.TemporaryDirectory(prefix="hangar-commands-contract-") as temporary:
            root = Path(temporary)
            (root / "home").mkdir()
            for path, content in files.items():
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content.replace("$ROOT", root.as_posix()).encode("utf-8"))
            previous = {key: os.environ.get(key) for key in ("HOME", "USERPROFILE")}
            for key in previous:
                os.environ[key] = str(root / "home")
            try:
                output = implementation.list_commands(str(root / "project") if project else None, cli, frozenset(excluded or []), com_tui=terminal)
                expected = [item.model_dump() for item in output]
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
            cases.append(dict(name=name, files=files, cli=cli, project=project, terminal=terminal, excluded=excluded or [], expected=expected))

    record("empty_home")
    record("headless_before_initialize", terminal=False, excluded=["color", "doctor", "reload-plugins"])
    record("empty_cli_terminal", cli=[])
    record("empty_cli_headless", cli=[], terminal=False)
    project_files = {
        "project/.claude/commands/z.md": "---\nname: custom-name\ndescription: |\n  Texto com\n  várias linhas\nargument-hint: <alvo>\n---\n",
        "project/.claude/commands/a.md": "sem frontmatter\n",
        "project/.claude/commands/invalid.md": "---\nname: [\n---\n",
        "project/.claude/commands/sequence.md": "---\n- item\n---\n",
        "project/.claude/commands/bom.md": "\ufeff---\r\nname: bom-name\r\ndescription: Ação\r\nargumentHint: [texto]\r\n---\r\n",
        "project/.claude/commands/nested/ignored.md": "---\nname: nested-ignored\n---\n",
        "project/.claude/commands/not-markdown.txt": "ignorado",
        "project/.claude/skills/folder/SKILL.md": "---\nname: renamed-skill\ndescription: Organiza o texto\nargument-hint: ignored\n---\n",
        "project/.claude/skills/fallback/SKILL.md": "---\nname: 123\ndescription: false\n---\n",
    }
    record("project_frontmatter", project_files, project=True)
    record("project_survives_cli", project_files, cli=[{"name": "usage", "description": "Usage"}], project=True, terminal=False)
    record("headless_exclusions", cli=[{"name": "doctor"}, {"name": "color"}, {"name": "usage"}], terminal=False, excluded=["doctor", "color"])
    record("cli_metadata", cli=[{"name": "clear", "description": "Clear", "argumentHint": ""}, {"name": "unknown"}, {"name": "acme:task", "description": "  Múltiplos \n espaços  ", "argumentHint": " <id> "}])
    record("priority", {
        "project/.claude/commands/clear.md": "---\ndescription: Outra descrição\n---\n",
        "project/.claude/commands/shared.md": "---\ndescription: Projeto\nargumentHint: <projeto>\n---\n",
        "home/.claude/commands/shared.md": "---\ndescription: Conta\n---\n",
        "home/.claude/skills/shared/SKILL.md": "---\ndescription: Skill\n---\n",
    }, cli=[{"name": "shared", "description": "CLI", "argumentHint": "<cli>"}, {"name": "clear"}, {"name": "shared"}], project=True)
    record("global_skills", {"home/.claude/skills/global/SKILL.md": "---\nname: global-skill\ndescription: Ação global\n---\n", "home/.claude/commands/global.md": "---\ndescription: Comando global\n---\n"})
    record("global_absent_from_cli", {"home/.claude/commands/global.md": "texto"}, cli=[{"name": "usage"}], terminal=False)
    plugin_files = {
        "home/.claude/plugins/installed_plugins.json": json.dumps({"plugins": {"acme@market": [{"installPath": "$ROOT/plugin"}, {"installPath": "$ROOT/plugin"}], "ignored@market": {}, "bad@market": [None, {}, {"installPath": ""}]}}),
        "plugin/commands/task.md": "---\nname: alias\ndescription: Executa a ação\nargumentHint: <id>\n---\n",
        "plugin/skills/task/SKILL.md": "---\nname: alias\ndescription: Duplicada\n---\n",
        "plugin/skills/other/SKILL.md": "---\ndescription: Outra skill\n---\n",
    }
    record("installed_plugins", plugin_files)
    record("plugin_cli_metadata", plugin_files, cli=[{"name": "acme:alias", "description": "CLI"}], terminal=False)
    for name, content in [("broken_registry", "{"), ("array_registry", "[]"), ("bad_plugins_registry", '{"plugins":[]}')]:
        record(name, {"home/.claude/plugins/installed_plugins.json": content})
    record("yaml_hint_precedence", {"project/.claude/commands/hint.md": "---\nargument-hint: ' '\nargumentHint: <ignorado>\ndescription: 42\n---\n", "project/.claude/commands/camel.md": "---\nargument-hint: ''\nargumentHint: <usado>\n---\n"}, project=True)
    record("excluded_across_origins", project_files, cli=[{"name": "custom-name"}, {"name": "clear"}], project=True, excluded=["custom-name", "clear", "renamed-skill"])
    record("yaml_legacy_types", {
        "project/.claude/commands/bool.md": "---\nname: yes\ndescription: off\n---\n",
        "project/.claude/commands/numeric.md": "---\nname: 010\ndescription: 09\nargumentHint: 1e3\n---\n",
        "project/.claude/commands/duplicate.md": "---\nname: first\nname: last\ndescription: Mantém a última\n---\n",
        "project/.claude/commands/tagged.md": "---\nname: !custom alias\ndescription: Não carrega metadados\n---\n",
        "project/.claude/commands/keys.md": "---\n123: ignored\nname: valid-name\n---\n",
    }, project=True)
    record("yaml_tagged_scalars", {
        "project/.claude/commands/binary.md": '---\nname: binary-name\ndescription: !!binary "YcOnw6Nv"\n---\n',
        "project/.claude/commands/date.md": '---\nname: 2026-10-16\ndescription: !!timestamp "2026-10-16"\n---\n',
        "project/.claude/commands/quoted.md": '---\nname: "yes"\ndescription: !!str 010\nargument-hint: !!str 1e3\n---\n',
    }, project=True)
    record("platform_path_case", {
        "project/.claude/commands/a.md": "---\nname: duplicate-command\ndescription: Primeiro comando\n---\n",
        "project/.claude/commands/Z.md": "---\nname: duplicate-command\ndescription: Segundo comando\n---\n",
        "project/.claude/commands/upper.MD": "texto",
        "project/.claude/commands/mixed.Md": "texto",
        "project/.claude/skills/a/SKILL.md": "---\nname: duplicate-skill\ndescription: Primeira skill\n---\n",
        "project/.claude/skills/Z/SKILL.md": "---\nname: duplicate-skill\ndescription: Segunda skill\n---\n",
    }, project=True)
    scalars = [
        "0:0.0", "!!int 1:00", "!!int 0:0", "!!int 1:60", "!!int 1:-60",
        "!!int 08", "!!int 010", "!!int __0__", "!!int ''", "!!float 0:0",
        "!!float 1:-60", "!!float 1e-9999", "!!float 1e9999", "!!float ''",
        "08", "0o10", "1e3", ".NaN", "2001-02-30", "!!timestamp 2001-1-1",
        "2001-1-1", "!!timestamp 2001-12-15T00:00:00.123456789Z",
        "2001-12-15T24:00:00Z", "2001-12-15T00:00:00+25:00",
        "!!binary '!!@@'", "!!binary '===='", "!!binary Y!Q==", "!!binary AA==",
        "!!binary YQ======", "!!binary YQ", "!!binary A", "!!binary 'é'",
        "!!binary YQ==ignored", "!!set {}", "!!set {a: 99}", "!!set []",
        "!!omap []", "!!omap [{a: 1}, {a: 2}]", "!!omap [{? []: 1}]",
        "!!pairs [{? []: 1}]", "!!omap {}", "!!omap [{a: 1, b: 2}]",
        "!!pairs [a]", "!!pairs [{a: 1, b: 2}]", "!!bool OFF",
        "!!null arbitrary", "!!str 010", "! text", "[one, two]", "&self [*self]",
        "!!int 0o10", "!!int 0b0b1", "!!int 0x0x1", "!!int 0O10",
    ]
    constructor_files = {
        f"project/.claude/commands/scalar-{index:02}.md":
            f"---\nname: typed-{index:02}\ndescription: Descrição tipada\nargumentHint: <alternativa>\nargument-hint: {scalar}\n---\n"
        for index, scalar in enumerate(scalars)
    }
    for index, extra in enumerate([
        "unused: !!int 08", "unused: {nested: !foo x}",
        "<<: {name: base, description: Herdada}",
        "<<: [{name: primeiro}, {name: segundo, description: Herdada}]",
        "<<: []", "<<: 0", "<<: [{name: válido}, []]",
        '"<<": {name: base}', "unused: &self {self: *self}",
        'description: "a\\u001cb\\u001dc\\u001ed\\u001fe"',
    ]):
        constructor_files[f"project/.claude/commands/structure-{index:02}.md"] = f"---\nname: structured-{index:02}\n{extra}\n---\n"
    record("yaml_constructor_edges", constructor_files, project=True)
    generator = "cd backend && uv run python tests/fixtures/contract/commands/generate.py --source " + origin
    if os.name == "nt":
        generator += " --source-files <exportação-git-show-da-origem> --output tests/fixtures/contract/commands/catalog-windows.json"
    payload = {"source_commit": origin, "platform": os.name, "python_version": sys.version.split()[0], "yaml_version": yaml.__version__, "generator": generator, "cases": cases}
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Caracterização gravada: {len(cases)} cenários, origem {origin}")


if __name__ == "__main__":
    main()
