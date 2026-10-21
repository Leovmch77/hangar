import { describe, expect, it } from 'vitest';
import { resolveShortcuts, type Shortcut } from '@hangar/core';
import { panelShortcuts } from './panelShortcuts';

describe('panelShortcuts', () => {
  it('mantém texto, terminal e anexos na ordem configurada', () => {
    const shell: Shortcut = { id: 'shell', type: 'shell', label: 'Shell', command: 'pwd' };
    const external: Shortcut = { id: 'externo', type: 'internal', action: 'externo' };
    const terminal: Shortcut = { id: 'terminal', type: 'internal', action: 'terminal' };
    const sendText: Shortcut = { id: 'finalizar', type: 'send_text', label: 'Finalizar PM', text: '/finalizar-pm' };
    const run: Shortcut = { id: 'rodar', type: 'internal', action: 'rodar' };
    const attachments: Shortcut = { id: 'anexos', type: 'internal', action: 'anexos' };
    expect(panelShortcuts([shell, external, terminal, sendText, run, attachments])).toEqual([terminal, sendText, attachments]);
  });

  it('config ilegível conserva só terminal e anexos do conjunto nativo', () => {
    expect(panelShortcuts(resolveShortcuts('{quebrado'))).toEqual([
      { id: 'terminal', type: 'internal', action: 'terminal' },
      { id: 'anexos', type: 'internal', action: 'anexos' },
    ]);
  });
});
