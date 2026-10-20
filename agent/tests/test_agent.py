import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from fastapi.testclient import TestClient

from app import create_app
from valve import Valve, ValveError


class FakeDevice:
    def __init__(self):
        self.on = False
        self.fail = False

    def set_status(self, on, switch=1, nowait=False):
        if self.fail:
            return {"Error": "Network Error: Unable to Connect", "Err": "901"}
        self.on = on
        return {"dps": {str(switch): on}}

    def status(self):
        return {"dps": {"1": self.on}}


@pytest.fixture
def device():
    return FakeDevice()


@pytest.fixture
def client(device):
    return TestClient(create_app(Valve(device, max_on_seconds=60), token="secret"))


AUTH = {"Authorization": "Bearer secret"}


def test_requires_token(client):
    assert client.post("/valve/open", json={"seconds": 5}).status_code == 401
    assert client.get("/status", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/healthz").status_code == 200


def test_open_and_close(client, device):
    r = client.post("/valve/open", json={"seconds": 30}, headers=AUTH)
    assert r.json() == {"open": True, "closes_in": 30}
    assert device.on
    assert client.get("/status", headers=AUTH).json()["open"] is True
    client.post("/valve/close", headers=AUTH)
    assert not device.on
    assert client.get("/status", headers=AUTH).json() == {"open": False, "closes_in": None}


def test_open_is_capped(client):
    r = client.post("/valve/open", json={"seconds": 3600}, headers=AUTH)
    assert r.json()["closes_in"] == 60
    client.post("/valve/close", headers=AUTH)


def test_auto_close_fires(device):
    valve = Valve(device)
    valve.open(1)
    assert device.on
    time.sleep(1.4)
    assert not device.on


def test_auto_close_alerts_owner(device):
    alerts = []
    valve = Valve(device, alert=lambda title, message: alerts.append(title))
    valve.open(1)
    time.sleep(1.4)
    assert alerts == ["Valve: closed by agent timer"]


def test_explicit_close_does_not_alert(device):
    alerts = []
    valve = Valve(device, alert=lambda title, message: alerts.append(title))
    valve.open(1)
    valve.close()
    time.sleep(1.4)
    assert alerts == []


def test_failed_auto_close_alerts_loudly(device):
    alerts = []
    valve = Valve(device, alert=lambda title, message: alerts.append(title))
    valve.open(1)
    device.fail = True
    time.sleep(1.4)
    assert alerts == ["Valve: FAILED to close"]
    valve._disarm()


def test_device_error_is_502(client, device):
    device.fail = True
    assert client.post("/valve/open", json={"seconds": 5}, headers=AUTH).status_code == 502


def test_failed_close_keeps_retrying(device):
    valve = Valve(device)
    valve.open(30)
    device.fail = True
    with pytest.raises(ValveError):
        valve.close()
    assert valve._timer is not None  # re-armed to retry, not abandoned
    valve._disarm()
