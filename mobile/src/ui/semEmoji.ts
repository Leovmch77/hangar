// Mensagens compartilhadas com o web trazem um emoji na frente ("🔐 Pedido de permissão"). O app
// desenha ícone lucide monocromático no lugar, então tira o emoji do texto antes de mostrar.
const EMOJI_INICIAL = /^(?:\p{Extended_Pictographic}|[✀-➿])️?\s*/u;

export const semEmoji = (texto: string) => texto.replace(EMOJI_INICIAL, '');
