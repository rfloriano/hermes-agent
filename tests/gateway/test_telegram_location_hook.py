"""Telegram location messages are observed through the hook registry, never dispatched.

A live location is one message plus a stream of ``edited_message`` updates.
Before this behaviour existed every refresh became an agent turn ("what would
you like to find nearby?" x N, plus "Interrupting current task" for whatever
was running). These tests pin the contract:

* no ``handle_message`` / message-handler call for any location update;
* every authorised update reaches the registry as ``telegram:location`` with
  a structured, JSON-serialisable record;
* authorisation and group gating still run first;
* nothing crashes when no registry is attached or a hook misbehaves;
* coordinates never reach the log.
"""

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from tests.gateway.test_telegram_group_gating import _make_adapter


class _RecordingRegistry:
    """Stand-in for gateway.hooks.HookRegistry: records emit_collect calls."""

    def __init__(self, results=None, raise_exc=None):
        self.events = []
        self._results = [{"stored": True}] if results is None else results
        self._raise = raise_exc

    async def emit_collect(self, event_type, context=None):
        self.events.append((event_type, context))
        if self._raise is not None:
            raise self._raise
        return list(self._results)


_T0 = datetime(2026, 9, 11, 2, 38, tzinfo=timezone.utc)


def _location(lat=-22.9519, lon=-43.2105, *, live_period=None, accuracy=None, heading=None):
    return SimpleNamespace(
        latitude=lat,
        longitude=lon,
        horizontal_accuracy=accuracy,
        heading=heading,
        live_period=live_period,
        proximity_alert_radius=None,
    )


def _dm_location_message(*, location=None, venue=None, message_id=42, date=_T0, edit_date=None,
                         from_user_id=111):
    return SimpleNamespace(
        message_id=message_id,
        text=None,
        caption=None,
        entities=[],
        caption_entities=[],
        message_thread_id=None,
        is_topic_message=False,
        chat=SimpleNamespace(id=from_user_id, type="private", full_name="Alice Example",
                             title=None, is_forum=False),
        from_user=SimpleNamespace(id=from_user_id, full_name="Alice Example", first_name="Alice"),
        reply_to_message=None,
        date=date,
        edit_date=edit_date,
        location=location,
        venue=venue,
        sticker=None,
        photo=None,
        video=None,
        audio=None,
        voice=None,
        document=None,
    )


def _update(update_id, msg, *, edited=False):
    # PTB populates exactly one of message / edited_message; effective_message
    # points at whichever is set.
    return SimpleNamespace(
        update_id=update_id,
        message=None if edited else msg,
        edited_message=msg if edited else None,
        effective_message=msg,
    )


def _dm_adapter(registry=None):
    adapter = _make_adapter()
    adapter.handle_message = AsyncMock()
    if registry is not None:
        adapter.set_hook_registry(registry)
    return adapter


def _run(coro):
    return asyncio.run(coro)


def test_live_location_updates_are_observed_without_any_agent_dispatch():
    registry = _RecordingRegistry()
    adapter = _dm_adapter(registry)

    first = _dm_location_message(location=_location(live_period=3600, accuracy=8.0, heading=90))
    refresh_1 = _dm_location_message(
        location=_location(-22.9515, -43.2100, live_period=3600),
        edit_date=_T0 + timedelta(seconds=30),
    )
    refresh_2 = _dm_location_message(
        location=_location(-22.9510, -43.2095, live_period=3600),
        edit_date=_T0 + timedelta(seconds=60),
    )

    async def _go():
        await adapter._handle_location_message(_update(9000, first), SimpleNamespace())
        await adapter._handle_location_message(_update(9001, refresh_1, edited=True), SimpleNamespace())
        await adapter._handle_location_message(_update(9002, refresh_2, edited=True), SimpleNamespace())

    _run(_go())

    adapter.handle_message.assert_not_awaited()
    adapter._message_handler.assert_not_awaited()
    assert [name for name, _ in registry.events] == ["telegram:location"] * 3

    records = [ctx for _, ctx in registry.events]
    assert [r["update_id"] for r in records] == [9000, 9001, 9002]
    assert [r["is_edit"] for r in records] == [False, True, True]
    # Every refresh of one live share reuses the original message id, so the
    # update id is what tells the points apart.
    assert {r["message_id"] for r in records} == {"42"}
    assert records[0]["captured_at"] == _T0.isoformat()
    assert records[1]["captured_at"] == (_T0 + timedelta(seconds=30)).isoformat()
    assert records[2]["latitude"] == -22.9510 and records[2]["longitude"] == -43.2095

    head = records[0]
    assert head["platform"] == "telegram"
    assert head["kind"] == "location"
    assert head["chat_id"] == "111" and head["chat_type"] == "dm"
    assert head["user_id"] == "111" and head["user_name"] == "Alice Example"
    assert head["live_period"] == 3600
    assert head["horizontal_accuracy"] == 8.0 and head["heading"] == 90
    assert head["date"] == _T0.isoformat() and head["edit_date"] is None
    # The record travels to a hook that writes JSONL: it must serialise as-is.
    json.dumps(head)


def test_static_pin_is_observed_not_dispatched():
    registry = _RecordingRegistry()
    adapter = _dm_adapter(registry)
    msg = _dm_location_message(location=_location())

    _run(adapter._handle_location_message(_update(1, msg), SimpleNamespace()))

    adapter.handle_message.assert_not_awaited()
    assert len(registry.events) == 1
    record = registry.events[0][1]
    assert record["live_period"] is None and record["is_edit"] is False
    assert "venue" not in record


def test_venue_record_carries_venue_fields_and_venue_coordinates():
    registry = _RecordingRegistry()
    adapter = _dm_adapter(registry)
    venue = SimpleNamespace(
        title="Padaria do Bairro",
        address="Rua X, 10",
        foursquare_id="4sq",
        google_place_id=None,
        location=_location(-22.1, -42.2),
    )
    msg = _dm_location_message(location=None, venue=venue)

    _run(adapter._handle_location_message(_update(2, msg), SimpleNamespace()))

    adapter.handle_message.assert_not_awaited()
    record = registry.events[0][1]
    assert record["kind"] == "venue"
    assert record["latitude"] == -22.1 and record["longitude"] == -42.2
    assert record["venue"] == {
        "title": "Padaria do Bairro",
        "address": "Rua X, 10",
        "foursquare_id": "4sq",
        "google_place_id": None,
    }


def test_no_hook_registry_means_silence_not_dispatch():
    adapter = _dm_adapter(registry=None)
    msg = _dm_location_message(location=_location(live_period=900))

    _run(adapter._handle_location_message(_update(3, msg), SimpleNamespace()))

    adapter.handle_message.assert_not_awaited()
    adapter._message_handler.assert_not_awaited()


def test_hook_registry_failure_is_contained():
    registry = _RecordingRegistry(raise_exc=RuntimeError("hook exploded"))
    adapter = _dm_adapter(registry)
    msg = _dm_location_message(location=_location())

    _run(adapter._handle_location_message(_update(4, msg), SimpleNamespace()))

    adapter.handle_message.assert_not_awaited()
    assert len(registry.events) == 1


def test_unauthorized_sender_is_neither_observed_nor_dispatched():
    registry = _RecordingRegistry()
    adapter = _dm_adapter(registry)
    adapter._is_user_authorized_from_message = lambda _msg: False
    msg = _dm_location_message(location=_location())

    _run(adapter._handle_location_message(_update(5, msg), SimpleNamespace()))

    adapter.handle_message.assert_not_awaited()
    assert registry.events == []


def test_unusable_coordinates_are_ignored():
    registry = _RecordingRegistry()
    adapter = _dm_adapter(registry)

    async def _go():
        await adapter._handle_location_message(
            _update(6, _dm_location_message(location=None)), SimpleNamespace())
        await adapter._handle_location_message(
            _update(7, _dm_location_message(location=_location(lat=None))), SimpleNamespace())
        await adapter._handle_location_message(
            _update(8, _dm_location_message(location=_location(lat=float("nan")))), SimpleNamespace())
        await adapter._handle_location_message(
            _update(9, _dm_location_message(location=_location(lon="not-a-number"))), SimpleNamespace())

    _run(_go())

    adapter.handle_message.assert_not_awaited()
    assert registry.events == []


def test_log_line_names_the_update_but_never_the_coordinates(caplog):
    registry = _RecordingRegistry()
    adapter = _dm_adapter(registry)
    msg = _dm_location_message(location=_location(-22.9519, -43.2105, live_period=3600))

    with caplog.at_level(logging.INFO, logger="plugins.platforms.telegram.adapter"):
        _run(adapter._handle_location_message(_update(9000, msg), SimpleNamespace()))

    lines = [r.getMessage() for r in caplog.records if "observed without agent dispatch" in r.getMessage()]
    assert len(lines) == 1
    assert "update=9000" in lines[0] and "consumers=1" in lines[0] and "live=True" in lines[0]
    assert "-22.95" not in lines[0] and "-43.21" not in lines[0]


def test_consumer_count_reflects_hooks_that_returned_a_result(caplog):
    registry = _RecordingRegistry(results=[])
    adapter = _dm_adapter(registry)
    msg = _dm_location_message(location=_location())

    with caplog.at_level(logging.INFO, logger="plugins.platforms.telegram.adapter"):
        _run(adapter._handle_location_message(_update(10, msg), SimpleNamespace()))

    lines = [r.getMessage() for r in caplog.records if "observed without agent dispatch" in r.getMessage()]
    assert lines and "consumers=0" in lines[0]
