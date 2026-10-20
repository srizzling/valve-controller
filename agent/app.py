"""HTTP API in front of the valve. Meant to sit behind a Cloudflare Tunnel."""
import hmac
import logging
import os

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

import notify
from valve import Valve, ValveError

log = logging.getLogger("agent")


class OpenRequest(BaseModel):
    seconds: int = Field(gt=0, le=24 * 3600)


def create_app(valve: Valve, token: str) -> FastAPI:
    app = FastAPI(title="valve-agent")

    def require_token(authorization: str = Header(default="")) -> None:
        expected = f"Bearer {token}"
        if not hmac.compare_digest(authorization.encode(), expected.encode()):
            raise HTTPException(401, "unauthorized")

    def guarded(fn):
        try:
            return fn()
        except ValveError as e:
            log.error("valve error: %s", e)
            raise HTTPException(502, f"valve error: {e}")

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/status", dependencies=[Depends(require_token)])
    def status():
        return guarded(valve.status)

    @app.post("/valve/open", dependencies=[Depends(require_token)])
    def open_valve(body: OpenRequest):
        granted = guarded(lambda: valve.open(body.seconds))
        return {"open": True, "closes_in": granted}

    @app.post("/valve/close", dependencies=[Depends(require_token)])
    def close_valve():
        guarded(valve.close)
        return {"open": False}

    return app


def create_app_from_env() -> FastAPI:
    import tinytuya

    device = tinytuya.OutletDevice(
        dev_id=os.environ["TUYA_DEVICE_ID"],
        address=os.environ["TUYA_IP"],
        local_key=os.environ["TUYA_LOCAL_KEY"],
        version=float(os.environ.get("TUYA_VERSION", "3.4")),
    )
    device.set_socketTimeout(5)
    device.set_socketRetryLimit(2)

    valve = Valve(
        device,
        dp=int(os.environ.get("TUYA_DP", "1")),
        max_on_seconds=int(os.environ.get("MAX_ON_SECONDS", "3900")),
        alert=lambda title, message: notify.send(title, message, priority=5, tags="rotating_light"),
    )
    try:
        valve.close()  # an agent restart mid-run must not leave water running
    except ValveError as e:
        log.error("could not close valve at startup: %s", e)
        notify.send("Valve: agent cannot reach valve", f"The agent started but could not close the valve: {e}", priority=4)
    return create_app(valve, os.environ["AGENT_TOKEN"])
