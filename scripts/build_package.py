#!/usr/bin/env python3
"""Build the installable Bootstrap ZIP used by GitHub Releases."""

from __future__ import annotations

import argparse
import json
import re
import stat
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
PACKAGE_FILES = (
    Path("README.md"),
    Path("SKILL.md"),
    Path("VERSION"),
    Path("release.json"),
    Path("bootstrap-profile.json"),
    Path("references/configuration.md"),
    Path("scripts/check_version.mjs"),
    Path("scripts/skillctl.mjs"),
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not VERSION_PATTERN.fullmatch(version):
        raise SystemExit(f"ERROR: invalid VERSION: {version!r}")
    missing = [str(path) for path in PACKAGE_FILES if not (ROOT / path).is_file()]
    if missing:
        raise SystemExit(f"ERROR: missing package files: {', '.join(missing)}")

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    profile = json.loads((ROOT / "bootstrap-profile.json").read_text(encoding="utf-8"))
    channel = profile.get("channel")
    if channel not in {"test", "production"}:
        raise SystemExit(f"ERROR: invalid Bootstrap channel: {channel!r}")
    artifact_name = f"adgine-skill-bootstrap-{version}.zip"
    if channel == "test":
        artifact_name = f"adgine-skill-bootstrap-test-{version}.zip"
    artifact = output / artifact_name
    with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in PACKAGE_FILES:
            source = ROOT / relative
            info = zipfile.ZipInfo(relative.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if source.stat().st_mode & stat.S_IXUSR else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, source.read_bytes())
    print(artifact)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
