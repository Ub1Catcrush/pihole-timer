"""Config flow for PiHole Bypass integration."""
from __future__ import annotations

import logging
import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession

DOMAIN = "pihole_timer"
_LOGGER = logging.getLogger(__name__)


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
        """Authenticate and verify /api/clients/_suggestions + /api/groups are reachable.

        Returns an error key string on failure, None on success.
        All steps are logged at WARNING level so they always appear in HA logs.
        """
        session = async_get_clientsession(self.hass)
        base = _build_base_url(host, protocol)
        _LOGGER.warning("PiHole config test: connecting to %s", base)

        # Step 1: authenticate
        auth_url = f"{base}/api/auth"
        try:
            async with session.post(
                auth_url,
                json={"password": password},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                _LOGGER.warning(
                    "PiHole config test: POST %s → HTTP %s", auth_url, resp.status
                )
                if resp.status == 200:
                    data = await resp.json()
                    session_data = data.get("session", {})
                    _LOGGER.warning(
                        "PiHole config test: auth response session=%s", session_data
                    )
                    if not session_data.get("valid"):
                        _LOGGER.warning(
                            "PiHole config test: auth rejected (valid=False), message=%s",
                            data.get("message", "—"),
                        )
                        return "invalid_auth"
                    sid = session_data.get("sid")
                    _LOGGER.warning(
                        "PiHole config test: auth OK, sid present=%s", bool(sid)
                    )
                elif resp.status == 401:
                    body = await resp.text()
                    _LOGGER.warning(
                        "PiHole config test: auth 401 body=%s", body[:200]
                    )
                    return "invalid_auth"
                else:
                    body = await resp.text()
                    _LOGGER.warning(
                        "PiHole config test: unexpected auth status %s body=%s",
                        resp.status, body[:200],
                    )
                    return "cannot_connect"
        except aiohttp.ClientConnectorError as err:
            _LOGGER.warning("PiHole config test: connection error: %s", err)
            return "cannot_connect"
        except aiohttp.ClientSSLError as err:
            _LOGGER.warning("PiHole config test: SSL error: %s", err)
            return "ssl_error"
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("PiHole config test: unexpected error during auth: %s", err)
            return "unknown"

        # Step 2: verify /api/clients/_suggestions and /api/groups respond correctly
        headers = {"X-FTL-SID": sid}
        for endpoint, key, error_key in (
            ("clients/_suggestions", "clients", "api_clients_unavailable"),
            ("groups", "groups", "api_groups_unavailable"),
        ):
            url = f"{base}/api/{endpoint}"
            try:
                async with session.get(
                    url,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    body = await resp.text()
                    _LOGGER.warning(
                        "PiHole config test: GET %s → HTTP %s body=%s",
                        url, resp.status, body[:300],
                    )
                    if resp.status == 401:
                        return "invalid_auth"
                    if resp.status != 200:
                        return error_key
                    try:
                        payload = await resp.json(content_type=None)
                    except Exception as parse_err:  # noqa: BLE001
                        _LOGGER.warning(
                            "PiHole config test: JSON parse error for %s: %s",
                            endpoint, parse_err,
                        )
                        return error_key
                    if key not in payload:
                        _LOGGER.warning(
                            "PiHole config test: key '%s' missing from %s response, keys=%s",
                            key, endpoint, list(payload.keys()),
                        )
                        return error_key
                    _LOGGER.warning(
                        "PiHole config test: %s OK (%d items)",
                        endpoint, len(payload[key]),
                    )
            except aiohttp.ClientConnectorError as err:
                _LOGGER.warning("PiHole config test: connection error on %s: %s", url, err)
                return "cannot_connect"
            except aiohttp.ClientSSLError as err:
                _LOGGER.warning("PiHole config test: SSL error on %s: %s", url, err)
                return "ssl_error"
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("PiHole config test: error on %s: %s", url, err)
                return error_key

        _LOGGER.warning("PiHole config test: all checks passed")
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
