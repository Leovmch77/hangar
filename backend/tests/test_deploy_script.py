"""Executa o deploy real em clones descartáveis; serviços e builds são falsos."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "deploy.sh"
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['DEPLOY_TEST_ROOT'])
repo = root / 'repo'
scenario = os.environ['DEPLOY_TEST_SCENARIO']
state_file = root / 'state.json'
state = json.loads(state_file.read_text())
with (root / 'calls').open('a') as f:
    f.write(name + ' ' + ' '.join(args) + '\n')
candidate = (repo / 'revision').read_text() == 'new'
def save(): state_file.write_text(json.dumps(state))
if name == 'sleep': pass
elif name == 'journalctl': print('Traceback: SyntaxError in rejected candidate')
elif name == 'uv':
    if 'run' in args: print('8766')
    elif scenario == 'deps_fail' and candidate: sys.exit(1)
elif name == 'npm':
    if 'build' in args:
        dist = repo / 'frontend' / 'dist'
        dist.mkdir(exist_ok=True)
        (dist / 'index.html').write_text('new dist')
        if scenario == 'build_fail': sys.exit(1)
elif name == 'systemctl':
    if 'list-unit-files' in args: sys.exit(0 if scenario == 'front_fail' else 1)
    if 'show' in args:
        if scenario == 'flapping' and candidate:
            state['pid'] += 1; save()
        print(state['pid'])
    elif 'is-active' in args:
        if scenario == 'front_fail' and candidate and 'hangar-frontend.service' in args: sys.exit(1)
        sys.exit(0 if state['pid'] else 1)
    elif 'stop' in args: state['pid'] = 0; save()
    elif 'restart' in args:
        state['restarts'] += 1
        state['pid'] = 101 if scenario == 'same_pid' and candidate else 200 + state['restarts']
        save()
        if scenario == 'restart_fail' and candidate: sys.exit(1)
        if scenario == 'rollback_restart_fail' and not candidate: sys.exit(1)
elif name == 'curl':
    assert any('127.0.0.1:8766/api/peers/ping' in a for a in args), args
    state['probes'] += 1; save()
    failed = scenario == 'rollback_fail' or (candidate and scenario in ('boot_fail', 'rollback_restart_fail', 'self_update_fail'))
    failed |= candidate and scenario == 'delayed' and state['probes'] < 3
    if failed: print('000'); sys.exit(7)
    body = '<html>wrong server</html>' if candidate and scenario == 'wrong_body' else '{"hangar":true}'
    pathlib.Path(args[args.index('-o') + 1]).write_text(body)
    print('200')
'''


@pytest.mark.parametrize("scenario", [
    "success", "delayed", "boot_fail", "wrong_body", "same_pid", "flapping",
    "restart_fail", "rollback_fail", "build_fail", "deps_fail", "dirty",
    "front_fail", "self_update", "self_update_fail", "rollback_restart_fail",
])
def test_deploy_script(scenario):
    with tempfile.TemporaryDirectory(prefix="hangar-deploy-test-") as temporary:
        root = Path(temporary)
        repo, origin, home = root / "repo", root / "origin", root / "home"
        binaries = home / ".local" / "bin"
        binaries.mkdir(parents=True)
        env = {**os.environ, "HOME": str(home), "DEPLOY_TEST_ROOT": str(root),
               "DEPLOY_TEST_SCENARIO": scenario, "TMPDIR": str(root)}
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"):
            env.pop(key, None)

        def git(*args, cwd=repo):
            return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", *args],
                                           cwd=cwd, env=env, stderr=subprocess.DEVNULL, text=True).strip()

        origin.mkdir()
        git("init", "--bare", cwd=origin)
        repo.mkdir()
        git("init", "-b", "main")
        git("config", "user.name", "Deploy test")
        git("config", "user.email", "deploy@example.invalid")
        (repo / "scripts").mkdir()
        (repo / "backend").mkdir()
        (repo / "frontend").mkdir()
        (repo / ".gitignore").write_text("frontend/dist*\nbackend/.env\n")
        shutil.copy2(SCRIPT, repo / "scripts" / "deploy.sh")
        (repo / "revision").write_text("old")
        (repo / "package-lock.json").write_text("old lock")
        (repo / "backend" / "uv.lock").write_text("old lock")
        (repo / "backend" / "pyproject.toml").write_text("old config")
        git("add", "scripts/deploy.sh", ".gitignore", "revision", "package-lock.json",
            "backend/uv.lock", "backend/pyproject.toml")
        git("commit", "-m", "old")
        old = git("rev-parse", "HEAD")
        git("remote", "add", "origin", str(origin))
        git("push", "origin", "main")
        (repo / "revision").write_text("new")
        (repo / "package-lock.json").write_text("new lock")
        (repo / "backend" / "uv.lock").write_text("new lock")
        if scenario.startswith("self_update"):
            script = repo / "scripts/deploy.sh"
            changed = script.read_text().replace(
                "#!/usr/bin/env bash\n", "#!/usr/bin/env bash\n" + "# candidate\n" * 1000, 1)
            script.write_text(changed + '\nprintf unexpected > "$REPO/candidate-script-executed"\n')
            git("add", "scripts/deploy.sh")
        git("add", "revision", "package-lock.json", "backend/uv.lock")
        git("commit", "-m", "new")
        new = git("rev-parse", "HEAD")
        git("push", "origin", "main")
        git("reset", "--keep", old)
        (repo / "frontend" / "dist").mkdir()
        (repo / "frontend" / "dist" / "index.html").write_text("old dist")
        (repo / "backend" / ".env").write_text("CP_PORT=8766\n")
        if scenario == "dirty":
            (repo / "revision").write_text("user edit")
        (root / "state.json").write_text('{"pid":101,"restarts":0,"probes":0}')
        fake = binaries / "fake"
        fake.write_text(FAKE)
        fake.chmod(0o755)
        for name in ("systemctl", "curl", "npm", "uv", "sleep", "journalctl"):
            (binaries / name).symlink_to(fake)
        result = subprocess.run(["bash", str(repo / "scripts" / "deploy.sh")], cwd=repo,
                                env=env, capture_output=True, text=True, timeout=20)
        state = json.loads((root / "state.json").read_text())
        calls = (root / "calls").read_text() if (root / "calls").exists() else ""
        if scenario in ("success", "delayed", "self_update"):
            assert result.returncode == 0, result.stdout + result.stderr
            assert git("rev-parse", "HEAD") == new
            assert (repo / "frontend/dist/index.html").read_text() == "new dist"
            assert state["restarts"] == 1
        elif scenario == "dirty":
            assert result.returncode != 0
            assert git("rev-parse", "HEAD") == old
            assert (repo / "revision").read_text() == "user edit"
            assert state["restarts"] == 0
        else:
            assert result.returncode != 0, result.stdout
            assert git("rev-parse", "HEAD") == old, result.stdout + result.stderr
            assert git("branch", "--show-current") == "main"
            assert (repo / "frontend/dist/index.html").read_text() == "old dist"
            assert state["restarts"] == (0 if scenario in ("build_fail", "deps_fail") else 2)
            assert "rollback" in result.stdout.lower()
            assert "uv sync" in calls or scenario == "build_fail"
            if scenario in ("rollback_fail", "rollback_restart_fail"):
                assert "CRITICO" in result.stdout
                assert state["pid"] == 0
            if scenario not in ("build_fail", "deps_fail"):
                assert "journalctl" in calls
        if scenario != "dirty":
            assert not git("status", "--porcelain", "--untracked-files=no")
        assert not (repo / "candidate-script-executed").exists()
