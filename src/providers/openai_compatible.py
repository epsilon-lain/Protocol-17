"""OpenAI-compatible provider — supports OpenAI, Ollama, DeepSeek, OpenRouter,
and any other endpoint that speaks the OpenAI chat completions API."""

import os

from .base import BaseProvider


class OpenAICompatibleProvider(BaseProvider):
    """Provider for any OpenAI-compatible chat completions endpoint."""

    def chat_completion(self, system_prompt: str, user_content: str,
                        model: str) -> str:
        try:
            from openai import OpenAI
        except ImportError:
            raise RuntimeError(
                "Missing dependency: openai. Install with:\n"
                "  pip install -r requirements.txt"
            )

        api_url = os.environ.get("P17_API_URL", "")
        api_key = os.environ.get("P17_API_KEY", "")

        if not api_url:
            raise RuntimeError(
                "P17_API_URL must be set for the openai-compatible provider.\n"
                "Set it in your .p17.env file or shell environment."
            )
        if not api_key:
            raise RuntimeError(
                "P17_API_KEY must be set.\n"
                "Set it in your .p17.env file or shell environment."
            )

        client = OpenAI(base_url=api_url, api_key=api_key)

        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.1,
            )
        except Exception as exc:
            # Never include the API key in error messages
            msg = str(exc)
            if api_key and api_key in msg:
                msg = msg.replace(api_key, "<redacted>")
            raise RuntimeError(f"AI API call failed: {msg}")

        content = response.choices[0].message.content
        if content is None:
            raise RuntimeError("AI API returned empty response.")
        return content.strip()
