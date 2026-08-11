"""Gemini provider — uses the official Google Gen AI SDK (google-genai)."""

import os

from .base import BaseProvider


class GeminiProvider(BaseProvider):
    """Provider for Google Gemini models via the google-genai SDK."""

    def chat_completion(self, system_prompt: str, user_content: str,
                        model: str) -> str:
        try:
            from google import genai
            from google.genai import types
        except ImportError:
            raise RuntimeError(
                "Missing dependency: google-genai. Install with:\n"
                "  pip install google-genai"
            )

        api_key = os.environ.get("P17_API_KEY", "")

        if not api_key:
            raise RuntimeError(
                "P17_API_KEY must be set for the gemini provider.\n"
                "Set it in your .p17.env file or shell environment."
            )

        client = genai.Client(api_key=api_key)

        try:
            response = client.models.generate_content(
                model=model,
                contents=user_content,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    system_instruction=system_prompt,
                ),
            )
        except Exception as exc:
            msg = str(exc)
            if api_key and api_key in msg:
                msg = msg.replace(api_key, "<redacted>")
            raise RuntimeError(f"AI API call failed: {msg}")

        if not response.text:
            raise RuntimeError("AI API returned empty response.")
        return response.text.strip()
