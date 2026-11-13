"""Compare both versions' Chromium results on the same runner."""

import json
import math
import os
import statistics
import sys
from pathlib import Path


def load(directory, version, robot):
    path = directory / f"{version}-{robot}.jsonl"
    return {record["kind"]: record for record in map(json.loads, path.read_text().splitlines())}


def summarize(samples, scenario, expected_count):
    rows = [row for row in samples if row["scenario"] == scenario]
    if len(rows) != expected_count:
        raise ValueError(f"Expected {expected_count} {scenario} samples, got {len(rows)}")
    times = sorted(row["ms"] for row in rows if row["ms"] is not None)
    failures = len(rows) - len(times)
    rank = math.ceil(0.9 * len(rows))
    median = round(statistics.median(times)) if times else None
    p90 = times[rank - 1] if rank <= len(times) else None
    return median, p90, failures


def main(directory):
    expected_count = int(os.environ.get("MOSS_EXPERIENCE_SAMPLES", "30"))
    print("| Robot | Browser scenario | Baseline median / P90 / failures | Candidate median / P90 / failures |")
    print("| --- | --- | --- | --- |")
    failures = []
    for robot in ("Flex", "OT-2"):
        baseline = load(directory, "baseline", robot)
        candidate = load(directory, "candidate", robot)
        new_rows = candidate["preview"]["samples"]
        for scenario in ("normal", "slow-setup", "failed-setup"):
            before = summarize(baseline["preview"]["samples"], scenario, expected_count)
            after = summarize(new_rows, scenario, expected_count)
            print(f"| {robot} | {scenario} | {before} | {after} |")
            if after[2] or after[1] is None:
                failures.append(f"{robot} {scenario}: candidate playback failed")
            elif scenario == "slow-setup" and (before[1] is None or after[1] > min(before[1] * 0.8, before[1] - 1000)):
                failures.append(f"{robot}: slow setup improvement fell below the target")
            elif scenario == "normal" and (before[1] is None or after[1] > max(before[1] * 1.15, before[1] + 300)):
                failures.append(f"{robot}: normal playback exceeded its comparison budget")
        if any(row["setupRequests"] for row in new_rows):
            failures.append(f"{robot}: setup was fetched before selection")
        if any(row["retryMs"] is None for row in new_rows if row["scenario"] == "failed-setup"):
            failures.append(f"{robot}: setup retry failed")
        if candidate["voice"]["recoveryMs"] is None:
            failures.append(f"{robot}: browser continuation after voice disconnect failed")
    if failures:
        raise SystemExit("\n".join(failures))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
