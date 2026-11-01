#!/usr/bin/env python3
"""Partition site-packages into size-balanced, transferable trees.

The resulting directories are copied into the same destination by separate
Docker COPY instructions. This avoids a single multi-gigabyte OCI layer while
keeping Python's installed package layout unchanged.
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--parts", type=int, default=64)
    args = parser.parse_args()

    source = args.source.resolve(strict=True)
    target = args.target.resolve()
    if args.parts < 2:
        parser.error("--parts must be at least 2")
    if target == source or source in target.parents:
        parser.error("target must not be inside source")
    if target.exists():
        shutil.rmtree(target)
    for index in range(args.parts):
        (target / f"{index:02d}").mkdir(parents=True)

    file_entries: list[tuple[int, str, Path]] = []
    directory_links: list[tuple[str, Path]] = []
    for root, dirs, file_names in os.walk(source, followlinks=False):
        root_path = Path(root)
        relative_root = root_path.relative_to(source)
        # Preserve symlinked directories as entries; os.walk otherwise lists
        # them in dirs without descending into them.
        for name in list(dirs):
            original = root_path / name
            if original.is_symlink():
                dirs.remove(name)
                relative = relative_root / name
                directory_links.append((relative.as_posix(), original))

        for name in file_names:
            original = root_path / name
            relative = relative_root / name
            size = 0 if original.is_symlink() else original.stat().st_size
            file_entries.append((size, relative.as_posix(), original))

    # Hashing only the path balances file counts, not bytes. ML wheels contain
    # a few very large shared libraries, so that approach can still create a
    # multi-gigabyte OCI layer. Greedy largest-first bin packing keeps each
    # COPY layer close to the same uncompressed size, deterministically.
    buckets: list[list[tuple[int, str, Path]]] = [[] for _ in range(args.parts)]
    bucket_sizes = [0] * args.parts
    for item in sorted(file_entries, key=lambda entry: (-entry[0], entry[1])):
        bucket = min(range(args.parts), key=lambda index: (bucket_sizes[index], index))
        buckets[bucket].append(item)
        bucket_sizes[bucket] += item[0]

    for index, entries in enumerate(buckets):
        for _, relative, original in entries:
            destination = target / f"{index:02d}" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if original.is_symlink():
                destination.symlink_to(_relocated_link(original, source))
            else:
                try:
                    os.link(original, destination)
                except OSError:
                    shutil.copy2(original, destination)

    for relative, original in directory_links:
        bucket = min(range(args.parts), key=lambda index: (bucket_sizes[index], index))
        destination = target / f"{bucket:02d}" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(_relocated_link(original, source), target_is_directory=True)

def _relocated_link(link: Path, source: Path) -> str:
    """Keep links valid after chunk trees are merged into site-packages."""
    raw_target = os.readlink(link)
    if os.path.isabs(raw_target):
        target = Path(raw_target)
        try:
            target_relative = target.relative_to(source)
        except ValueError:
            return raw_target
    else:
        target_relative = Path(os.path.normpath(os.path.join(
            os.fspath(link.parent.relative_to(source)), raw_target
        )))
    return os.path.relpath(target_relative, link.parent.relative_to(source))


if __name__ == "__main__":
    main()
