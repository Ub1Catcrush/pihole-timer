"""Config flow for PiHole Bypass integration."""
from __future__ import annotations

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession

DOMAIN = "pihole_bypass"

STEP_USER_DATA_SCHEMA = vol.Schema(
    {
        vol.Required("name", default="PiHole"): str,
        vol.Required("host"): str,
        vol.Required("api_key"): str,
    }
)


class PiHoleBypassConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for PiHole Bypass."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors: dict[str, str] = {}

        if user_input is not None:
            error = await self._test_connection(
                user_input["host"], user_input["api_key"]
            )
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=user_input["name"],
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            errors=errors,
        )

    async def _test_connection(self, host: str, password: str) -> str | None:
        """Return an error key string, or None on success."""
        session = async_get_clientsession(self.hass)
        if not host.startswith("http"):
            host = f"http://{host}"
        url = f"{host.rstrip('/')}/api/auth"
        try:
            async with session.post(
                url,
                json={"password": password},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if data.get("session", {}).get("valid"):
                        return None
                    return "invalid_auth"
                if resp.status == 401:
                    return "invalid_auth"
                return "cannot_connect"
        except aiohttp.ClientConnectorError:
            return "cannot_connect"
        except Exception:  # noqa: BLE001
            return "unknown"

    @staticmethod
    @config_entries.callback
    def async_get_options_flow(config_entry):
        """Create the options flow."""
        return PiHoleBypassOptionsFlow()


class PiHoleBypassOptionsFlow(config_entries.OptionsFlow):
    """Options flow — no __init__ args needed; self.config_entry is set by HA."""

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current_duration = self.config_entry.options.get("default_duration", 10)

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        "default_duration",
                        default=current_duration,
                    ): vol.All(int, vol.Range(min=1, max=1440)),
                }
            ),
        )
