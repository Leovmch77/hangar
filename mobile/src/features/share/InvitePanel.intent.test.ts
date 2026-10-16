import { describe, expect, it } from 'vitest';
import { redirectSystemPath } from '../../../app/+native-intent';

describe('redirectSystemPath de convite', () => {
  it.each([true, false])('preserva URL e host do convite web no formulário, initial=%s', (initial) => {
    expect(redirectSystemPath({ path: 'https://guest.ts.net:8443/convite/ABCD', initial }))
      .toBe('/convite/ABCD?link=https%3A%2F%2Fguest.ts.net%3A8443%2Fconvite%2FABCD');
  });
  it('preserva também a forma hangar:// e porta local', () => {
    expect(redirectSystemPath({ path: 'hangar://convite/10.0.0.5:8766/CODE', initial: false }))
      .toBe('/convite/CODE?link=hangar%3A%2F%2Fconvite%2F10.0.0.5%3A8766%2FCODE');
  });
  it.each(['/s/own/api', '/convite/CODE', 'hangar://s/own/api', 'not a URL', 'https://public.example/unrelated'])('não muda outro caminho %s', (path) => {
    expect(redirectSystemPath({ path, initial: true })).toBe(path);
  });
});
