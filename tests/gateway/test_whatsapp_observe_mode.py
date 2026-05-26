"""Tests for WhatsApp observe-mode hook emission and message:sent."""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock
from gateway.platforms.whatsapp import WhatsAppAdapter
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
