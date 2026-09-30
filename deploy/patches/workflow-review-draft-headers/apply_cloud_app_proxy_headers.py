"""Create the reviewed cloud_app.py candidate from the exact downloaded production source."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


EXPECTED_SOURCE_SHA256 = "eb732b01c7a23ee9407f1d4e0954e39ddb32698613cf0cce4b56b111513192e3"
OLD = "        for name in ('Content-Type', 'Content-Disposition'):\n"
NEW = (
    "        for name in ('Content-Type', 'Content-Disposition',\n"
    "                     'X-Review-Draft-Sha256', 'X-Review-Draft-Engineering-Release'):\n"
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    if source == output:
        raise SystemExit("refusing to modify the downloaded production source in place")
    actual_source_sha256 = digest(source)
    if actual_source_sha256 != EXPECTED_SOURCE_SHA256:
        raise SystemExit(
            f"source SHA-256 mismatch: expected {EXPECTED_SOURCE_SHA256}, got {actual_source_sha256}"
        )

    text = source.read_text(encoding="utf-8")
    if text.count(OLD) != 1:
        raise SystemExit("expected proxy response allowlist statement was not found exactly once")
    candidate = text.replace(OLD, NEW)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(candidate, encoding="utf-8", newline="\n")
    temporary.replace(output)

    print(
        json.dumps(
            {
                "source": str(source),
                "source_sha256": actual_source_sha256,
                "output": str(output),
                "output_sha256": digest(output),
                "replacement_count": 1,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
