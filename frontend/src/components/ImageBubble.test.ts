// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { parseImageMessage } from '@hangar/core';
import ImageBubble from './ImageBubble.svelte';

let comp: ReturnType<typeof mount> | null = null;
afterEach(async () => {
  if (comp) await unmount(comp);
  comp = null;
  document.body.innerHTML = '';
});

describe('imagem e arquivo na mesma mensagem', () => {
  it('a foto vira miniatura e o arquivo vira card de download', async () => {
    const img = parseImageMessage('veja — 📎 imagem: /up/1-a.png 📎 arquivo: /up/2-b.txt')!;
    const target = document.createElement('div');
    document.body.append(target);
    comp = mount(ImageBubble, { target, props: {
      caption: img.caption,
      srcs: img.filenames.map((f) => `https://s/uploads/${f}`),
      files: img.files.map((f) => ({ path: f, name: f, kind: 'document' as const, url: `https://s/uploads/${f}` })),
    } });
    await tick();
    expect([...target.querySelectorAll('img.thumb')].map((i) => i.getAttribute('src'))).toEqual(['https://s/uploads/1-a.png']);
    expect(target.querySelector('.file-card')?.textContent).toContain('2-b.txt');
  });
});
