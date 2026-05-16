"""Config flow for PiHole Bypass integration."""
from __future__ import annotations

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession

DOMAIN = "pihole_timer"


def _build_base_url(host: str, protocol: str) -> str:
    """Return a clean base URL, stripping any protocol the user may have typed."""
    # Strip any embedded protocol so we always use the dropdown value
    host = host.strip()
    for prefix in ("https://", "http://"):
        if host.lower().startswith(prefix):
            host = host[len(prefix):]
    return f"{protocol}://{host.rstrip('/')}"


class PiHoleBypassConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for PiHole Bypass."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors: dict[str, str] = {}

        if user_input is not None:
            error = await self._test_connection(
                user_input["host"],
                user_input["protocol"],
                user_input["api_key"],
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
            data_schema=vol.Schema(
                {
                    vol.Required("name", default="PiHole"): str,
                    vol.Required("protocol", default="http"): vol.In(["http", "https"]),
                    vol.Required("host"): str,
                    vol.Required("api_key"): str,
                }
            ),
            errors=errors,
        )

    async def async_step_reconfigure(self, user_input=None):
        """Allow the user to change host, protocol and API key after initial setup."""
        errors: dict[str, str] = {}

        if user_input is not None:
            error = await self._test_connection(
                user_input["host"],
                user_input["protocol"],
                user_input["api_key"],
            )
            if error:
                errors["base"] = error
            else:
                self.hass.config_entries.async_update_entry(
                    self._get_reconfigure_entry(),
                    data={
                        **self._get_reconfigure_entry().data,
                        "protocol": user_input["protocol"],
                        "host": user_input["host"],
                        "api_key": user_input["api_key"],
                    },
                )
                return self.async_abort(reason="reconfigure_successful")

        entry = self._get_reconfigure_entry()
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        "protocol",
                        default=entry.data.get("protocol", "http"),
                    ): vol.In(["http", "https"]),
                    vol.Required("host", default=entry.data.get("host", "")): str,
                    vol.Required("api_key", default=entry.data.get("api_key", "")): str,
                }
            ),
            errors=errors,
        )

    async def _test_connection(
        self, host: str, protocol: str, password: str
    ) -> str | None:
        """Authenticate and verify /api/clients + /api/groups are reachable.

        Returns an error key string on failure, None on success.
        """
        session = async_get_clientsession(self.hass)
        base = _build_base_url(host, protocol)

        # Step 1: authenticate
        try:
            async with session.post(
                f"{base}/api/auth",
                json={"password": password},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    session_data = data.get("session", {})
                    if not session_data.get("valid"):
                        return "invalid_auth"
                    sid = session_data.get("sid")
                elif resp.status == 401:
                    return "invalid_auth"
                else:
                    return "cannot_connect"
        except aiohttp.ClientConnectorError:
            return "cannot_connect"
        except aiohttp.ClientSSLError:
            return "ssl_error"
        except Exception:  # noqa: BLE001
            return "unknown"

        # Step 2: verify /api/clients and /api/groups respond correctly
        headers = {"sid": sid}
        for endpoint, error_key in (
            ("clients", "api_clients_unavailable"),
            ("groups", "api_groups_unavailable"),
        ):
            try:
                async with session.get(
                    f"{base}/api/{endpoint}",
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 401:
                        return "invalid_auth"
                    if resp.status != 200:
                        return error_key
                    payload = await resp.json()
                    if endpoint not in payload:
                        return error_key
            except aiohttp.ClientConnectorError:
                return "cannot_connect"
            except aiohttp.ClientSSLError:
                return "ssl_error"
            except Exception:  # noqa: BLE001
                return error_key

        return None

    @staticmethod
    @config_entries.callback
    def async_get_options_flow(config_entry):
        """Create the options flow."""
        return PiHoleBypassOptionsFlow()


class PiHoleBypassOptionsFlow(config_entries.OptionsFlow):
    """Options flow for adjustable defaults."""

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
