// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import AssistantBubble from './AssistantBubble.svelte';
import { toolLook } from '../lib/toolLook.svelte';

let alvo: HTMLElement | null = null;
let comp: ReturnType<typeof mount> | null = null;
async function montar() {
  alvo = document.createElement('div');
  document.body.append(alvo);
  comp = mount(AssistantBubble, { target: alvo, props: { text: 'Texto do agente.', ts: 1, sessionName: 's' } });
  await tick();
  return alvo;
}
afterEach(async () => {
  if (comp) await unmount(comp);
  comp = null;
  alvo?.remove();
});

describe('AssistantBubble e o ponto do Claude Code', () => {
  it('na pele terminal o texto ganha o ponto; nas outras, não', async () => {
    toolLook.look = 'terminal';
    expect((await montar()).querySelector('.assistant-msg.term')).not.toBeNull();
    await unmount(comp!);
    alvo!.remove();
    toolLook.look = 'classico';
    expect((await montar()).querySelector('.assistant-msg.term')).toBeNull();
  });
});
