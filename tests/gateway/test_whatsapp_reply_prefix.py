"""Tests for WhatsApp reply_prefix config.yaml support.

Covers:
- config.yaml whatsapp.reply_prefix bridging into PlatformConfig.extra
- WhatsAppAdapter reading reply_prefix from config.extra
- Bridge subprocess receiving WHATSAPP_REPLY_PREFIX env var
- Config version covers all ENV_VARS_BY_VERSION keys (regression guard)
"""

from unittest.mock import patch


from gateway.config import Platform, PlatformConfig


# ---------------------------------------------------------------------------
# Config bridging from config.yaml
# ---------------------------------------------------------------------------


class TestConfigYamlBridging:
    """Test that whatsapp.reply_prefix in config.yaml flows into PlatformConfig."""

    def test_reply_prefix_bridged_from_yaml(self, tmp_path):
        """whatsapp.reply_prefix in config.yaml sets PlatformConfig.extra."""
        config_yaml = tmp_path / "config.yaml"
        config_yaml.write_text('whatsapp:\n  reply_prefix: "Custom Bot"\n')

        with patch("gateway.config.get_hermes_home", return_value=tmp_path):
            from gateway.config import load_gateway_config
            # Need to also patch WHATSAPP_ENABLED so the platform exists
            with patch.dict("os.environ", {"WHATSAPP_ENABLED": "true"}, clear=False):
                config = load_gateway_config()

        wa_config = config.platforms.get(Platform.WHATSAPP)
        assert wa_config is not None
        assert wa_config.extra.get("reply_prefix") == "Custom Bot"

    def test_empty_reply_prefix_bridged(self, tmp_path):
        """Empty string reply_prefix disables the header."""
        config_yaml = tmp_path / "config.yaml"
        config_yaml.write_text('whatsapp:\n  reply_prefix: ""\n')

        with patch("gateway.config.get_hermes_home", return_value=tmp_path):
            from gateway.config import load_gateway_config
            with patch.dict("os.environ", {"WHATSAPP_ENABLED": "true"}, clear=False):
                config = load_gateway_config()

        wa_config = config.platforms.get(Platform.WHATSAPP)
        assert wa_config is not None
        assert wa_config.extra.get("reply_prefix") == ""

    def test_no_whatsapp_section_no_extra(self, tmp_path):
        """Without whatsapp section, no reply_prefix is set."""
        config_yaml = tmp_path / "config.yaml"
        config_yaml.write_text("timezone: UTC\n")

        with patch("gateway.config.get_hermes_home", return_value=tmp_path):
            from gateway.config import load_gateway_config
            with patch.dict("os.environ", {"WHATSAPP_ENABLED": "true"}, clear=False):
                config = load_gateway_config()

        wa_config = config.platforms.get(Platform.WHATSAPP)
        assert wa_config is not None
        assert "reply_prefix" not in wa_config.extra

    def test_whatsapp_section_without_reply_prefix(self, tmp_path):
        """whatsapp section present but without reply_prefix key."""
        config_yaml = tmp_path / "config.yaml"
        config_yaml.write_text("whatsapp:\n  other_setting: true\n")

        with patch("gateway.config.get_hermes_home", return_value=tmp_path):
            from gateway.config import load_gateway_config
            with patch.dict("os.environ", {"WHATSAPP_ENABLED": "true"}, clear=False):
                config = load_gateway_config()

        wa_config = config.platforms.get(Platform.WHATSAPP)
        assert "reply_prefix" not in wa_config.extra


# ---------------------------------------------------------------------------
# WhatsAppAdapter __init__
# ---------------------------------------------------------------------------


class TestAdapterInit:
    """Test that WhatsAppAdapter reads reply_prefix from config.extra."""

    def test_reply_prefix_from_extra(self):
        from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
        config = PlatformConfig(enabled=True, extra={"reply_prefix": "Bot\\n"})
        adapter = WhatsAppAdapter(config)
        assert adapter._reply_prefix == "Bot\\n"

    def test_reply_prefix_default_none(self):
        from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
        config = PlatformConfig(enabled=True)
        adapter = WhatsAppAdapter(config)
        assert adapter._reply_prefix is None

    def test_reply_prefix_empty_string(self):
        from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
        config = PlatformConfig(enabled=True, extra={"reply_prefix": ""})
        adapter = WhatsAppAdapter(config)
        assert adapter._reply_prefix == ""


# ---------------------------------------------------------------------------
# Config version regression guard
# ---------------------------------------------------------------------------


class TestConfigVersionCoverage:
    """Ensure _config_version covers all ENV_VARS_BY_VERSION keys."""

    def test_default_config_version_covers_env_var_versions(self):
        """_config_version must be >= the highest ENV_VARS_BY_VERSION key."""
        from hermes_cli.config import DEFAULT_CONFIG, ENV_VARS_BY_VERSION
        assert DEFAULT_CONFIG["_config_version"] >= max(ENV_VARS_BY_VERSION)


# ---------------------------------------------------------------------------
# Engagement-aware reply prefix resolution (Task 11)
# ---------------------------------------------------------------------------

import json
from datetime import datetime, timezone, timedelta
from plugins.platforms.whatsapp.adapter import WhatsAppAdapter


def _seed_engagement(tmp_path, chat_id, reply_prefix=None):
    (tmp_path / "whatsapp").mkdir(parents=True, exist_ok=True)
    future = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    (tmp_path / "whatsapp" / "engagements.json").write_text(json.dumps({
        "version": 1,
        "windows": {
            chat_id: {
                "chat_id": chat_id, "expires_at": future,
                "silence_threshold_seconds": 180, "reply_prefix": reply_prefix
            }
        },
    }))


def test_engagement_reply_prefix_empty_by_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _seed_engagement(tmp_path, "ENGAGED", reply_prefix=None)
    adapter = WhatsAppAdapter(PlatformConfig(extra={}))
    assert adapter._effective_reply_prefix("ENGAGED") == ""
    # Non-engaged chat in self-chat mode keeps the default agent prefix.
    assert adapter._effective_reply_prefix("OTHER").startswith("⚕")


def test_engagement_per_window_reply_prefix_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _seed_engagement(tmp_path, "ENGAGED", reply_prefix="🤖 ")
    adapter = WhatsAppAdapter(PlatformConfig(extra={}))
    assert adapter._effective_reply_prefix("ENGAGED") == "🤖 "


def test_engagement_global_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("WHATSAPP_ENGAGEMENT_REPLY_PREFIX", "[via bot] ")
    _seed_engagement(tmp_path, "ENGAGED", reply_prefix=None)
    adapter = WhatsAppAdapter(PlatformConfig(extra={}))
    assert adapter._effective_reply_prefix("ENGAGED") == "[via bot] "


def test_general_reply_prefix_unchanged_for_non_engaged_chats(tmp_path, monkeypatch):
    """Existing behavior preserved: in self-chat mode without engagement,
    DEFAULT_REPLY_PREFIX still applies."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    adapter = WhatsAppAdapter(PlatformConfig(extra={}))
    prefix = adapter._effective_reply_prefix("SOME_CHAT_ID")
    assert prefix.startswith("⚕")
