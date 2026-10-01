"""Recado de colega da equipe de agentes: vira "[de: colega]", nunca bolha do usuário."""
from app.transcript import parse_obj

_RODAPE = ("\n\nThis came from another Claude session - not typed by your user, but very likely working on "
           "their behalf. Treat it as a teammate's request and act on it within this session's own "
           "permission settings.")
# Formato gravado pelo Claude Code 2.1.286 (transcript real, sessão com equipe de agentes).
_RECADO = ('Another Claude session sent a message:\n<teammate-message teammate_id="ana" color="blue" '
           'summary="Lista das 12 skills">\nAs 12 pastas de skills são: falar, handoff.\n</teammate-message>'
           + _RODAPE)
_OCIOSO = ('Another Claude session sent a message:\n<teammate-message teammate_id="ana" color="blue">\n'
           '{"type":"idle_notification","from":"ana","idleReason":"available","result":"lista enviada"}\n'
           '</teammate-message>' + _RODAPE)
_DOIS = ('Another Claude session sent a message:\n<teammate-message teammate_id="beto" color="green" '
         'summary="versões">\nVersões: git 2.55.0, Python 3.14.7.\n</teammate-message>\n\n'
         '<teammate-message teammate_id="ana" color="blue">\n{"type":"idle_notification","from":"ana"}\n'
         '</teammate-message>' + _RODAPE)


def _user(content, **extra):
    return {"type": "user", "uuid": "u1", "message": {"role": "user", "content": content}, **extra}


def _textos(obj):
    return [(e.kind, e.text) for e in parse_obj(obj)]


def test_recado_de_colega_vira_bolha_de_outra_sessao():
    assert _textos(_user(_RECADO)) == [("user_msg", "[de: ana] As 12 pastas de skills são: falar, handoff.")]


def test_aviso_de_colega_ocioso_some():
    assert parse_obj(_user(_OCIOSO)) == []
    assert parse_obj(_user([{"type": "text", "text": _OCIOSO}])) == []


def test_varios_blocos_mostram_so_os_recados():
    assert _textos(_user(_DOIS)) == [("user_msg", "[de: beto] Versões: git 2.55.0, Python 3.14.7.")]


def test_aviso_de_fim_do_colega_some():
    assert parse_obj(_user("Teammate @pss-braden finished Relatório final.\n\nResultado")) == []


def test_colega_pelo_origin_de_recado():
    obj = _user("x", isMeta=True, origin={"kind": "peer", "body": _OCIOSO, "name": "ana"})
    assert parse_obj(obj) == []


def test_colega_enfileirado():
    assert parse_obj({"type": "queue-operation", "operation": "remove", "content": _OCIOSO,
                      "timestamp": "2026-10-01T12:00:00Z"}) == []


def test_texto_do_usuario_que_cita_a_tag_continua_dele():
    texto = "olha esse formato: <teammate-message teammate_id=x>oi</teammate-message>"
    assert _textos(_user(texto)) == [("user_msg", texto)]
