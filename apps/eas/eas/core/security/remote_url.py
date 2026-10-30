"""SSRF-safe validation for remote services configured by a deployment."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

_BLOCKED = tuple(
    ipaddress.ip_network(value)
    for value in (
        "0.0.0.0/8",
        "169.254.0.0/16",
        "fe80::/10",
        "fd00:ec2::254/128",
        "100.100.100.200/32",
        "::/128",
    )
)
_STRICT_BLOCKED = tuple(
    ipaddress.ip_network(value)
    for value in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "::1/128",
        "fc00::/7",
    )
)


def validate_remote_url(url: str, *, strict: bool = False) -> tuple[bool, str]:
    try:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            return False, f"Only http/https allowed, got {parsed.scheme or 'none'!r}"
        _ = parsed.port
    except (TypeError, ValueError) as exc:
        return False, str(exc)
    hostname = parsed.hostname
    if not hostname:
        return False, "Missing hostname"
    if parsed.username or parsed.password or parsed.fragment:
        return False, "Remote service URLs must not contain embedded credentials or fragments"
    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        return False, f"Cannot resolve hostname: {hostname}"
    resolved = False
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
            addr = addr.ipv4_mapped
        resolved = True
        if any(addr in network for network in _BLOCKED + (_STRICT_BLOCKED if strict else ())):
            return False, f"Blocked: {hostname} resolves to a disallowed address ({addr})"
    return (True, "") if resolved else (False, "No usable address resolved for this host")


async def validate_remote_url_async(
    url: str, *, strict: bool = False
) -> tuple[bool, str]:
    return await asyncio.to_thread(validate_remote_url, url, strict=strict)


__all__ = ["validate_remote_url", "validate_remote_url_async"]
