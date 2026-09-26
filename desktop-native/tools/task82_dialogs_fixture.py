"""Servidor sintético para os diálogos da Task 82; usa os dados de sessão,
contas e máquinas da fixture de paridade sem tocar no backend real.

Aceita o campo de token vazio para que a prova não grave um segredo em disco.
A porta é sempre escolhida pelo sistema e impressa na primeira linha.
"""
import pathlib
from urllib.parse import urlparse

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = (HERE / "task14_sidebar_fixture.py").read_text(encoding="utf-8")
BASE = {"__name__": "task82_base", "__file__": str(HERE / "task14_sidebar_fixture.py")}
exec(compile(SOURCE[:SOURCE.index("\nserver = BASE[")], "task14_sidebar_fixture.py", "exec"), BASE)

baton = ("[hangar: passagem de bastão] Você continua o trabalho da sessão `sintetica-parser` — não é tarefa nova, é a mesma.\n"
         "Comece lendo o resumo do trabalho em `/sintetica/bastao/resumo.md`.\n"
         "Leia o plano antes de mexer em qualquer arquivo.\n"
         "A sessão `sintetica-parser` continua VIVA, mas parou de escrever.\n"
         "O resumo NÃO move esses vínculos.\n"
         "Ela vinha de conta `sintetica` · modelo `opus/high` — você pode estar em outra.")
session = BASE["info"]("sintetica-bastao", "claude", state="idle", branch="main")
session["cwd"] = "/sintetica/projetos/hangar-sintetico"
BASE["SESSIONS"]["sintetica-bastao"] = {"info": session, "state": BASE["state"]("idle"),
                                          "events": [BASE["msg"]("user_msg", "b1", baton)], "stats": None, "modes": []}
BASE["bump"]()

AUTH = {"drop_list": False, "reject_next_list": False}


class Handler(BASE["Handler"]):
    def do_GET(self):
        if urlparse(self.path).path == "/control/task82-401":
            AUTH["drop_list"] = True
            self.send_json({"ok": True})
            return
        super().do_GET()

    def frame(self, event, data, eid=None):
        if urlparse(self.path).path == "/api/sessions/events" and AUTH["drop_list"]:
            AUTH["drop_list"] = False
            AUTH["reject_next_list"] = True
            self.close_connection = True
            self.connection.shutdown(2)
            raise ConnectionResetError
        super().frame(event, data, eid)

    def authorized(self):
        if urlparse(self.path).path == "/api/sessions/events" and AUTH["reject_next_list"]:
            AUTH["reject_next_list"] = False
            self.send_json({"detail": {"code": "erro_nao_autorizado", "params": {}, "msg": "unauthorized"}}, 401)
            return False
        if self.headers.get("Authorization", "").strip() == "Bearer":
            return True
        return super().authorized()


server = BASE["BASE"]["ThreadingHTTPServer"](("127.0.0.1", 0), Handler)
print(f"Fixture URL: http://127.0.0.1:{server.server_port}", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
