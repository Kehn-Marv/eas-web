import asyncio
import os
import shutil
from pathlib import Path, PurePosixPath
from typing import Protocol


class StorageProvider(Protocol):
    async def put_file(self, key: str, source: Path, content_type: str) -> None: ...

    async def get_file(self, key: str, destination: Path) -> None: ...

    async def delete(self, key: str) -> None: ...


def _validate_key(key: str) -> str:
    path = PurePosixPath(key)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("Invalid object key")
    return path.as_posix()


class FilesystemStorage:
    """Private local storage for development; deploy persistent production storage."""

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            self.root.chmod(0o700)

    async def put_file(self, key: str, source: Path, content_type: str) -> None:
        del content_type
        safe_key = _validate_key(key)
        destination = (self.root / Path(*PurePosixPath(safe_key).parts)).resolve()
        if not destination.is_relative_to(self.root):
            raise ValueError("Object path escapes storage root")
        destination.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copyfile, source, destination)
        if os.name != "nt":
            await asyncio.to_thread(destination.chmod, 0o600)

    async def get_file(self, key: str, destination: Path) -> None:
        safe_key = _validate_key(key)
        source = (self.root / Path(*PurePosixPath(safe_key).parts)).resolve()
        if not source.is_relative_to(self.root):
            raise ValueError("Object path escapes storage root")
        await asyncio.to_thread(shutil.copyfile, source, destination)

    async def delete(self, key: str) -> None:
        safe_key = _validate_key(key)
        destination = (self.root / Path(*PurePosixPath(safe_key).parts)).resolve()
        if destination.is_relative_to(self.root):
            await asyncio.to_thread(destination.unlink, missing_ok=True)


class S3Storage:
    def __init__(self, bucket: str, region: str | None = None, endpoint_url: str | None = None):
        import boto3

        self.bucket = bucket
        self.client = boto3.client("s3", region_name=region, endpoint_url=endpoint_url)

    async def put_file(self, key: str, source: Path, content_type: str) -> None:
        safe_key = _validate_key(key)
        await asyncio.to_thread(
            self.client.upload_file,
            str(source),
            self.bucket,
            safe_key,
            ExtraArgs={"ContentType": content_type, "ServerSideEncryption": "AES256"},
        )

    async def get_file(self, key: str, destination: Path) -> None:
        await asyncio.to_thread(
            self.client.download_file, self.bucket, _validate_key(key), str(destination)
        )

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(
            self.client.delete_object, Bucket=self.bucket, Key=_validate_key(key)
        )


def make_storage(
    backend: str, root: str, bucket: str | None, region: str | None, endpoint_url: str | None = None
) -> StorageProvider:
    if backend == "filesystem":
        return FilesystemStorage(root)
    if backend == "s3" and bucket:
        return S3Storage(bucket, region, endpoint_url)
    raise ValueError("STORAGE_BACKEND must be filesystem or s3 (with S3_BUCKET configured)")
