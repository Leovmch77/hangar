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
