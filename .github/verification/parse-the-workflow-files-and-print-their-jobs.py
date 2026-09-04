"""Parses every file in .github/workflows/ and prints what GitHub would find.

    python .github/verification/parse-the-workflow-files-and-print-their-jobs.py

A workflow with a YAML syntax error, a job with no steps, or a step whose `uses:`
carries no version does not fail loudly on GitHub - it fails to run, or it runs
against a moving target, and a pipeline nobody notices is switched off is worse
than no pipeline. This is the one verification in the repository that verifies
the pipeline itself, which is why it is the first step of the tier that needs no
SDK: it is checked by the thing it checks.

What it asserts, and exits 1 with the offending file and value if any fails:
  1. every .yml / .yaml file under .github/workflows/ parses as YAML
  2. each declares `on` and a non-empty `jobs` mapping
  3. each job names `runs-on` and has at least one step
  4. every step has a name, so a CI log names what it is doing
  5. every `uses:` names an action AND a version after the `@`; a bare action
     name, or `@main`, or `@master`, is a dependency on whatever someone pushed
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent.parent
WORKFLOW_DIRECTORY = REPOSITORY_ROOT / ".github" / "workflows"

VERSIONS_THAT_ARE_NOT_A_VERSION = {"main", "master", "latest", "HEAD"}


def main() -> int:
    print(f"reading workflow directory: {WORKFLOW_DIRECTORY}")
    if not WORKFLOW_DIRECTORY.is_dir():
        print(f"  {WORKFLOW_DIRECTORY} does not exist, so this repository has no CI at all")
        return 1

    workflow_paths = sorted(
        path for path in WORKFLOW_DIRECTORY.iterdir() if path.suffix in {".yml", ".yaml"}
    )
    if not workflow_paths:
        print(f"  no .yml or .yaml file in {WORKFLOW_DIRECTORY}, so GitHub would run nothing")
        return 1

    print(f"  {len(workflow_paths)} workflow file(s): {', '.join(path.name for path in workflow_paths)}")
    print()

    complaints: list[str] = []
    total_jobs = 0
    total_steps = 0
    actions_used: dict[str, set[str]] = {}

    for path in workflow_paths:
        relative = path.relative_to(REPOSITORY_ROOT).as_posix()
        text = path.read_text(encoding="utf-8")
        print(f"{relative}  ({len(text)} bytes)")

        try:
            document = yaml.safe_load(text)
        except yaml.YAMLError as failure:
            complaints.append(f"{relative}: is not valid YAML, so GitHub would not run it: {failure}")
            print("  DOES NOT PARSE")
            continue

        if not isinstance(document, dict):
            complaints.append(f"{relative}: parsed as {type(document).__name__}, not a mapping")
            continue

        print(f"  name: {document.get('name', '(none declared)')}")

        # `on:` is the YAML 1.1 boolean True once PyYAML has read it, which is a
        # real trap: the key is present under a name nobody would grep for.
        trigger_key = "on" if "on" in document else (True if True in document else None)
        if trigger_key is None:
            complaints.append(f"{relative}: declares no `on:`, so nothing would ever start it")
        else:
            triggers = document[trigger_key]
            spelled = ", ".join(triggers) if isinstance(triggers, (dict, list)) else str(triggers)
            print(f"  on: {spelled}")

        jobs = document.get("jobs")
        if not isinstance(jobs, dict) or not jobs:
            complaints.append(f"{relative}: declares no jobs")
            continue

        for job_id, job in jobs.items():
            total_jobs += 1
            if not isinstance(job, dict):
                complaints.append(f"{relative}: job '{job_id}' is not a mapping")
                continue

            runs_on = job.get("runs-on")
            if runs_on is None:
                complaints.append(f"{relative}: job '{job_id}' names no runs-on")
            runs_on_spelled = ", ".join(runs_on) if isinstance(runs_on, list) else str(runs_on)

            steps = job.get("steps")
            if not isinstance(steps, list) or not steps:
                complaints.append(f"{relative}: job '{job_id}' has no steps")
                steps = []

            print(f"  job '{job_id}': runs-on {runs_on_spelled}, {len(steps)} step(s), timeout-minutes {job.get('timeout-minutes', '(none)')}")

            for index, step in enumerate(steps, start=1):
                total_steps += 1
                if not isinstance(step, dict):
                    complaints.append(f"{relative}: job '{job_id}' step {index} is not a mapping")
                    continue

                step_name = step.get("name")
                if not step_name:
                    complaints.append(f"{relative}: job '{job_id}' step {index} has no name")
                    step_name = "(unnamed)"

                uses = step.get("uses")
                if uses is None:
                    print(f"    {index:>2}. {step_name}   [run]")
                    continue

                print(f"    {index:>2}. {step_name}   [uses {uses}]")
                if "@" not in uses:
                    complaints.append(
                        f"{relative}: job '{job_id}' step {index} uses '{uses}' with no version after '@'"
                    )
                    continue
                action, version = uses.rsplit("@", 1)
                if version in VERSIONS_THAT_ARE_NOT_A_VERSION:
                    complaints.append(
                        f"{relative}: job '{job_id}' step {index} uses '{uses}', which follows whatever "
                        f"was last pushed to '{version}' rather than a released version"
                    )
                actions_used.setdefault(action, set()).add(version)
        print()

    print(f"every action referenced, and at which version:")
    for action in sorted(actions_used):
        print(f"  {action:<28} {', '.join(sorted(actions_used[action]))}")
    print()

    if complaints:
        print(f"{len(complaints)} problem(s) in {len(workflow_paths)} workflow file(s):", file=sys.stderr)
        for complaint in complaints:
            print(f"  {complaint}", file=sys.stderr)
        return 1

    print(
        f"{len(workflow_paths)} workflow file(s) parse, declaring {total_jobs} job(s) and {total_steps} named "
        f"step(s); every one of the {len(actions_used)} actions used names a version"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
