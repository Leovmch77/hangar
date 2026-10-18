const { existsSync } = require('node:fs');
const path = require('node:path');

// O `@hangar/core` mora fora de mobile/ e o Metro resolve o React dele pelo node_modules da raiz;
// o app usa o de mobile/node_modules. Com as duas instalações (`npm ci` na raiz com o workspace do
// app e `npm install` em mobile/) o bundle leva duas cópias do React e quebra ao abrir. Numa OTA o
// expo-updates marca a atualização como falha naquele aparelho e fica na anterior, sem aviso.
function assertSingleReact(mobileDir) {
  const own = path.join(mobileDir, 'node_modules/react/package.json');
  const root = path.join(mobileDir, '../node_modules/react/package.json');
  if (!existsSync(own) || !existsSync(root)) return;
  throw new Error(
    'React instalado na raiz e em mobile/node_modules: o bundle sairia com duas cópias e quebraria ao abrir.\n'
    + 'Para publicar OTA, use só a instalação da raiz: apague mobile/node_modules e rode, na raiz, '
    + '`npm ci --workspace=@hangar/core --workspace=mobile`.\n'
    + 'Para desenvolver e testar, use só a de mobile/: rode, na raiz, `npm ci --workspace=@hangar/core --workspace=frontend` '
    + '(sem o app) e `npm ci` em mobile/.',
  );
}

module.exports = { assertSingleReact };
