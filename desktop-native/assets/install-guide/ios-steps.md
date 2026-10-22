# Prints do iPad — confiar no perfil e ligar o modo de desenvolvimento

Capturados num iPad real (iPadOS 26.5, 1640×2360, escala 2×), idioma pt-BR, em 2026-10-20, via WebDriverAgent.
O perfil já estava confiável e o modo de desenvolvimento já estava ligado: os prints mostram as telas como estão, nada foi alterado.
Cada print tem um retângulo vermelho no lugar do toque; passos sem toque não têm marca. Os prints guardados aqui já saíram tratados: 820 px de largura, papel de parede pessoal trocado por fundo liso (ícones e nomes redesenhados), nome, e-mail, rede Wi-Fi, Team ID, pastas pessoais, mapa e código de verificação cobertos ou trocados por exemplo (`seu.email@exemplo.com`, `123 456`).
No iPadOS 26 os nomes mudaram: "VPN e Gerenciamento de Dispositivos" virou "Gestão de VPN e Dispositivo" e "Modo Desenvolvedor" virou "Modo de Desenvolvimento".

| Arquivo | Passo | Onde tocar | Por quê |
|---|---|---|---|
| ios-01-abrir-ajustes.png | Abra os Ajustes | Ícone de engrenagem (Ajustes) no Dock | Confiar no perfil e ligar o modo ficam nos Ajustes. |
| ios-02-geral.png | Abra Geral | "Geral" na coluna da esquerda | A confiança no desenvolvedor fica dentro de Geral. |
| ios-03-gestao-vpn-dispositivo.png | Role até o fim e abra "Gestão de VPN e Dispositivo" | "Gestão de VPN e Dispositivo" | É onde aparecem os perfis dos apps instalados fora da App Store. |
| ios-04-app-do-desenvolvedor.png | Em "App do Desenvolvedor", abra o seu Apple ID | Linha com o e-mail do Apple ID | O app foi assinado com esse Apple ID e é ele que precisa de confiança. |
| ios-05-perfil-confiavel.png | Toque em "Confiar" e confirme; depois os apps aparecem como "Verificado" | "Confiar" (neste print já está confiável, por isso não aparece) | Sem confiar, o iPad não abre o app. Não toque em "Apagar Apps". |
| ios-06-privacidade-seguranca.png | Volte aos Ajustes e abra "Privacidade e Segurança" | "Privacidade e Segurança" na coluna da esquerda (role se preciso) | O modo de desenvolvimento fica nessa seção. |
| ios-07-modo-desenvolvimento.png | Role até o fim e abra "Modo de Desenvolvimento" | "Modo de Desenvolvimento", na seção Segurança | O iPad só abre app instalado por desenvolvedor com esse modo ligado. |
| ios-08-chave-modo-desenvolvimento.png | Ligue a chave e confirme a reinicialização | Chave ao lado de "Modo de Desenvolvimento" | Ao ligar, o iPad reinicia e pede para confirmar depois; neste print já está ligada. |

# Prints do iPad — instalar o LocalDevVPN

Capturados no mesmo iPad (iPadOS 26.5, pt-BR), em 2026-10-20, via WebDriverAgent. O app na loja se chama "LocalDevVPN", subtítulo "Para desenvolvedores", desenvolvedor "Coxson Engineering LLC". A instalação parou na confirmação: quem confirma é o dono do iPad.

| Arquivo | Passo | Onde tocar | Por quê |
|---|---|---|---|
| ios-09-abrir-app-store.png | Na tela inicial, abra a App Store | Ícone azul "App Store" (aqui na 2ª página da tela inicial) | O LocalDevVPN é baixado da App Store, de graça. |
| ios-10-buscar-na-app-store.png | Toque em "Buscar" | "Buscar", à direita na barra do topo | A busca leva direto ao app. |
| ios-11-digitar-localdevvpn.png | Digite LocalDevVPN e toque na sugestão | Sugestão "localdevvpn" abaixo do campo | Abre a lista de resultados. |
| ios-12-obter-localdevvpn.png | No resultado "LocalDevVPN — Para desenvolvedores", toque em "Obter" | Botão "Obter" ao lado do LocalDevVPN (não os anúncios de VPN ao lado) | Os primeiros resultados são anúncios de outras VPNs; o certo tem o ícone verde-azulado com um plugue. |
| ios-13-confirmar-instalacao.png | Confirme com o Touch ID (encoste o dedo no botão de cima) | Botão de cima do iPad, indicado por "Touch ID" | Sem a confirmação do dono do Apple ID, a App Store não instala. |

# Prints do iPad — ligar o LocalDevVPN

Capturados no mesmo iPad (iPadOS 26.5, pt-BR), em 2026-10-20, via WebDriverAgent. Na primeira abertura o app mostra um assistente de 4 páginas, em inglês. O fluxo parou na tela do código do iPad: quem digita é o dono. (Os números 15–17 previstos viraram 15–21 por causa do assistente.)

| Arquivo | Passo | Onde tocar | Por quê |
|---|---|---|---|
| ios-14-abrir-localdevvpn.png | Terminada a instalação, toque em "Abrir" | Botão "Abrir" ao lado do LocalDevVPN | Abre o app recém-instalado (também dá pelo ícone na tela inicial). |
| ios-15-assistente-next.png | Na página "Welcome to LocalDevVPN", toque em "Next" | Botão azul "Next" | Primeira de 4 páginas de apresentação. |
| ios-16-assistente-next-2.png | Em "Why Use LocalDevVPN?", toque em "Next" | Botão azul "Next" | Segunda página. |
| ios-17-assistente-next-3.png | Em "Easy to Use", toque em "Next" | Botão azul "Next" | Terceira página. |
| ios-18-assistente-comecar.png | Em "Privacy Focused", toque em "Get Started" | Botão azul "Get Started" | Fecha o assistente e mostra a tela principal. |
| ios-19-conectar.png | Toque em "Connect" | Botão azul "Connect", na seção Connection | Liga o túnel local que o SideStore usa para instalar e renovar apps. |
| ios-20-permitir-vpn.png | No aviso "LocalDevVPN Deseja Adicionar Configurações de VPN", toque em "Permitir" | "Permitir" (o cinza, à esquerda; não o azul "Não Permitir") | Sem permitir, o iPad não cria a VPN. |
| ios-21-codigo-do-ipad.png | Digite o código do iPad | Teclado numérico da tela | O iPad exige o código para adicionar a VPN; depois volta ao app, que deve mostrar "Connected". |
| ios-22-vpn-conectada.png | Confira que o app mostra "Connected" e o selo VPN na barra de status | Nada (só conferir) | Com a VPN ligada o SideStore consegue instalar e renovar os apps. Deixe o LocalDevVPN ligado. |

# Prints do iPad — abrir o SideStore e entrar com o Apple ID

Capturados no mesmo iPad em 2026-10-20, via WebDriverAgent. O SideStore aberto é o instalado hoje (bundle `com.SideStore.SideStore.<Team ID>`, aberto pelo WDA); na tela inicial só há um ícone "SideStore", na última página, ao lado do WebDriverAgent e do LocalDevVPN. O fluxo parou no formulário de login: quem digita Apple ID e senha é o dono.

| Arquivo | Passo | Onde tocar | Por quê |
|---|---|---|---|
| ios-23-abrir-sidestore.png | Na tela inicial, abra o SideStore | Ícone roxo "SideStore" (última página) | É o app que instala o Hangar e renova a assinatura a cada 7 dias. |
| ios-24-sidestore-rede-local.png | No aviso de redes locais, toque em "Permitir" | "Permitir", à direita | O próprio app diz que não é obrigatório; permitir evita o aviso de novo. |
| ios-25-sidestore-notificacoes.png | No aviso de notificações, toque em "Permitir" | "Permitir", à direita | O SideStore avisa quando é hora de renovar os apps. |
| ios-26-sidestore-ajustes.png (fora do guia) | Toque na aba "Settings" | "Settings", na barra do topo | O login do Apple ID fica nos ajustes do SideStore. |
| ios-27-sidestore-entrar-apple-id.png (fora do guia) | Toque em "Sign in with Apple ID" | Primeira linha, seção ACCOUNT | Sem o Apple ID o SideStore não consegue assinar os apps. |
| ios-28-sidestore-apple-id.png (fora do guia) | Digite o Apple ID e a senha e toque em "Sign in" | Campo "APPLE ID", depois "PASSWORD" e "Sign in" | A senha vai só para a Apple; se a Apple pedir código de dois fatores, digite o que aparecer no outro aparelho. |

# SideStore nightly 0.7.0-20261016 — assistente, login e instalação do Hangar (prints `ios-sidestore-*`)

Capturados em 2026-10-20 no mesmo iPad (iPadOS 26.5), via WebDriverAgent. Substituem `ios-23`..`ios-28`: o nightly novo abre com um assistente de 5 páginas e não tem mais o formulário em Settings como primeiro passo.

O que tem que ser verdade para funcionar (achado nesta captura):
- **SideStore nightly de 16/10 ou mais novo.** O 0.7.0-alpha de 11/09 aceita a senha mas o código de dois fatores nunca chega: a Apple mudou o login em 13/10 (ela mesma empurra o código) e só o nightly com o commit `12ff39c6` entende a resposta.
- **No iOS 26.4+, só o arquivo RemoteRP.** Com o pareamento lockdown o SideStore loga, mas instalar e renovar falham: "no ipsec interface (required for lockdown on iOS 26.4+)" (o LocalDevVPN é utun). O arquivo combinado (lockdown + RemoteRP, o que o iloader grava) é recusado como "ambiguous". O PC deve gravar só o `PairingFile_RemoteRP.plist` em iOS ≥ 26.4, senão o SideStore carrega o lockdown na abertura (ele procura o `ALTPairingFile` primeiro).
- Anisette: servidor remoto `mac-ani.jkcoxson.com`, On-Device Anisette desligado (o assistente não pede nada disso; ficou o que já estava gravado).

| Arquivo | Passo | Onde tocar | Por quê |
|---|---|---|---|
| ios-sidestore-01-boas-vindas.png | Abra o SideStore e toque em "Get Started" | Botão roxo "Get Started" | Começa o assistente de configuração. |
| ios-sidestore-02-arquivo-pareamento.png | Em "Pairing File", toque em "Select Pairing File" | Botão "Select Pairing File" | O arquivo que o Hangar do PC gravou deixa o SideStore falar com o próprio iPad. |
| ios-sidestore-03-arquivos.png | Toque em "No Meu iPad" | Barra lateral, "No Meu iPad" | O arquivo fica na pasta do SideStore no iPad. |
| ios-sidestore-04-pasta-sidestore.png | Toque na pasta "SideStore" | Pasta com o ícone do SideStore | |
| ios-sidestore-07-pasta-sidestore.png | Toque em "PairingFile_RemoteRP.plist" | Arquivo de ~500 bytes | É o único tipo que funciona no iPadOS 26.4+ (ver acima). |
| ios-sidestore-08-localdevvpn.png | Confira "LocalDevVPN is connected" e toque em "Continue" | Botão "Continue" | O SideStore só instala com a VPN local ligada. |
| ios-sidestore-09-apple-id.png | Toque em "Sign In with Apple ID" | Botão roxo | A Apple ID assina os apps. |
| ios-sidestore-10-formulario-apple-id.png | Digite e-mail e senha da Apple ID e toque em "Sign in" | Campos APPLE ID, PASSWORD | A senha vai só para a Apple. |
| ios-sidestore-11-metodo-verificacao.png | Toque em "Apple Devices (Recommended)" | Botão azul | Não use SMS: falha na hora. |
| ios-sidestore-12-permitir-inicio-sessao.png | No aviso da Apple, toque em "Permitir" | "Permitir", azul | O aviso diz "MacBook Pro": é o nome que o SideStore usa, é normal. |
| ios-sidestore-13-codigo-apple.png | Memorize o código de 6 dígitos e toque em "OK" | "OK" | |
| ios-sidestore-14-digitar-codigo.png | Digite o código e toque em "Continue" | Campo do código | Não toque em "Other Options". |
| ios-sidestore-15-autenticado.png (fora do guia) | Aparece "Authenticated" | Nada | Login aceito. |
| ios-sidestore-17-tudo-pronto.png | Em "You're All Set!", toque em "Open SideStore" | Botão roxo | |
| ios-sidestore-20-sidestore-pronto.png | Na aba "My Apps", o SideStore aparece com "7 DAYS" | Nada | A assinatura vale 7 dias e é renovada pelo SideStore. |
| ios-sidestore-22-confirmar-instalar.png (fora do guia) | Ao instalar o Hangar, toque em "Install" | "Install" | |
| ios-sidestore-23-hangar-instalado.png | O Hangar aparece em "My Apps" com "7 DAYS" | Nada | Instalado e assinado com a Apple ID. |
| ios-sidestore-24-hangar-aberto.png | Abra o Hangar: tela "Conectar a um servidor" | Nada | Pronto para conectar ao PC. Recapturado em 2026-10-21, aberto pelo "OPEN" da fonte (por isso o "◀ SideStore" na barra). |

# Instalar o Hangar pela fonte e sair sem o certificado

Capturados em 2026-10-21 no mesmo iPad, via WebDriverAgent, com o link `sidestore://source?url=…` do QR da tela do PC. Os prints da fonte só mostram "Jefferson Felizardo", o nome público do desenvolvedor. No print de Sign Out o nome e o e-mail da conta foram cobertos de vez e trocados por "Seu nome" e `seu.email@exemplo.com`.

| Arquivo | Passo | Onde tocar | Por quê |
|---|---|---|---|
| ios-sidestore-30-adicionar-fonte.png | Abra o link da fonte no SideStore e toque em "ADD" | "ADD", no canto de cima à direita | O SideStore mostra a prévia da fonte do Hangar antes de adicionar. |
| ios-sidestore-31-confirmar-fonte.png | Confirme em "Add Source" | "Add Source", à direita no aviso | A fonte diz de onde baixar o Hangar e as atualizações. |
| ios-sidestore-32-obter-hangar.png | No Hangar, toque em "FREE" | "FREE", à direita do Hangar | Com a fonte adicionada o botão de cima vira "REMOVE". |
| ios-sidestore-33-confirmar-instalar.png | Confirme em "Install" | "Install", à direita no aviso | O SideStore baixa e assina o Hangar com a Apple ID. |
| ios-sidestore-34-hangar-instalado-pela-fonte.png | Quando o botão virar "OPEN", toque nele | "OPEN" | "OPEN" no lugar do círculo girando = instalado. |
| ios-sidestore-39-sair-sem-certificado.png (reserva) | Settings → SIGN OUT, desmarque "Keep signing certificate" e toque "Sign Out" | "Keep signing certificate", depois "Sign Out" | Depois de revogar o certificado (pelo Hangar ou outra ferramenta) o SideStore diz "sessão expirada" ou "certificado revogado"; sair sem guardar o certificado e entrar de novo com a Apple ID resolve. |

Prints que mostram o caminho errado ou não entram no guia não ficam no repositório: `05`/`06` (arquivo combinado recusado), `16`/`18`/`19` (lockdown aceito no login, mas instalar falha), `15`, `21`, `22` e os antigos `ios-26`..`ios-28`.
