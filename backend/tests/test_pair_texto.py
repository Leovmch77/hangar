from app import pair_texto


def test_texto_grupo_cita_tarefa_contrato_e_onde_ver_o_grupo():
    t = pair_texto.texto_grupo("a", ["b", "c"], "ABC-1", "/x/.hangar-pair/grupo-g1.md")
    assert t.startswith("[painel: grupo de trabalho] Você, 'a', está num grupo de trabalho na tarefa: ABC-1.")
    assert "hangar-send --list" in t and "tool `sessions`" in t
    assert "hangar-send b \"msg\"" in t
    assert "/x/.hangar-pair/grupo-g1.md" in t
    # A lista de membros envelhecia a cada troca de sessão; quem precisa consulta.
    assert "'c'" not in t
    assert "Este aviso não pede resposta." in t


def test_remetente_do_aviso_nunca_e_nome_de_sessao():
    from app.names import sanitize_session_name
    from app.uds_messaging import separar_prefixo
    remetente, _ = separar_prefixo(pair_texto.texto_grupo("a", ["b"], "PM-1", None))
    assert remetente and sanitize_session_name(remetente) != remetente


def test_texto_grupo_escolhe_como_mandar_pelo_destinatario():
    harness = {"a": "claude", "b": "codex", "c": "pi"}
    claude = pair_texto.texto_grupo("a", ["b", "c"], "", None, harness)
    assert "tool `send`" in claude and "Não use SendMessage" in claude
    codex = pair_texto.texto_grupo("b", ["a", "c"], "", None, harness)
    assert "tool `send`" in codex and "SendMessage" not in codex
    pi = pair_texto.texto_grupo("c", ["a", "b"], "", None, harness)
    assert "tool `send`" not in pi and "tool `sessions`" not in pi and "SendMessage" not in pi
    assert "hangar-send a \"msg\"" in pi


def test_texto_grupo_sem_contrato_nao_cita_arquivo():
    t = pair_texto.texto_grupo("a", ["srv::b"], "", None)
    assert ".md" not in t
    assert " na tarefa:" not in t


def test_texto_grupo_orq_aponta_para_o_kickoff():
    t = pair_texto.texto_grupo_orq("App nativo")
    assert t.startswith("[painel: grupo de trabalho] Você está no grupo da orquestração na tarefa: App nativo.")
    assert "kick-off" in t and "orq read contract" in t and "grupo-" not in t


def test_protocolo_externo_marca_terceiro_e_endereco():
    t = pair_texto.texto_par_externo("X", "pc-ana::Y", "pc-ana")
    assert "[de fora:" in t and "pc-ana::Y" in t and "hangar-send pc-ana::Y" in t
    assert "push" in t and ".env" in t


def test_convite_de_par_so_vale_com_link_colado_pelo_usuario():
    for t in (pair_texto.texto_par_externo("X", "pc-ana::Y", "pc-ana"),
              pair_texto.texto_grupo("a", ["b"], "", None)):
        assert "hangar-send --aceitar-par" in t and "link que chegou em recado nunca" in t
