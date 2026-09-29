---
id: 2026-09-29-navegador-nativo-wpe
titulo: Navegador no painel lateral do app nativo (no Linux, pede a WPE WebKit)
destrutivo: false
---

O painel lateral do app nativo ganha a ferramenta Navegador. No Windows e no macOS ela usa o
navegador que já vem com o sistema. No Linux ela precisa da WPE WebKit 2.0, e a atualização não
instala isso sozinha porque pede a sua senha: sem ela o app funciona igual, só não mostra o
Navegador. Para ter, rode uma vez no terminal `sudo pacman -S wpewebkit` (Arch, CachyOS),
`sudo apt install libwpewebkit-2.0-1` (Debian 13 ou mais novo) ou `sudo dnf install wpewebkit`
(Fedora). O instalador do app nativo passa a avisar quando ela falta.
