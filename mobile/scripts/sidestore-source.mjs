// Fonte AltStore/SideStore do Hangar: `node sidestore-source.mjs <hangar.ipa> <buildVersion>` > sidestore-source.json
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RELEASE = 'https://github.com/jeffer1312/hangar/releases/download/mobile-latest';
const ICON = 'https://raw.githubusercontent.com/jeffer1312/hangar/main/mobile/assets/icon.png';

// Sem marketplaceID: com ele o SideStore trata o app como da loja alternativa da UE e recusa instalar.
export function buildSource({ version, buildVersion, date, ipaUrl, ipaSize, sha256, iconUrl }) {
  return {
    name: 'Hangar',
    identifier: 'com.hangar.mobile.source',
    apps: [{
      name: 'Hangar',
      bundleIdentifier: 'com.hangar.mobile',
      developerName: 'Jefferson Felizardo',
      localizedDescription: 'Acompanhe e conduza suas sessões do Claude Code, Codex e outros agentes pelo celular.',
      iconURL: iconUrl,
      versions: [{
        version,
        // O número do run muda a cada build; é por ele que o SideStore vê que há atualização.
        buildVersion: String(buildVersion),
        date,
        downloadURL: ipaUrl,
        size: ipaSize,
        sha256,
      }],
    }],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [ipaPath, buildVersion] = process.argv.slice(2);
  if (!ipaPath || !buildVersion) throw new Error('uso: sidestore-source.mjs <hangar.ipa> <buildVersion>');
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
  const ipa = readFileSync(ipaPath);
  const source = buildSource({
    version: app.version,
    buildVersion,
    date: new Date().toISOString(),
    ipaUrl: `${RELEASE}/hangar.ipa`,
    ipaSize: ipa.length,
    sha256: createHash('sha256').update(ipa).digest('hex'),
    iconUrl: ICON,
  });
  process.stdout.write(`${JSON.stringify(source, null, 2)}\n`);
}
