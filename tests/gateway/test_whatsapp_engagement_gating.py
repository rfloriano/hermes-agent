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


# ------------------------------------------- single-writer: the hook owns
# observe_only
#
# 2026-08-17 production privacy incident. An engagement window was open on an
# external contact. Every inbound message he sent was ALSO dispatched into the
# normal gateway, which did not recognise him and answered with Hermes's canned
# pairing text:
#
#     Hi~ I don't recognize you yet!  Here's your pairing code: ...
#
# So the contact learned Rafael runs an agent, and learned it from the agent.
#
# The cause was dual routing, not the string. _handle_incoming_event emitted the
# watcher hook and THEN, when a window was active, dispatched the same event to
# the normal agent — while the watcher hook has its own complete decision and
# send path (invoke.invoke_agent_reply -> the bridge's /send). Two writers on
# one conversation: for an unauthorized contact the second one pairs, and for a
# contact authorized later it would be a second full agent reply.
#
# The fix makes observe_only hook-owned: emitted, then returned on,
# unconditionally. These tests pin that. They deliberately configure
# dm_policy="pairing" — the permissive default that produced the incident — so
# they prove ISOLATION rather than passing because some allowlist happened to
# reject the sender. `unauthorized_dm_behavior: ignore` is live on the VPS as
# defence in depth and is deliberately NOT what these tests lean on.

_OBSERVE_DM_POLICY = {"dm_policy": "pairing"}


def _observe_adapter(tmp_path, monkeypatch):
    """Adapter with the permissive DM policy and the agent path fully mocked."""
    from unittest.mock import AsyncMock, MagicMock

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra=dict(_OBSERVE_DM_POLICY)))
    adapter._hook_registry = MagicMock()
    adapter._hook_registry.emit = AsyncMock()
    adapter._dispatch_to_agent = AsyncMock()
    # The invariant that actually matters is "nothing left the box". Mocking the
    # two agent entry points AND the bridge poster means a regression cannot
    # sneak through by reaching the agent via some path other than
    # _dispatch_to_agent.
    adapter.handle_message = AsyncMock()
    adapter._enqueue_text_event = MagicMock()
    adapter._bridge_post = AsyncMock(return_value={"ok": True, "message_id": "X"})
    return adapter


def _inbound(chat_id: str, *, observe_only: bool) -> dict:
    data = {
        "chatId": chat_id,
        "senderId": chat_id,
        "fromMe": False,
        "isGroup": False,
        "messageId": "M-observe",
        "body": "oi, tudo bem?",
        "timestamp": 1716000000,
    }
    if observe_only:
        data["observe_only"] = True
    return data


def _assert_nothing_reached_the_agent(adapter):
    adapter._dispatch_to_agent.assert_not_awaited()
    adapter.handle_message.assert_not_awaited()
    adapter._enqueue_text_event.assert_not_called()
    adapter._bridge_post.assert_not_awaited()


@pytest.mark.asyncio
async def test_active_window_observe_only_is_hook_owned(tmp_path, monkeypatch):
    """The incident, inverted: an ACTIVE window must not add a second writer."""
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _observe_adapter(tmp_path, monkeypatch)
    data = _inbound(PHONE_JID, observe_only=True)

    await adapter._handle_incoming_event(data)

    # The watcher still sees everything — archiving and the engagement reply
    # both depend on it.
    adapter._hook_registry.emit.assert_awaited_once_with("message:received", data)
    _assert_nothing_reached_the_agent(adapter)


@pytest.mark.asyncio
async def test_active_window_observe_only_via_lid_alias_is_hook_owned(
    tmp_path, monkeypatch
):
    """The production shape exactly: window on the phone JID, reply as a LID.

    Worth its own test because the alias path is what made the window resolve
    as ACTIVE in the first place — before the phone/LID fix these messages were
    dropped, which accidentally hid the dual-writer bug for LID-keyed contacts.
    """
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _observe_adapter(tmp_path, monkeypatch)
    data = _inbound(LID_JID, observe_only=True)

    # Precondition: this really is the active-window branch, not a silent miss.
    assert adapter._engagement_active_for_chat(LID_JID) is True

    await adapter._handle_incoming_event(data)

    adapter._hook_registry.emit.assert_awaited_once_with("message:received", data)
    _assert_nothing_reached_the_agent(adapter)


@pytest.mark.asyncio
async def test_inactive_window_observe_only_still_reaches_the_hook(
    tmp_path, monkeypatch
):
    """No window: unchanged behaviour, and the archive must still get it."""
    _engagements_file(tmp_path, {})
    adapter = _observe_adapter(tmp_path, monkeypatch)
    data = _inbound(PHONE_JID, observe_only=True)

    await adapter._handle_incoming_event(data)

    adapter._hook_registry.emit.assert_awaited_once_with("message:received", data)
    _assert_nothing_reached_the_agent(adapter)


@pytest.mark.asyncio
async def test_expired_window_observe_only_is_hook_owned(tmp_path, monkeypatch):
    """An expired window is not a licence to dispatch either."""
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID, _past())})
    adapter = _observe_adapter(tmp_path, monkeypatch)
    data = _inbound(PHONE_JID, observe_only=True)

    await adapter._handle_incoming_event(data)

    adapter._hook_registry.emit.assert_awaited_once_with("message:received", data)
    _assert_nothing_reached_the_agent(adapter)


@pytest.mark.asyncio
async def test_non_observe_only_dm_still_reaches_the_agent(tmp_path, monkeypatch):
    """Positive control — without it every assertion above could pass vacuously.

    A normal (non-observe_only) DM under the same permissive policy must still
    run the ordinary gateway path. The fix narrows observe_only ONLY.
    """
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _observe_adapter(tmp_path, monkeypatch)
    data = _inbound(PHONE_JID, observe_only=False)

    await adapter._handle_incoming_event(data)

    adapter._hook_registry.emit.assert_awaited_once_with("message:received", data)
    adapter._dispatch_to_agent.assert_awaited_once()


@pytest.mark.asyncio
async def test_observe_only_gating_does_not_read_the_engagement_store(
    tmp_path, monkeypatch
):
    """Returning early must not cost an engagement lookup — or an expansion.

    Beyond speed this is the structural point of the fix: the dispatch decision
    for an observe_only event no longer depends on engagement state at all, so
    it cannot be re-coupled to it by accident.
    """
    _link(tmp_path, PHONE, LID)
    _engagements_file(tmp_path, {PHONE_JID: _window(PHONE_JID)})
    adapter = _observe_adapter(tmp_path, monkeypatch)
    calls = _count_expansions(monkeypatch)
    probed = []
    monkeypatch.setattr(
        adapter, "_engagement_active_for_chat",
        lambda chat_id: probed.append(chat_id) or True,
    )

    await adapter._handle_incoming_event(_inbound(LID_JID, observe_only=True))

    assert probed == [], "observe_only dispatch must not consult engagement state"
    assert calls == []
