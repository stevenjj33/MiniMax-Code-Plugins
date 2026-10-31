// Bridge from the repo's `node --test` to the Python compatibility checker.
//
// A Skill declares a floor in its frontmatter `compatibility:` line, e.g.
// `Requires Python 3.8+`. Scripts that break that floor are a silent failure:
// PEP 604 union annotations (`str | None`) parse everywhere but raise
// TypeError at import time on Python < 3.10, and Python 3.10+ syntax such as
// `match` is a SyntaxError on the older interpreter. CI only installs a modern
// interpreter, so nothing catches it before the Plugin ships.
//
// The checker parses every Skill's Python scripts with the interpreter it is
// given, so running it under the lowest declared floor catches both cases.
//
// Interpreter discovery mirrors the convention used by the searxng-search
// regression test: prefer `py -3` on Windows, then `python`, then `python3`;
// on POSIX prefer `python3`, then `python`. If no interpreter is found the
// test fails with an explicit diagnostic instead of producing a misleading
// pass.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-python-compat.py');

const isWindows = process.platform === 'win32';

const CANDIDATES = isWindows
  ? [
      { cmd: 'py', args: ['-3', '--version'] },
      { cmd: 'py', args: ['--version'] },
      { cmd: 'python', args: ['--version'] },
      { cmd: 'python3', args: ['--version'] },
    ]
  : [
      { cmd: 'python3', args: ['--version'] },
      { cmd: 'python', args: ['--version'] },
    ];

function findPython() {
  for (const c of CANDIDATES) {
    const r = spawnSync(c.cmd, c.args, { encoding: 'utf-8' });
    if (r.status === 0) {
      return { cmd: c.cmd, prefix: c.cmd === 'py' ? ['-3'] : [] };
    }
  }
  return null;
}

test('Plugin Python scripts honour their declared minimum Python', () => {
  const py = findPython();
  assert.ok(py, `no usable Python interpreter found; tried: ${CANDIDATES.map((c) => `${c.cmd} ${c.args.join(' ')}`).join(', ')}`);

  const r = spawnSync(py.cmd, [...py.prefix, CHECKER], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
  }
  assert.equal(r.status, 0, 'python scripts/check-python-compat.py must exit 0');
});
