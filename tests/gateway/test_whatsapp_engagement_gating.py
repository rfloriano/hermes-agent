"""Tests for engagement-window gating in WhatsAppAdapter.

Two things are covered here:

1. The original expiry gate: a window exists and has not expired.
2. Phone/LID aliasing (2026-08-11 production failure). One human has two
   WhatsApp JID shapes — ``<phone>@s.whatsapp.net`` and a mapped
   ``<lid>@lid``. A window opened under the phone JID never matched that
   contact's inbound LID, so ``_handle_incoming_event`` dropped every
   observe-only reply before agent dispatch.

**The trap these tests exist to pin.** ``expand_whatsapp_aliases`` returns
*bare numeric ids, not JIDs* (``normalize_whatsapp_identifier`` ends in
``.split("@", 1)[0]``), so ``"<id>@lid" in expand_whatsapp_aliases(...)`` is
False for every input. A membership check written against a JID looks correct,
passes a naive test and changes nothing in production —
``test_expand_returns_bare_ids_not_jids`` below asserts that contract directly
so the fix can never quietly regress to it.

All identifiers here are synthetic.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from gateway.platforms.base import PlatformConfig
from plugins.platforms.whatsapp.adapter import WhatsAppAdapter


# --------------------------------------------------------------- identifiers
# Synthetic throughout — these are not real WhatsApp numbers or LIDs.
PHONE = "100000000001"
LID = "200000000002"
LID2 = "200000000003"
OTHER_LID = "900000000009"

PHONE_JID = f"{PHONE}@s.whatsapp.net"
LID_JID = f"{LID}@lid"
LID2_JID = f"{LID2}@lid"
OTHER_LID_JID = f"{OTHER_LID}@lid"

GROUP_JID = "300000000004@g.us"
# A group whose digits are exactly the phone number's. Numeric normalization
# would collapse it into the DM identity; it must not.
COLLIDING_GROUP_JID = f"{PHONE}@g.us"


# ------------------------------------------------------------------- helpers

def _future(minutes: int = 30) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def _past(minutes: int = 5) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


def _window(chat_id: str, expires_at: str = None, **extra) -> dict:
    w = {
        "chat_id": chat_id,
        "expires_at": expires_at if expires_at is not None else _future(),
        "silence_threshold_seconds": 180,
    }
    w.update(extra)
    return w


def _engagements_file(tmp_path: Path, windows: dict = None) -> Path:
    """Write engagements.json. Insertion order of *windows* is preserved."""
    p = tmp_path / "whatsapp" / "engagements.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": 1, "windows": windows or {}}))
    return p


def _link(tmp_path: Path, a: str, b: str) -> None:
    """Mirror the bridge's bidirectional mapping files for one alias pair."""
    session = tmp_path / "whatsapp" / "session"
    session.mkdir(parents=True, exist_ok=True)
    (session / f"lid-mapping-{a}.json").write_text(json.dumps(b), encoding="utf-8")
    (session / f"lid-mapping-{b}_reverse.json").write_text(
        json.dumps(a), encoding="utf-8"
    )


def _adapter(tmp_path, monkeypatch) -> WhatsAppAdapter:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return WhatsAppAdapter(PlatformConfig(extra={}))


def _count_expansions(monkeypatch):
    """Wrap expand_whatsapp_aliases so tests can assert how often it runs.

    The real helper still runs — this counts, it does not stub. It costs
    ~18.7 ms per call on the production box and scales with the session
    directory's file count, so the call count is a correctness property of the
    inbound path, not a micro-optimisation.
    """
    import gateway.whatsapp_identity as whatsapp_identity

    real = whatsapp_identity.expand_whatsapp_aliases
    calls = []

    def counting(identifier):
        calls.append(identifier)
        return real(identifier)

    monkeypatch.setattr(whatsapp_identity, "expand_whatsapp_aliases", counting)
    return calls


# ------------------------------------------------------- original expiry gate

def test_engagement_active_for_chat_reads_file(tmp_path, monkeypatch):
    ef = _engagements_file(tmp_path)
    adapter = _adapter(tmp_path, monkeypatch)
    assert adapter._engagement_active_for_chat("X") is False

    ef.write_text(json.dumps({
        "version": 1,
        "windows": {"X": _window("X")},
    }))
    assert adapter._engagement_active_for_chat("X") is True


def test_engagement_expired_window_not_active(tmp_path, monkeypatch):
    _engagements_file(tmp_path, {"X": _window("X", _past())})
    adapter = _adapter(tmp_path, monkeypatch)
    assert adapter._engagement_active_for_chat("X") is False


def test_missing_expires_at_is_not_active(tmp_path, monkeypatch):
    windows = {"X": {"chat_id": "X", "silence_threshold_seconds": 180}}
    _engagements_file(tmp_path, windows)
    adapter = _adapter(tmp_path, monkeypatch)
    assert adapter._engagement_active_for_chat("X") is False


# ------------------------------------------------ the helper's own contract

def test_expand_returns_bare_ids_not_jids(tmp_path, monkeypatch):
    """Pins the trap: a JID is never a member of its own alias set.

    If this ever starts passing with JIDs in the set, the membership form of
    the fix would also start working and this file's other assertions would
    stop distinguishing the two.
    """
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _link(tmp_path, PHONE, LID)

    from gateway.whatsapp_identity import expand_whatsapp_aliases

    aliases = expand_whatsapp_aliases(PHONE_JID)
    assert PHONE in aliases
    assert LID in aliases
    assert PHONE_JID not in aliases
    assert LID_JID not in aliases


# ------------------------------------------------------------ alias matching

def test_engagement_record_matches_lid_alias_of_phone_keyed_window(
    tmp_path, monkeypatch
):
    """The production case: window keyed by phone JID, reply arrives as LID."""
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID, marker="target")})
    adapter = _adapter(tmp_path, monkeypatch)

    record = adapter._engagement_record(LID_JID)
    assert record is not None
    assert record["marker"] == "target"


def test_engagement_active_for_chat_matches_lid_alias(tmp_path, monkeypatch):
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_active_for_chat(LID_JID) is True


def test_engagement_active_for_chat_matches_phone_alias_of_lid_window(
    tmp_path, monkeypatch
):
    """The mirror direction: window keyed by LID, message arrives by phone."""
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {LID_JID: _window(LID_JID)})
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_active_for_chat(PHONE_JID) is True


def test_unrelated_lid_is_not_admitted(tmp_path, monkeypatch):
    """An unmapped stranger must not be let in by the alias path."""
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_record(OTHER_LID_JID) is None
    assert adapter._engagement_active_for_chat(OTHER_LID_JID) is False


def test_unrelated_lid_with_its_own_mapping_is_not_admitted(tmp_path, monkeypatch):
    """A second contact that HAS mappings still must not match the first."""
    _link(tmp_path, PHONE, LID)
    _link(tmp_path, "100000000055", OTHER_LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_record(OTHER_LID_JID) is None
    assert adapter._engagement_active_for_chat(OTHER_LID_JID) is False


def test_expired_aliased_window_is_not_active(tmp_path, monkeypatch):
    """The alias path resolves WHICH window; it never resurrects an expired one.

    Both assertions matter: the record IS found through the alias (so this is
    not passing merely because the alias lookup failed), and the expiry check
    still rejects it.
    """
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID, _past())})
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_record(LID_JID) is not None
    assert adapter._engagement_active_for_chat(LID_JID) is False


def test_window_key_differing_from_chat_id_matches_on_either(tmp_path, monkeypatch):
    """A window stored under an opaque key still matches via window['chat_id']."""
    _link(tmp_path, PHONE, LID)
    _engagements_file(
        tmp_path,
        {"opaque-window-key": _window(PHONE_JID, marker="by-chat-id")},
    )
    adapter = _adapter(tmp_path, monkeypatch)

    record = adapter._engagement_record(LID_JID)
    assert record is not None and record["marker"] == "by-chat-id"
    assert adapter._engagement_active_for_chat(LID_JID) is True


def test_window_matches_on_key_when_chat_id_is_the_other_alias(
    tmp_path, monkeypatch
):
    """Key is the phone JID, stored chat_id is the LID; both must resolve."""
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(LID_JID, marker="split")})
    adapter = _adapter(tmp_path, monkeypatch)

    # Exact key.
    assert adapter._engagement_record(PHONE_JID)["marker"] == "split"
    # Via the stored chat_id / the key's alias — the fast path misses here.
    assert adapter._engagement_record(LID_JID)["marker"] == "split"


def test_tie_break_is_sorted_first_by_key(tmp_path, monkeypatch):
    """Two windows on one identity resolve deterministically, not by insertion.

    Chain: PHONE <-> LID <-> LID2. An inbound LID2 aliases both stored
    windows. Insertion order is deliberately the reverse of sorted order, so
    an implementation that iterates the dict returns the other one.
    """
    _link(tmp_path, PHONE, LID)
    _link(tmp_path, LID, LID2)
    _engagements_file(
        tmp_path,
        {
            LID_JID: _window(LID_JID, marker="inserted-first"),
            PHONE_JID: _window(PHONE_JID, marker="sorted-first"),
        },
    )
    adapter = _adapter(tmp_path, monkeypatch)

    assert sorted([LID_JID, PHONE_JID])[0] == PHONE_JID
    assert adapter._engagement_record(LID2_JID)["marker"] == "sorted-first"


# ------------------------------------------------------- groups and unmapped

def test_group_exact_key_still_matches(tmp_path, monkeypatch):
    _engagements_file(tmp_path, {GROUP_JID: _window(GROUP_JID)})
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_active_for_chat(GROUP_JID) is True
    assert adapter._engagement_active_for_chat("300000000099@g.us") is False


def test_group_inbound_is_never_aliased_to_a_dm_window(tmp_path, monkeypatch):
    """A group whose digits match a phone must not reach that DM's window."""
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_record(COLLIDING_GROUP_JID) is None
    assert adapter._engagement_active_for_chat(COLLIDING_GROUP_JID) is False


def test_dm_inbound_is_never_aliased_to_a_group_window(tmp_path, monkeypatch):
    """The other direction of the same boundary: stored group, inbound DM."""
    _link(tmp_path, PHONE, LID)
    _engagements_file(
        tmp_path, {COLLIDING_GROUP_JID: _window(COLLIDING_GROUP_JID)}
    )
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_record(LID_JID) is None
    assert adapter._engagement_record(PHONE_JID) is None
    assert adapter._engagement_active_for_chat(LID_JID) is False


def test_unmapped_ids_behave_exactly_as_before(tmp_path, monkeypatch):
    """No mapping files at all: exact keys hit, everything else misses."""
    _engagements_file(tmp_path, {"X": _window("X")})
    adapter = _adapter(tmp_path, monkeypatch)

    assert adapter._engagement_active_for_chat("X") is True
    assert adapter._engagement_active_for_chat("Y") is False
    assert adapter._engagement_record(LID_JID) is None
    assert adapter._engagement_record("") is None


def test_no_engagements_file_is_not_active(tmp_path, monkeypatch):
    adapter = _adapter(tmp_path, monkeypatch)
    assert adapter._engagement_active_for_chat(LID_JID) is False
    assert adapter._engagement_record(LID_JID) is None


# --------------------------------------------------------- cost of the gate
# _engagement_active_for_chat runs on every observe-only inbound message and
# expand_whatsapp_aliases costs ~18.7 ms on the production box, scaling with
# the session directory's size. These pin the call count.

def test_exact_key_hit_expands_nothing(tmp_path, monkeypatch):
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _adapter(tmp_path, monkeypatch)
    calls = _count_expansions(monkeypatch)

    assert adapter._engagement_active_for_chat(PHONE_JID) is True
    assert calls == []


def test_no_open_windows_expands_nothing(tmp_path, monkeypatch):
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {})
    adapter = _adapter(tmp_path, monkeypatch)
    calls = _count_expansions(monkeypatch)

    assert adapter._engagement_active_for_chat(LID_JID) is False
    assert calls == []


def test_group_inbound_expands_nothing(tmp_path, monkeypatch):
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _adapter(tmp_path, monkeypatch)
    calls = _count_expansions(monkeypatch)

    assert adapter._engagement_active_for_chat(GROUP_JID) is False
    assert calls == []


def test_alias_path_expands_once_regardless_of_window_count(tmp_path, monkeypatch):
    """One expansion per message, not one per stored window.

    Expanding both sides per window would be 2N+1 calls — ~133 ms of
    synchronous work in the gateway's event loop at the three-window cap.
    """
    _link(tmp_path, PHONE, LID)
    _engagements_file(
        tmp_path,
        {
            "900000000101@lid": _window("900000000101@lid"),
            "900000000102@lid": _window("900000000102@lid"),
            PHONE_JID: _window(PHONE_JID),
        },
    )
    adapter = _adapter(tmp_path, monkeypatch)
    calls = _count_expansions(monkeypatch)

    assert adapter._engagement_active_for_chat(LID_JID) is True
    assert calls == [LID_JID]


def test_alias_path_expands_once_on_a_miss(tmp_path, monkeypatch):
    """The miss path is the common one while a window is open — also one call."""
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _adapter(tmp_path, monkeypatch)
    calls = _count_expansions(monkeypatch)

    assert adapter._engagement_active_for_chat(OTHER_LID_JID) is False
    assert calls == [OTHER_LID_JID]


def test_alias_expansion_failure_degrades_to_exact_key(tmp_path, monkeypatch):
    """A broken helper must not put a new exception in the inbound path."""
    import gateway.whatsapp_identity as whatsapp_identity

    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _adapter(tmp_path, monkeypatch)

    def boom(identifier):
        raise RuntimeError("session directory unreadable")

    monkeypatch.setattr(whatsapp_identity, "expand_whatsapp_aliases", boom)

    assert adapter._engagement_record(LID_JID) is None
    assert adapter._engagement_active_for_chat(LID_JID) is False
    # Exact key still works — this is the behaviour that shipped before.
    assert adapter._engagement_active_for_chat(PHONE_JID) is True
