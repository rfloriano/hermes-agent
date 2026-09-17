"""Tests: channel_directory merges watcher contacts into whatsapp section."""

import asyncio
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from gateway.channel_directory import (
    build_channel_directory,
    _merge_whatsapp_watcher_contacts,
)


# ---------------------------------------------------------------------------
# _merge_whatsapp_watcher_contacts unit tests
# ---------------------------------------------------------------------------

class TestMergeWhatsappWatcherContacts:
    def _write_contacts(self, tmp_path, contacts):
        wa_dir = tmp_path / "whatsapp"
        wa_dir.mkdir(parents=True, exist_ok=True)
        path = wa_dir / "contacts.json"
        path.write_text(json.dumps({"version": 1, "contacts": contacts}))
        return path

    def test_merges_two_contacts(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        self._write_contacts(tmp_path, [
            {"chat_id": "1234@c.us", "canonical_name": "Twilio Sandbox", "is_group": False},
            {"chat_id": "5678@g.us", "canonical_name": "Family Group", "is_group": True},
        ])
        result = _merge_whatsapp_watcher_contacts([])
        ids = [e["id"] for e in result]
        names = [e["name"] for e in result]
        assert "1234@c.us" in ids
        assert "5678@g.us" in ids
        assert "Twilio Sandbox" in names
        assert "Family Group" in names

    def test_deduplicates_by_id(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        self._write_contacts(tmp_path, [
            {"chat_id": "1234@c.us", "canonical_name": "Alice", "is_group": False},
        ])
        existing = [{"id": "1234@c.us", "name": "Alice (session)", "type": "dm", "thread_id": None}]
        result = _merge_whatsapp_watcher_contacts(existing)
        # Session entry kept, watcher entry not added (duplicate id)
        count = sum(1 for e in result if e["id"] == "1234@c.us")
        assert count == 1
        # The original (session-sourced) entry is preserved
        assert result[0]["name"] == "Alice (session)"

    def test_tolerates_missing_contacts_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        # No contacts.json written
        result = _merge_whatsapp_watcher_contacts([{"id": "X", "name": "Y", "type": "dm"}])
        assert len(result) == 1

    def test_group_type_flagged_correctly(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        self._write_contacts(tmp_path, [
            {"chat_id": "g1@g.us", "canonical_name": "Team Chat", "is_group": True},
            {"chat_id": "d1@c.us", "canonical_name": "Bob", "is_group": False},
        ])
        result = _merge_whatsapp_watcher_contacts([])
        by_id = {e["id"]: e for e in result}
        assert by_id["g1@g.us"]["type"] == "group"
        assert by_id["d1@c.us"]["type"] == "dm"

    def test_corrupt_contacts_file_returns_existing(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        wa_dir = tmp_path / "whatsapp"
        wa_dir.mkdir(parents=True, exist_ok=True)
        (wa_dir / "contacts.json").write_text("{bad json")
        existing = [{"id": "Z", "name": "Z", "type": "dm"}]
        result = _merge_whatsapp_watcher_contacts(existing)
        assert result == existing


# ---------------------------------------------------------------------------
# build_channel_directory integration — watcher contacts end up in whatsapp
# ---------------------------------------------------------------------------

class TestBuildChannelDirectoryWatcherIntegration:
    def test_watcher_contacts_in_built_directory(self, tmp_path, monkeypatch):
        """build_channel_directory with empty adapters still picks up watcher contacts."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))

        wa_dir = tmp_path / "whatsapp"
        wa_dir.mkdir(parents=True, exist_ok=True)
        (wa_dir / "contacts.json").write_text(json.dumps({"version": 1, "contacts": [
            {"chat_id": "sandbox@c.us", "canonical_name": "Twilio Sandbox", "is_group": False},
            {"chat_id": "fam@g.us", "canonical_name": "Family", "is_group": True},
        ]}))

        dir_path = tmp_path / "channel_directory.json"
        with (
            patch("gateway.channel_directory.DIRECTORY_PATH", dir_path),
            patch("gateway.channel_directory.get_hermes_home", return_value=tmp_path),
            patch("gateway.channel_directory.atomic_json_write"),
        ):
            directory = asyncio.run(build_channel_directory({}))

        whatsapp = directory.get("platforms", {}).get("whatsapp", [])
        ids = [e["id"] for e in whatsapp]
        assert "sandbox@c.us" in ids
        assert "fam@g.us" in ids
        assert len(whatsapp) == 2
