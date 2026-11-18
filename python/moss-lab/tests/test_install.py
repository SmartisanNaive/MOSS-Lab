"""Exercise real files, SQLite data and application processes through upgrade boundaries."""
import hashlib
import contextlib
import io
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
from moss_lab.install import Bundle, Manager, atomic_json, exclusive, extract
from moss_lab.process import StopUncertain

NODE = shutil.which("node")
BOOT = r'''
import {createInterface} from 'node:readline';import fs from 'node:fs';import path from 'node:path';
import http from 'node:http';import {DatabaseSync} from 'node:sqlite';
const input=createInterface({input:process.stdin,terminal:false});let go=false;
input.once('line',line=>{
 if(line!=='MOSS_START'){input.close();return}go=true;input.close();
 const home=process.env.MOSS_HOME;
 if(MODE==='fail'){
  fs.writeFileSync(path.join(home,'.env'),'BROKEN=1\n');
  const db=new DatabaseSync(path.join(home,'.dsh-local','experiments.sqlite'));
  db.exec('DELETE FROM experiments');db.close();process.exit(1);
 }
 const server=http.createServer((req,res)=>{
  if(req.url==='/api/moss-install-ready'&&MODE!=='html-only'){
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({ready:true,nonce:process.env.MOSS_RUN_NONCE,identity:process.env.MOSS_RELEASE_ID}));
  }else res.end('<html><body>MOSS fixture</body></html>')
 });
 const at=process.argv.indexOf('--port');server.listen(Number(process.argv[at+1]),'127.0.0.1',()=>{
  console.log('dsh web: http://127.0.0.1:'+server.address().port+'/');
 });
});input.once('close',()=>{if(!go)process.exitCode=1});
'''


class NativeFixtureBundle(Bundle):
    def install(self, home):
        directory = super().install(home)
        if sys.platform == "darwin":
            # Share the existing native fixture inode to avoid repeated macOS
            # executable trust scans. Windows tests execute the extracted binary.
            binary = directory / "node"
            if not os.path.samefile(binary, NODE):
                temporary = directory / "node-fixture"
                os.link(Path(NODE).resolve(), temporary)
                os.replace(temporary, binary)
        return directory


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="MOSS 中文 spaces ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "user home"
        self.home.mkdir()
        (self.home / ".env").write_text("AI_API_KEY=test-private\nMOSS_ALLOW_LIVE_ROBOT=0\n")
        data = self.home / ".dsh-local"
        data.mkdir()
        (data / "conversation.jsonl").write_text('{"message":"保留我的实验"}\n', encoding="utf-8")
        with closing(sqlite3.connect(data / "experiments.sqlite")) as database:
            database.execute("CREATE TABLE experiments(id TEXT PRIMARY KEY, revision INTEGER)")
            database.execute("INSERT INTO experiments VALUES ('old-experiment', 2)")
            database.commit()
        self.original = self.files()

    def files(self):
        files = [self.home / ".env", *(self.home / ".dsh-local").rglob("*")]
        return {str(p.relative_to(self.home)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in files if p.is_file()}

    def bundle(self, version="0.1.0", mode="good"):
        if not NODE:
            self.fail("Node is required for application process tests")
        folder = self.root / ("bundle-" + version)
        folder.mkdir()
        archive = folder / "application.zip"
        node_name = "node.exe" if os.name == "nt" else "node"
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.write(NODE, node_name)
            zipped.writestr("app.mjs", BOOT.replace("MODE", json.dumps(mode)))
        atomic_json(folder / "manifest.json", {"schema": 1, "manager_api": 1, "version": version,
                    "platform": sys.platform, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                    "node": node_name, "entry": "app.mjs"})
        return NativeFixtureBundle(folder)

    def activate(self, manager):
        return manager.activate(manager.bundle, port=0, timeout=20)

    def test_log_creation_failure_never_launches_a_process(self):
        manager = Manager(self.home, self.bundle())
        manager.bundle.install(self.home)
        original_open = Path.open
        def denied(path, *args, **kwargs):
            if path.parent == manager.home / "logs":
                raise PermissionError("log denied")
            return original_open(path, *args, **kwargs)
        with patch.object(Path, "open", denied), patch("moss_lab.install.ApplicationProcess") as launch:
            with self.assertRaisesRegex(PermissionError, "log denied"):
                manager.run_release(manager.bundle.id, port=0, verify=True, no_open=True, timeout=20)
            launch.assert_not_called()

    def test_reader_start_failure_stops_the_real_application_before_returning(self):
        from moss_lab.process import ApplicationProcess
        manager = Manager(self.home, self.bundle())
        manager.bundle.install(self.home)
        children = []
        def launch(*args, **kwargs):
            application = ApplicationProcess(*args, **kwargs)
            children.append(application)
            return application
        with patch("moss_lab.install.ApplicationProcess", side_effect=launch), patch("moss_lab.install.threading.Thread.start", side_effect=RuntimeError("reader denied")):
            with self.assertRaisesRegex(RuntimeError, "reader denied"):
                manager.run_release(manager.bundle.id, port=0, verify=True, no_open=True, timeout=20)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].child.poll())

    def test_failed_new_application_restores_exact_config_database_and_conversation(self):
        old = self.bundle()
        first = Manager(self.home, old)
        self.activate(first)
        bad = Manager(self.home, self.bundle("0.1.1", "fail"))
        with self.assertRaisesRegex(RuntimeError, "before readiness"):
            self.activate(bad)
        self.assertEqual(self.files(), self.original)
        self.assertEqual(bad.state()["current"], old.id)
        self.assertEqual(bad.state()["blocked"], bad.bundle.id)
        self.assertFalse(bad.journal_path.exists())
        self.assertTrue(list((self.home / "backups").glob("retained-*")))
        bad.start(verify=True, no_open=True, port=0, timeout=20)
        self.assertEqual(self.files(), self.original)

    def test_successful_upgrade_and_manual_rollback_preserve_both_generations(self):
        old = self.bundle()
        self.activate(Manager(self.home, old))
        new = Manager(self.home, self.bundle("0.1.2"))
        self.activate(new)
        (self.home / ".dsh-local" / "new-after-upgrade.txt").write_text("keep this too")
        new.rollback()
        self.assertEqual(self.files(), self.original)
        self.assertEqual(new.state()["current"], old.id)
        self.assertEqual(new.state()["blocked"], new.bundle.id)
        self.assertEqual(len(list((self.home / "backups").glob("retained-*/.dsh-local/new-after-upgrade.txt"))), 1)

    def test_uncertain_shutdown_keeps_journal_and_never_restores_or_starts_old_data(self):
        old = self.bundle()
        self.activate(Manager(self.home, old))
        manager = Manager(self.home, self.bundle("0.1.1"))
        with patch.object(manager, "run_release", side_effect=StopUncertain("uncertain tree")), patch.object(manager, "restore") as restore:
            with self.assertRaises(StopUncertain):
                manager.start(verify=True, port=0)
            restore.assert_not_called()
        self.assertTrue(manager.journal_path.exists())
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            manager.recover(stopped=False)
        manager.recover(stopped=True)
        self.assertEqual(self.files(), self.original)

    def test_exclusive_home_lock_rejects_a_second_real_process(self):
        code = "from pathlib import Path;from moss_lab.install import exclusive;import sys\nwith exclusive(Path(sys.argv[1])):print('acquired')"
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")}
        with exclusive(self.home):
            result = subprocess.run([sys.executable, "-c", code, str(self.home)], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("acquired", result.stdout)
        self.assertIn("MOSS is running", result.stderr)

    def test_import_copies_old_data_without_touching_the_original(self):
        target = self.root / "new home"
        manager = Manager(target, self.bundle())
        with self.assertRaisesRegex(RuntimeError, "Stop the old"):
            manager.import_legacy(self.home, stopped=False)
        manager.import_legacy(self.home, stopped=True)
        self.assertEqual(self.files(), self.original)
        self.assertEqual((target / ".env").read_bytes(), (self.home / ".env").read_bytes())
        with closing(sqlite3.connect(target / ".dsh-local/experiments.sqlite")) as database:
            self.assertEqual(database.execute("SELECT * FROM experiments").fetchall(), [("old-experiment", 2)])
        with self.assertRaisesRegex(RuntimeError, "already has data"):
            manager.import_legacy(self.home, stopped=True)

    def test_incomplete_or_escaping_backup_is_rejected(self):
        manager = Manager(self.home, self.bundle())
        for path in [self.root, self.home / "backups/../../elsewhere"]:
            with self.assertRaisesRegex(RuntimeError, "incomplete or outside"):
                manager.restore(path)
        self.assertEqual(self.files(), self.original)

    def test_interrupted_import_can_complete_without_overwriting_either_generation(self):
        target = self.root / "new home"
        manager = Manager(target, self.bundle())
        replace = os.replace

        def fail_env(source, destination):
            if str(source).endswith(".env"):
                raise OSError("simulated second rename failure")
            return replace(source, destination)

        with patch("moss_lab.install.os.replace", side_effect=fail_env):
            with self.assertRaisesRegex(OSError, "second rename"):
                manager.import_legacy(self.home, stopped=True)
        self.assertTrue((target / "import.json").is_file())
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            manager.recover(stopped=False)
        manager.recover(stopped=True)
        self.assertEqual((target / ".env").read_bytes(), (self.home / ".env").read_bytes())
        self.assertEqual(self.files(), self.original)
        self.assertFalse((target / "import.json").exists())

    def test_import_rejects_nested_linked_data_without_changing_its_target(self):
        outside = self.root / "outside"
        outside.mkdir()
        secret = outside / "result.txt"
        secret.write_text("unchanged")
        link = self.home / ".dsh-local" / "linked-experiment"
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)
        else:
            link.symlink_to(outside, target_is_directory=True)
        manager = Manager(self.root / "new home", self.bundle())
        with self.assertRaisesRegex(RuntimeError, "Linked"):
            manager.import_legacy(self.home, stopped=True)
        self.assertEqual(secret.read_text(), "unchanged")

    def test_unrelated_html_endpoint_cannot_activate_an_application(self):
        manager = Manager(self.home, self.bundle(mode="html-only"))
        with self.assertRaises((RuntimeError, json.JSONDecodeError)):
            self.activate(manager)
        self.assertIsNone(manager.state()["current"])
        self.assertEqual(self.files(), self.original)


class ProcessTreeTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows Job Object kernel behavior")
    def test_abrupt_manager_exit_stops_the_node_grandchild(self):
        import ctypes
        import time
        with tempfile.TemporaryDirectory(prefix="MOSS job 中文 ") as folder:
            root = Path(folder)
            (root / "child.mjs").write_text("import{createInterface}from'node:readline';import{spawn}from'node:child_process';import fs from'node:fs';const r=createInterface({input:process.stdin});r.once('line',()=>{r.close();const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)});")
            code = "from pathlib import Path;import os,sys,time;from moss_lab.process import ApplicationProcess\np=ApplicationProcess([sys.argv[1],'child.mjs'],cwd=Path(sys.argv[2]),env=dict(os.environ))\nwhile not (Path(sys.argv[2])/'pids.json').exists():time.sleep(.05)\nos._exit(91)"
            parent = subprocess.run([sys.executable, "-c", code, NODE, str(root)],
                env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")}, timeout=30)
            self.assertEqual(parent.returncode, 91)
            pids = json.loads((root / "pids.json").read_text())
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.restype = ctypes.c_void_p
            kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            for pid in pids:
                handle = kernel.OpenProcess(0x100000, False, pid)
                if handle:
                    self.assertEqual(kernel.WaitForSingleObject(handle, 10000), 0, f"Orphan process {pid}")
                    kernel.CloseHandle(handle)


class ArchiveTests(unittest.TestCase):
    def test_missing_pip_record_cannot_create_an_empty_recovery_wheel(self):
        from moss_lab.update import installed_wheel
        with tempfile.TemporaryDirectory() as folder, patch("moss_lab.update.importlib.metadata.distribution") as distribution:
            distribution.return_value.files = None
            with self.assertRaisesRegex(RuntimeError, "record is missing"):
                installed_wheel(Path(folder))
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_incomplete_recovery_wheel_never_replaces_the_installed_namespace(self):
        from moss_lab.recovery import restore_package
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            package = root / "moss_lab"
            package.mkdir()
            (package / "cli.py").write_text("existing installer")
            with zipfile.ZipFile(root / "incomplete.whl", "w") as archive:
                archive.writestr("moss_lab-0.1.0.dist-info/RECORD", "")
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                restore_package(root / "incomplete.whl", root)
            self.assertEqual((package / "cli.py").read_text(), "existing installer")

    def test_command_help_matches_the_shipped_user_entry(self):
        from moss_lab.cli import main
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as exit:
            main(["--help"])
        self.assertEqual(exit.exception.code, 0)
        self.assertEqual(output.getvalue(), Path(__file__).with_name("expected-help.txt").read_text())

    def test_rejects_traversal_links_duplicate_names_and_windows_aliases(self):
        for names in [["../escape"], ["C:/escape"], ["normal", "NORMAL"], ["a\\escape"]]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                with zipfile.ZipFile(root / "bad.zip", "w") as archive:
                    for name in names:
                        entry = zipfile.ZipInfo()
                        entry.filename = name
                        archive.writestr(entry, b"bad")
                with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                    extract(root / "bad.zip", root / "out")
                self.assertFalse((root / "escape").exists())


if __name__ == "__main__":
    unittest.main()
