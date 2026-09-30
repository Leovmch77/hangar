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
