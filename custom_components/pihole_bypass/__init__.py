"""PiHole Bypass Integration for Home Assistant."""
from __future__ import annotations

import logging
import asyncio
import aiohttp
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import storage
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

DOMAIN = "pihole_bypass"
STORAGE_KEY = f"{DOMAIN}.timers"
STORAGE_VERSION = 1

PLATFORMS = []


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the PiHole Bypass component."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up PiHole Bypass from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    coordinator = PiHoleBypassCoordinator(hass, entry)
    hass.data[DOMAIN][entry.entry_id] = coordinator

    await coordinator.async_initialize()

    # Register services
    async def handle_activate_bypass(call: ServiceCall) -> None:
        """Handle activate bypass service call."""
        await coordinator.activate_bypass(
            client_ip=call.data.get("client_ip"),
            groups=call.data.get("groups", []),
            duration_minutes=call.data.get("duration_minutes", 10),
        )

    async def handle_deactivate_bypass(call: ServiceCall) -> None:
        """Handle deactivate bypass service call."""
        await coordinator.deactivate_bypass(
            client_ip=call.data.get("client_ip"),
        )

    async def handle_get_clients(call: ServiceCall) -> None:
        """Handle get clients service call."""
        clients = await coordinator.get_clients()
        hass.bus.async_fire(f"{DOMAIN}_clients_loaded", {"clients": clients})

    async def handle_get_groups(call: ServiceCall) -> None:
        """Handle get groups service call."""
        groups = await coordinator.get_groups()
        hass.bus.async_fire(f"{DOMAIN}_groups_loaded", {"groups": groups})

    hass.services.async_register(DOMAIN, "activate_bypass", handle_activate_bypass)
    hass.services.async_register(DOMAIN, "deactivate_bypass", handle_deactivate_bypass)
    hass.services.async_register(DOMAIN, "get_clients", handle_get_clients)
    hass.services.async_register(DOMAIN, "get_groups", handle_get_groups)

    # Register REST API endpoint for the card
    hass.http.register_view(PiHoleBypassView(coordinator))

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    coordinator = hass.data[DOMAIN].pop(entry.entry_id, None)
    if coordinator:
        await coordinator.async_cleanup()
    return True


class PiHoleBypassCoordinator:
    """Coordinator for PiHole Bypass operations."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the coordinator."""
        self.hass = hass
        self.entry = entry
        self.session = async_get_clientsession(hass)
        self._store = storage.Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._active_timers: dict[str, asyncio.TimerHandle] = {}
        self._timer_data: dict[str, dict] = {}

    @property
    def host(self) -> str:
        return self.entry.data.get("host", "")

    @property
    def api_key(self) -> str:
        return self.entry.data.get("api_key", "")

    @property
    def api_base(self) -> str:
        host = self.host.rstrip("/")
        if not host.startswith("http"):
            host = f"http://{host}"
        return f"{host}/api"

    async def async_initialize(self) -> None:
        """Initialize and restore any active timers."""
        data = await self._store.async_load()
        if data:
            now = dt_util.utcnow()
            for client_ip, timer_info in data.get("timers", {}).items():
                end_time = datetime.fromisoformat(timer_info["end_time"])
                if end_time > now:
                    remaining = (end_time - now).total_seconds()
                    self._schedule_restore(client_ip, timer_info["original_groups"], remaining)
                    self._timer_data[client_ip] = timer_info
                else:
                    # Timer expired while HA was offline - restore immediately
                    await self._restore_client_groups(client_ip, timer_info["original_groups"])

    async def async_cleanup(self) -> None:
        """Cancel all active timers."""
        for handle in self._active_timers.values():
            handle.cancel()
        self._active_timers.clear()

    async def _api_request(self, method: str, endpoint: str, data: dict = None) -> dict | None:
        """Make an API request to PiHole."""
        url = f"{self.api_base}/{endpoint}"
        headers = {}
        if self.api_key:
            headers["X-FTL-SID"] = self.api_key

        try:
            async with self.session.request(
                method, url, json=data, headers=headers, timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status == 200:
                    return await resp.json()
                else:
                    _LOGGER.error("PiHole API error %s: %s", resp.status, await resp.text())
                    return None
        except aiohttp.ClientError as err:
            _LOGGER.error("PiHole connection error: %s", err)
            return None

    async def _get_auth_token(self) -> str | None:
        """Authenticate and get session token."""
        url = f"{self.api_base}/auth"
        try:
            async with self.session.post(
                url,
                json={"password": self.api_key},
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("session", {}).get("sid")
        except aiohttp.ClientError as err:
            _LOGGER.error("PiHole auth error: %s", err)
        return None

    async def get_clients(self) -> list[dict]:
        """Get all clients from PiHole."""
        result = await self._api_request("GET", "clients")
        if result:
            return result.get("clients", [])
        return []

    async def get_groups(self) -> list[dict]:
        """Get all groups from PiHole."""
        result = await self._api_request("GET", "groups")
        if result:
            return result.get("groups", [])
        return []

    async def get_client_groups(self, client_ip: str) -> list[int]:
        """Get the current group assignments for a client."""
        clients = await self.get_clients()
        for client in clients:
            if client.get("ip") == client_ip or client.get("comment") == client_ip:
                return client.get("groups", [])
        return []

    async def set_client_groups(self, client_ip: str, group_ids: list[int]) -> bool:
        """Set group assignments for a client."""
        # Find client ID first
        clients = await self.get_clients()
        client_id = None
        for client in clients:
            if client.get("ip") == client_ip:
                client_id = client.get("id")
                break

        if client_id is None:
            _LOGGER.error("Client %s not found", client_ip)
            return False

        result = await self._api_request(
            "PUT",
            f"clients/{client_id}",
            {"groups": group_ids}
        )
        return result is not None

    async def activate_bypass(self, client_ip: str, groups: list[int], duration_minutes: int) -> bool:
        """Activate bypass for a client."""
        # Save original groups
        original_groups = await self.get_client_groups(client_ip)

        # Set new groups
        success = await self.set_client_groups(client_ip, groups)
        if not success:
            return False

        # Cancel any existing timer for this client
        if client_ip in self._active_timers:
            self._active_timers[client_ip].cancel()

        # Store timer data
        end_time = dt_util.utcnow() + timedelta(minutes=duration_minutes)
        timer_info = {
            "client_ip": client_ip,
            "original_groups": original_groups,
            "bypass_groups": groups,
            "end_time": end_time.isoformat(),
            "duration_minutes": duration_minutes,
        }
        self._timer_data[client_ip] = timer_info

        # Persist timer data
        await self._save_timers()

        # Schedule restore
        self._schedule_restore(client_ip, original_groups, duration_minutes * 60)

        # Fire event
        self.hass.bus.async_fire(f"{DOMAIN}_bypass_activated", {
            "client_ip": client_ip,
            "groups": groups,
            "end_time": end_time.isoformat(),
        })

        _LOGGER.info("Bypass activated for %s for %d minutes", client_ip, duration_minutes)
        return True

    def _schedule_restore(self, client_ip: str, original_groups: list[int], delay_seconds: float) -> None:
        """Schedule restoration of client groups."""
        def restore_callback():
            asyncio.ensure_future(self._restore_client_groups(client_ip, original_groups))

        handle = self.hass.loop.call_later(delay_seconds, restore_callback)
        self._active_timers[client_ip] = handle

    async def _restore_client_groups(self, client_ip: str, original_groups: list[int]) -> None:
        """Restore original group assignments."""
        success = await self.set_client_groups(client_ip, original_groups)

        if success:
            self._active_timers.pop(client_ip, None)
            self._timer_data.pop(client_ip, None)
            await self._save_timers()

            self.hass.bus.async_fire(f"{DOMAIN}_bypass_expired", {
                "client_ip": client_ip,
                "restored_groups": original_groups,
            })
            _LOGGER.info("Groups restored for client %s", client_ip)

    async def deactivate_bypass(self, client_ip: str) -> bool:
        """Manually deactivate bypass for a client."""
        if client_ip in self._active_timers:
            self._active_timers[client_ip].cancel()
            self._active_timers.pop(client_ip)

        timer_info = self._timer_data.pop(client_ip, None)
        if timer_info:
            await self.set_client_groups(client_ip, timer_info["original_groups"])
            await self._save_timers()
            self.hass.bus.async_fire(f"{DOMAIN}_bypass_cancelled", {"client_ip": client_ip})
            return True
        return False

    async def get_active_timers(self) -> dict:
        """Get all currently active timers with remaining time."""
        now = dt_util.utcnow()
        result = {}
        for client_ip, info in self._timer_data.items():
            end_time = datetime.fromisoformat(info["end_time"])
            remaining = max(0, (end_time - now).total_seconds())
            result[client_ip] = {
                **info,
                "remaining_seconds": remaining,
            }
        return result

    async def _save_timers(self) -> None:
        """Persist timer data to storage."""
        await self._store.async_save({"timers": self._timer_data})


from homeassistant.components.http import HomeAssistantView
from aiohttp import web


class PiHoleBypassView(HomeAssistantView):
    """Handle PiHole Bypass API requests."""

    url = "/api/pihole_bypass/{action}"
    name = "api:pihole_bypass"
    requires_auth = True

    def __init__(self, coordinator: PiHoleBypassCoordinator) -> None:
        self.coordinator = coordinator

    async def get(self, request: web.Request, action: str) -> web.Response:
        """Handle GET requests."""
        if action == "clients":
            clients = await self.coordinator.get_clients()
            return self.json({"clients": clients})
        elif action == "groups":
            groups = await self.coordinator.get_groups()
            return self.json({"groups": groups})
        elif action == "timers":
            timers = await self.coordinator.get_active_timers()
            return self.json({"timers": timers})
        return self.json_message("Unknown action", 404)

    async def post(self, request: web.Request, action: str) -> web.Response:
        """Handle POST requests."""
        try:
            data = await request.json()
        except Exception:
            return self.json_message("Invalid JSON", 400)

        if action == "activate":
            success = await self.coordinator.activate_bypass(
                client_ip=data.get("client_ip"),
                groups=data.get("groups", []),
                duration_minutes=data.get("duration_minutes", 10),
            )
            return self.json({"success": success})
        elif action == "deactivate":
            success = await self.coordinator.deactivate_bypass(
                client_ip=data.get("client_ip"),
            )
            return self.json({"success": success})

        return self.json_message("Unknown action", 404)
