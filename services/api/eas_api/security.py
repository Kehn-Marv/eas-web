"""Small bounded process-local request limiter for the single-service MVP."""

from collections import deque


class InMemoryRateLimiter:
    def __init__(self, limit: int, window_seconds: int, max_clients: int = 10_000):
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_clients = max_clients
        self._requests: dict[str, deque[float]] = {}

    def retry_after(self, key: str, now: float) -> int | None:
        cutoff = now - self.window_seconds
        timestamps = self._requests.get(key)
        if timestamps is not None:
            while timestamps and timestamps[0] <= cutoff:
                timestamps.popleft()
            if not timestamps:
                del self._requests[key]
                timestamps = None

        if timestamps is None:
            if len(self._requests) >= self.max_clients:
                # Reclaim expired identities before failing closed on a new one.
                for client, entries in list(self._requests.items()):
                    while entries and entries[0] <= cutoff:
                        entries.popleft()
                    if not entries:
                        del self._requests[client]
                if len(self._requests) >= self.max_clients:
                    return 1
            timestamps = deque()
            self._requests[key] = timestamps

        if len(timestamps) >= self.limit:
            return max(1, int(timestamps[0] + self.window_seconds - now + 0.999))
        timestamps.append(now)
        return None
