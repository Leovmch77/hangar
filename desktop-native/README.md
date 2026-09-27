# Hangar Native (experimental)

Cliente desktop em Rust/GPUI para o backend Hangar **já em execução**. Mostra a lista de sessões, histórico e conversa ao vivo; permite enviar texto e interromper a geração na sessão escolhida. Não substitui o aplicativo Electron padrão. Perguntas e aprovações pendentes ainda são respondidas no Electron.

## Compilar e abrir

```bash
cargo +1.98.1 run --manifest-path desktop-native/Cargo.toml --locked
```

Execute o comando na raiz desta worktree. O seletor `+1.98.1` mantém a versão do Rust ao executar fora de `desktop-native/`; se ela ainda não estiver instalada, use `rustup toolchain install 1.98.1`. Para uma compilação otimizada, acrescente `--release` depois de `--locked`. A janela pede a URL HTTP(S) do backend existente e o token de acesso; o token fica apenas na memória do processo, sem ser salvo em disco. Para a interface em inglês, use `HANGAR_NATIVE_LANG=en` no ambiente do processo.

## Ambiente

- Rust 1.98.1, fixado em `rust-toolchain.toml`. `Cargo.lock` fixa as versões usadas nesta worktree.
- Linux: sessão Wayland ou X11 e bibliotecas de desenvolvimento de xkbcommon, fontconfig, freetype, Vulkan e ALSA. Compilação e uso real conferidos em CachyOS/Hyprland/Wayland.
- Windows: Rust com alvo MSVC, Visual Studio C++ Build Tools e Windows SDK para Win32/DirectWrite. A compilação e a janela **não foram conferidas** no Windows.
- macOS: Xcode e Command Line Tools para Metal. A compilação e a janela **não foram conferidas** no macOS.

No Linux, o fundo do chat usa transparência; a prova com dois fundos coloridos está em [verification.md](docs/verification.md). Windows e macOS mantêm fundo opaco até sua conferência visual. O estado exato das verificações e os limites desta entrega estão no mesmo documento.

## Baixar pronto e atualização

Cada push na `main` que mexe no app recompila e publica na release fixa [`native-latest`](https://github.com/jeffer1312/hangar/releases/tag/native-latest) (workflow `.github/workflows/native.yml`): `Hangar-linux-x86_64.tar.gz`, `Hangar-windows-x86_64.zip` e `Hangar-macos-aarch64.zip`, cada um com o `.sha256` ao lado (`sha256sum -c`). Dentro do arquivo o executável é `hangar` (`Hangar.exe` no Windows). Não são assinados: no macOS, abra pelo botão direito na primeira vez. Windows e macOS compilam sem conferência de uso; se o build deles falhar, a release sai só com o Linux.

A versão é a do backend: `VERSION` da raiz + número de commits (`0.1.0.2533`), embutida pelo `build.rs` e mostrada em Configurações → Sobre. Ao abrir e a cada 6 h o app lê o `native-latest.json` da release; havendo versão maior, aparece **Atualizar** na barra do topo, ao lado da engrenagem. O clique baixa o binário da plataforma (`Hangar-<sistema>-<arquitetura>`), confere o sha256 do manifesto (diferente: recusa sem trocar nada), guarda o atual em `<executável>.old`, põe o novo no lugar e o abre. O novo prova que subiu gravando o próprio pid; se não fizer isso em 30 s ou morrer antes, o anterior volta para o lugar e a janela antiga continua aberta com o aviso. Build local de uma branch com mais commits que a `main` não recebe oferta.

Para provar sem o GitHub: `HANGAR_NATIVE_UPDATE_URL=http://127.0.0.1:<porta>` aponta para uma release falsa, servida por `tools/release_update_fixture.py`.
