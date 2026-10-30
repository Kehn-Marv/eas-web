"""Factory registry for built-in and external chat-loop extensions."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
import importlib
import logging
from typing import cast

from eas.capabilities.protocol import LoopExtension
from eas.core.context import UnifiedContext
from eas.runtime.capability_catalog import EmptyConfig, get_capability_catalog

logger = logging.getLogger(__name__)

LoopFactory = Callable[[], LoopExtension]


@dataclass(frozen=True, slots=True)
class LoopCapabilitySpec:
    """Import-free descriptor for a built-in chat-loop extension."""

    name: str
    class_path: str

    def create(self) -> LoopExtension:
        module_path, class_name = self.class_path.rsplit(":", 1)
        factory = getattr(importlib.import_module(module_path), class_name)
        extension = factory()
        if getattr(extension, "name", None) != self.name:
            raise RuntimeError(
                f"Loop capability descriptor drift for {self.class_path}: "
                f"expected {self.name!r}, got {getattr(extension, 'name', None)!r}"
            )
        return cast(LoopExtension, extension)

    def __call__(self) -> LoopExtension:
        return self.create()


BUILTIN_LOOP_CAPABILITY_SPECS: tuple[LoopCapabilitySpec, ...] = (
    LoopCapabilitySpec(
        "ask_questions",
        "eas.capabilities.ask_questions.loop:AskQuestionsLoopCapability",
    ),
    LoopCapabilitySpec("mastery", "eas.capabilities.mastery.loop:MasteryLoopCapability"),
    LoopCapabilitySpec("solve", "eas.capabilities.solve.loop:SolveLoopCapability"),
    LoopCapabilitySpec(
        "immersive_reading",
        "eas.capabilities.reading.capability:ReadingCapability",
    ),
    LoopCapabilitySpec(
        "course_study",
        "eas.capabilities.course_study.capability:CourseStudyLoopCapability",
    ),
    LoopCapabilitySpec(
        "explore_context",
        "eas.capabilities.explore_context.capability:ExploreContextCapability",
    ),
    LoopCapabilitySpec("setup", "eas.capabilities.setup.capability:SetupCapability"),
    LoopCapabilitySpec(
        "visualization_generation",
        "eas.visualizers.loop_capability:VisualizationLoopCapability",
    ),
)

# Compatibility surface: the descriptors remain zero-argument callables.
LOOP_EXTENSION_FACTORIES: tuple[LoopFactory, ...] = cast(
    tuple[LoopFactory, ...], BUILTIN_LOOP_CAPABILITY_SPECS
)


def _builtin_loop_extensions() -> tuple[LoopExtension, ...]:
    return tuple(factory() for factory in LOOP_EXTENSION_FACTORIES)


class _LegacyLoopCapabilitiesView(Sequence[LoopExtension]):
    """Deprecated sequence view that never retains extension instances."""

    def __len__(self) -> int:
        return len(LOOP_EXTENSION_FACTORIES)

    def __iter__(self) -> Iterator[LoopExtension]:
        return iter(_builtin_loop_extensions())

    def __getitem__(self, index):  # noqa: ANN001, ANN204
        return _builtin_loop_extensions()[index]


LOOP_CAPABILITIES: Sequence[LoopExtension] = _LegacyLoopCapabilitiesView()


def _register_loop_entry(name: str, factory: LoopFactory) -> None:
    preview = factory()
    get_capability_catalog().register(
        name=name,
        kind="loop_extension",
        manifest={"name": name, "owned_tools": tuple(preview.owned_tools)},
        factory=factory,
        config_model=EmptyConfig,
        replace=True,
    )


def all_loop_capabilities() -> tuple[LoopExtension, ...]:
    """Create an isolated extension set for the caller's turn."""

    specs: list[tuple[str, LoopFactory]] = []
    specs.extend((spec.name, spec) for spec in BUILTIN_LOOP_CAPABILITY_SPECS)
    for name, factory in specs:
        _register_loop_entry(name, factory)
    catalog = get_capability_catalog()
    return tuple(
        cast(LoopExtension, catalog.create("loop_extension", name)) for name, _factory in specs
    )


def active_loop_capabilities(context: UnifiedContext) -> tuple[LoopExtension, ...]:
    return tuple(extension for extension in all_loop_capabilities() if extension.is_active(context))


def any_exclusive_capability_active(context: UnifiedContext) -> bool:
    return any(
        getattr(extension, "exclusive_tools", False)
        for extension in active_loop_capabilities(context)
    )


def capability_tool_owners() -> dict[str, str]:
    return {
        name: extension.name
        for extension in all_loop_capabilities()
        for name in extension.owned_tools
    }


__all__ = [
    "BUILTIN_LOOP_CAPABILITY_SPECS",
    "LOOP_CAPABILITIES",
    "LOOP_EXTENSION_FACTORIES",
    "active_loop_capabilities",
    "all_loop_capabilities",
    "any_exclusive_capability_active",
    "capability_tool_owners",
]
