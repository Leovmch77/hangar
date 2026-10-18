# Contas e anexos no servidor Rust

A migração cobre as contas Claude/Codex e os anexos de sessão. Outros módulos do
backend continuam no Python. O protocolo interno muda nos dois lados juntos.

## Contas

O catálogo, a criação, o preparo, o login, o estado, o cancelamento e o logout são
decididos pelo Rust. Os auxiliares nativos usam a CLI do provedor e a proteção por
conta. A ponte fornece fatos de uso e controla as janelas necessárias ao Claude.
Os destinos secundários Pi/omp são escritos diretamente pelo Rust.

O cache de cotas continua no formato existente, com um escritor e publicação
atômica. O TTL é de cinco minutos; um 429 espera dez minutos, inclusive após
reinício e pedido forçado. O último resultado legível é conservado quando a rede
falha. A assinatura da credencial impede reutilizar a leitura de uma identidade
anterior. Provedores fora desta migração continuam fornecendo leituras pelo Python.

A renovação Claude verifica o uso da conta e mantém exclusividade durante a CLI.
Uma resposta perdida ao abrir ou fechar a janela conserva a guarda e o registro
da operação para limpeza. Uma operação encerrada não pode abrir uma janela tardia.
Não há laço de renovação no Python: sem o Rust, nenhuma conta é renovada.

A redefinição Codex relê a janela de sete dias e só consome crédito quando ela está
em 100%. O UUID é gravado antes do consumo. Retentativas usam a mesma chave; um
resultado definitivo fica persistido e não dispara outro consumo. Depois do
resultado, o cache é invalidado e os limites são relidos.

Apagar uma conta Claude ou Codex copia antes as conversas dela para a conta padrão
do mesmo provedor (`projects/` do Claude; `sessions/` e `archived_sessions/` do
Codex), no mesmo caminho relativo e sem sobrescrever: arquivo igual é pulado e
arquivo diferente vira `<nome>.from-<conta><ext>`. Essa cópia não é conversa: só
`<uuid>.jsonl` conta como transcript (`archive.conversation_files` no Python,
`is_conversation_file` no Rust), em Arquivo, retomada, índice, contagem de worktree e
escolha do transcript da sessão pelo mtime. Link, socket ou fifo entre as conversas,
inclusive a própria raiz (`projects/`, `sessions/`), recusa a exclusão: seguir levaria o que mora fora da conta, pular o apagaria calado. A exceção é o link que aponta para dentro da conta padrão ou, no Claude, do `~/.claude` real (o `memory/` de cada projeto aponta para lá mesmo com `CLAUDE_CONFIG_DIR`): não guarda nada da conta, é pulado e sai com ela. Link quebrado vale pelo alvo escrito nele. A cópia mantém o modo do arquivo (0600 no Claude) e pasta
nova nasce 0700. Só depois da cópia e de cada pasta criada gravadas no disco a pasta
é removida; falha na cópia recusa a exclusão com
`account_transcripts_merge_failed` e mantém a conta. `keep_transcripts=0` volta a
apagar tudo; ausente vale guardar, para cliente antigo não perder conversa.

### Sem reserva Python (09/10/2026)

Contas e cotas não têm mais reserva Python. No modo `python` (sem binário,
`CP_RUST_SERVER=0`, `--reload` ou supervisor que desistiu), as rotas de conta e cota
que o Rust atende respondem 503 com `accounts_need_rust_server`, e os consumidores
internos (criação de sessão, `loop.py`, política do runtime, catálogo de provedores)
tratam a ponte ausente como "sem cota, sem login conhecido", sem ler
credencial nem abrir CLI. O conserto de OAuth da saúde dos harnesses (importar e
espalhar o login do ChatGPT) também recusa com o mesmo código. Manter as duas implementações custava código duplicado e
testes que provavam um caminho que quase nunca roda. A lista de credenciais
(`GET /api/credenciais`) passou ao Rust em 13/10 e segue a mesma regra: no modo `python`
responde 503 `accounts_need_rust_server`.

Continua no Python, por ser o que o Rust consome ou o que ele não atende:

- as rotas `/internal` de contas: janela escondida do login e da renovação
  (`ClaudeWindows`, em `claude_window.py`), fatos de uso, preparo e invalidação do
  catálogo de modelos do Codex;
- os leitores de cota Codex que a transferência de conversa usa;
- as escritas de credenciais: apelido, cookie do OpenCode, sincronização nos agentes e
  remoção de provedor Kimi.

Desde 13/10/2026 a lista `GET /api/credenciais` e as cotas de Kimi, CommandCode e OpenCode
são do Rust, sem pergunta ao Python (ver "Migrar é migrar o caminho inteiro" em
[plataforma.md](plataforma.md#migrar-é-migrar-o-caminho-inteiro)).

## Anexos

O Rust atende upload, galeria, download e resolução de áudio pelo cofre existente.
O corpo entra em stream, com limite de 100 MiB, temporário privado e publicação
sem sobrescrever um arquivo anterior. Desconexão remove somente o temporário
daquela operação. A galeria e a poda usam a mesma retenção configurada.

O download mantém o descritor validado durante a resposta, suporta Range/If-Range
e dispõe HTML em iframe isolado. SVG/XML mantêm o MIME do `mime_guess`
e bloqueiam scripts.

Vídeos geram seis quadros distribuídos pela duração e uma faixa de áudio.
Sem duração legível, é tentado um quadro inicial. Cada subprocesso tem prazo,
e os derivados só entram na galeria depois da publicação pelo cofre. Falha de
extração ou transcrição preserva o upload original. `audio_only` evita extração e
transcrição duplicadas.

Desde 18/10/2026 nenhum pedido de anexo pergunta ao Python. Antes, cada pedido buscava
`/internal/sessions/{nome}/uploads-facts` (pasta, id, retenção, MIME, trava da troca) e o vídeo
transcrevia por `/internal/.../upload-transcript`, que voltava ao Rust: uma volta Rust → Python
→ Rust que prendia uma thread do Python. Agora a sessão e o `cwd` vêm da descoberta da lista
(`side.locate`), o id é o `session_key` do transcript (o nome enquanto não há transcript), a
retenção é a do `runtime-config.json`, depois `CP_UPLOAD_RETENTION_DAYS`, depois 30, e a
transcrição do vídeo roda no serviço de transcrição, no perfil de vídeo. O `/transcribe` da
sessão também é do Rust: grava ou resolve o áudio no cofre, transcreve e organiza dentro do
processo; o corte de 180/270 s da ponte Python deixou de existir, vale o prazo do serviço.

Connect (8768) e convidado com login entram pelo Python, que autentica e repassa em fluxo
(`account_bridge.forward_stream`) a `/__hangar_server/forwarded`; `x-hangar-forwarded-guest: 1`
mantém os limites do convidado (sem caminho absoluto no `/transcribe`, sem a conta do harness
na organização). No modo `python` do Supervisor essas rotas respondem 503
`erro_midia_precisa_rust`, sem reserva Python.

## Saída ao vivo de ferramenta e imagem colada

`bash-output` lê só os shells abaixo do agente da sessão (pid do registro nativo
`<conta>/sessions/<pid>.json`), nunca a máquina inteira: antes, um convidado completo numa
sessão lia a saída de outra que rodasse o mesmo comando. No Windows os arquivos abertos do
shell vêm dos handles do processo (`NtQuerySystemInformation` + `GetFinalPathNameByHandleW`,
só arquivo de disco). `tool-progress` recusa id com quebra de linha no fim e pula linha que não
é UTF-8. A imagem colada só sai como `image/png`, `jpeg`, `gif` ou `webp`; qualquer outro tipo
(SVG incluído) vai como `application/octet-stream`, sempre com `nosniff`. A imagem de conversa
transferida (`transfer:`) e a do Arquivo seguem no Python, como o histórico delas.

## Verificação

As verificações focadas exercitam cache/429/reinício, concorrência e perda de
resposta do reset, posse dos auxiliares, upload/galeria, limites, Range e isolamento
de documentos. A criação e o login humano devem ser conferidos antes de retirar
o PR de rascunho.
