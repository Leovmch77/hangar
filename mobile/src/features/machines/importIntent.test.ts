import { describe, expect, test } from 'vitest';
import { redirectSystemPath } from '../../../app/+native-intent';
import { parseMachineImportPayload } from '@hangar/core';

const raw = '[{"id":"home","label":"fixture-home","baseUrl":"https://home.test","token":"literal%25/#?+"}]';
const fragment = encodeURIComponent(raw);
const credentialLink = new URL('hangar://importar');
credentialLink.username = 'fixture-user';
credentialLink.password = 'fixture-password';
credentialLink.hash = 'fixture-payload';

describe.each([true, false])('importação fria/quente: initial=%s', (initial) => {
  test('normaliza para a rota sem decodificar nem mover o segredo para query', () => {
    const path = redirectSystemPath({ path: `hangar://importar#${fragment}`, initial });
    expect(path).toBe(`/importar#${fragment}`);
    expect(path.split('#')[0]).not.toContain('?');
    // É a única decodificação feita por useLocalSearchParams no Expo Router instalado.
    expect(parseMachineImportPayload(decodeURIComponent(path.slice(path.indexOf('#') + 1)))[0].token).toBe('literal%25/#?+');
  });

  test.each(['hangar://importar?token=fixture-token#fixture-payload', credentialLink.toString(),
    'hangar://importar/extra#payload', 'hangar://importar:99#payload', 'hangar://importar?#payload',
  ])('link fora do contrato cai no erro sem carregar query ou credenciais: %s', (path) => {
    expect(redirectSystemPath({ path, initial })).toBe('/importar');
  });
});
