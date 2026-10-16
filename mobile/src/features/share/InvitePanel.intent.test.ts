import { describe, expect, it } from 'vitest';
import appConfig from '../../../app.json';
import { redirectSystemPath } from '../../../app/+native-intent';

describe.each([true, false])('redirectSystemPath de convite, initial=%s', (initial) => {
  it.each([
    ['https://guest.ts.net:8443/convite/ABCD', '/convite/ABCD?link=https%3A%2F%2Fguest.ts.net%3A8443%2Fconvite%2FABCD'],
    ['http://10.0.0.5:8766/convite/CODE', '/convite/CODE?link=http%3A%2F%2F10.0.0.5%3A8766%2Fconvite%2FCODE'],
    ['hangar://convite/guest.ts.net:8443/ABCD', '/convite/ABCD?link=hangar%3A%2F%2Fconvite%2Fguest.ts.net%3A8443%2FABCD'],
    ['hangar://convite/10.0.0.5:8766/CODE', '/convite/CODE?link=hangar%3A%2F%2Fconvite%2F10.0.0.5%3A8766%2FCODE'],
    ['hangar://exemplo-teste.tailcac351.ts.net:8443/convite/TESTE123ABC', '/convite/TESTE123ABC?link=hangar%3A%2F%2Fconvite%2Fexemplo-teste.tailcac351.ts.net%3A8443%2FTESTE123ABC'],
    ['hangar://10.0.0.5:8766/convite/CODE', '/convite/CODE?link=hangar%3A%2F%2Fconvite%2F10.0.0.5%3A8766%2FCODE'],
  ])('preenche o formulário com convite válido %s', (path, expected) => {
    expect(redirectSystemPath({ path, initial })).toBe(expected);
  });

  it.each([
    'hangar://convite',
    'hangar://convite/guest.ts.net:8443/',
    'hangar://convite/user:pass@guest.ts.net:8443/CODE',
    'hangar://convite/guest.ts.net:8443/BAD!',
    'hangar://convite/guest.ts.net:8443/CODE/extra',
    'hangar://convite/guest.ts.net:8443/CODE?token=extra',
    'hangar://convite/guest.ts.net:8443/CODE#extra',
    'hangar://guest.ts.net:8443/convite',
    'hangar://guest.ts.net:8443/convite/',
    'hangar://user:pass@guest.ts.net:8443/convite/CODE',
    'hangar://guest.ts.net:8443/convite/BAD!',
    'hangar://guest.ts.net:8443/convite/CODE/extra',
    'hangar://guest.ts.net:8443/convite/CODE?token=extra',
    'hangar://guest.ts.net:8443/convite/CODE#extra',
    'hangar://guest.ts.net:8443/convite/CODE?',
    'hangar://guest.ts.net:8443/convite/CODE#',
    'https://guest.ts.net:8443/convite',
    'https://guest.ts.net:8443/convite/',
    'https://user:pass@guest.ts.net:8443/convite/CODE',
    'https://guest.ts.net:8443/convite/BAD!',
    'https://guest.ts.net:8443/convite/CODE/extra',
    'https://guest.ts.net:8443/convite/CODE?token=extra',
    'https://guest.ts.net:8443/convite/CODE#extra',
    'http://public.example/convite/CODE',
  ])('encaminha convite inválido para o erro existente %s', (path) => {
    expect(redirectSystemPath({ path, initial })).toBe('/convite/invalid');
  });

  it.each([
    ['hangar://guest.ts.net:abc/convite/CODE', '/convite/invalid'],
    ['hangar://guest.ts.net:65536/convite/CODE', '/convite/invalid'],
    ['hangar://host:abc/other', 'hangar://host:abc/other'],
  ])('trata porta inválida sem capturar outro caminho %s', (path, expected) => {
    expect(redirectSystemPath({ path, initial })).toBe(expected);
  });

  it.each(['/s/own/api', '/convite/CODE', 'hangar://s/own/api', 'not-a-url', 'https://public.example/unrelated'])('não muda outro caminho %s', (path) => {
    expect(redirectSystemPath({ path, initial })).toBe(path);
  });
});

it('registra somente o contrato de abertura HTTPS de convite no Android', () => {
  expect(appConfig.expo.android).toMatchObject({
    intentFilters: expect.arrayContaining([expect.objectContaining({
      action: 'VIEW',
      autoVerify: false,
      category: expect.arrayContaining(['BROWSABLE', 'DEFAULT']),
      data: expect.arrayContaining([expect.objectContaining({
        scheme: 'https', host: '*.ts.net', port: '8443', pathPrefix: '/convite/',
      })]),
    })]),
  });
});
