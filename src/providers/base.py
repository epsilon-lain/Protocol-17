"""Abstract base for Protocol 17 model providers."""

from abc import ABC, abstractmethod


class BaseProvider(ABC):
    """A model provider that accepts a system prompt + user content and returns
    plain generated text.

    Provider-specific request/response formats must not leak into Protocol
    fidelity rules, target verification, or compiler logic.
    """

    @abstractmethod
    def chat_completion(self, system_prompt: str, user_content: str,
                        model: str) -> str:
        """Send a chat completion request.

        Args:
            system_prompt: The system-level instructions.
            user_content: The user message (P17 source or code to explain).
            model: The model identifier selected by the user.

        Returns:
            The plain text response from the model.

        Raises:
            RuntimeError: On provider, API, or authentication failure.
            ImportError: If a required provider SDK is not installed.
        """
        ...
