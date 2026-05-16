"""PiHole Bypass Integration for Home Assistant."""
from __future__ import annotations

import logging
import asyncio
import aiohttp
from datetime import datetime, timedelta
from pathlib import Path

from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import storage
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.util import dt as dt_util
from aiohttp import web

_LOGGER = logging.getLogger(__name__)

DOMAIN = "pihole_bypass"
STORAGE_KEY = f"{DOMAIN}.timers"
STORAGE_VERSION = 1

LOVELACE_RESOURCE_URL = "/pihole_bypass/pihole-bypass-card.js"
LOVELACE_RESOURCES_STORAGE_KEY = "lovelace_resources"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})

    coordinator = PiHoleBypassCoordinator(hass, entry)
    hass.data[DOMAIN][entry.entry_id] = coordinator

    await coordinator.async_initialize()

    # Serve the card JS from inside the integration directory
    card_path = Path(__file__).parent / "www" / "pihole-bypass-card.js"
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            url_path=LOVELACE_RESOURCE_URL,
            path=str(card_path),
            cache_headers=False,
        )
    ])

    # Auto-register the Lovelace resource (runs once, idempotent)
    await _async_register_lovelace_resource(hass)

    # REST API for the card
    hass.http.register_view(PiHoleBypassView(coordinator))

    return True


async def _async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """Add the card JS to Lovelace resources if not already present."""
    store = storage.Store(hass, 1, LOVELACE_RESOURCES_STORAGE_KEY)
    try:
        data = await store.async_load() or {}
    except Exception:  # noqa: BLE001
        data = {}

    items: list[dict] = data.get("items", [])

    # Already registered?
    for item in items:
        if item.get("url", "").startswith(LOVELACE_RESOURCE_URL.split("?")[0]):
            _LOGGER.debug("Lovelace resource already registered, skipping")
            return

    items.append({
        "id": str(len(items) + 1),
        "type": "module",
        "url": f"{LOVELACE_RESOURCE_URL}?v=1.2.0",
    })
    data["items"] = items
    await store.async_save(data)
    _LOGGER.info("PiHole Bypass: Lovelace resource registered automatically")

    hass.bus.async_fire("lovelace_updated")


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = hass.data[DOMAIN].pop(entry.entry_id, None)
    if coordinator:
        await coordinator.async_cleanup()
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

    async def _api_request(self, method: str, endpoint: str, data: dict = None) -> dict | None:
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
                    _LOGGER.error("PiHole API %s %s → HTTP %s", method, endpoint, resp.status)
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
            end_time = datetime.fromisoformat(info["end_time"])
            remaining = max(0, (end_time - now).total_seconds())
            result[client_ip] = {**info, "remaining_seconds": remaining}
        return result

    async def _save_timers(self) -> None:
        await self._store.async_save({"timers": self._timer_data})


class PiHoleBypassView(HomeAssistantView):
    url = "/api/pihole_bypass/{action}"
    name = "api:pihole_bypass"
    requires_auth = True

    def __init__(self, coordinator: PiHoleBypassCoordinator) -> None:
        self.coordinator = coordinator

    async def get(self, request: web.Request, action: str) -> web.Response:
        if action == "clients":
            return self.json({"clients": await self.coordinator.get_clients()})
        if action == "groups":
            return self.json({"groups": await self.coordinator.get_groups()})
        if action == "timers":
            return self.json({"timers": await self.coordinator.get_active_timers()})
        return self.json_message("Unknown action", status_code=404)

    async def post(self, request: web.Request, action: str) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return self.json_message("Invalid JSON", status_code=400)
        if action == "activate":
            ok = await self.coordinator.activate_bypass(
                client_ip=data.get("client_ip"),
                groups=data.get("groups", []),
                duration_minutes=int(data.get("duration_minutes", 10)),
            )
            return self.json({"success": ok})
        if action == "deactivate":
            ok = await self.coordinator.deactivate_bypass(data.get("client_ip"))
            return self.json({"success": ok})
        return self.json_message("Unknown action", status_code=404)
