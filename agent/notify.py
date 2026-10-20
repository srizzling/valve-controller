"""Best-effort ntfy alerts from the agent. A no-op unless NTFY_TOPIC is set."""
import logging
import os
import urllib.request

log = logging.getLogger("notify")


def send(title: str, message: str, priority: int = 4, tags: str = "warning") -> None:
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        return
    req = urllib.request.Request(
        f"{os.environ.get('NTFY_URL', 'https://ntfy.sh')}/{topic}",
        data=message.encode(),
        headers={"Title": title, "Priority": str(priority), "Tags": tags},
        method="POST",
    )
    if token := os.environ.get("NTFY_TOKEN"):
        req.add_header("Authorization", f"Bearer {token}")
    try:
        urllib.request.urlopen(req, timeout=10).close()
    except Exception as e:  # noqa: BLE001 - alerts must never break the valve
        log.error("ntfy failed: %s", e)
