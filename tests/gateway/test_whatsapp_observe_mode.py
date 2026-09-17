"""Tests for WhatsApp observe-mode hook emission, message:sent, and the
location of the inbound intake gate.

See ``TestBuildMessageEventOwnsTheIntakeGate`` at the bottom of this module:
those tests exist to pin an assumption the watcher now depends on, and must
not be deleted as redundant.
"""

import asyncio
import os
import pytest
from unittest.mock import AsyncMock, MagicMock
from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
from gateway.platforms.base import PlatformConfig


# Policy fixtures used by the intake-gate regression tests below.
# "pairing" accepts every DM unconditionally; "allowlist" with an empty
# allow_from rejects every DM. Together they give a positive/negative control
# pair, so a test asserting "no event" cannot pass vacuously.
_DM_ACCEPTED = {"dm_policy": "pairing"}
_DM_REJECTED = {"dm_policy": "allowlist", "allow_from": []}

_INBOUND_DM = {
    "chatId": "15551234567@s.whatsapp.net",
    "senderId": "15551234567@s.whatsapp.net",
    "fromMe": False,
    "isGroup": False,
    "messageId": "M-gate",
    "body": "hello",
    "timestamp": 1716000000,
}


@pytest.mark.asyncio
async def test_message_received_hook_fires_for_observe_only():
    config = PlatformConfig(extra={})
    adapter = WhatsAppAdapter(config)
    adapter._hook_registry = MagicMock()
    adapter._hook_registry.emit = AsyncMock()
    # Avoid running the agent in this unit test.
    adapter._dispatch_to_agent = AsyncMock()

    inbound = {
        "chatId": "15551234567@s.whatsapp.net",
        "senderId": "15551234567@s.whatsapp.net",
        "fromMe": False,
        "isGroup": False,
        "messageId": "M1",
        "body": "hi",
        "timestamp": 1716000000,
        "observe_only": True,
    }
    await adapter._handle_incoming_event(inbound)

    adapter._hook_registry.emit.assert_any_await("message:received", inbound)


@pytest.mark.asyncio
async def test_observe_only_message_does_not_run_agent_by_default():
    config = PlatformConfig(extra={})
    adapter = WhatsAppAdapter(config)
    adapter._hook_registry = MagicMock()
    adapter._hook_registry.emit = AsyncMock()
    adapter._dispatch_to_agent = AsyncMock()
    inbound = {
        "chatId": "15551234567@s.whatsapp.net",
        "senderId": "15551234567@s.whatsapp.net",
        "fromMe": False,
        "isGroup": False,
        "messageId": "M1",
        "body": "hi",
        "observe_only": True,
    }
    await adapter._handle_incoming_event(inbound)
    adapter._dispatch_to_agent.assert_not_awaited()


@pytest.mark.asyncio
async def test_message_sent_hook_fires_after_send():
    config = PlatformConfig(extra={})
    adapter = WhatsAppAdapter(config)
    adapter._hook_registry = MagicMock()
    adapter._hook_registry.emit = AsyncMock()
    adapter._bridge_post = AsyncMock(return_value={"ok": True, "message_id": "OUT-1"})

    await adapter.send_message(
        chat_id="15551234567@s.whatsapp.net",
        text="hello",
        hermes_origin=True,
    )

    adapter._hook_registry.emit.assert_any_await(
        "message:sent",
        {
            "chatId": "15551234567@s.whatsapp.net",
            "messageId": "OUT-1",
            "body": "hello",
            "hermes_origin": True,
            "direction": "out",
        },
    )


@pytest.mark.asyncio
async def test_send_message_defaults_self_chat_mode(monkeypatch):
    """In self-chat mode (default), mark_read and typing_enabled default to False."""
    monkeypatch.setenv("WHATSAPP_MODE", "self-chat")
    config = PlatformConfig(extra={})
    adapter = WhatsAppAdapter(config)
    adapter._hook_registry = None
    adapter._bridge_post = AsyncMock(return_value={"ok": True, "message_id": "M1"})

    await adapter.send_message(chat_id="555@s.whatsapp.net", text="hi")

    call_kwargs = adapter._bridge_post.call_args
    assert call_kwargs.kwargs.get("mark_read") is False
    assert call_kwargs.kwargs.get("typing_enabled") is False


@pytest.mark.asyncio
async def test_send_message_defaults_non_self_chat_mode(monkeypatch):
    """In non-self-chat mode, mark_read and typing_enabled default to True."""
    monkeypatch.setenv("WHATSAPP_MODE", "observe")
    config = PlatformConfig(extra={})
    adapter = WhatsAppAdapter(config)
    adapter._hook_registry = None
    adapter._bridge_post = AsyncMock(return_value={"ok": True, "message_id": "M2"})

    await adapter.send_message(chat_id="555@s.whatsapp.net", text="hi")

    call_kwargs = adapter._bridge_post.call_args
    assert call_kwargs.kwargs.get("mark_read") is True
    assert call_kwargs.kwargs.get("typing_enabled") is True


@pytest.mark.asyncio
async def test_send_message_explicit_overrides_respected(monkeypatch):
    """Explicit mark_read/typing_enabled override the mode-derived defaults."""
    monkeypatch.setenv("WHATSAPP_MODE", "self-chat")
    config = PlatformConfig(extra={})
    adapter = WhatsAppAdapter(config)
    adapter._hook_registry = None
    adapter._bridge_post = AsyncMock(return_value={"ok": True, "message_id": "M3"})

    await adapter.send_message(
        chat_id="555@s.whatsapp.net",
        text="hi",
        mark_read=True,
        typing_enabled=True,
    )

    call_kwargs = adapter._bridge_post.call_args
    assert call_kwargs.kwargs.get("mark_read") is True
    assert call_kwargs.kwargs.get("typing_enabled") is True


class TestBuildMessageEventOwnsTheIntakeGate:
    """Regression guard for the duplicate _should_process_message() gate that
    was REMOVED from _handle_incoming_event() during the 0.18.2 -> 0.19.0
    rebase (2026-07-28).

    Why this exists
    ---------------
    _handle_incoming_event() used to call _should_process_message() itself
    before dispatching. That call was redundant — _should_process_message() is
    the first statement of _build_message_event(), invoked with the same
    ``data`` and with no side effects in between — and it actively broke
    upstream 0.19's read-receipt tests, which terminate the _poll_messages()
    loop by monkeypatching _build_message_event(). Our duplicate gate
    short-circuited before that call was ever reached, so the loop spun
    forever and the suite hung with no output.

    Removing it left the watcher's DM/group/mention gating dependent on
    _should_process_message() STAYING inside _build_message_event(). If a
    future upstream release relocates that call, the watcher would stop
    gating inbound messages **silently** — this component's documented
    failure mode, and the reason the archive canary exists.

    These tests make that relocation fail loudly here instead.
    """

    @pytest.mark.asyncio
    async def test_build_message_event_invokes_the_policy_gate(self):
        """Pins the call SITE: the gate must run inside _build_message_event.

        If upstream moves _should_process_message() out of
        _build_message_event(), this mock is never called and the test fails.
        """
        adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra=dict(_DM_ACCEPTED)))
        adapter._should_process_message = MagicMock(return_value=False)

        event = await adapter._build_message_event(dict(_INBOUND_DM))

        adapter._should_process_message.assert_called_once()
        assert adapter._should_process_message.call_args.args[0]["messageId"] == "M-gate"
        assert event is None, (
            "_build_message_event must honour _should_process_message() -- the "
            "watcher relies on this being the single intake chokepoint"
        )

    @pytest.mark.asyncio
    async def test_policy_rejected_message_yields_no_event(self):
        """Pins the BEHAVIOUR with the real policy, no mocks on the gate."""
        adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra=dict(_DM_REJECTED)))

        assert adapter._should_process_message(dict(_INBOUND_DM)) is False
        assert await adapter._build_message_event(dict(_INBOUND_DM)) is None

    @pytest.mark.asyncio
    async def test_policy_accepted_message_yields_an_event(self):
        """Positive control: proves the assertions above are not vacuous.

        Without this, `_build_message_event() is None` could pass for an
        unrelated reason (malformed fixture, changed defaults) while the gate
        had silently stopped working.
        """
        adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra=dict(_DM_ACCEPTED)))

        assert adapter._should_process_message(dict(_INBOUND_DM)) is True
        assert await adapter._build_message_event(dict(_INBOUND_DM)) is not None

    @pytest.mark.asyncio
    async def test_rejected_message_never_reaches_the_agent_end_to_end(self):
        """The invariant that actually matters, independent of gate location.

        Drives the full watcher intake path. Wherever the gate lives, a
        policy-rejected message must not reach the agent.
        """
        adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra=dict(_DM_REJECTED)))
        adapter._hook_registry = None
        adapter.handle_message = AsyncMock()
        adapter._enqueue_text_event = MagicMock()

        await adapter._handle_incoming_event(dict(_INBOUND_DM))

        adapter.handle_message.assert_not_awaited()
        adapter._enqueue_text_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_accepted_message_does_reach_the_agent_end_to_end(self):
        """Positive control for the end-to-end path."""
        adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra=dict(_DM_ACCEPTED)))
        adapter._hook_registry = None
        adapter.handle_message = AsyncMock()
        adapter._enqueue_text_event = MagicMock()

        await adapter._handle_incoming_event(dict(_INBOUND_DM))

        # TEXT events go through the debounce batcher rather than
        # handle_message() directly.
        adapter._enqueue_text_event.assert_called_once()
