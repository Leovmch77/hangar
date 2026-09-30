# Registro de aceitação do app móvel — cinco entregas

Registro cumulativo exigido por `docs/superpowers/plans/2026-09-29-mobile-validation-batches.md`.
Cada lote (T12, T21, T32, T37, T44) acrescenta a sua seção com: lote/Task, HEAD e binário,
plataforma/aparelho, comando ou percurso, esperado, observado, tentativas 1 e 2, evidências
(sem token nem conversa privada), correções, causa e pendências. Cenário sem registro aqui é
**não conferido**. Segunda correção sem reteste leva "aplicada, não revalidada".

Estados possíveis de um cenário: `pendente`, `falhou`, `conferido`, `não conferido`.

## Entrega 1 — T1: levantamento de empacotamento Android e viabilidade iOS

HEAD: `aeb2ae7e78664ebd3d54ba52675db60a83fd23c5` (branch `mobile-deliveries-orq-cad3e6fe-t1`).
Data: 29/09/2026. Natureza: levantamento estático e leitura do ambiente. Nenhum build, instalação,
teste ou percurso foi executado; APK, login e reabertura ficam para o lote T12.

### Configuração do binário (Step 1)

| Item | Observado | Situação |
|---|---|---|
| `owner` (`mobile/app.json`) | `jeffer1312` | conferido: `eas whoami` na máquina = `jeffer1312 (Role: Owner)` |
| `projectId` | `9fd06001-323e-4b82-835f-6dfc3674236d` | não conferido contra o servidor: `eas project:info` exige `node_modules` instalado no `mobile/` |
| Pacote Android / bundle iOS | `com.hangar.mobile` nos dois | conferido no arquivo; não alterado |
| Perfil `preview` (`mobile/eas.json`) | `distribution: internal`, Android `buildType: apk`, sem `developmentClient` | adequado ao APK sem Metro; `expo-dev-client` não é necessário |
| Versão do app | `version 0.1.0`; `appVersionSource: remote` (versionCode no servidor EAS) | versionCode atual não conferido |
| Assinatura Android | nenhum keystore no repositório (`*.jks` ignorado); credenciais geridas pelo EAS | não conferido: `eas credentials` é interativo e `build:list` exige `node_modules` |
| Hook `eas-build-post-install` | compila Paraglide do core e do app (pastas geradas não versionadas) | presente |
| Workspace | raiz lista `mobile` em `workspaces`; `mobile/package.json` usa `@hangar/core: file:../packages/core` | preservado |
| Metro | `watchFolders` + `nodeModulesPaths` para o core | preservado; o comentário "o app NÃO é workspace" está desatualizado, sem efeito no build |
| EAS CLI | `eas` fora do PATH; `eas-cli/23.2.0` no cache do `npx` (satisfaz `cli.version >= 12.0.0`) | disponível; o CLI avisa versão desatualizada. Não instalar `latest` por suposição |

Nenhum arquivo de configuração foi alterado: nenhuma incompatibilidade foi demonstrada.

**Divergência entre os dois lockfiles.** O EAS detecta o monorepo e instala pelo `package-lock.json`
da raiz; o desenvolvimento local em `mobile/` usa `mobile/package-lock.json`. As dependências
declaradas coincidem, mas as versões resolvidas diferem em patch: `expo` 57.0.21 (raiz) × 57.0.20
(mobile), `expo-router` 57.0.20 × 57.0.19, `@expo/ui` 57.0.17 × 57.0.16; `react-native` 0.86.2,
`react` 19.2.3 e `react-native-reanimated` 4.6.0 iguais. Ambas dentro das faixas `~57.0.x`. Risco
para T12: o APK do EAS pode não ter as mesmas versões do Metro local; registrar as versões do log
de instalação do build.

### Ambiente Android desta máquina (para T12)

| Item | Observado |
|---|---|
| SDK | `ANDROID_HOME=/opt/android-sdk`; `adb`, `emulator`, `build-tools`, `ndk`, `cmdline-tools` presentes (`adb`/`emulator` fora do PATH) |
| AVD | `hangar` — `pixel_7`, `android-36`, `google_apis/x86_64`, sem Play Store |
| Aparelho conectado | nenhum (`adb devices` vazio) |
| Java | OpenJDK 17.0.19 |
| Node / npm | v24.18.0 / 11.16.0 |
| `node_modules` na worktree | ausente (raiz e `mobile/`); `eas build` e `project:info` precisam dele |

### Pré-requisitos antes do build de T12

1. Instalar dependências do app na worktree do lote (`npm install` em `mobile/` ou `npm ci` na raiz) — sem isso o `eas` falha em `Failed to resolve plugin for module "expo-router"`.
2. Reservar `mobile-build` e `mobile-signing` (`orq lock take`) e confirmar autorização do build remoto.
3. Conferir o conjunto enviado: o EAS envia o que o git rastreia; a árvore precisa estar limpa ou só com o trabalho do lote.
4. Rodar com o CLI registrado: `(cd <worktree>/mobile && <eas-cli 23.2.0> build --platform android --profile preview)`; registrar ID do build, versionCode e se o keystore já existia ou foi gerado.
5. Instalar o APK no AVD `hangar`, encerrar Metro, conectar por QR ou endereço/token, reabrir e confirmar servidor salvo; token recusado deve mostrar a causa.

### Cenários da entrega 1 herdados de T1 (para o lote T12)

| Cenário | Situação |
|---|---|
| APK `preview` gerado pelo EAS sem Metro | pendente |
| APK instalado e aberto no emulador, tela de login montada | pendente |
| Conexão por endereço/token e reabertura com servidor salvo | pendente |
| Token recusado mostra a causa | pendente |

### Viabilidade iOS (Step 4)

| Item | Situação |
|---|---|
| Conta Apple Developer ligada ao EAS | não conferido: nenhuma credencial Apple encontrada nesta máquina; depende do Jefferson |
| iPhone disponível e registrado (`eas device:create`) | não conferido |
| Canal interno (ad hoc / TestFlight) | não conferido; TestFlight e submit fora do escopo |
| Build `eas build --platform ios --profile preview` | não tentado: sem credenciais nem autorização de build remoto |
| Configuração | `bundleIdentifier com.hangar.mobile`, `supportsTablet: false`, `NSAllowsArbitraryLoads`, textos de rede local, câmera e microfone presentes |

Impedimento iOS registrado; não bloqueia a entrega Android.


## Entrega 1 — T12: lote amplo Android conversável

Execução: 29–30/09/2026, worktree `hangar-mobile-deliveries-cad3e6fe-t12`, branch
`mobile-deliveries-orq-cad3e6fe-t12`. Base integrada T1–T11:
`8b157f058bbd42ee27066d33ca4be58a8c235c0d`, conferida antes da primeira edição;
árvore limpa na entrada. Suites desta seção usam essa base e as correções abaixo.
**O resultado automatizado não aprova a entrega Android.** Situação do APK e dos
percursos registrada separadamente abaixo. Nenhum teste de backend/PWA/Rust rodou.

### Preparação e ferramentas

Dependências instaladas nesta worktree com `npm ci --prefix mobile --workspaces=false`
e `npm ci --workspace=@hangar/core --include-workspace-root`; ambos exit 0. Os lockfiles
não mudaram. A instalação mobile informou 13 vulnerabilidades moderadas e script
`react-native-enriched-markdown` não autorizado pelo npm; não foi aplicado `audit fix`
nem atualização de dependências. Paraglide foi gerado pelos scripts existentes.

CLI EAS 23.2.0 já instalado; projeto remoto conferido como `@jeffer1312/hangar`, ID
`9fd06001-323e-4b82-835f-6dfc3674236d`. Android SDK `/opt/android-sdk`, AVD `hangar`
Pixel 7, Android API 36, x86_64; tela 1080×2400, densidade 420. Recursos `screen`,
`android-emulator`, `mobile-build`, `mobile-signing`, `mobile-version` reservados por T12.
Nenhum serviço/Metro foi iniciado ou reiniciado, nem sessão de terceiro operada.

A primeira abertura do emulador em shell com `&` não manteve o processo vivo; log vazio
não foi tratado como sucesso. Segunda tentativa em processo acompanhado iniciou o AVD;
`sys.boot_completed=1`. Daemon adb ficou ativo; nenhuma autorização para encerrar daemon
alheio foi inferida. O AVD já continha `com.hangar.mobile`, versão 0.1.0/versionCode 1,
instalado em 05/09/2026, portanto não era um APK da revisão T1.

### Suites e typechecks — limite de tentativas preservado

| Família/comando | Esperado | Tentativa 1 | Correção e tentativa 2 | Resultado |
|---|---|---|---|---|
| `npm --prefix packages/core run check` | Nenhum erro TS | exit 2: `api.test.ts:455`, TS2322, spy genérico não garante `() => void` | Tipo da declaração alinhado à inicialização `vi.fn<() => void>`; único reteste do check, exit 0 | conferido |
| `npm --prefix packages/core run test` | Suite core sem falhas | exit 0, 666/666 testes, 47/47 arquivos | não repetido | conferido |
| `npm --prefix mobile run typecheck` | Nenhum erro TS | exit 0 | não repetido | conferido |
| `npm --prefix mobile run test` | Suite mobile sem falhas | exit 1, 207/209 testes, 34/36 arquivos | Reteste somente `src/stores/chat.test.ts src/features/ask/AskSheet.test.tsx`, exit 0, 55/55 testes, 2/2 arquivos | falhas iniciais consertadas e conferidas; suite inteira não repetida |
| Rejeição antiga após sair/reabrir | Eco de `nova` preservado | Regressão nova: esperado `['nova']`, observado `[]` | Removido reset de `pendingSeq` no `release`, preservando identidade dos envios; caso passou no reteste acima | conferido automaticamente |
| ACK de cancelamento antigo após trocar servidor | Pergunta nova continua aberta | Falhou antes da mutação: botão `Cancel` inexistente na fase inicial Codex | Teste agora escolhe `Primeira` para chegar à revisão antes de cancelar, como os demais casos; asserções de destino/ACK preservadas; passou no reteste acima | conferido automaticamente |
| Plano Codex com prosa, link e arquivo | Sem tags, prosa/links íntegros e chip abre destino certo | Tentativa anterior 1 falhou na revisão T4; preservada, não reiniciada | Tentativa 2 neste lote: bolha real via `vi.importActual`, prosa antes/depois, links e rota `/s/srv/sess/files?path=%2Frepo%2Fdocs%2Fplano.md` conferidos; sem novo reteste | conferido automaticamente; não é prova Android |

O teste da bolha falharia se `planDisplayText` descartasse a prosa ou o chip abrisse outro
servidor/caminho; Markdown e dependências nativas usam os mocks DOM existentes. A regressão
de envio falhou antes da correção produtiva. A correção do spy e a preparação do cancelamento
alteram testes; não modificam o comportamento produtivo das perguntas.

Cobertura automática do lote: Codex `tracked=false` clicável, destino explícito de envio,
Parar presente/desabilitado, 401 sem reconexão infinita, watchdog, cursor/ETag e geração no
retorno, pergunta/resposta concorrente, cancelamento/ACK tardio e plano. A tela de startup
Codex, RPC real de Parar, rede real, teclado e rendering nativo continuam exigindo o APK.
`SessionProblem` não foi exercitado no emulador; tradução/detalhe são leitura estática.

Evidências (diretório durável `/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/tasks`):
`t12-core-check-attempt1.txt`, `t12-core-check-attempt2.txt`, `t12-core-test-attempt1.txt`,
`t12-mobile-typecheck-attempt1.txt`, `t12-mobile-test-attempt1.txt`,
`t12-mobile-retest-attempt2.txt`. Duração medida pelo Vitest: core 73,95 s; mobile inicial
332,24 s; reteste afetado 70,98 s. São durações dos runs, com transform/import/testes,
não estimativas humanas nem tempo de fila do `flock`.

### Referência Android e comparação visual

Abertura de `com.hangar.mobile/.MainActivity` no AVD trouxe ANR da interface do sistema;
toque em `Aguarde` liberou a tela. A referência então mostrou literalmente:
`Unable to load script. Make sure you're running Metro or that your bundle
'index.android.bundle' is packaged correctly for release.` O APK da referência foi copiado e inspecionado: 129.046.141 bytes, SHA-256
`f77fc9591e724ace347f09d23b512d202f8000c4796eb613976ea43b12a03664`, calculado sobre
os bytes de `visual/t12/reference.apk`. O ZIP não contém `assets/index.android.bundle`,
confirmando a causa do erro independente do backend. Não foi ligado Metro para
contornar o requisito. Login/lista/conversa da referência **não conferidos**; referência
visual comparável indisponível, nenhuma comparação cega feita.

Capturas inspecionadas: `/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/visual/t12/reference-list.png`
contém o ANR, e `reference-error.png` no mesmo diretório contém o erro de bundle. A primeira
não é uma captura válida de lista. Viewport 1080×2400/portrait, diálogo do sistema em pt-BR;
a tela de erro do React Native está em inglês, portanto não serve para comparar idiomas.
Sem teclado, sem enquadramento equivalente da lista/conversa. Nenhuma imagem comprova
mutação/recuperação. Ausência da referência mantém a avaliação visual pendente.

### APK integrado e percursos no aparelho

Build remoto: `2410f755-df87-4722-a946-8c7bd5557c65`, perfil `preview`,
`appVersion=0.1.0`, `appBuildVersion=1`, `gitCommitHash` igual à base acima. Comando:
`eas build --platform android --profile preview --freeze-credentials --non-interactive
--no-wait --json`. Keystore Android existente utilizado; credenciais congeladas, sem geração
ou mudança de assinatura. Upload de 58 MB, impressão digital do projeto concluída.
O arquivo enviado já contém a correção produtiva de `pendingSeq`; ajustes posteriores são
somente testes e registro do lote. Nenhuma publicação em loja/OTA.

Log remoto confirmou workspace mobile e `npm ci --include=dev` na raiz do monorepo;
1050 pacotes instalados. A resolução do APK segue o lockfile da raiz; as versões patch
locais diferentes registradas em T1 permanecem uma limitação da comparação com mocks.
Não se presume equivalência entre teste DOM e binário Android.

Às 03:11:35 UTC, após criação às 03:01:08 UTC, o build continuava `IN_PROGRESS`,
sem erro/artefato; quatro leituras de estado e log de `RUN_GRADLEW` com NDK/CMake e
compilação dos módulos nativos. Não foi tratado como falha nem disparado segundo build.
O árbitro registrou exceção de espera: até mais 20 minutos, no máximo quatro leituras
adicionais separadas por cinco minutos, sem espera bloqueante acima de 60 segundos.
Primeira leitura adicional, 03:17 UTC: permanece `IN_PROGRESS`; progresso real de
`RUN_GRADLEW` avançou para `writeReleaseLintModelMetadata`, `bundleReleaseLocalLintAar`
e `lintVitalAnalyzeRelease` às 03:17:28–03:17:57 UTC. Sem erro/artefato nessa leitura.
Segunda leitura adicional, 03:23 UTC: ainda `IN_PROGRESS`; `RUN_GRADLEW` compilou
C/C++ de `react-native-enriched-markdown` às 03:22:16 UTC, com três avisos `-Wswitch`
no scanner YAML. Aviso de compilação não foi rotulado como falha do build.
Terceira leitura adicional, 03:28 UTC: `IN_PROGRESS`, sem erro/artefato. Progresso:
scanner YAML recompilado às 03:25:15 UTC e `:app:buildCMakeRelWithDebInfo[x86]` às
03:27:35 UTC. São estágios diferentes do mesmo build, não novas tentativas.
Nenhum APK foi obtido dentro da janela consultada. O acompanhamento termina ao teto
operacional autorizado; o último estado confirmado é esse, sem presumir falha do EAS ou
consultar de novo para reiniciar a janela. Não houve segundo build nem cancelamento.

Servidor autorizado: backend existente, host `http://127.0.0.1:8765` retornou HTTP 200
com autenticação. Token lido da chave `CP_AUTH_TOKEN` da configuração autorizada, em
memória, enviado somente pelo stdin da sonda; valor nunca impresso/salvo no relatório.
Rota Android: `http://10.0.2.2:8765`. Duas sondas pelo AVD (`adb shell toybox nc`) não
retornaram HTTP, ambas exit 0. A segunda usou `-q 3` para manter leitura após EOF,
conforme ajuda da ferramenta. Causa indeterminada entre transporte da sonda e rede;
**alcance Android não confirmado**, sem terceira sonda e sem presumir servidor fora do ar.
Evidências redigidas: `tasks/t12-backend-reach.txt` e `tasks/t12-backend-reach-attempt2.txt`
no diretório durável. Nenhum fixture criado enquanto APK indisponível.

| Percurso amplo no APK integrado | Resultado do lote, sem APK disponível na janela |
|---|---|
| Instalar sobre referência e abrir sem Metro | pendente: nenhum APK integrado disponível; instalação não tentada |
| Login, reabertura e servidor salvo; token recusado visível | não conferido |
| Criar sessão pelo formulário atual | não conferido |
| Claude/Codex, com terminal e headless: enviar/receber/Parar | não conferido |
| Pergunta única/múltipla/texto livre/cancelamento, dois toques | não conferido |
| Aprovação permitir/negar e plano antes das ações | não conferido |
| Startup Codex sem transcript e transição para `tracked` | não conferido |
| Plano Codex real sem tags, links/chip no Android | não conferido |
| Interrupção de rede e retorno do fundo com resposta/pergunta | não conferido |
| Problema do provedor com causa visível/expansão permitida | não conferido |
| Pi/Kimi/omp e combinações ausentes | não conferido |
| Estados carregando/vazio/erro/sucesso, pt-BR/en, comparação visual | não conferido |
| iOS/Apple/iPhone | não conferido; nenhum recurso iOS disponibilizado para o lote |

### Pendências e calibração

Nenhuma correção produtiva fora dos Files da T12. Leitura estática apontou polling extra de
startup Codex no fundo e delimitador de cerca de Markdown permissivo no parser core;
nenhum cenário desses foi executado nem corrigido nesta rodada, portanto são hipóteses
para investigação autorizada, sem bateria adicional ou mudança de arquivo fora do escopo.

Faixa das próximas entregas continua não calibrada: o lote mediu suites (acima), instalação
de dependências (mobile 57 s/core 12 s reportados pelo npm) e espera EAS separadamente;
sem percurso nativo íntegro não há base para prometer prazo das entregas seguintes.
**Lote encerrado com pendências.** A cobertura automatizada foi ampla e limitada a duas
tentativas; o limite de espera do EAS é separado da contagem de testes. APK integrado não
instalado, percursos nativos não conferidos e comparação visual pendente. Nenhum fixture
`cx-mobile-t12-*` foi criado, portanto não há sessão descartável para remover. O emulador
iniciado pela T12 foi encerrado e as cinco reservas liberadas; o build remoto não foi cancelado.
A aceitação da entrega continua pendente, sem pedir ao revisor que repita suites/retome contador.


## Entrega 2 — T21: lote amplo Android, criação no primeiro envio

Execução: 30/09/2026, worktree `hangar-mobile-deliveries-cad3e6fe-t21`, branch
`mobile-deliveries-orq-cad3e6fe-t21`. Base integrada T1–T20:
`1201802ba271b2848320eb1fa9909aef5093a83a`, conferida antes da primeira edição; árvore limpa
na entrada. Nenhum teste de backend/PWA/Rust rodou. **O resultado automatizado não aprova
a entrega Android**; a situação do APK e dos percursos está separada abaixo.

### Regressões acrescentadas (Step 1)

A maior parte dos casos do Step 1 já existia nas Tasks 18–20 (`newConversation.test.ts`:
toque duplo, create OK/input recusado, timeout/rede/5xx/408 sem outro create, processo
reaberto sem novo POST, troca de máquina, cwd inválido editável, ACK tardio;
`firstConversation.test.ts`: tabela completa de transições, incluindo `send_rejected` que
conserva sessão e texto). Faltavam e foram escritos:

| Arquivo | Caso novo |
|---|---|
| `packages/core/src/api.test.ts` | `createSessionForServer` preserva `status` numérico (400/408/409/502) e faz um só POST; transporte incerto não inventa `status` nem repete |
| `mobile/src/features/create/CreateSessionSheet.test.tsx` | toque duplo em Enviar na tela faz um único create; cwd recusado (400) mantém o texto no campo, mostra o motivo, deixa Enviar habilitado e não navega |

Os dois casos de tela e os dois de API passaram na primeira execução: descrevem comportamento
já existente, nunca foram vistos vermelhos.

### Preparação

Dependências: `npm ci --prefix mobile --workspaces=false` e depois
`npm ci --workspace=@hangar/core --include-workspace-root`, ambos exit 0 — mas o segundo
esvaziou `mobile/node_modules` (a raiz lista `mobile` como workspace). O primeiro
`typecheck` falhou por isso também (`TS6053: File 'expo/tsconfig.base' not found`).
Reinstalado o mobile depois do core (690 pacotes, exit 0). Ordem correta para os próximos
lotes: core primeiro, mobile depois. Lockfiles inalterados; nenhum `audit fix`.

### Suites e typechecks

Evidências no diretório durável `/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/tasks`.

| Família/comando | Tentativa 1 | Correção e tentativa 2 | Resultado |
|---|---|---|---|
| `npm --prefix packages/core run check` | exit 0 (`t21-core-check-attempt1.txt`) | não repetido | conferido |
| `npm --prefix packages/core run test` | exit 0, 742/742 testes, 48/48 arquivos (`t21-core-test-attempt1.txt`) | não repetido | conferido |
| `npm --prefix mobile run typecheck` | exit 2: `CreateSessionSheet.tsx(540,7): error TS1005: ')' expected` + `TS6053` da instalação (`t21-mobile-typecheck-attempt1.txt`) | Fechamento `) : null}` do bloco de retomada Codex, perdido no commit `5a532f95` (Task 19), restaurado; mobile reinstalado; reteste exit 0 (`t21-mobile-typecheck-attempt2.txt`) | conferido. **Defeito produtivo real**: sem a correção a tela Nova conversa não compila e o bundle do APK quebraria |
| `npm --prefix mobile run test` | exit 1, 273/274 testes, 37/38 arquivos (`t21-mobile-test-attempt1.txt`) — `envia esforço Codex…`: mock de mensagens sem `criar_subagente` (a lista de modelos cheia faz o Claude inicial renderizar o seletor de subagente) | Três chaves `criar_subagente*` acrescentadas ao mock; reteste só de `CreateSessionSheet.test.tsx`, exit 0, 22/22 (`t21-mobile-retest-attempt2.txt`) | falha inicial de teste consertada e conferida; suite inteira não repetida; produto inalterado por esta correção |

Durações do Vitest: core 34,74 s; mobile 144,72 s; reteste 10,91 s.

### Entrega 1 no aparelho (APK do lote T12, conferido nesta janela)

O build T12 `2410f755-df87-4722-a946-8c7bd5557c65` terminou `FINISHED` depois da janela da T12
(`gitCommitHash` `8b157f05…`, versionCode 1). Baixado nesta Task: 204 MB, SHA-256
`11fd78e55d3a52cb7098929d0b03ca1704c12761423a1dedd9adb1c93aec597b`, contém
`assets/index.android.bundle`. Estes resultados são da **T21**, não reescrevem a janela da T12.

AVD `hangar` (Pixel 7, API 36, x86_64, 1080×2400, pt-BR). A instalação sobre o app de
05/09 falhou com `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (assinatura diferente); o app antigo
do emulador (cópia preservada em `visual/t12/reference.apk`) foi desinstalado e o APK T12
instalado limpo. Backend alcançado por `adb reverse tcp:8765 tcp:8765` e URL
`http://127.0.0.1:8765` (a rota `10.0.2.2` da T12 não foi retentada). Token digitado
direto do arquivo de configuração no campo, sem impressão nem registro.

| Percurso (APK entrega 1) | Observado | Resultado |
|---|---|---|
| Abrir sem Metro | tela "Conectar a um servidor" montou (`visual/t21/e1-open.png`) | conferido |
| Login por endereço/token | lista "Sessões" carregou do backend (`visual/t21/e1-after-login.png`) | conferido |
| Reabertura com servidor salvo | `force-stop` + abrir: lista direto, sem login | conferido |
| Filtro da lista | campo aceita texto e filtra | conferido; lista vazia filtrada mostrou só "Cancelar", sem texto de vazio (não investigado) |
| Botões do cabeçalho (Servidores, Configurações, "+") | "+" com três toques curtos e um de 120 ms, Servidores e Configurações com um toque cada, e deep link `hangar://create`: nada abre, nenhum erro no logcat (`visual/t21/e1-tap-new*.png`) | **falhou**; causa indeterminada; `mobile/app/index.tsx`, `Screen`, `Background` fora dos Files desta Task |

### APK da entrega 2 e percursos no aparelho

Build `664e770a-d7f2-452d-964e-a4be776725a3`, perfil `preview`, `--freeze-credentials
--non-interactive --no-wait`, criado 05:56 (UTC−3) a partir da árvore desta Task com a
correção do JSX (`gitCommitHash` informa a base `1201802b…`; o EAS empacota a árvore de
trabalho). Cinco leituras de estado espaçadas de 5 min (`tasks/t21-eas-reads.txt`);
`FINISHED` às 06:21. APK 204 MB, SHA-256
`0dd02e4bcba7344df67b56bc8e41c25a22ed32568fa24cf366a34d65c60a09e2`, com
`assets/index.android.bundle`, versionCode 1. **Instalado por cima da entrega 1** (`install -r`,
mesma assinatura, `Success`), dados e servidor salvos preservados.

Sessões descartáveis próprias, criadas pelo app numa pasta própria
(`~/Projetos/cx-mobile-t21-fixture` e `sub-b`), fechadas e pastas removidas ao fim. Codex na
conta Codex padrão da máquina, `gpt-6.1-sol`; Claude na conta autorizada pelo árbitro,
Opus 1M/medium. Nenhuma sessão de terceiros operada.

| Percurso (APK entrega 2) | Observado | Resultado |
|---|---|---|
| Atualizar sobre a entrega 1 e abrir sem Metro | lista com o servidor salvo, sem login | conferido |
| "+" do cabeçalho | mesmo resultado da entrega 1: toque não abre a Nova conversa | **falhou**, segunda observação da família; esgotada, sem correção (fora dos Files) |
| Chegar à Nova conversa | deep link `hangar:///create` com o app fechado abre a rota; aberto, o link não navega | conferido só por deep link |
| Campo imediato, linha de máquina/projeto, Enviar | campo, rótulo da máquina, projeto e Enviar desabilitado sem texto (`visual/t21/e2-deeplink-create.png`) | conferido; o rótulo da máquina ficou "127" (derivado do endereço) |
| Seletor de pasta: raízes, busca, subpasta, campo avançado | todos respondem; o seletor reabre na primeira raiz, não na última usada | conferido |
| cwd inexistente pelo campo avançado | `400: a pasta … não existe` na tela, texto no campo, Enviar reabilitado, sem navegar, sem sessão criada (`e2-cwd-invalido.png`) | conferido; a mensagem de erro continua visível depois de trocar a pasta |
| Toque duplo em Enviar | uma única sessão (`/api/sessions`) | conferido |
| cwd/provider/modelo do lado do servidor | Codex: cwd da pasta, `gpt-6.1-sol (high)`; Claude: `sub-b`, Opus 1M medium (statusline do pane) | conferido |
| Passagem Nova conversa → chat | 1ª criação: **crash nativo** do app ao abrir o chat, `SIGSEGV` no `RenderThread`, estouro de pilha em `RenderNode::prepareTreeImpl` (`tasks/t21-e2-crash-open-chat.txt`); 2ª e 3ª criações abriram o chat normalmente | **falhou 1 em 3**, intermitente; causa indeterminada (árvore de render recursiva) |
| Primeira mensagem chega ao provider | 1ª sessão Codex: backend gravou a mensagem com `queued_delivered: true`, mas o Codex nunca recebeu (TUI vazia, nenhum turno); 2ª Codex e a Claude receberam e responderam | **falhou 1 em 3**, intermitente; o app não reenviou por conta própria; causa no caminho fila→Codex na partida, backend fora do escopo |
| Tentativa fechada após o ACK | reaberta a Nova conversa: campo vazio, sem "mensagem guardada" | conferido |
| Rede cortada logo após Enviar (create) | "Não deu para confirmar se a conversa foi criada", "Conferir"/"Descartar", Enviar travado (`e2-create-cut.png`); servidor não criou nada | conferido |
| Reabrir o app com a tentativa incerta | mesma tentativa incerta, nenhum POST novo | conferido |
| "Conferir" sem a sessão no servidor | "A conversa ainda não aparece… Isso não prova que falhou"; nada criado | conferido |
| "Descartar" e enviar de novo | texto fica no campo; nova ação explícita cria uma sessão e abre o chat | conferido |
| Trocar de projeto e repetir | segunda sessão em `sub-b` com o cwd novo | conferido |
| Enviar/receber no chat (Codex) | "Diga apenas ok" → "ok" no app e no pane | conferido |
| Parar (Codex) | "Conversation interrupted" no pane; app volta a "pronto" | conferido |
| Retorno do fundo | resposta que chegou com o app em segundo plano aparece ao voltar | conferido |
| Pergunta (Claude `AskUserQuestion`) | banner "Precisa de você" abre a folha nativa; dois toques numa opção levam à revisão com uma resposta; dois toques em Enviar entregam uma resposta ("Verde") | conferido |
| create OK com input recusado no aparelho | não há como provocar recusa do input no backend real sem mexer nele | não conferido; coberto por teste automatizado |
| Rede cortada depois do input (incerto) | janela entre o create e o input curta demais para cortar pelo adb | não conferido; coberto por teste automatizado |
| Troca de máquina durante a resposta | um só servidor; o botão Servidores não abre | não conferido |
| Aprovação permitir/negar | sessões em modo sem aprovação | não conferido |
| Token recusado com causa visível | não repetido nesta janela | não conferido |
| Idioma en | aparelho em pt-BR | não conferido |
| iOS | nenhum recurso iOS | não conferido |

A comparação visual com a referência do `provar-tela` continua pendente: não há captura de
referência comparável (a do app antigo não carregava o bundle). As capturas desta janela ficam
em `/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/visual/t21/`; nenhuma contém token.
Um tutorial de caneta do teclado Gboard cobriu a tela na primeira abertura com foco no campo
e engoliu toques até ser fechado; é do emulador, não do app.

### Pendências do lote 2

1. Botões do cabeçalho da lista não respondem no APK (entregas 1 e 2). Sem eles não se
   chega à Nova conversa, às Configurações nem aos Servidores pelo toque. Família esgotada;
   causa indeterminada; arquivos fora dos Files da T21.
2. Crash nativo intermitente ao passar da Nova conversa para o chat (1 em 3).
3. Primeira mensagem marcada como entregue pela fila sem chegar ao Codex na partida (1 em 3).
4. Desvios observados em percursos marcados conferido (uma observação cada, não investigados,
   sem tentativa de correção):
   a. Linha "Filtro da lista" (entrega 1): lista vazia filtrada mostra só "Cancelar", sem texto
      de estado vazio.
   b. Linha "Chegar à Nova conversa": com o app aberto o deep link `hangar:///create` não
      navega; somado ao item 1, o app em execução não tem caminho para a Nova conversa.
   c. Linha "cwd inexistente pelo campo avançado": a mensagem de erro continua visível depois
      de trocar a pasta.
   d. Linha "Campo imediato, linha de máquina/projeto, Enviar": o rótulo da máquina ficou
      "127", derivado do endereço.
   e. Linha "Seletor de pasta": o seletor reabre na primeira raiz, não na última usada.
5. Cenários não conferidos da tabela acima.

**Lote encerrado com pendências.** A entrega 2 não está aceita: os percursos centrais do
primeiro envio funcionaram no APK, mas a entrada normal pela lista falha e há dois defeitos
intermitentes. Emulador encerrado, `adb reverse` removido e as cinco reservas liberadas.


## Entrega 3 — T32: lote amplo do cotidiano Android

Execução: 30/09/2026, worktree `hangar-mobile-deliveries-cad3e6fe-t32`, branch
`mobile-deliveries-orq-cad3e6fe-t32`. Base integrada T1–T31:
`7595169f192bccaebb2f4bedd49913d1b9d70b84`, conferida antes da primeira edição;
árvore limpa na entrada. Este lote **não aprova a entrega Android**. Não rodaram
backend/PWA/Rust, lint ou suite adicional fora dos quatro comandos autorizados.

### Preparação, identidade e evidências

Dependências instaladas nesta worktree, core primeiro e mobile depois:
`npm ci --workspace=@hangar/core --include-workspace-root` (89 pacotes, exit 0) e
`npm ci --prefix mobile --workspaces=false` (exit 0). Lockfiles preservados.
O segundo comando informou vulnerabilidades e postinstall de
`react-native-enriched-markdown@1.0.2` sem aprovação; não houve atualização de
pacotes, `audit fix` ou aprovação de scripts. Scripts existentes geraram Paraglide.

Executada a skill Superpowers de execução de planos pelo executor, com o recorte
T32 e registro de Steps em `tasks/t32-execution.md` no diretório durável. Política
posterior dos cinco lotes substitui testes por Step, repetição de suite, planos
históricos editados e revisão adicional. A revisão independente da Task recebe
os resultados; não repete a bateria nem reinicia contadores.

Evidências abaixo estão em `/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/tasks/`.
`t32-runs.jsonl` registra comandos, exit, tentativa e duração medida por relógio
monotônico: inclui subprocesso completo/pre-script e fila do flock. As durações
internas do Vitest são separadas. Nenhum token foi incluído nesta seção.

### Suites e typechecks — duas tentativas, sem terceira execução

| Família | Tentativa 1 | Correção e tentativa 2 | Resultado real |
|---|---|---|---|
| Core check | exit 0, `t32-core-check-attempt1.txt` | não repetido | conferido |
| Core test | exit 0, 758/758 testes, 48/48 arquivos, `t32-core-test-attempt1.txt` | não repetido | conferido automaticamente |
| Mobile typecheck | exit 2: `newConversation.test.ts:333`, TS1005; erros seguintes na linha 492, `t32-mobile-typecheck-attempt1.txt` | `expect` fechava antes de `.submission`; parêntese reposicionado sem remover asserção. Único reteste, exit 2, `t32-mobile-typecheck-attempt2.txt`: `useDitado.ts:75,160`, TS2339 em `AudioRecorder.release/addListener`, TS7006 no callback | **falhou**; sintaxe corrigida, declaração Expo pendente, nenhum terceiro check |
| Mobile test | exit 1, 318/320 testes executados, 35/40 arquivos; três arquivos não coletados, `t32-mobile-test-attempt1.txt` | Reteste somente os cinco arquivos que falharam, exit 1, 104/129 testes, 3/5 arquivos, `t32-mobile-retest-attempt2.txt` | **falhou**; sem terceira suite/reteste |
| `newConversation.test.ts` | não coletado, sintaxe acima | coletado e passou, asserção do snapshot `sending` preservada | consertado e conferido |
| `chat.test.ts` | cauda sem costura/reentrada esperava apagar cursor ao remontar | T24 conserva store e cursor da conversa; só expectativa de reentrada alinhada, mantendo proibição de cursor após cauda sem costura e acrescentando conversa preservada; passou | expectativa antiga consertada e conferida, sem mudança produtiva |
| `AskSheet.test.tsx` | não coletado, `Unexpected token typeof`; store passou a importar persistência nativa | `prefs` substituído por mock para os casos de resposta desta suite; passou | consertado e conferido; não prova MMKV nativo |
| `semTerminal.test.tsx` | não coletado: `expo-file-system` importava `expo-modules-core` inacessível | cópia nativa isolada, catálogo/revisão/marca de envio atualizados; reteste coletou mas 24 mounts falharam por `AppState.currentState` ausente no mock | **falhou**; segunda correção: mock de AppState, **aplicada, não revalidada** |
| `FileViewer.test.tsx`, PDF | faltava tradução `arq_pdf_sem_leitor` no mock | tradução acrescentada; reteste falha porque Android exibe aviso e não monta leitor PDF; asserção do leitor autenticado mantida | **falhou**, leitor PDF Android continua pendente |

A contagem 318/320 exclui três arquivos sem coleta; não equivale a 318 testes de
uma suite de 320 completa. A contagem 104/129 é apenas dos cinco arquivos do reteste,
não da suite inteira. Vitest: core 65,71 s; mobile inicial 132,22 s; reteste 66,38 s.
Comandos completos: core check 14,77 s/core test 73,59 s/mobile typecheck1 9,78 s/
mobile test1 140,20 s/mobile typecheck2 21,58 s/reteste 70,59 s.

Hipótese fundamentada do typecheck: `expo-audio` declara `AudioRecorder extends
SharedObject` importado de `expo-modules-core`, mas esse pacote só existe aninhado
em `mobile/node_modules/expo/node_modules/` (57.0.16); não é resolvido pelo import da
biblioteca irmã. Não foram inseridos casts, assinaturas inventadas ou mudanças
no áudio para esconder a falha. Sem terceiro check/instalação para testar a hipótese;
ela não comprova falha nativa de gravação. Os testes do hook de ditado passaram
na primeira suite, com mocks; áudio Android real continua exigindo o binário do lote.

### Cobertura automática e lacunas de anexo

A primeira suite cobriu rascunhos, revisão/ACK, upload reutilizável, cópia de anexo
em mock, isolamento de destino, arquivos/plano/par e interrupções do ditado.
Os arquivos que passaram não foram repetidos depois. Nenhuma alteração produtiva
foi feita neste lote.

Acrescentados em `semTerminal.test.tsx`: reabrir upload confirmado com input
`sending`/`unknown`/`rejected`, sem POST automático, e recuperação com anexo atual
recusada até removê-lo, adotando o anterior sem upload da sessão morta. São quatro
casos sobre estado persistido previamente, **não conferidos**: todos falharam no
mount por AppState antes das asserções. O mock final ainda não simula envio em voo,
MMKV/cópia física nem transcrição/upload real.

Continuam ausentes testes integrados de sucesso/recusa/incerto com envio de anexo
e sair/remontar, ACK com troca/remoção de anexo/recriação, upload com blob `file://`
no Android, troca de idioma antes de Recuperar, cópias órfãs após duas recriações,
anexo anterior no banner e recuperação do primeiro input incerto. A aprovação
estática da T29 não preenche essas lacunas. Não chamar os quatro casos novos de
regressões aprovadas nem reiniciar contador para executá-los novamente.

### APK e percursos nativos

Build da T32: `ccb85697-3253-48e3-adf8-1f5d209b46b5`, perfil `preview`,
`appVersion 0.1.0`, versionCode 1, `gitCommitHash` igual à base acima. CLI existente
EAS 23.2.0; comando na pasta mobile: `eas build --platform android --profile preview
--freeze-credentials --non-interactive --no-wait --json`. Keystore remoto existente,
credenciais congeladas, sem assinatura nova, loja ou OTA. A árvore enviada antecede
as correções de testes/registro; não há mudança produtiva posterior ao envio.

Primeiro `build:view` foi chamado por engano na raiz e recusou contexto de projeto;
segundo comando na pasta mobile informou `IN_QUEUE`. O primeiro comando gerou
`app.json` vazio na raiz às 13:33:49 UTC, fora dos Files; o arquivo criado por essa
chamada foi identificado por horário/conteúdo e removido, sem staging. Não houve
segundo build.
Às 13:38 UTC, ainda sem APK, o árbitro autorizou só acompanhamento desse mesmo
build até 13:55 UTC, no máximo quatro leituras adicionais a cinco minutos, sem
cancelamento/build novo/renovação. Estado final e instalação são registrados abaixo
após essa janela; estar na fila não é aprovação nem falha de compilação.

AVD próprio `hangar`, Pixel 7/API 36/x86_64, 1080×2400/densidade 420/portrait,
pt-BR. Recursos `screen`, `android-emulator`, `mobile-build`, `mobile-signing` e
`mobile-version` reservados antes de operar. Nenhum serviço paralelo/Metro,
instalador ou reinício de backend. `adb reverse tcp:8765 tcp:8765` conecta ao
backend existente e servidor salvo do APK 2; token não foi redigitado nem capturado.
APK instalado inicialmente: versão 0.1.0/versionCode 1, atualizado em 30/09 às
06:22:12, correspondente à entrega 2. Ele **não comprova T22–T31**.

Referência capturada antes das edições:
`/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/visual/t32/reference-list.png`:
lista com servidor salvo e sessões, inspecionada pelo executor. Abertura restaurou
posteriormente a conversa anteriormente ativa do app; nenhum envio/alteração
foi feito nela, e o botão Voltar não mudou a rota. Volta pela tecla do Android
retornou à lista. Tentativa de filtro sem conferir foco foi inválida; a tecla Voltar
acabou saindo do app. `reference-navigation.png` contém o launcher Android e é
**inválida como referência de conversa**, não será usada para comparar tela.
Nada disso comprova funcionamento atual dos botões, cuja família já está esgotada
em T21. Não houve nova investigação/correção dessa família.

Criada somente a sessão descartável própria `fixture-t32`, Codex headless, conta
padrão autorizada, pasta no diretório durável `tasks/t32-fixture`. Sem tocar sessões
de terceiros. A referência do APK anterior não conta como execução da entrega 3;
enhuma comparação cega se realiza sem artefato correspondente e estado equivalente.


Observações posteriores T30/T31, recebidas do árbitro e lidas pelo comando de
contrato da T32, entram neste mesmo lote sem terceira execução. Sem APK da base,
continuam **não conferidas**: limpar ditado após inserção pode reoferecer/duplicar
texto; transcrição vazia conserva áudio/retranscrição; mensagem de falha pode
aparecer duas vezes; reabrir ditado pending pode oferecer retry enquanto callback
anterior é descartado por id; opções aninhadas do gravador precisam de prova nativa.
Histórico antigo com rede interrompida precisa mostrar erro/repetição acessíveis no
topo; largura 320 dp trabalhando pode deixar pill ultrapassar slot; teclado/controles
exigem aparelho. Mocks não comprovam essas observações. Ajuste suplementar da
Nova conversa autorizado pelo usuário fica após T32; não altera este lote/build.


### Estado final do build, cobertura nativa e encerramento

Quatro leituras adicionais em 13:40:02, 13:45:02, 13:50:02 e 13:55:02 UTC,
todas `IN_QUEUE`, exit 0. Evidência: `tasks/t32-eas-additional-reads.jsonl` no
diretório durável. A última consulta começou no prazo fixo 13:55 e retornou em
2 s. A espera terminou nessa consulta; **não há APK integrado, download,
instalação ou execução T22–T31**. Sem segundo build, cancelamento ou consulta
posterior para reabrir a janela. Sem SHA-256 do APK 3, pois arquivo inexistente;
o build da fila não é tratado como compilação aprovada ou defeito do código.

| Percurso requerido no APK da entrega 3 | Esperado | Observado / resultado |
|---|---|---|
| Atualizar sobre APK 2, sem desinstalar/reset | mesma assinatura/pacote; servidor/projeto preservados | não conferido: nenhum APK 3 disponível; APK 2/dados preservados |
| Nova conversa → primeiro envio → resposta → Parar | uma criação e destino corretos | não conferido no APK 3; criação/ACK em mocks na suite do lote |
| Pergunta/aprovação, erro e retorno | decisão nativa no destino capturado | não conferido no APK 3; AskSheet passou no reteste, sem prova Android |
| Rascunho, troca de sessão/servidor e ACK tardio | edição nova e origem preservadas | não conferido no APK 3; stores passaram na primeira suite; Composer com falha de mock |
| Anexo, sair/reabrir durante envio e upload confirmado/input pendente | sucesso limpa, recusa/incerto reutilizam upload | não conferido; quatro casos novos não chegaram às asserções |
| Recuperar com anexo atual e após remoção | recusa sem perda; adoção posterior sem caminho da sessão morta | não conferido; caso novo falhou antes das asserções |
| Ditado, silêncio/interrupção/resposta tardia e transcrição vazia | áudio recuperável e texto isolado na origem | não conferido no APK 3; useDitado passou com mocks, declaração TS pendente |
| Arquivo citado fora da raiz, edição/digest/conflito e PDF | leitura/erro visíveis no destino; leitor disponível quando oferecido | não conferido no APK 3; FileViewer PDF continua falhando; APIs/stores em mocks |
| Plano, par, servidor lembrado e pin em voo | resposta antiga não muda estado novo | não conferido no APK 3; testes existentes em mocks não provam reinicialização de folhas |
| Teclado, histórico longo, erro ao pedir mensagens antigas, 320 dp | Enviar/Parar/erro/repetição alcançáveis | não conferido: artefato ausente; não repetir família do cabeçalho esgotada em T21 |
| Bloquear/retornar, rede interrompida, pt-BR/en | estado correto e dados preservados | não conferido no APK 3; referência somente pt-BR do APK 2 |
| Carregando/vazio/erro/sucesso e comparação visual | estados equivalentes e referência comparável | não conferido no APK 3; sem comparação cega |
| iOS | mesmos fluxos no recurso iOS disponível | não conferido; nenhum iPhone/Apple disponibilizado neste lote |

A falha de envio inicial fila→Codex, crash nativo e botões do cabeçalho registrados
em T21 continuam pendentes; esta janela não reabre seus contadores nem altera os
registros anteriores. Nenhuma sessão alheia recebeu input, pareamento ou fechamento.
A sessão própria `fixture-t32` foi encerrada; o AVD iniciado pela Task foi fechado,
`adb reverse` removido e os cinco recursos liberados. O build remoto segue em fila,
sem cancelamento. Não há serviço local extra para remover.

**Lote encerrado com pendências**, conforme a política aprovada: tentativas limitadas
e resultados registrados. A entrega 3 **não está aceita**, mobile typecheck/test
continuam falhando, AppState recebeu segunda correção aplicada/não revalidada,
PDF Android e percursos do APK 3 permanecem pendentes. Revisão estática da rodada
não pode ser descrita como aprovação funcional ou repetir a bateria.

## Entrega 4 — T33: preparação de assinatura e instalação iOS

HEAD: `820dc6b7b67b1a355bde9cd76562c95ad0dbcf38` (branch `mobile-deliveries-orq-cad3e6fe-t33`).
Data: 30/09/2026, 14:40–14:45 UTC. Natureza: leituras do EAS e uma tentativa de build iOS
não interativa. Nenhum binário gerado, instalado ou aberto; os percursos são do lote T37.
Recursos `mobile-signing`, `mobile-build` e `mobile-version` reservados durante as operações
e liberados ao sair. Evidências (sem UDID completo nem credencial) em `tasks/t33-*.log` do
diretório durável.

Preparação: `npm ci --prefix mobile --workspaces=false` na worktree (exit 0, lockfiles
inalterados; mesmo aviso de script do `react-native-enriched-markdown` dos lotes anteriores).
Todo `eas` rodou em subshell dentro de `mobile/` com `eas-cli/23.2.0` do cache do `npx`
(24.8.0 disponível; não atualizado).

### Assinatura, dispositivo e canal (Step 1)

| Item | Esperado | Observado / resultado |
|---|---|---|
| Conta Expo e projeto | owner `jeffer1312`, projeto do `app.json` | conferido: `whoami` = `jeffer1312 (Owner)`; `project:info` = `@jeffer1312/hangar`, ID `9fd06001-…` igual ao `app.json` |
| Equipe Apple ligada à conta | equipe com capacidade de assinar | conferido parcialmente: EAS lista uma equipe do tipo organização; capacidade de assinar ad hoc não comprovada (ver credenciais) |
| iPhone registrado | aparelho do dono registrado na equipe | conferido no EAS: um `iPhone` registrado, nome `Unknown`. Não confirmado que é o aparelho atual dele nem que está no perfil |
| Credenciais de distribuição interna (certificado + perfil ad hoc) | existentes no servidor Expo | **falhou**: `eas build --platform ios --profile preview --non-interactive --freeze-credentials` → "EAS CLI couldn't find any credentials suitable for internal distribution. Run this command again in interactive mode." |
| Canal | preview ad hoc interno; sem TestFlight/submit | escolhido o `preview` existente (`distribution: internal`); TestFlight, submit, loja e OTA não usados |
| iOS suportado pelo binário | versão mínima do SDK 57 compatível com o aparelho | não conferido: sem binário e sem acesso ao aparelho |
| Aparelho na máquina | iPhone por USB para diagnóstico | ausente: `idevice_id -l` sem aparelho, `usbmuxd` inativo |

Bundle, owner, projeto e equipe não foram trocados. `app.json`/`eas.json` ficaram
inalterados: nenhuma falha atribuível à configuração foi demonstrada. O aviso
`ITSAppUsesNonExemptEncryption` ausente só afeta App Store Connect/TestFlight, fora do canal.

### Build e instalação (Step 2)

Uma tentativa, exit 1, antes do upload do projeto: o build não entrou na fila e nada foi
enviado. Sem segunda tentativa, porque o impedimento é credencial, não código.
**Impedimento:** criar certificado de distribuição e perfil ad hoc com o UDID exige login
Apple interativo (Apple ID + 2FA) do Jefferson: `(cd <worktree>/mobile && eas credentials
--platform ios)` ou o mesmo `eas build` sem `--non-interactive`. Depois disso, o build
`preview` do código atual e a instalação pelo link interno no iPhone real ficam para o lote T37.

### Rede local, QR/token e reinício (Step 3)

| Percurso | Resultado |
|---|---|
| Permitir/recusar rede local e câmera | não conferido: sem binário iOS |
| Conectar por LAN e pela VPN | não conferido |
| Token recusado explica a causa | não conferido |
| Reiniciar conserva servidor no SecureStore | não conferido |
| Rede local negada oferece caminho para os Ajustes | não conferido |

**T33 com impedimento registrado; aceite iOS pendente.** Assinatura e instalação dependem
da ação interativa do Jefferson descrita no Step 2. Android não é afetado.

## Entrega 4 — T37: lote amplo iOS e Android afetado

Execução: 30/09/2026, worktree `hangar-mobile-deliveries-cad3e6fe-t37`, branch
`mobile-deliveries-orq-cad3e6fe-t37`. Base integrada T1–T36:
`34d7de6d27b8427cc24c5057214ac7061a36b02a`, conferida antes da primeira edição; árvore
limpa na entrada. Este lote **não aprova a entrega 4**. Evidências em `tasks/t37-*` do
diretório durável; `t37-runs.jsonl` registra comando, exit, tentativa e duração por relógio
monotônico. Nenhum token ou UDID nesta seção.

### Preparação

`npm ci --workspace=@hangar/core --include-workspace-root` e
`npm ci --prefix mobile --workspaces=false`, ambos exit 0, lockfiles inalterados, sem
`audit fix` nem atualização de pacote. `eas-cli` 23.2.0 pelo cache do `npx`, sempre em
subshell dentro de `mobile/`. Recursos `mobile-build`, `mobile-signing` e `mobile-version`
reservados a cada operação EAS e liberados em seguida; `screen` e `android-emulator` durante
o uso do AVD.

### Suites e typechecks — cada comando uma vez, reteste só do que falhou

| Família | Tentativa 1 | Correção e tentativa 2 | Resultado real |
|---|---|---|---|
| Core check | exit 0, 9,16 s | não repetido | conferido |
| Core test | exit 0, 758/758 testes, 47,34 s | não repetido | conferido automaticamente |
| Mobile typecheck | exit 2: `useDitado.ts:75,160`, TS2339 `AudioRecorder.release/addListener`, TS7006 | família esgotada em T32 (duas tentativas); sem correção nem reteste | **falhou**, pendência T32 inalterada |
| Mobile test | exit 1: 39 falhas/416 testes, 3/40 arquivos (`CreateSessionSheet` 33, `semTerminal` 5, `FileViewer` 1) | reteste único dos dois arquivos corrigidos: 38/38 `semTerminal`, `CreateSessionSheet` 33 falhas | **falhou**; ver linhas abaixo |
| `semTerminal.test.tsx` | cinco falhas de asserção, agora que a correção de AppState da T32 deixou o arquivo montar (a correção da T32 continua sem contagem de revalidação própria) | quatro causas corrigidas, reteste 38/38 | consertado e conferido na tentativa 2 |
| ↳ ACK confirmado antes do botão atualizar | `Composer` reenviava o texto do handoff como mensagem nova quando a tentativa já tinha sido confirmada e apagada | `sendText` não envia de novo o texto adotado do handoff sem tentativa e limpa o campo | produto corrigido; conferido no reteste |
| ↳ rascunho em formato inválido | edição seguinte não gravava: `persistDraft` recusava ao reler o JSON inválido | formato inválido é sobrescrito, como no boot; falha de leitura real continua bloqueando | produto corrigido; conferido no reteste |
| ↳ ACK que chega após o handoff | campo mantinha o texto entregue quando `firstInputSent` virava verdadeiro | efeito limpa o campo só se ainda igual ao texto do handoff; edição nova fica | produto corrigido; conferido no reteste |
| ↳ Cancelar da Nova conversa 44×44 | mock do `Pressable` no teste descartava `style` | mock repassa estilo (função resolvida com `pressed:false`) | teste corrigido; conferido no reteste |
| `CreateSessionSheet.test.tsx` | 33/33 falharam: mock de Paraglide sem `nova_conversa_destino_hint`/`nova_conversa_config_hint` (chaves presentes em `pt.json`/`en.json`) | chaves no mock; reteste falhou 33/33: o mock global do `Pressable` entrega estilo por função ao DOM (`The style prop expects a mapping`) | **falhou**; segunda correção (mock local resolve estilo por função) **aplicada, não revalidada** |
| `FileViewer.test.tsx`, PDF Android | mesma falha da T32 | família esgotada; sem correção nem reteste | **falhou**, pendência T32 inalterada |

Depois do reteste, a revisão estática por subagente apontou que o texto igual ao primeiro,
digitado de novo depois, seria engolido. O critério passou a usar o texto adotado do handoff
uma única vez (`adoptedDraftRef`, zerado ao limpar). Esse refinamento **não foi revalidado**
por teste (seria terceira execução da família) e entrou no pacote do build 3 abaixo.

### Builds Android e iOS

| Build | Criado (UTC) | Pacote enviado | Destino |
|---|---|---|---|
| Android `45f48aa6` | 15:55 | árvore da base, antes das correções | cancelado na fila entre 16:02 e 16:06 (o log do cancelamento não registra horário): o artefato não seria o código corrigido |
| Android `53d87a12` | 16:03 | base + correções do Composer e testes da tentativa 2 | cancelado na fila às 16:07: o refinamento pós-revisão mudou o Composer |
| Android `a9ed153a` | 16:07 | base + código final desta rodada | acompanhado conforme decisão `t37-eas-window` do árbitro |
| iOS `preview` | 16:03 | nenhum | exit 1 antes do upload: "couldn't find any credentials suitable for internal distribution"; segunda falha de credencial, sem terceira tentativa nem login |

O `gitCommitHash` que o EAS mostra é a base `34d7de6d`, não o conteúdo do pacote: as três
submissões enviaram a árvore de trabalho com as alterações não commitadas da rodada.
Nenhum aparelho iOS ligado à máquina (`idevice_id -l` sem lista).

Janela do árbitro para `a9ed153a`: quatro leituras em 16:22:03, 16:27:05, 16:32:04 e
16:37:04 UTC, todas `IN_QUEUE` (`tasks/t37-eas-reads.log`). A espera terminou no prazo;
**não há APK da entrega 4**, download, SHA-256 ou instalação. Sem build novo, cancelamento
ou leitura depois da janela. Estar na fila não é defeito de compilação nem aprovação.

### Aparelho e percursos

AVD próprio `hangar`, Pixel 7/API 36/x86_64, 1080×2400, pt-BR, sem janela. App instalado:
0.1.0/versionCode 1 de 30/09 às 06:22:12, o APK da entrega 2; ele **não comprova T22–T36**
e não foi usado como prova. `adb reverse tcp:8765` para o backend existente, sem serviço
paralelo, Metro, instalador ou reinício. Referência de lista capturada antes dos percursos:
`/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/visual/t37/reference-apk2-list.png`
(lista em pt-BR, estado de sucesso após “Carregando sessões…”). Sessão descartável própria
`fixture-t37` (Codex sem terminal, gpt-5.6-luna/low) criada e fechada sem receber input; nenhuma
sessão alheia recebeu input, pareamento ou fechamento.

| Percurso (fonte `mobile-04-iphone.md` Task 3) | Esperado | Resultado |
|---|---|---|
| Step 1, matriz essencial iPhone: criar no primeiro envio, enviar/receber/Parar, aprovar/negar, pergunta, headless, bloquear/rede, rascunho, incerto, mesmo nome em dois servidores | fluxos corretos no destino capturado | não conferido: sem binário iOS (credencial ad hoc ausente, duas falhas) |
| Step 2, diário iOS: anexos, permissões, ditado e interrupção, teclado multiline, histórico longo, arquivo citado, plano, `inactive` sem autoenvio | texto preservado, recurso indisponível registrado | não conferido: sem binário iOS; Android não substitui |
| Step 3, iOS final instalado mantendo dados | build pós-correção instalado | não conferido: build iOS não entrou na fila |
| Step 3, APK com o mesmo código e percursos afetados no Android | atualização sobre o APK 2 e caminhos de T33–T36 e desta rodada | não conferido: `a9ed153a` em fila no fim da janela |
| Observações T34/T35: alças 44 pt no Composer, Glass ao trocar material/tema com rascunho e foco | densidade e filhos preservados no aparelho | não conferido no aparelho; nenhuma afirmação visual por leitura |
| Observação T9: lançamento frio iOS `inactive` | uma ressincronização ao ficar ativo | não conferido |
| Nova conversa `/create` da T42: aviso duplicado, espaço de avisos vazio, Enviar com teclado, pt/en, claro/escuro, tentativas e resposta tardia | sem duplicação, Enviar alcançável | não conferido no aparelho; `CreateSessionSheet.test.tsx` com segunda correção não revalidada |
| Handoff do primeiro input no Composer (correções desta rodada) | sem reenvio, edição nova preservada | conferido só em teste com mocks (`semTerminal` 38/38); aparelho não conferido |

### Pendências do lote 4

- Aceite iOS: exige a ação interativa de credencial registrada na T33
  (`(cd <worktree>/mobile && eas credentials --platform ios)` pelo Jefferson); duas falhas não
  interativas, sem terceira tentativa.
- APK da entrega 4 (`a9ed153a`) sem artefato no prazo; percursos Android de T33–T36 e desta
  rodada não conferidos.
- Mobile typecheck (`expo-audio`/`expo-modules-core`) e PDF Android: famílias esgotadas na T32.
- `CreateSessionSheet.test.tsx`: segunda correção aplicada, não revalidada.
- Refinamento pós-revisão do `Composer` (texto do handoff consumido uma vez): não revalidado.

AVD encerrado, `adb reverse` removido, fixture fechada e os cinco recursos liberados.
**Lote encerrado com pendências.** A entrega 4 **não está aceita**.

## Entrega 5 — T43: receita de geração e versões atualizáveis

Task de implementação: nenhum teste, typecheck, build nem instalação. Base `80413b21`.
Consultas EAS só de leitura, em subshell dentro de `mobile/`, com `eas-cli/23.2.0` do cache do
`npx` e o recurso `mobile-version` reservado e liberado. `build:list` falhou sem
`node_modules` no app; depois de `npm ci --prefix mobile --workspaces=false` (exit 0, lockfiles
inalterados) as três consultas saíram 0. Saídas em `tasks/t43-*` do diretório durável.

### Fonte da versão e assinatura (Step 1)

| Item | Observado | Resultado |
|---|---|---|
| Versão visível | `app.json` `version 0.1.0` = `VERSION` 0.1.0; a tela Sobre mostra só `expoConfig.version` | conferido; `app.json` inalterado |
| Número do build no EAS | `build:version:get --profile preview`: Android `versionCode 1`, iOS `buildNumber 1` | conferido |
| Builds `preview` recentes | `ccb85697` (`7595169f`), `664e770a` (`1201802b`), `2410f755` (`8b157f05`) FINISHED; `a9ed153a` (`34d7de6d`) IN_QUEUE; todos `0.1.0`/`appBuildVersion 1` | conferido: o número não subia entre entregas |
| Causa | `appVersionSource: remote` com `autoIncrement` só em `production` | corrigido: `autoIncrement: true` no `preview`, mantendo `internal`/APK |
| Pacote/assinatura | `com.hangar.mobile` nos dois; keystore Android remoto reutilizado pelos builds registrados em T12/T32 | inalterados |

Efeito esperado: o próximo build `preview` de cada plataforma sai com número 2, e assim por
diante. `a9ed153a`, enfileirado antes da mudança, continua com 1. Nenhum binário foi gerado nesta
Task.

### Receita (Step 2)

`mobile/README.md` criado: conexão ao servidor existente, dependências no monorepo, hook de
traduções app/core, perfis (`development` não comprovado), versão e número do build, Android e
iOS interno com credenciais, atualização por cima, trava de verificação e limitações. Sem token,
arquivo de credencial, restart de backend, `eas submit`, loja ou OTA.

### Preferências na atualização (leitura estática para o Step 3)

Servidores ficam no SecureStore (`cp_servers_v1`); aparência em chaves MMKV avulsas
(`aparencia.*`, `lista.agrupar`) lidas com valor padrão quando ausentes ou inválidas; rascunhos e
primeira conversa com `version: 1`. T43 não muda formato nenhum, então não há migração nem teste
de migração a escrever.

### Cenários para o lote T44

| Cenário | Esperado | Resultado |
|---|---|---|
| Build `preview` Android e iOS com o código final | `appBuildVersion` maior que o instalado, mesmo pacote e assinatura | pendente |
| Instalar por cima do binário anterior, sem desinstalar/limpar, abrir sem Metro | servidores/token, projeto por máquina, rascunho, tema, acento e papel de parede preservados | pendente |
| Receita do README repetida como escrita | comandos correspondem à geração real | pendente |
| iOS | credencial ad hoc da T33 ainda exige ação interativa do Jefferson | pendente |


## Entrega 5 — T44: distribuição, manutenção e conjunto final

Execução: 30/09/2026, worktree `hangar-mobile-deliveries-cad3e6fe-t44`, branch
`mobile-deliveries-orq-cad3e6fe-t44`. Base integrada T1–T43:
`f153efce72ee5df7d161089b269ec4edc8088bc4`, conferida antes da primeira edição;
árvore limpa na entrada. **A entrega final não está aceita.** A política dos cinco lotes
permite encerrar com pendências; revisão estática não aprova o produto no aparelho.

### Fronteira e preparação (Step 1)

`mobile/README.md` registra o que pertence a core, mobile, backend e Rust, além de três
duplicações concretas no mobile: classificação de recusa SSE, classificação de input recusado
e validação de opacidade. Nenhum store foi movido, nenhuma interface foi retirada e nenhuma
linha produtiva mudou. Backend/Rust são a fronteira arquitetural documentada, sem auditoria
ou teste desses arquivos neste lote. Corrigida a receita do EAS: mudanças locais rastreadas
podem entrar no pacote; `gitCommitHash` identifica HEAD, não o diff enviado (evidência das
árvores enviadas nas T21/T37 acima).

Dependências instaladas core primeiro e mobile depois, ambos exit 0, pelos mesmos comandos
de T32/T37. Lockfiles inalterados; nenhuma atualização, `audit fix` ou aprovação de script.
O npm informou 14 vulnerabilidades (13 moderadas/1 alta) e postinstall pendente de
`react-native-enriched-markdown`; esses avisos não foram suprimidos nem investigados no lote.
Superpowers executing-plans e provar-tela carregadas. O plano recortado/progresso está em
`tasks/t44-execution.md` no diretório durável; planos históricos preservados.

### Suites e typechecks — sem reiniciar famílias esgotadas

Evidências em `/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/tasks/`.
`t44-runs.jsonl` registra comando, saída e duração por relógio monotônico do subprocesso
completo, incluindo pre-script e espera de flock. Os números de testes vêm do resumo Vitest.
Não rodaram backend/PWA/Rust, lint ou uma sexta rodada de validação.

| Comando/família | Esperado | Primeira execução T44 | Correção/reteste e limite | Resultado |
|---|---|---|---|---|
| `npm --prefix packages/core run check` | nenhum erro TS | exit 0, 29,18 s (`t44-core-check-attempt1.txt`) | não repetido | conferido |
| `npm --prefix packages/core run test` | todos os casos passam | exit 0, 758/758 testes, 48/48 arquivos, 74,57 s (`t44-core-test-attempt1.txt`) | não repetido | conferido automaticamente |
| `npm --prefix mobile run typecheck` | nenhum erro TS | exit 2, 43,14 s (`t44-mobile-typecheck-attempt1.txt`): `useDitado.ts:75,160`, TS2339 `release/addListener`, TS7006 `status` | família expo-audio esgotada T32, observada também T37; nenhuma correção/reteste novo | **falhou**, pendência preservada |
| `npm --prefix mobile run test` | todos os casos passam | exit 1, 404/416 testes, 38/40 arquivos, 187,28 s (`t44-mobile-test-attempt1.txt`) | suite inteira não repetida | **falhou**; duas famílias abaixo |
| Nova conversa: fechamento de opções/acessibilidade | fechar conserva destino/texto e não duplica picker/POST | 11 falhas em `CreateSessionSheet.test.tsx`; dez TypeError no método de foco e uma asserção de cancelamento após montagens interrompidas | método `AccessibilityInfo.sendAccessibilityEvent` do RN 0.86.2 acrescentado ao mock local; asserções preservadas. Único reteste do arquivo: exit 0, 33/33, 67,71 s (`t44-mobile-create-retest-attempt2.txt`) | reteste 33/33 observado em terceiro ciclo, fora do limite da política; não ratificado e excluído do aceite autorizado do lote; não prova foco nativo |
| PDF Android (`FileViewer.test.tsx`) | leitor autenticado disponível quando oferecido | mesma asserção do leitor falha, como T32/T37 | família esgotada T32; nenhuma correção/reteste | **falhou**, pendência preservada |

A chamada `AccessibilityInfo.sendAccessibilityEvent` veio da T36 (`34b08bbf`) e já estava
na base do lote T37 (`34d7de6d`); ficou escondida pelas falhas anteriores do mesmo arquivo.
A correção de mock e o reteste T44 foram o terceiro ciclo de correção/reteste da família
`CreateSessionSheet.test.tsx`, esgotada na T37. O executor reclassificou indevidamente a
família; essa execução ficou fora do limite da política. A decisão `t44-family-limit`,
comunicada pelo árbitro, não ratifica o terceiro ciclo nem uma nova família: os 33/33
observados ficam registrados como fato e excluídos do aceite autorizado do lote, sem zerar
contador ou pedir exceção. A linha de mock permanece sujeita ao julgamento estático do
revisor. A correção é só de teste: o método existe na fonte RN instalada
e usa o renderer nativo, indisponível no mock DOM. A asserção de cancelamento também
passou no reteste, sem ser alterada. Nenhuma asserção de PDF foi removida. Não somar 404 + 33
como total aprovado: o reteste repete casos de um arquivo, e a suite inteira continua com a
falha PDF registrada. Durações internas Vitest: core 66,65 s; mobile 179,21 s; reteste 18,93 s.

### Artefatos, instalação e percursos finais (Steps 2–3)

Recursos `android-emulator`, `screen`, `mobile-build`, `mobile-signing` e `mobile-version`
reservados antes das operações. EAS CLI 23.2.0 do cache, sempre em subshell dentro de `mobile/`.
Um build Android `preview` foi enviado com o runtime da base limpa integrada; mudanças
posteriores são README, registro e mock de teste, sem efeito no runtime enviado:
`620c7bfd-445c-4e29-9380-b9df267fe451`, `gitCommitHash f153efce…`, `appVersion 0.1.0`.
O CLI reutilizou o keystore remoto e incrementou `versionCode 1 → 2`, confirmando que a
configuração T43 é aplicada na submissão. Isso ainda não comprova instalação/atualização.

Estado final da janela EAS: **IN_QUEUE**, em três consultas, às 17:24 (consulta inicial),
17:29:23 e 17:34:22 UTC. A última começou no prazo de 10 min da criação (17:24:19)
e retornou em cerca de 4 s; espera encerrada. **Não há APK final, download, SHA-256,
instalação ou percurso do runtime final**. Fila não é falha de compilação nem aprovação.
Nenhum segundo build, cancelamento, loja, submit ou OTA. Evidências:
`t44-eas-build-android-attempt1.txt`, `t44-eas-build-view-1.json`, consultas adicionais
`t44-eas-reads.jsonl`. A espera não é teste do produto e não reabre contadores de cenários.

Android disponível: AVD `hangar`, Pixel 7/API 36/x86_64, 1080×2400, portrait, pt-BR.
O instalado era **APK da entrega 2**, 0.1.0/versionCode 1, `lastUpdateTime 30/09 06:22:12`.
Após `adb reverse tcp:8765 tcp:8765` e reabertura, a lista carregou sem login; o servidor salvo
permaneceu. Captura lida: `/home/jefferson/.hangar/orq/2026-09-29-cad3e6fe/visual/t44/reference-apk2-connected.png`.
A captura anterior ao reverse (`reference-apk2-before-reverse.png`) mostrou somente filtro
com área vazia; não foi tratada como sucesso da lista. Nenhum toque/input em sessão de terceiro.
Não se usou o APK2 como prova de T22–T43 nem se instalou outro código histórico para simular
aceitação final.

| Percurso final requerido, Android e iOS | Esperado | Resultado neste lote |
|---|---|---|
| Instalação atualizada sem Metro; preservar servidor/token/projeto/rascunho/aparência | mesmo pacote/assinatura, dados mantidos, build novo instalado | não conferido: build final ainda em fila ao encerrar a janela |
| Abrir conversa; Nova conversa com projeto; enviar/receber/Parar | destino original, uma criação, resposta e interrupção reais | não conferido no código final instalado |
| Pergunta/aprovação, permitir/negar, retorno de formSheet e foco | decisão única, pergunta preservada, foco nativo correto | não conferido no aparelho; mock não aprova TalkBack/VoiceOver |
| Anexo/ditado configurado, silêncio/interrupção e transcrição vazia | upload recuperável e áudio/texto preservados na origem | não conferido; typecheck Expo pendente e nenhum percurso de áudio no binário final |
| Arquivo/plano/par; erro relevante, carregando/vazio/sucesso | conteúdo renderizado, ações no servidor capturado e erro visível | não conferido no aparelho; PDF Android falha em teste |
| Sair/voltar com rascunho; ACK tardio; trocar tela/servidor | edição nova e tentativa incerta preservadas, sem POST automático | não conferido no aparelho; cobertura automática não substitui retorno nativo |
| Cortar/restaurar rede e retornar do fundo | sincronização sem perder dados nem trocar destino | não conferido no código final instalado |
| Organização T38–T42: agrupamento, avisos, controles, teclado, pt-BR/en, claro/escuro | interface montada, legível e alcançável | não conferido; sem comparação cega contra referência equivalente do binário final |
| iOS: build interno, instalação e todos os percursos acima | aparelho disponível, perfil ad hoc, runtime final | não conferido; credencial ad hoc esgotada T33/T37. `idevice_id -l` nesta janela saiu 255 (“Unable to retrieve device list”), sem aparelho identificado/disponibilizado; ausência física não é inferida desse erro |

Nenhuma terceira tentativa de credencial iOS; nenhum login Apple, UDID ou conta interna
publicado. Android não comprova iOS. A referência APK2 foi preparada/lida, mas falta a
captura equivalente do artefato final: comparação cega/cores/foco não foram inventados.
O compromisso de paridade PWA/Rust permanece; não houve mudança de token compartilhado.

### Consolidação dos cinco lotes e compatibilidade real

A tabela usa os registros anteriores desta página, preservando a janela de cada lote.
Estados posteriores conhecidos (T21/T43) ficam atribuídos à janela que os observou.

| Lote | Resultado automatizado registrado | Artefato/uso real registrado | Aceitação |
|---|---|---|---|
| T12, entrega 1 | core 666/666; checks passaram; duas falhas mobile corrigidas no reteste focado | build `2410f755` sem APK dentro da janela T12; APK foi instalado/aberto somente T21 | pendente |
| T21, entrega 2 | core 742/742; check/typecheck e arquivo mobile corrigidos no reteste | APK `664e770a` instalado sobre `2410f755`; criação/envio/Parar/pergunta/retorno conferidos em combinações Claude/Codex descritas na seção T21; cabeçalho, crash e fila→Codex falharam | não aceita |
| T32, entrega 3 | core 758/758; mobile typecheck/test falharam; correções e limites registrados | `ccb85697` sem artefato na janela T32, visto FINISHED somente na T43; APK3 não instalado nos registros | não aceita |
| T37, entrega 4 | core 758/758; semTerminal 38/38 no reteste; mobile check/PDF/criação pendentes | `a9ed153a` em fila na janela T37 e ainda na T43; nenhum APK4/iOS instalado; credencial iOS esgotada | não aceita |
| T44, entrega 5 | core 758/758; criação 33/33 observada em terceiro ciclo fora do limite, não ratificado e excluído do aceite autorizado; mobile typecheck/PDF continuam falhando | build `620c7bfd`, número 2, estado final registrado acima; nenhum resultado nativo final presumido | não aceita |

As combinações de provider conferidas no APK2 pela T21 não são conferidas no código final.
Claude/Codex com e sem terminal, Pi/omp/Kimi e combinação de dois servidores mantêm as
lacunas por cenário/aparelho das tabelas, sem uma aprovação geral por provider.
Pendências acumuladas: typecheck de áudio Expo, PDF Android, cabeçalho da lista esgotado,
crash nativo intermitente, primeiro input fila→Codex, recursos não exercitados em binário
correspondente e assinatura/instalação iOS. Segunda correção/refinamento não revalidados da
T37 ficam assim registrados; a suite ampla T44 observou `semTerminal` passando, sem abrir
um ciclo específico novo. Push com app fechado, lojas, OTA, terminal/CDP e recursos desktop
continuam fora do conjunto; nenhuma retirada de interfaces foi recomendada.

AVD iniciado por esta Task encerrado (`adb emu kill`, exit 0; processo terminou exit 0),
reverse removido, APK2/dados preservados e os cinco recursos liberados. Nenhum fixture foi
criado, servidor reiniciado ou serviço paralelo iniciado. Build remoto não foi cancelado;
sem consulta posterior para reabrir a janela.
**Lote encerrado com pendências.** Reunidos os cinco registros, com a violação do limite
na família de criação explicitada: terceiro ciclo não ratificado e excluído do aceite
autorizado do lote. O resultado observado foi preservado; o produto não foi aprovado nas
duas plataformas e não se exige uma sexta rodada.
