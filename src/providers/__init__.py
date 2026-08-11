"""Protocol 17 provider layer — BYOK (Bring Your Own Key / Model)."""

import os
import sys

from .base import BaseProvider

# Public API
__all__ = ["BaseProvider", "get_provider", "PROVIDER_NAMES"]

PROVIDER_NAMES = {
    "openai-compatible": "OpenAICompatibleProvider",
    "anthropic": "AnthropicProvider",
    "gemini": "GeminiProvider",
}


def get_provider() -> BaseProvider:
    """Return a provider instance based on P17_PROVIDER env var.

    Defaults to 'openai-compatible' for backward compatibility.
    """
    provider_name = os.environ.get("P17_PROVIDER", "openai-compatible")

    if provider_name == "openai-compatible":
        from .openai_compatible import OpenAICompatibleProvider
        return OpenAICompatibleProvider()
    elif provider_name == "anthropic":
        from .anthropic import AnthropicProvider
        return AnthropicProvider()
    elif provider_name == "gemini":
        from .gemini import GeminiProvider
        return GeminiProvider()
    else:
        known = ", ".join(sorted(PROVIDER_NAMES.keys()))
        sys.exit(
            f"Unknown P17_PROVIDER: {provider_name!r}. "
            f"Choose from: {known}"
        )
