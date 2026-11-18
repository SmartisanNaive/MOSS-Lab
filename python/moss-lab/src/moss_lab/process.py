"""Own the application process tree until every child has stopped."""
from __future__ import annotations

import ctypes
import os
import signal
import subprocess
import time
from pathlib import Path


class StopUncertain(RuntimeError):
    """Process-tree exit was not established; restoring data would be unsafe."""


class ApplicationProcess:
    """Start a waiting Node bootstrap, contain it, then permit application launch."""

    def __init__(self, command: list[str], *, cwd: Path, env: dict[str, str]):
        self.job = None
        self.child = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace", bufsize=1,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
        try:
            if os.name == "nt":
                self.job = WindowsJob(self.child)
            self.child.stdin.write("MOSS_START\n")
            self.child.stdin.flush()
            self.child.stdin.close()
        except BaseException:
            try:
                self.stop()
            except BaseException as error:
                raise StopUncertain("Bootstrap containment failed and shutdown is uncertain") from error
            raise

    def stop(self) -> None:
        """Terminate and await the owned tree; an uncertain stop remains an error."""
        if self.job is not None:
            self.job.stop()
            self.job = None
        elif os.name != "nt":
            if self.child.poll() is None:
                try:
                    os.killpg(self.child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    if self.child.poll() is None:
                        raise
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(self.child.pid, signal.SIGKILL)
        elif self.child.poll() is None:
            # Before job assignment the bootstrap only waits on stdin and cannot spawn.
            self.child.kill()
        self.child.wait(timeout=15)
        if self.child.stdin is not None:
            self.child.stdin.close()


if os.name == "nt":
    from ctypes import wintypes

    class _Limits(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                    ("flags", wintypes.DWORD), ("minimum", ctypes.c_size_t),
                    ("maximum", ctypes.c_size_t), ("active", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                    ("scheduling", wintypes.DWORD)]

    class _IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ["read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes"]]

    class _Extended(ctypes.Structure):
        _fields_ = [("basic", _Limits), ("io", _IO),
                    ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                    ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

    class _Accounting(ctypes.Structure):
        _fields_ = [("user", ctypes.c_int64), ("kernel", ctypes.c_int64),
                    ("period_user", ctypes.c_int64), ("period_kernel", ctypes.c_int64),
                    ("faults", wintypes.DWORD), ("total", wintypes.DWORD),
                    ("active", wintypes.DWORD), ("terminated", wintypes.DWORD)]

    class WindowsJob:
        """The waiting bootstrap closes the spawn-before-assignment race."""

        def __init__(self, child: subprocess.Popen):
            self.api = ctypes.WinDLL("kernel32", use_last_error=True)
            for name, args, result in [
                ("CreateJobObjectW", [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
                ("SetInformationJobObject", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
                ("AssignProcessToJobObject", [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
                ("TerminateJobObject", [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
                ("QueryInformationJobObject", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
                ("CloseHandle", [wintypes.HANDLE], wintypes.BOOL),
            ]:
                function = getattr(self.api, name)
                function.argtypes, function.restype = args, result
            self.handle = self.api.CreateJobObjectW(None, None)
            if not self.handle:
                raise ctypes.WinError(ctypes.get_last_error())
            limits = _Extended()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
            try:
                if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                    raise ctypes.WinError(ctypes.get_last_error())
                # CPython owns this process HANDLE for the lifetime of Popen. A PID
                # lookup would instead race process exit and PID reuse.
                if not self.api.AssignProcessToJobObject(self.handle, int(child._handle)):
                    raise ctypes.WinError(ctypes.get_last_error())
            except BaseException:
                self.api.CloseHandle(self.handle)
                raise

        def stop(self):
            if not self.api.TerminateJobObject(self.handle, 1):
                raise ctypes.WinError(ctypes.get_last_error())
            deadline = time.monotonic() + 15
            while True:
                accounting = _Accounting()
                if not self.api.QueryInformationJobObject(self.handle, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
                    raise ctypes.WinError(ctypes.get_last_error())
                if accounting.active == 0:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("MOSS processes have not stopped; data recovery was not attempted")
                time.sleep(0.05)
            self.api.CloseHandle(self.handle)
