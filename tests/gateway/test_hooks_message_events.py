"""Smoke tests for message:received and message:sent hook event names.

The HookRegistry is generic over event-name strings, so the registration
here is largely about docstring discoverability + a guard that the registry
correctly dispatches handlers subscribed to these names.
"""
import pytest

from gateway.hooks import HookRegistry


@pytest.mark.asyncio
async def test_hooks_emit_message_received():
    reg = HookRegistry()
    received = []
    reg._handlers.setdefault("message:received", []).append(
        lambda et, ctx: received.append((et, ctx))
    )
    await reg.emit("message:received", {"chat_id": "X"})
    assert received == [("message:received", {"chat_id": "X"})]


@pytest.mark.asyncio
async def test_hooks_emit_message_sent():
    reg = HookRegistry()
    sent = []
    reg._handlers.setdefault("message:sent", []).append(
        lambda et, ctx: sent.append(ctx)
    )
    await reg.emit("message:sent", {"chat_id": "X", "hermes_origin": True})
    assert sent[0]["hermes_origin"] is True


def test_docstring_advertises_new_event_names():
    """Docstring is the canonical event catalog; tooling reads it."""
    from gateway import hooks
    assert "message:received" in hooks.__doc__
    assert "message:sent" in hooks.__doc__
