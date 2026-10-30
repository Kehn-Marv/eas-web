"""Setup loop capability — EAS inspecting and changing its own configuration."""

from eas.capabilities.setup.capability import SetupCapability
from eas.capabilities.setup.tools import SETUP_TOOL_NAMES, SETUP_TOOL_TYPES

__all__ = ["SETUP_TOOL_NAMES", "SETUP_TOOL_TYPES", "SetupCapability"]
