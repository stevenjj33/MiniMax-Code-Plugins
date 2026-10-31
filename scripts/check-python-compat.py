#!/usr/bin/env python3
"""Check that Plugin Python scripts honour their declared minimum Python.

A Skill declares a floor in its frontmatter `compatibility:` line, e.g.
``Requires Python 3.8+``. Two things silently break that promise:

  1. PEP 604 union syntax (``str | None``) in an annotation. It *parses* on
     every Python version, but evaluating it at function-definition time
     raises ``TypeError: unsupported operand type(s) for |`` on Python < 3.10.
     ``from __future__ import annotations`` defers evaluation and makes it
     safe.
  2. Python 3.10+ syntax such as ``match`` statements -- a hard SyntaxError
     on the older interpreter.

Neither shows up when the only interpreter available is a modern one (CI
installs Python 3.13), which is how such a bug reaches the Marketplace and
breaks every user on an older interpreter. This check is therefore run both
by ``npm run check`` and by CI under the lowest declared floor.

Scope: only Skills that declare a Python floor below 3.10 are inspected, so
Plugins that legitimately require a newer interpreter are left alone.

Exit code 0 means every declared floor is honoured.
"""
from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_DIR = REPO_ROOT / "plugins"

# PEP 604 unions (``X | Y``) require Python 3.10.
PEP_604_FLOOR = (3, 10)

_COMPAT_LINE = re.compile(r"^compatibility:\s*(.*)$")
_PYTHON_VERSION = re.compile(r"Python\s+(\d+)\.(\d+)", re.IGNORECASE)
_FUTURE_ANNOTATIONS = re.compile(
    r"^\s*from\s+__future__\s+import\s+annotations\b", re.MULTILINE
)


def compatibility_text(text):
    """Return the `compatibility:` frontmatter value, unwrapping YAML blocks."""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = _COMPAT_LINE.match(line)
        if not match:
            continue
        value = match.group(1).strip()
        if value not in ("|", ">", "|-", ">-", "|+", ">+"):
            return value
        block = []
        for nxt in lines[index + 1:]:
            if not nxt.strip() or nxt.startswith((" ", "\t")):
                block.append(nxt.strip())
            else:
                break
        return " ".join(block)
    return None


def declared_floor(text):
    """Lowest Python version the compatibility line claims to require."""
    value = compatibility_text(text)
    if not value:
        return None
    floors = [(int(major), int(minor))
              for major, minor in _PYTHON_VERSION.findall(value)]
    return min(floors) if floors else None


def _annotations(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.AnnAssign):
            yield node.annotation
        elif isinstance(node, ast.arg):
            yield node.annotation
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node.returns


def has_pep_604_union(tree):
    """True if any annotation uses the PEP 604 ``X | Y`` union syntax."""
    for annotation in _annotations(tree):
        if annotation is None:
            continue
        for node in ast.walk(annotation):
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
                return True
    return False


def check_script(script, floor, base):
    """Return problem descriptions for one Python file, or an empty list."""
    try:
        relative = script.relative_to(base)
    except ValueError:
        relative = script
    version = ".".join(str(part) for part in floor)
    source = script.read_text(encoding="utf-8", errors="replace")

    try:
        tree = ast.parse(source, filename=str(relative))
    except SyntaxError as exc:
        return [
            "{0}: cannot be parsed by Python {1} ({2}: {3})".format(
                relative, version, exc.lineno, exc.msg
            )
        ]

    if has_pep_604_union(tree) and not _FUTURE_ANNOTATIONS.search(source):
        return [
            "{0}: uses PEP 604 union annotations (`X | Y`) but declares "
            "Python {1}+. Add `from __future__ import annotations` to the "
            "file, or raise the declared floor.".format(relative, version)
        ]
    return []


def _plugin_dirs(plugins_dir):
    for owner in sorted(plugins_dir.iterdir()):
        if not owner.is_dir():
            continue
        for plugin in sorted(owner.iterdir()):
            if plugin.is_dir():
                yield plugin


def _skill_dirs(plugin_dir):
    return sorted({path.parent for path in plugin_dir.rglob("SKILL.md")
                   if "node_modules" not in path.parts})


def _plugin_scripts(plugin_dir, skill_dirs):
    """Python files in the plugin that do not belong to any Skill."""
    scripts = []
    for script in plugin_dir.rglob("*.py"):
        if "node_modules" in script.parts:
            continue
        if any(skill in script.parents for skill in skill_dirs):
            continue
        scripts.append(script)
    return scripts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugins-dir", default=str(PLUGINS_DIR))
    args = parser.parse_args()

    plugins_dir = Path(args.plugins_dir)
    problems = []
    checked = 0

    for plugin_dir in _plugin_dirs(plugins_dir):
        skill_dirs = _skill_dirs(plugin_dir)
        floors = {}
        for skill_dir in skill_dirs:
            for skill_md in sorted(skill_dir.glob("SKILL.md")):
                floor = declared_floor(
                    skill_md.read_text(encoding="utf-8", errors="replace")
                )
                if floor is not None:
                    floors[skill_dir] = floor

        if not floors:
            continue
        plugin_floor = min(floors.values())

        for skill_dir, floor in floors.items():
            if floor >= PEP_604_FLOOR:
                continue
            checked += 1
            for script in sorted(skill_dir.rglob("*.py")):
                if "node_modules" in script.parts:
                    continue
                problems.extend(check_script(script, floor, plugins_dir))

        if plugin_floor < PEP_604_FLOOR:
            for script in _plugin_scripts(plugin_dir, skill_dirs):
                problems.extend(check_script(script, plugin_floor, plugins_dir))

    for problem in problems:
        print("FAIL " + problem, file=sys.stderr)
    if problems:
        print(
            "\n{0} Python compatibility problem(s) found. A Skill declaring "
            "`Requires Python 3.x+` must run on 3.x.".format(len(problems)),
            file=sys.stderr,
        )
        return 1

    print("Python compatibility OK: checked {0} Skill(s) declaring a floor "
          "below 3.10.".format(checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
