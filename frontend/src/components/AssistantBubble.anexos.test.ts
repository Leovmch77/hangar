// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { configureApi } from '@hangar/core';
import AssistantBubble from './AssistantBubble.svelte';

let alvo: HTMLElement;
let comp: ReturnType<typeof mount> | null = null;
beforeEach(() => {
  configureApi({ getBaseUrl: () => 'https://desktop.example.ts.net', getToken: () => 't',
    onUnauthorized: () => {}, origin: 'https://pwa.example',
    createEventSource: () => { throw new Error('Unexpected stream'); } });
  alvo = document.createElement('div');
  document.body.append(alvo);
});
afterEach(async () => {
  if (comp) await unmount(comp);
  comp = null;
  alvo.remove();
});

describe('caminho que virou anexo', () => {
  it('some do texto e fica só a prévia', async () => {
    const text = 'Prints prontos.\n\n/tmp/pdf/06-viewer.png /tmp/pdf/07-leitor.png\n\nO relatório está em /tmp/rel.docx agora.';
    comp = mount(AssistantBubble, { target: alvo, props: { text, ts: 1, sessionName: 's' } });
    await tick();
    const prose = alvo.querySelector('.prose')!.textContent!;
    expect(prose).not.toContain('/tmp/');
    expect(prose).toContain('rel.docx');
    expect(alvo.querySelectorAll('.atts img')).toHaveLength(2);
    expect(alvo.querySelector('.file-card')?.textContent).toContain('rel.docx');
  });
});
