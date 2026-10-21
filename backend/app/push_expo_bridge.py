"""Ponte privada do aviso no celular pelo Expo: o Python decide quando avisar, o Rust guarda os tokens
e fala com o Expo (`/__hangar_server/push/expo`)."""
import http.client
import json
import logging
import urllib.request

_log = logging.getLogger("hangar.push")
_config: tuple[str, str] | None = None
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def configure(address: str | None, secret: str | None) -> None:
    global _config
    _config = (address, secret) if address and secret else None


def configured() -> bool:
    return _config is not None


def send(session: str, title: dict[str, str], body: dict[str, str], list_view: bool) -> None:
    """Bloqueia até 5 s. Falha vira aviso no log: o push nunca derruba quem o chamou."""
    from app import runtime_coordinator
    owner = runtime_coordinator.current()
    config = _config
    if owner is None or owner.mode == "python" or config is None:
        return
    text = json.dumps({"session": session, "title": title, "body": body, "list": list_view}, ensure_ascii=False)
    # Surrogate solto (texto lido do pane) vira o caractere de troca: o Rust só aceita UTF-8 válido.
    data = text.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")
    req = urllib.request.Request(f"http://{config[0]}/__hangar_server/push/expo", data=data,
        headers={"content-type": "application/json", "x-hangar-internal": config[1]}, method="POST")
    try:
        with _opener.open(req, timeout=5) as response:
            response.read(4096)
    except (OSError, ValueError, http.client.HTTPException) as e:
        _log.warning("push expo falhou session=%s reason=%s", session, type(e).__name__)
