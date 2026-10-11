"""Offline retrieval benchmark metrics with optional EvaluationRecord persistence."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from packages.shared.evaluation import evaluate_benchmark, persist


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "benchmark", type=Path, help="JSON benchmark with retrieved results and gold labels"
    )
    parser.add_argument("--output", type=Path, help="Write metrics JSON to this file")
    args = parser.parse_args()
    result = evaluate_benchmark(json.loads(args.benchmark.read_text(encoding="utf-8")))
    rendered = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    asyncio.run(persist(result))


if __name__ == "__main__":
    main()
