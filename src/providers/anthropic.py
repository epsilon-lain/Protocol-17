"""Anthropic provider — uses the Anthropic Messages API."""

import os

from .base import BaseProvider


class AnthropicProvider(BaseProvider):
    """Provider for Anthropic (Claude) models."""

    def chat_completion(self, system_prompt: str, user_content: str,
                        model: str) -> str:
        try:
            from anthropic import Anthropic
        except ImportError:
            raise RuntimeError(
                "Missing dependency: anthropic. Install with:\n"
                "  pip install anthropic"
            )

        api_key = os.environ.get("P17_API_KEY", "")

        if not api_key:
            raise RuntimeError(
                "P17_API_KEY must be set for the anthropic provider.\n"
                "Set it in your .p17.env file or shell environment."
            )

        client = Anthropic(api_key=api_key)

        try:
            response = client.messages.create(
                model=model,
                max_tokens=4096,
                system=system_prompt,
                messages=[
                    {"role": "user", "content": user_content},
                ],
                temperature=0.1,
            )
        except Exception as exc:
            msg = str(exc)
            if api_key and api_key in msg:
                msg = msg.replace(api_key, "<redacted>")
            raise RuntimeError(f"AI API call failed: {msg}")

        # Anthropic returns a list of content blocks; concatenate text blocks
        parts = []
        for block in response.content:
            if hasattr(block, "text"):
                parts.append(block.text)
        if not parts:
            raise RuntimeError("AI API returned empty response.")
        return "".join(parts).strip()
