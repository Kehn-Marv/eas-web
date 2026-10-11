from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Declarative base for application persistence models."""


def make_engine(database_url: str, *, echo: bool = False):
    return create_async_engine(database_url, echo=echo, pool_pre_ping=True)


def make_session_factory(engine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def check_database(engine) -> bool:
    from sqlalchemy import text

    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))
    return True


async def session_dependency(factory) -> AsyncIterator[AsyncSession]:
    async with factory() as session:
        yield session
