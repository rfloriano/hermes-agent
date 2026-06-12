"""Tests for WhatsApp observe-mode hook emission and message:sent."""

import asyncio
import os
import pytest
from unittest.mock import AsyncMock, MagicMock
from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
from gateway.platforms.base import PlatformConfig


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
