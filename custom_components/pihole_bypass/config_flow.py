"""Config flow for PiHole Bypass integration."""
from __future__ import annotations

import aiohttp
import voluptuous as vol
from typing import Any

from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_API_KEY, CONF_NAME
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import DOMAIN

STEP_USER_DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_NAME, default="PiHole"): str,
        vol.Required(CONF_HOST, description={"suggested_value": "192.168.1.x"}): str,
        vol.Required(CONF_API_KEY): str,
    }
)


class PiHoleBypassConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for PiHole Bypass."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.FlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            # Validate connection
            error = await self._test_connection(
                user_input[CONF_HOST], user_input[CONF_API_KEY]
            )
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=user_input[CONF_NAME],
                    data={
                        "name": user_input[CONF_NAME],
                        "host": user_input[CONF_HOST],
                        "api_key": user_input[CONF_API_KEY],
                    },
                )

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            errors=errors,
            description_placeholders={
                "docs_url": "https://docs.pi-hole.net/api/"
            },
        )

    async def _test_connection(self, host: str, api_key: str) -> str | None:
        """Test connection to PiHole API."""
        session = async_get_clientsession(self.hass)
        if not host.startswith("http"):
            host = f"http://{host}"
        url = f"{host.rstrip('/')}/api/auth"

        try:
            async with session.post(
                url,
                json={"password": api_key},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if data.get("session", {}).get("valid"):
                        return None
                    return "invalid_auth"
                elif resp.status == 401:
                    return "invalid_auth"
                else:
                    return "cannot_connect"
        except aiohttp.ClientConnectorError:
            return "cannot_connect"
        except aiohttp.ClientError:
            return "cannot_connect"
        except Exception:
            return "unknown"

    @staticmethod
    def async_get_options_flow(config_entry):
        return PiHoleBypassOptionsFlow(config_entry)


class PiHoleBypassOptionsFlow(config_entries.OptionsFlow):
    """Handle options flow."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self.config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.FlowResult:
        """Manage options."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        "default_duration",
                        default=self.config_entry.options.get("default_duration", 10),
                    ): vol.All(int, vol.Range(min=1, max=1440)),
                }
            ),
        )
