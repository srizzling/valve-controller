"""Tuya valve wrapper with a hard auto-close.

Every open() carries a duration and arms a local timer, so if the Worker (or the
tunnel) dies mid-run the valve still closes by itself.
"""
import logging
import threading
import time
from typing import Any, Protocol

log = logging.getLogger("valve")


class Device(Protocol):
    def set_status(self, on: Any, switch: int = 1, nowait: bool = False) -> dict[str, Any]: ...
    def status(self) -> dict[str, Any]: ...


class ValveError(RuntimeError):
    pass


class Valve:
    def __init__(self, device: Device, dp: int = 1, max_on_seconds: int = 1800):
        self._device = device
        self._dp = dp
        self._max = max_on_seconds
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._closes_at: float | None = None

    def open(self, seconds: int) -> int:
        """Open the valve and schedule a local close. Returns the seconds actually granted."""
        granted = max(1, min(int(seconds), self._max))
        with self._lock:
            self._set(True)
            self._arm(granted)
        return granted

    def close(self) -> None:
        with self._lock:
            self._disarm()
            try:
                self._set(False)
            except ValveError:
                self._arm(5)  # keep trying locally even though the caller sees the failure
                raise

    def status(self) -> dict[str, Any]:
        with self._lock:
            result = self._device.status()
            if "Error" in result:
                raise ValveError(str(result["Error"]))
            is_open = bool(result.get("dps", {}).get(str(self._dp)))
            closes_in = None if self._closes_at is None else max(0, round(self._closes_at - time.time()))
            return {"open": is_open, "closes_in": closes_in}

    def _set(self, on: bool) -> None:
        result = self._device.set_status(on, self._dp)
        if isinstance(result, dict) and "Error" in result:
            raise ValveError(str(result["Error"]))

    def _arm(self, seconds: float) -> None:
        self._disarm()
        self._closes_at = time.time() + seconds
        self._timer = threading.Timer(seconds, self._auto_close)
        self._timer.daemon = True
        self._timer.start()

    def _disarm(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
        self._timer = None
        self._closes_at = None

    def _auto_close(self) -> None:
        with self._lock:
            self._timer = None
            self._closes_at = None
            try:
                self._set(False)
                log.warning("auto-close timer fired, valve closed")
            except ValveError as e:
                log.error("auto-close failed (%s), retrying in 5s", e)
                self._arm(5)
