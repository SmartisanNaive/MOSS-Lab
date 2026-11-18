"""Installed-package tests: real pip replacement, complete data preservation and out-of-package repair."""
from contextlib import closing
import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile

from moss_lab.install import Bundle, Manager, atomic_json, digest, exclusive
from moss_lab.update import installed_wheel

home = Path(sys.argv[1]).resolve()
report = Path(sys.argv[2]).resolve()
report.mkdir(parents=True, exist_ok=True)
results = []
os.environ["MOSS_TEST_INSTALL_PYTHON"] = sys.executable


def run(*args, success=True):
    outcome = subprocess.run([sys.executable, '-m', 'moss_lab', '--home', str(home), *map(str, args)], capture_output=True, text=True, encoding='utf-8', timeout=2000)
    if (outcome.returncode == 0) != success:
        raise AssertionError(f'Command {args[0]} returned {outcome.returncode}: {outcome.stderr[-1500:]}')
    return outcome


def data_hashes(root):
    return {p.relative_to(root).as_posix(): digest(p) for name in ['.env', '.dsh-local']
            for p in ([root / name] if (root / name).is_file() else (root / name).rglob('*')) if p.is_file()}


def assert_data_hashes(expected, root=home, *, task):
    actual = data_hashes(root)
    differences = {name: {'before': expected.get(name), 'after': actual.get(name)}
                   for name in sorted(expected.keys() | actual.keys()) if expected.get(name) != actual.get(name)}
    if differences:
        results.append({'task': task, 'status': 'FAIL', 'changed_files': differences})
        raise AssertionError(f'{task}: changed files: {list(differences)}')


def package_version():
    return subprocess.check_output([sys.executable, '-c', 'import importlib.metadata;print(importlib.metadata.version("moss-lab"))'], text=True).strip()


def variant(original, destination, version, *, failing=False):
    """Keep manager code identical; only the application fixture and package version vary."""
    with zipfile.ZipFile(original) as incoming:
        manifest = json.loads(incoming.read('moss_lab/_payload/manifest.json'))
        previous = manifest['version']
        archive_bytes = incoming.read('moss_lab/_payload/application.zip')
        if failing:
            node = manifest['node']
            stream = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as app, zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as replacement:
                info = app.getinfo(node)
                replacement.writestr(info, app.read(node))
                replacement.writestr('failed.mjs', "import{createInterface}from'node:readline';import fs from'node:fs';import path from'node:path';import{spawnSync}from'node:child_process';import{DatabaseSync}from'node:sqlite';const r=createInterface({input:process.stdin});r.once('line',()=>{r.close();const home=process.env.MOSS_HOME;const version=spawnSync(process.env.MOSS_TEST_INSTALL_PYTHON,['-c','import importlib.metadata;print(importlib.metadata.version(\"moss-lab\"))'],{encoding:'utf8'}).stdout.trim();fs.writeFileSync(path.join(home,'.env'),'BROKEN=1');const db=new DatabaseSync(path.join(home,'.dsh-local/experiments.sqlite'));const before=db.prepare('SELECT count(*) AS count FROM checks').get().count;db.exec('DELETE FROM checks');const after=db.prepare('SELECT count(*) AS count FROM checks').get().count;db.close();fs.writeFileSync(path.join(home,'test-upgrade-probe.json'),JSON.stringify({packageVersion:version,checksBefore:before,checksAfter:after}));throw new Error('intentional candidate startup failure after modifying data')});")
            archive_bytes = stream.getvalue()
            manifest['entry'] = 'failed.mjs'
        manifest.update(version=version, sha256=hashlib.sha256(archive_bytes).hexdigest())
        records = []
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as output:
            for name in incoming.namelist():
                if name.endswith('/RECORD'):
                    continue
                label = name.replace(f'moss_lab-{previous}.dist-info/', f'moss_lab-{version}.dist-info/')
                content = incoming.read(name)
                if name == 'moss_lab/_payload/manifest.json':
                    content = (json.dumps(manifest) + '\n').encode()
                elif name == 'moss_lab/_payload/application.zip':
                    content = archive_bytes
                elif name.endswith('/METADATA'):
                    content = content.replace(f'Version: {previous}\n'.encode(), f'Version: {version}\n'.encode())
                output.writestr(label, content)
                checksum = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b'=').decode()
                records.append([label, 'sha256=' + checksum, str(len(content))])
            record = f'moss_lab-{version}.dist-info/RECORD'
            records.append([record, '', ''])
            stream = io.StringIO()
            csv.writer(stream, lineterminator='\n').writerows(records)
            output.writestr(record, stream.getvalue())


try:
    # This home contains real experiments, revisions, simulation results and conversation logs
    # generated by check-moss-installed.mjs, not an empty substitute database.
    with closing(sqlite3.connect(home / '.dsh-local/experiments.sqlite')) as db:
        counts = {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                  for table in ['experiments', 'revisions', 'checks', 'session_creation_keys']}
    assert counts['experiments'] >= 2 and counts['revisions'] >= 4, counts
    original_hashes = data_hashes(home)
    run('check', '--port', '0', '--timeout', '1800')
    assert_data_hashes(original_hashes, task='normal-restart-preserves-persistent-history')
    results.append({'task': 'installed-restart-preserves-real-history', 'status': 'PASS', 'counts': counts})
    bundle = Bundle(Path(importlib.metadata.distribution('moss-lab').locate_file('moss_lab/_payload')))
    manager = Manager(home, bundle)
    with tempfile.TemporaryDirectory(prefix='moss-pip-fixtures-') as temporary:
        stage = Path(temporary)
        original = installed_wheel(stage / 'original')
        tag = original.name.split('-py3-none-')[1]
        bad = stage / ('moss_lab-0.1.1-py3-none-' + tag)
        good = stage / ('moss_lab-0.1.2-py3-none-' + tag)
        variant(original, bad, '0.1.1', failing=True)
        run('update', '--wheel', bad, '--port', '0', '--timeout', '60', success=False)
        probe = json.loads((home / 'test-upgrade-probe.json').read_text())
        assert probe['packageVersion'] == '0.1.1', 'The failing application must really run from the newly installed pip package'
        assert probe['checksBefore'] == counts['checks'] and probe['checksAfter'] == 0, 'The rollback must restore data that was actually changed'
        (home / 'test-upgrade-probe.json').unlink()
        assert package_version() == '0.1.0'
        assert_data_hashes(original_hashes, task='failed-update-restores-exact-history-and-key')
        assert not (home / 'package-update.json').exists()
        results.append({'task': 'real-pip-failed-application-restores-package-and-real-data', 'status': 'PASS'})
        variant(original, good, '0.1.2')
        run('update', '--wheel', good, '--port', '0', '--timeout', '1800')
        assert package_version() == '0.1.2'
        assert_data_hashes(original_hashes, task='successful-update-preserves-history')
        marker = home / '.dsh-local/after-upgrade.txt'
        marker.write_text('Keep this new data too', encoding='utf-8')
        run('rollback')
        assert run('status').stdout.startswith('MOSS 0.1.0\n')
        assert_data_hashes(original_hashes, task='manual-rollback-restores-exact-history')
        assert list((home / 'backups').glob('retained-*/.dsh-local/after-upgrade.txt'))
        run('check', '--port', '0', '--timeout', '1800')
        results.append({'task': 'real-pip-success-manual-rollback-retains-new-data-and-runs-old-application', 'status': 'PASS'})
        # Reinstall the shipped package before intentionally interrupting a pip-like replacement.
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-deps', '--force-reinstall', str(original)], check=True, capture_output=True)
        distribution = importlib.metadata.distribution('moss-lab')
        site_packages = Path(distribution.locate_file('')).resolve()
        cached = installed_wheel(home / 'packages/interrupted-test')
        backup = manager.snapshot()
        recovery = home / 'recover-install.py'
        shutil.copy2(Path(distribution.locate_file('moss_lab/recovery.py')), recovery)
        atomic_json(home / 'package-update.json', {'schema': 1, 'wheel': cached.relative_to(home).as_posix(),
            'wheel_sha256': digest(cached), 'backup': backup.relative_to(home).as_posix(),
            'site_packages': str(site_packages), 'writer': 'fixture-transaction'})
        # The exact kernel lock held inside pip must outlive its parent coordinator.
        writer = subprocess.Popen([sys.executable, '-c',
            "from pathlib import Path;from moss_lab.recovery import file_lock;import sys\nwith file_lock(Path(sys.argv[1])):print('locked',flush=True);sys.stdin.read()", str(home / 'pip-writer.lock')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            assert writer.stdout.readline().strip() == 'locked'
            busy = subprocess.run([sys.executable, str(recovery), '--stopped'], capture_output=True, timeout=30)
            assert busy.returncode != 0
            assert (home / 'package-update.json').is_file()
            assert_data_hashes(original_hashes, task='busy-recovery-preserves-history')
        finally:
            writer.stdin.close()
            writer.wait(timeout=15)
            writer.stdout.close()
        results.append({'task': 'active-pip-writer-blocks-external-recovery', 'status': 'PASS'})
        (home / '.env').write_text('INTERRUPTED=1')
        (home / '.dsh-local/new-during-pip.txt').write_text('retain interrupted data')
        Path(distribution.locate_file('moss_lab/cli.py')).unlink()
        record = next(Path(distribution.locate_file(name)) for name in distribution.files if str(name).replace('\\', '/').endswith('.dist-info/RECORD'))
        record.unlink()
        failed = run('status', success=False)
        assert 'recover-install.py' in failed.stderr
        subprocess.run([sys.executable, str(recovery), '--stopped'], check=True, capture_output=True, timeout=120)
        delayed = subprocess.run([sys.executable, str(recovery), '--install-wheel', str(original), '--writer-token', 'fixture-transaction'], capture_output=True, timeout=30)
        assert delayed.returncode != 0, 'A delayed pip writer must refuse a completed recovery'
        assert package_version() == '0.1.0'
        assert_data_hashes(original_hashes, task='external-repair-restores-exact-history')
        assert list((home / 'backups').glob('retained-pip-*/.dsh-local/new-during-pip.txt'))
        run('status')
        run('check', '--port', '0', '--timeout', '1800')
        results.append({'task': 'external-repair-with-cli-and-pip-record-deleted', 'status': 'PASS'})
    # Import into a new home using the same application; original source stays byte identical.
    copied = home.parent / (home.name + '-imported')
    with exclusive(copied):
        Manager(copied, bundle).import_legacy(home, stopped=True)
    assert_data_hashes(original_hashes, copied, task='legacy-import-preserves-history')
    assert_data_hashes(original_hashes, task='legacy-import-preserves-source')
    # A historical schema-2 database must migrate without losing any experiment or revision.
    with closing(sqlite3.connect(copied / '.dsh-local/experiments.sqlite')) as db:
        db.execute('DROP TABLE robot_runs')
        db.execute('PRAGMA user_version=2')
        db.commit()
    subprocess.run([sys.executable, '-m', 'moss_lab', '--home', str(copied), 'check', '--port', '0', '--timeout', '1800'], check=True, capture_output=True, timeout=2000)
    with closing(sqlite3.connect(copied / '.dsh-local/experiments.sqlite')) as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 3
        assert {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in counts} == counts
    assert_data_hashes(original_hashes, task='legacy-migration-preserves-source')
    results.append({'task': 'legacy-import-schema2-migration-retains-real-experiments-and-source', 'status': 'PASS'})
finally:
    (report / 'installed-pip.json').write_text(json.dumps({'platform': sys.platform, 'results': results}, indent=2) + '\n')
    print(json.dumps(results))
