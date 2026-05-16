"""PiHole Bypass Integration for Home Assistant."""
from __future__ import annotations

import logging
import asyncio
import aiohttp
import pathlib
from datetime import datetime, timedelta

from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import storage
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.util import dt as dt_util
from aiohttp import web

_LOGGER = logging.getLogger(__name__)

DOMAIN = "pihole_timer"
STORAGE_KEY = f"{DOMAIN}.timers"
STORAGE_VERSION = 1
CARD_VERSION = "0.1.2"
CARD_FILENAME = "pihole-bypass-card.js"

# URL under which HA will serve the card JS file.
# We register a static path ourselves so this works regardless of HACS.
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"

LOVELACE_RESOURCES_STORAGE_KEY = "lovelace_resources"

# Track whether we already registered the static path / module URL this run
_CARD_REGISTERED: bool = False
_VIEW_REGISTERED: bool = False


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})

    coordinator = PiHoleBypassCoordinator(hass, entry)
    hass.data[DOMAIN][entry.entry_id] = coordinator

    try:
        await coordinator.async_initialize()
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Failed to initialize coordinator: %s", err)
        return False

    try:
        await _async_register_card(hass)
    except Exception as err:  # noqa: BLE001
        # Card registration failure is non-fatal — integration still works.
        _LOGGER.error("Card registration failed: %s", err)

    # REST API for the card.
    # register_view raises if the URL is already registered (e.g. on reload).
    # Use a module-level flag — hass.data[DOMAIN] is cleared on each reload
    # so a flag stored there would never prevent re-registration.
    global _VIEW_REGISTERED  # noqa: PLW0603
    if not _VIEW_REGISTERED:
        try:
            hass.http.register_view(PiHoleBypassView(hass))
            _VIEW_REGISTERED = True
        except Exception as err:  # noqa: BLE001
            _LOGGER.error("Failed to register API view: %s", err)

    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the card JS via a static HTTP route and register it as a Lovelace resource.

    Uses the lovelace_resources storage directly — this works in both storage
    and YAML mode (HA ignores the storage in YAML mode but the static path
    still serves the file, so users can add the resource manually if needed).

    Safe to call on every setup; guarded by the module-level _CARD_REGISTERED flag.
    """
    global _CARD_REGISTERED  # noqa: PLW0603

    www_dir = pathlib.Path(__file__).parent / "www"
    js_path = www_dir / CARD_FILENAME

    if not js_path.is_file():
        _LOGGER.error("Card JS not found at %s — card will not be available", js_path)
        return

    if _CARD_REGISTERED:
        return

    # 1. Serve the file at a stable URL owned by this integration.
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, str(js_path), cache_headers=False)]
        )
        _LOGGER.debug("Registered static path %s → %s", CARD_URL, js_path)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Static path already registered (harmless): %s", err)

    # 2. Register as a Lovelace resource via storage.
    await _async_fix_lovelace_resource_fallback(hass)

    _CARD_REGISTERED = True


async def _async_fix_lovelace_resource_fallback(hass: HomeAssistant) -> None:
    """Write the card resource entry into lovelace_resources storage.

    Uses a stable domain-scoped id to stay idempotent across reloads.
    """
    store = storage.Store(hass, 1, LOVELACE_RESOURCES_STORAGE_KEY)
    try:
        data = await store.async_load() or {}
    except Exception:  # noqa: BLE001
        data = {}

    items: list[dict] = data.get("items", [])

    # Remove any stale entries from previous versions / URL schemes
    keywords = ("pihole-bypass-card", "pihole_timer", "pihole_bypass")
    clean = [
        item for item in items
        if not any(kw in item.get("url", "") for kw in keywords)
    ]
    removed = len(items) - len(clean)
    if removed:
        _LOGGER.info("Removed %d stale PiHole card resource entries", removed)

    clean.append({
        "id": f"{DOMAIN}_card",
        "type": "module",
        "url": f"{CARD_URL}?v={CARD_VERSION}",
    })

    data["items"] = clean
    await store.async_save(data)
    hass.bus.async_fire("lovelace_updated")
    _LOGGER.info("PiHole card resource set via storage fallback: %s?v=%s", CARD_URL, CARD_VERSION)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    global _CARD_REGISTERED, _VIEW_REGISTERED  # noqa: PLW0603
    coordinator = hass.data[DOMAIN].pop(entry.entry_id, None)
    if coordinator:
        await coordinator.async_cleanup()
    # When the last real entry (coordinator) is gone, reset module-level flags
    # so everything re-registers cleanly if the integration is set up again.
    remaining = [v for v in hass.data.get(DOMAIN, {}).values()
                 if isinstance(v, PiHoleBypassCoordinator)]
    if not remaining:
        _CARD_REGISTERED = False
        _VIEW_REGISTERED = False
    return True


class PiHoleBypassCoordinator:
    """Coordinator for PiHole Bypass operations."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.session = async_get_clientsession(hass)
        self._store = storage.Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._active_timers: dict[str, asyncio.TimerHandle] = {}
        self._timer_data: dict[str, dict] = {}
        self._sid: str | None = None

    @property
    def host(self) -> str:
        return self.entry.data.get("host", "")

    @property
    def password(self) -> str:
        return self.entry.data.get("api_key", "")

    @property
    def api_base(self) -> str:
        host = self.host.rstrip("/")
        if not host.startswith("http"):
            host = f"http://{host}"
        return f"{host}/api"

    async def _authenticate(self) -> bool:
        url = f"{self.api_base}/auth"
        try:
            async with self.session.post(
                url,
                json={"password": self.password},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    session = data.get("session", {})
                    if session.get("valid"):
                        self._sid = session.get("sid")
                        return True
                _LOGGER.error("PiHole auth failed: HTTP %s", resp.status)
        except aiohttp.ClientError as err:
            _LOGGER.error("PiHole auth error: %s", err)
        return False

    async def _api_request(
        self, method: str, endpoint: str, data: dict = None
    ) -> dict | None:
        for _attempt in range(2):
            if not self._sid:
                if not await self._authenticate():
                    return None
            url = f"{self.api_base}/{endpoint}"
            headers = {"sid": self._sid}
            try:
                async with self.session.request(
                    method, url, json=data, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 401:
                        self._sid = None
                        continue
                    if resp.status in (200, 201):
                        return await resp.json()
                    _LOGGER.error(
                        "PiHole API %s %s → HTTP %s", method, endpoint, resp.status
                    )
                    return None
            except aiohttp.ClientError as err:
                _LOGGER.error("PiHole connection error: %s", err)
                return None
        return None

    async def async_initialize(self) -> None:
        data = await self._store.async_load()
        if not data:
            return
        now = dt_util.utcnow()
        for client_ip, info in data.get("timers", {}).items():
            end_time = datetime.fromisoformat(info["end_time"])
            if end_time > now:
                remaining = (end_time - now).total_seconds()
                self._schedule_restore(client_ip, info["original_groups"], remaining)
                self._timer_data[client_ip] = info
            else:
                await self._restore_client_groups(client_ip, info["original_groups"])

    async def async_cleanup(self) -> None:
        for handle in self._active_timers.values():
            handle.cancel()
        self._active_timers.clear()

    async def get_clients(self) -> list[dict]:
        result = await self._api_request("GET", "clients")
        return result.get("clients", []) if result else []

    async def get_groups(self) -> list[dict]:
        result = await self._api_request("GET", "groups")
        return result.get("groups", []) if result else []

    async def get_client_groups(self, client_ip: str) -> list[int]:
        for c in await self.get_clients():
            if c.get("ip") == client_ip:
                return c.get("groups", [])
        return []

    async def set_client_groups(self, client_ip: str, group_ids: list[int]) -> bool:
        client_id = None
        for c in await self.get_clients():
            if c.get("ip") == client_ip:
                client_id = c.get("id")
                break
        if client_id is None:
            _LOGGER.error("Client %s not found in PiHole", client_ip)
            return False
        result = await self._api_request(
            "PUT", f"clients/{client_id}", {"groups": group_ids}
        )
        return result is not None

    async def activate_bypass(
        self, client_ip: str, groups: list[int], duration_minutes: int
    ) -> bool:
        original_groups = await self.get_client_groups(client_ip)
        if not await self.set_client_groups(client_ip, groups):
            return False
        if client_ip in self._active_timers:
            self._active_timers[client_ip].cancel()
        end_time = dt_util.utcnow() + timedelta(minutes=duration_minutes)
        info = {
            "client_ip": client_ip,
            "original_groups": original_groups,
            "bypass_groups": groups,
            "end_time": end_time.isoformat(),
            "duration_minutes": duration_minutes,
        }
        self._timer_data[client_ip] = info
        await self._save_timers()
        self._schedule_restore(client_ip, original_groups, duration_minutes * 60)
        self.hass.bus.async_fire(f"{DOMAIN}_bypass_activated", {
            "client_ip": client_ip,
            "groups": groups,
            "end_time": end_time.isoformat(),
        })
        _LOGGER.info("Bypass activated for %s (%d min)", client_ip, duration_minutes)
        return True

    def _schedule_restore(
        self, client_ip: str, original_groups: list[int], delay_seconds: float
    ) -> None:
        def _cb():
            asyncio.ensure_future(
                self._restore_client_groups(client_ip, original_groups)
            )
        self._active_timers[client_ip] = self.hass.loop.call_later(delay_seconds, _cb)

    async def _restore_client_groups(
        self, client_ip: str, original_groups: list[int]
    ) -> None:
        if await self.set_client_groups(client_ip, original_groups):
            self._active_timers.pop(client_ip, None)
            self._timer_data.pop(client_ip, None)
            await self._save_timers()
            self.hass.bus.async_fire(f"{DOMAIN}_bypass_expired", {
                "client_ip": client_ip,
                "restored_groups": original_groups,
            })
            _LOGGER.info("Groups restored for %s", client_ip)

    async def deactivate_bypass(self, client_ip: str) -> bool:
        handle = self._active_timers.pop(client_ip, None)
        if handle:
            handle.cancel()
        info = self._timer_data.pop(client_ip, None)
        if info:
            await self.set_client_groups(client_ip, info["original_groups"])
            await self._save_timers()
            self.hass.bus.async_fire(
                f"{DOMAIN}_bypass_cancelled", {"client_ip": client_ip}
            )
            return True
        return False

    async def get_active_timers(self) -> dict:
        now = dt_util.utcnow()
        result = {}
        for client_ip, info in self._timer_data.items():
            result[client_ip] = {
                **info,
                "remaining_seconds": max(
                    0,
                    (datetime.fromisoformat(info["end_time"]) - now).total_seconds(),
                ),
            }
        return result

    async def _save_timers(self) -> None:
        await self._store.async_save({"timers": self._timer_data})


class PiHoleBypassView(HomeAssistantView):
    """REST API consumed by the Lovelace card.

    Looks up the active coordinator from hass.data on every request so the
    view stays valid across reloads without needing to re-register its URL.
    """

    url = "/api/pihole_timer/{action}"
    name = "api:pihole_timer"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    def _coordinator(self) -> PiHoleBypassCoordinator | None:
        """Return the first active coordinator, or None."""
        domain_data = self._hass.data.get(DOMAIN, {})
        for key, value in domain_data.items():
            if isinstance(value, PiHoleBypassCoordinator):
                return value
        return None

    async def get(self, request: web.Request, action: str) -> web.Response:
        coordinator = self._coordinator()
        if coordinator is None:
            return self.json_message("Integration not loaded", status_code=503)
        if action == "clients":
            return self.json({"clients": await coordinator.get_clients()})
        if action == "groups":
            return self.json({"groups": await coordinator.get_groups()})
        if action == "timers":
            return self.json({"timers": await coordinator.get_active_timers()})
        return self.json_message("Unknown action", status_code=404)

    async def post(self, request: web.Request, action: str) -> web.Response:
        coordinator = self._coordinator()
        if coordinator is None:
            return self.json_message("Integration not loaded", status_code=503)
        try:
            data = await request.json()
        except Exception:
            return self.json_message("Invalid JSON", status_code=400)
        if action == "activate":
            ok = await coordinator.activate_bypass(
                client_ip=data.get("client_ip"),
                groups=data.get("groups", []),
                duration_minutes=int(data.get("duration_minutes", 10)),
            )
            return self.json({"success": ok})
        if action == "deactivate":
            ok = await coordinator.deactivate_bypass(data.get("client_ip"))
            return self.json({"success": ok})
        return self.json_message("Unknown action", status_code=404)
