"""Bounded API session/readiness load smoke test (not a production capacity benchmark)."""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import Counter

import httpx


async def run(base_url: str, request_count: int, concurrency: int) -> dict[str, object]:
    timeout = httpx.Timeout(20.0)
    async with httpx.AsyncClient(base_url=base_url, timeout=timeout) as client:
        created = await client.post("/v1/sessions")
        created.raise_for_status()
        session_id = created.json()["session_id"]
        semaphore = asyncio.Semaphore(concurrency)
        latencies: list[float] = []
        statuses: Counter[int] = Counter()

        async def fetch() -> None:
            async with semaphore:
                started = time.perf_counter()
                response = await client.get(f"/v1/sessions/{session_id}")
                latencies.append(time.perf_counter() - started)
                statuses[response.status_code] += 1

        started = time.perf_counter()
        await asyncio.gather(*(fetch() for _ in range(request_count)))
        elapsed = time.perf_counter() - started
    latencies.sort()
    percentile_index = min(len(latencies) - 1, int(len(latencies) * 0.95))
    return {
        "requests": request_count,
        "concurrency": concurrency,
        "elapsed_seconds": round(elapsed, 3),
        "requests_per_second": round(request_count / elapsed, 2),
        "p95_latency_ms": round(latencies[percentile_index] * 1000, 2),
        "status_counts": dict(statuses),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--requests", type=int, default=60)
    parser.add_argument("--concurrency", type=int, default=8)
    args = parser.parse_args()
    if not 1 <= args.requests <= 1000 or not 1 <= args.concurrency <= 100:
        parser.error("requests must be 1..1000 and concurrency must be 1..100")
    print(json.dumps(asyncio.run(run(args.base_url, args.requests, args.concurrency)), indent=2))


if __name__ == "__main__":
    main()
