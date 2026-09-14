// @vitest-environment happy-dom
// Lista que não rola (cauda só de tool calls, colapsadas em linha de grupo) nunca dispara o
// `onscroll`, e era só por ele que o Chat ficava sabendo que a memória acabou e o servidor tem o
// resto. A conversa parecia começar no meio: nada acima do grupo de ferramentas.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import MessageList from './MessageList.svelte';
import type { ChatEvent } from '@hangar/core';

const tools = (n: number): ChatEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'tool_use', id: `t${i}`, tool_use_id: `t${i}`, tool_name: 'Bash', tool_input: { command: 'ls' },
  }) as unknown as ChatEvent);

describe('MessageList pede o histórico ao servidor quando a tela não rola', () => {
  let alvo: HTMLElement;
  beforeEach(() => {
    alvo = document.createElement('div');
    document.body.appendChild(alvo);
  });

  it('memória esgotada sem rolagem chama onFimDoLocal sem precisar de scroll', async () => {
    const onFimDoLocal = vi.fn();
    const props = $state({
      events: tools(30),
      stateEvent: null,
      pending: [],
      sessionName: 's',
      dockH: 0,
      ancora: 0,
      onSelectOption: () => {},
      onCancel: () => {},
      onFimDoLocal,
    });
    const comp = mount(MessageList, { target: alvo, props });
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(onFimDoLocal).toHaveBeenCalled();
    unmount(comp as never);
  });
});
