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
CARD_VERSION = "0.1.7"
CARD_FILENAME = "pihole-bypass-card.js"
CARD_RESOURCE_URL = f"/pihole_timer/{CARD_FILENAME}"
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


async def _async_ensure_lovelace_resource(hass: HomeAssistant) -> None:
    """Write lovelace resource entry if not already present. Idempotent."""
    store = storage.Store(hass, 1, LOVELACE_RESOURCES_STORAGE_KEY)
    try:
        data = await store.async_load() or {}
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Could not read lovelace_resources: %s", err)
        return

    items: list[dict] = data.get("items", [])

    if any(CARD_RESOURCE_URL in item.get("url", "") for item in items):
        _LOGGER.debug("PiHole card resource already present in lovelace_resources")
        return

    items = [item for item in items if item.get("id") != f"{DOMAIN}_card"]
    items.append({
        "id": f"{DOMAIN}_card",
        "type": "module",
        "url": f"{CARD_RESOURCE_URL}?v={CARD_VERSION}",
    })
    data["items"] = items

    try:
        await store.async_save(data)
        hass.bus.async_fire("lovelace_updated")
        _LOGGER.info("PiHole card lovelace resource saved: %s", CARD_RESOURCE_URL)
    except Exception as err:  # noqa: BLE001
        _LOGGER.error("Failed to save lovelace_resources: %s", err)


async def _async_register_card(hass: HomeAssistant) -> None:
    """Register the card JS as a static HTTP path and ensure the lovelace resource entry exists."""
    global _CARD_REGISTERED  # noqa: PLW0603
    if _CARD_REGISTERED:
        return

    # Locate the JS file inside custom_components/pihole_timer/www/
    js_path = pathlib.Path(__file__).parent / "www" / CARD_FILENAME
    if not js_path.is_file():
        _LOGGER.error("Card JS not found at %s", js_path)
        return

    # Register a static HTTP route so the file is reachable at CARD_RESOURCE_URL.
    # This is the only reliable way for an integration-category HACS repo —
    # HACS only serves /hacsfiles/ for plugin-category repos.
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_RESOURCE_URL, str(js_path), cache_headers=False)]
        )
        _LOGGER.info("PiHole card static path registered: %s → %s", CARD_RESOURCE_URL, js_path)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Static path already registered (harmless on reload): %s", err)

    await _async_ensure_lovelace_resource(hass)
    _CARD_REGISTERED = True



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
        protocol = self.entry.data.get("protocol", "http")
        host = self.host.strip()
        # Strip any protocol the user may have typed into the host field
        for prefix in ("https://", "http://"):
            if host.lower().startswith(prefix):
                host = host[len(prefix):]
        return f"{protocol}://{host.rstrip('/')}/api"

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
                        # sid is None when PiHole has no password set —
                        # store empty string as sentinel so we don't re-auth endlessly.
                        self._sid = session.get("sid") or ""
                        return True
                _LOGGER.error("PiHole auth failed: HTTP %s", resp.status)
        except aiohttp.ClientError as err:
            _LOGGER.error("PiHole auth error: %s", err)
        return False

    async def _api_request(
        self, method: str, endpoint: str, data: dict = None
    ) -> dict | None:
        for _attempt in range(2):
            if self._sid is None:
                if not await self._authenticate():
                    return None
            url = f"{self.api_base}/{endpoint}"
            # Empty string sid means no password set — send no auth header.
            headers = {"X-FTL-SID": self._sid} if self._sid else {}
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
        """Return all known clients via the _suggestions endpoint.

        PiHole v6: GET /clients requires a specific {client} path param.
        GET /clients/_suggestions returns all network-seen clients with
        their group assignments — exactly what the card needs.
        """
        result = await self._api_request("GET", "clients/_suggestions")
        return result.get("clients", []) if result else []

    async def get_groups(self) -> list[dict]:
        """Return all groups. GET /groups is correct in PiHole v6."""
        result = await self._api_request("GET", "groups")
        return result.get("groups", []) if result else []

    async def get_client_groups(self, client_ip: str) -> list[int]:
        """Return the current group IDs for a specific client IP.

        PiHole v6: GET /clients/{client} — returns {"client": {"groups": [...]}}
        """
        result = await self._api_request("GET", f"clients/{client_ip}")
        if result:
            client_data = result.get("client", {})
            return client_data.get("groups", [])
        return []

    async def set_client_groups(self, client_ip: str, group_ids: list[int]) -> bool:
        """Assign groups to a client by IP address.

        PiHole v6: PUT /clients/{client} with body {"groups": [...]}
        No numeric ID lookup needed — the IP is the identifier.
        """
        result = await self._api_request(
            "PUT", f"clients/{client_ip}", {"groups": group_ids}
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
