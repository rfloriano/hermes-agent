"""Tests for engagement-window gating in WhatsAppAdapter."""

import json
from pathlib import Path
import pytest
from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
from gateway.platforms.base import PlatformConfig


def _engagements_file(tmp_path: Path) -> Path:
    p = tmp_path / "whatsapp" / "engagements.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": 1, "windows": {}}))
    return p


def test_engagement_active_for_chat_reads_file(tmp_path, monkeypatch):
    ef = _engagements_file(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    adapter = WhatsAppAdapter(PlatformConfig(extra={}))
    assert adapter._engagement_active_for_chat("X") is False

    from datetime import datetime, timezone, timedelta
    future = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
    ef.write_text(json.dumps({
        "version": 1,
        "windows": {
            "X": {"chat_id": "X", "expires_at": future, "silence_threshold_seconds": 180}
        },
    }))
    assert adapter._engagement_active_for_chat("X") is True


def test_engagement_expired_window_not_active(tmp_path, monkeypatch):
    ef = _engagements_file(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    adapter = WhatsAppAdapter(PlatformConfig(extra={}))

    from datetime import datetime, timezone, timedelta
    past = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    ef.write_text(json.dumps({
        "version": 1,
        "windows": {
            "X": {"chat_id": "X", "expires_at": past, "silence_threshold_seconds": 180}
        },
    }))
    assert adapter._engagement_active_for_chat("X") is False
