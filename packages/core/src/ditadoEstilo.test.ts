import { describe, it, expect } from 'vitest';
import { dictationOrganizationOf } from './ditadoEstilo';

describe('dictationOrganizationOf', () => {
  it('lê o modo como o Rust: só harness e external_api organizam', () => {
    expect(dictationOrganizationOf({ dictation_organization_mode: { valor: 'harness' } })).toBe('on');
    expect(dictationOrganizationOf({ dictation_organization_mode: { valor: 'external_api' } })).toBe('on');
    expect(dictationOrganizationOf({ dictation_organization_mode: { valor: 'none' } })).toBe('off');
    expect(dictationOrganizationOf({ dictation_organization_mode: { valor: '' } })).toBe('off');
  });

  it('servidor sem o campo mantém o seletor', () => {
    expect(dictationOrganizationOf({})).toBe('unknown');
    expect(dictationOrganizationOf(undefined)).toBe('unknown');
  });
});
