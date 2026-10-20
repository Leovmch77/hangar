# Prints do Android — instalar o Hangar

Capturados no AVD `hangar` (celular, Android 16, 1080×2400), idioma do sistema pt-BR, em 2026-10-20.
O APK veio de um servidor local aberto no Chrome (no guia real, o link vem do QR).
Arquivos `-marked` têm um retângulo vermelho no lugar do toque; passos sem toque não têm cópia marcada.

| Arquivo | Passo | Onde tocar | Por quê |
|---|---|---|---|
| android-01-abrir-navegador.png | Abra o Chrome | Ícone do Chrome | O APK é baixado pelo navegador. |
| android-02-baixando.png | Aguarde o download do `hangar.apk` | Nada | O arquivo tem ~270 MB e leva um tempo. |
| android-03-abrir-arquivo.png | Toque no arquivo baixado | Linha `hangar.apk` | Abrir o APK inicia a instalação. |
| android-04-aviso-fonte.png | O Android avisa que o Chrome não pode instalar apps | Configurações | Leva à chave que libera instalar apps de fora da Play Store. |
| android-05-permitir-fonte.png | Ligue "Permitir desta fonte" | Chave ao lado de "Permitir desta fonte" | Sem isso o Android bloqueia APK vindo do Chrome. |
| android-06-instalar.png | Confirme a instalação | Instalar | Neste Android o pedido aparece sozinho após ligar a chave, sem precisar voltar. |
| android-07-instalando.png | Aguarde "Instalando…" | Nada | A instalação leva alguns segundos. |
| android-08-abrir-app.png | App instalado | Abrir | Abre o Hangar pela primeira vez. |
| android-09-app-aberto.png | O Hangar abre na tela de conectar | Nada (volte para a tela inicial) | Confirma que o app instalou; a conexão é feita depois. |
| android-10-deslizar-para-cima.png | Na tela inicial, deslize de baixo para cima | Barra inferior (arrastar para cima) | Abre a lista de todos os apps. |
| android-11-abrir-configuracoes.png | Abra Configurações | Ícone Configurações | As permissões do Hangar ficam lá. |
| android-12-apps.png | Entre em Apps | Apps | Lista os apps instalados. |
| android-13-hangar.png | Escolha o Hangar | Hangar | Abre as informações do app. |
| android-14-notificacoes.png | Entre em Notificações | Notificações ("Desativadas") | O app não pede notificação ao abrir; liga-se por aqui. |
| android-15-ligar-notificacoes.png | Ligue "Todas as notificações do app Hangar" | Chave | Sem isso não chega aviso de sessão esperando você. |
| android-16-voltar.png | Notificações ligadas; volte | Seta de voltar | Retorna às informações do app. |
| android-17-uso-da-bateria.png | Role a tela e toque em "Uso da bateria pelo app" | Uso da bateria pelo app | É onde o Android limita apps em segundo plano. |
| android-18-segundo-plano.png | Toque em "Permitir o uso em segundo plano" (no texto, não na chave) | Texto "Permitir o uso em segundo plano" | Abre a escolha Otimizado / Sem restrições. |
| android-19-sem-restricoes.png | Marque "Sem restrições" | Sem restrições | Impede o Android de cortar a conexão do Hangar com a tela apagada. |
| android-20-pronto.png | "Sem restrições" marcado | Nada | Configuração concluída. |
