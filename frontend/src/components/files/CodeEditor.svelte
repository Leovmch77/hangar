<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import * as m from '../../paraglide/messages';
  import type { EditorView } from '@codemirror/view';

  interface Props {
    texto: string;
    path: string;
    linha?: number | null;
    editavel: boolean;
    // Texto da base. Com ele o editor desenha o DIFF por dentro (unifiedMergeView): arquivo
    // inteiro, mudanças embutidas, trechos iguais dobrados. `null` = mostra só o arquivo.
    original?: string | null;
    onChange?: (texto: string) => void;
    // Ctrl/Cmd+S dentro do editor: salvar é do hospedeiro, a tecla é daqui.
    onSalvar?: () => void;
  }
  let { texto, path, linha = null, editavel, original = null, onChange, onSalvar }: Props = $props();

  let caixa = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = $state.raw(null);
  // Qual texto ESTE componente colocou no editor por último. Sem isso, cada tecla digitada
  // dispara o onChange, o hospedeiro reatribui `texto`, e o efeito de sincronia devolveria o
  // documento inteiro — cursor no começo, digitação impossível.
  let ultimoTexto = '';
  let montando = false;

  // O CodeMirror inteiro (com as gramáticas) é import DINÂMICO: são centenas de KB que só quem
  // abre um arquivo precisa, e o app abre no chat.
  async function montar(el: HTMLDivElement, doc: string, base: string | null) {
    montando = true;
    const [{ EditorView: EV, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor },
           { EditorState },
           { defaultKeymap, history, historyKeymap, indentWithTab },
           { searchKeymap, highlightSelectionMatches, search, SearchQuery, setSearchQuery, getSearchQuery,
             findNext, findPrevious, closeSearchPanel, replaceNext, replaceAll },
           { syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, bracketMatching },
           { oneDarkHighlightStyle },
           { unifiedMergeView }] = await Promise.all([
      import('@codemirror/view'),
      import('@codemirror/state'),
      import('@codemirror/commands'),
      import('@codemirror/search'),
      import('@codemirror/language'),
      import('@codemirror/theme-one-dark'),
      import('@codemirror/merge'),
    ]);
    const linguagem = await gramatica(path);

    // `{dark: true}` não é enfeite: é o que faz o CodeMirror (e o baseTheme do merge) aplicar os
    // seletores `&dark`. Sem isso ele assume tema CLARO e a dobra vinha com um gradiente #f3f3f3
    // — a faixa branca atravessando o código escuro.
    const tema = EV.theme({
      '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: 'var(--text-primary)' },
      '.cm-scroller > .cm-content': { paddingBottom: '12px' },
      '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7', overflow: 'auto' },
      '.cm-line': { padding: '0 16px' },
      '.cm-gutterElement': { padding: '0 8px 0 6px' },
      '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--text-muted)',
                       minWidth: '34px', fontSize: '11.5px' },
      // Translúcida de propósito: a seleção é desenhada numa camada ATRÁS do texto, e uma linha
      // ativa de fundo opaco passava por cima dela — duplo clique e arrasto selecionavam sem
      // nada aparecer, justamente na linha em que a pessoa está.
      '.cm-activeLine': { backgroundColor: 'var(--fill-subtle)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-secondary)' },
      '.cm-content': { caretColor: 'var(--accent)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      // O seletor comprido é o que a doc do CodeMirror manda: com o editor em foco o baseTheme
      // dele pinta a seleção por `&.cm-focused > .cm-scroller > .cm-selectionLayer …`, mais
      // específico que `.cm-selectionBackground` sozinho — a nossa cor perdia e valia o #233 de
      // fábrica, quase invisível no painel escuro. 38% e não o `--accent-dim` (16%), que some
      // sobre o vidro.
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: 'color-mix(in srgb, var(--accent) 38%, transparent)' },
      '.cm-panels': { backgroundColor: 'var(--surface-raised)', color: 'var(--text-primary)' },
      '.cm-searchMatch': { backgroundColor: 'var(--accent-dim)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: 'var(--bg-base)' },
      // Diff embutido: as mesmas famílias de cor do resto do app (sucesso/erro), não o verde e o
      // vermelho que o pacote traz. Os seletores levam o `&dark`/`&light` porque é assim que o
      // próprio pacote escreve os dele — sem isso a regra tem menos especificidade e perde, e a
      // marca de palavra continua saindo como aquela faixa de 2px que parece sublinhado.
      // Faixa de 2px na borda ALÉM da cor de fundo: cor sozinha não informa quem não distingue
      // verde de vermelho.
      '.cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)',
                           boxShadow: 'inset 2px 0 0 var(--success)' },
      '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--error) 12%, transparent)',
                            boxShadow: 'inset 2px 0 0 var(--error)' },
      // `&.cm-merge-b` é o seletor VÁLIDO em `theme()` (o `&dark`/`&light` que o pacote usa só
      // existe no baseTheme dele — passá-lo aqui levanta "Unsupported selector" e o editor não
      // monta). Precisa dessa especificidade pra vencer a faixa de 2px que parece sublinhado.
      '&.cm-merge-b .cm-changedText, .cm-changedText':
        { background: 'color-mix(in srgb, var(--success) 24%, transparent)', borderRadius: '2px' },
      '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText':
        { background: 'color-mix(in srgb, var(--error) 24%, transparent)', borderRadius: '2px' },
      // `ins`/`del` são as tags que o pacote usa; sem isto o navegador risca e sublinha o código.
      '.cm-insertedLine, .cm-deletedLine': { textDecoration: 'none' },
      // A dobra vem clara por padrão (o estilo do pacote assume tema claro). Sem isto ela vira
      // uma faixa branca no meio do código escuro.
      // Quase da cor do código: a dobra é uma costura entre dois trechos, não uma barra.
      '.cm-collapsedLines': {
        // `background`, não `background-color`: o pacote pinta com um gradiente, e trocar só a
        // cor deixava o gradiente por baixo.
        color: 'var(--text-muted)', background: 'transparent',
        padding: '3px 8px 3px 50px', fontSize: '11px',
        borderTop: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)',
      },
      '.cm-collapsedLines:hover': { background: 'var(--fill-subtle)' },
      '.cm-collapsedLines::before, .cm-collapsedLines::after': { content: "'⋯'", opacity: '0.6' },
    }, { dark: true });

    // Painel de busca próprio, no lugar do que o @codemirror/search desenha. O de fábrica gasta
    // dois andares (~200px) com cinco botões de texto do mesmo peso, dá 140px ao campo — que é a
    // única coisa que a pessoa usa — e não diz quantas ocorrências achou, então `próxima` é
    // apertado no escuro. Este cabe numa linha, põe a contagem dentro do campo e reduz as opções
    // às convenções que o VS Code e o próprio Chrome já usam (Aa, .*, |ab|).
    // TETO da contagem: arquivo grande com termo de uma letra tem dezenas de milhares de
    // ocorrências, e varrer todas a cada tecla trava a digitação.
    const MAX_CONTAGEM = 5000;

    function painelDeBusca(view: import('@codemirror/view').EditorView) {
      const inicial = getSearchQuery(view.state);
      const opcoes = {
        caseSensitive: inicial.caseSensitive,
        regexp: inicial.regexp,
        wholeWord: inicial.wholeWord,
      };

      const cria = (tag: string, cls: string) => {
        const e = document.createElement(tag);
        e.className = cls;
        return e;
      };

      const dom = cria('div', 'cp-busca');
      const linha = cria('div', 'cp-busca-linha');
      const campoBox = cria('label', 'cp-busca-campo');

      const lupa = cria('span', 'cp-busca-lupa');
      lupa.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

      const campo = document.createElement('input');
      campo.type = 'text';
      campo.className = 'cp-busca-input';
      campo.placeholder = m.arq_busca_find();
      campo.setAttribute('aria-label', m.arq_busca_find());
      campo.setAttribute('autocomplete', 'off');
      campo.setAttribute('spellcheck', 'false');
      campo.value = inicial.search;

      const contador = cria('span', 'cp-busca-contador');
      contador.setAttribute('aria-live', 'polite');

      campoBox.append(lupa, campo, contador);

      const botao = (cls: string, titulo: string, conteudo: string, aoClicar: () => void) => {
        const b = document.createElement('button');
        b.className = cls;
        b.type = 'button';
        b.title = titulo;
        b.setAttribute('aria-label', titulo);
        b.innerHTML = conteudo;
        b.onclick = (e) => { e.preventDefault(); aoClicar(); view.focus(); };
        return b;
      };

      const nav = cria('span', 'cp-busca-nav');
      nav.append(
        botao('cp-busca-icone', m.arq_busca_previous(),
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
          () => findPrevious(view)),
        botao('cp-busca-icone', m.arq_busca_next(),
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
          () => findNext(view)),
      );

      const opc = cria('span', 'cp-busca-opc');
      const chip = (rotulo: string, titulo: string, chave: 'caseSensitive' | 'regexp' | 'wholeWord') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cp-busca-chip';
        b.textContent = rotulo;
        b.title = titulo;
        b.setAttribute('aria-label', titulo);
        const pinta = () => {
          b.classList.toggle('on', opcoes[chave]);
          b.setAttribute('aria-pressed', opcoes[chave] ? 'true' : 'false');
        };
        pinta();
        b.onclick = (e) => { e.preventDefault(); opcoes[chave] = !opcoes[chave]; pinta(); buscar(); campo.focus(); };
        return b;
      };
      opc.append(
        chip('Aa', m.arq_busca_match_case(), 'caseSensitive'),
        chip('.*', m.arq_busca_regexp(), 'regexp'),
        chip('|ab|', m.arq_busca_by_word(), 'wholeWord'),
      );

      // Substituir sai da barra fixa: ele só existe em arquivo que dá pra gravar, e era o que
      // ocupava o segundo andar em TODO arquivo, inclusive os de leitura.
      const sub = cria('div', 'cp-busca-sub');
      sub.hidden = true;
      const campoSub = document.createElement('input');
      campoSub.type = 'text';
      campoSub.className = 'cp-busca-input';
      campoSub.placeholder = m.arq_busca_replace();
      campoSub.setAttribute('aria-label', m.arq_busca_replace());
      campoSub.setAttribute('autocomplete', 'off');
      const bSub = document.createElement('button');
      bSub.type = 'button';
      bSub.className = 'cp-busca-txt';
      bSub.textContent = m.arq_busca_replace_btn();
      bSub.onclick = (e) => { e.preventDefault(); buscar(); replaceNext(view); };
      const bSubTodas = document.createElement('button');
      bSubTodas.type = 'button';
      bSubTodas.className = 'cp-busca-txt';
      bSubTodas.textContent = m.arq_busca_replace_all();
      bSubTodas.onclick = (e) => { e.preventDefault(); buscar(); replaceAll(view); };
      sub.append(campoSub, bSub, bSubTodas);

      let abrirSub: HTMLButtonElement | null = null;
      if (editavel) {
        abrirSub = botao('cp-busca-icone cp-busca-girar', m.arq_busca_replace(),
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
          () => {});
        abrirSub.onclick = (e) => {
          e.preventDefault();
          sub.hidden = !sub.hidden;
          abrirSub!.classList.toggle('aberto', !sub.hidden);
          if (!sub.hidden) campoSub.focus();
        };
      }

      const fechar = botao('cp-busca-icone', m.arq_busca_close(),
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        () => closeSearchPanel(view));

      if (abrirSub) linha.append(abrirSub);
      linha.append(campoBox, nav, opc, fechar);
      dom.append(linha, sub);

      function buscar() {
        view.dispatch({
          effects: setSearchQuery.of(new SearchQuery({
            search: campo.value,
            replace: campoSub.value,
            caseSensitive: opcoes.caseSensitive,
            regexp: opcoes.regexp,
            wholeWord: opcoes.wholeWord,
          })),
        });
        posicionar();
      }

      // Busca incremental: a cada tecla o editor pula pra primeira ocorrência A PARTIR de onde o
      // cursor já está, dando a volta no fim. Sem isto o contador nasce em "0 de 11" — há onze
      // ocorrências e você não está em nenhuma — e só sai de zero depois de apertar `próxima`.
      // A partir do `from` da seleção, não do fim: senão cada letra digitada saltaria adiante.
      function posicionar() {
        const q = getSearchQuery(view.state);
        if (!q.search || !q.valid) return;
        const cursor = q.getCursor(view.state, view.state.selection.main.from);
        let achado = cursor.next();
        if (achado.done) achado = q.getCursor(view.state, 0).next();
        if (achado.done) return;
        view.dispatch({
          selection: { anchor: achado.value.from, head: achado.value.to },
          scrollIntoView: true,
        });
      }

      // "3 de 17" dentro do campo. O índice sai da comparação com a seleção atual, que é o que o
      // findNext move — sem ela o número diria só quantas existem, não onde você está.
      function atualizarContador() {
        const q = getSearchQuery(view.state);
        if (!q.search) { contador.textContent = ''; contador.classList.remove('vazio'); return; }
        if (!q.valid) { contador.textContent = m.arq_busca_regex_invalida(); contador.classList.add('vazio'); return; }
        const sel = view.state.selection.main;
        let total = 0;
        let atual = 0;
        const cursor = q.getCursor(view.state);
        for (let v = cursor.next(); !v.done; v = cursor.next()) {
          total++;
          if (v.value.from === sel.from && v.value.to === sel.to) atual = total;
          if (total >= MAX_CONTAGEM) { total = -1; break; }
        }
        if (total === -1) {
          contador.textContent = m.arq_busca_muitos({ n: MAX_CONTAGEM });
          contador.classList.remove('vazio');
          return;
        }
        contador.textContent = m.arq_busca_contador({ atual, total });
        contador.classList.toggle('vazio', total === 0);
      }

      campo.oninput = buscar;
      campoSub.oninput = buscar;
      dom.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.target === campoSub) { replaceNext(view); return; }
          if (e.shiftKey) findPrevious(view); else findNext(view);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeSearchPanel(view);
          view.focus();
        }
      };

      return {
        dom,
        top: true,
        mount() { campo.focus(); campo.select(); atualizarContador(); },
        update(u: import('@codemirror/view').ViewUpdate) {
          if (u.docChanged || u.selectionSet
              || u.transactions.some((t) => t.effects.some((ef) => ef.is(setSearchQuery)))) {
            atualizarContador();
          }
        },
      };
    }

    const teclas = [...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab, ...foldKeymap];
    if (onSalvar) {
      teclas.unshift({
        key: 'Mod-s',
        run: () => { onSalvar(); return true; },   // true = a tecla foi consumida: não salva a página
      });
    }

    const v = new EV({
      parent: el,
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(),
          foldGutter(),
          history(),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true, createPanel: painelDeBusca }),
          indentOnInput(),
          bracketMatching(),
          // SÓ as cores de sintaxe do one-dark, nunca o tema inteiro: o `oneDark` pinta o fundo
          // do editor e da calha de #282c34 e ganha do nosso tema, e era isso que punha o código
          // dentro de uma segunda moldura, com a cor errada, sobre a superfície do app.
          syntaxHighlighting(oneDarkHighlightStyle),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          ...(linguagem ? [linguagem] : []),
          // O diff mora DENTRO do editor. `mergeControls: false` porque aceitar/rejeitar trecho
          // é operação de merge, não de leitura — quem resolve conflito aqui é o git, não a tela.
          // `collapseUnchanged` é o que tira o "parede de código igual" de arquivo grande.
          ...(base !== null ? [unifiedMergeView({
            original: base,
            mergeControls: false,
            highlightChanges: true,
            gutter: true,
            allowInlineDiffs: true,
            collapseUnchanged: { margin: 3, minSize: 4 },
          })] : []),
          // O rótulo da dobra vem do pacote em inglês e passa por `phrase` — é o gancho de i18n
          // dele, e é o que mantém a regra do projeto (texto de interface sai de `m.*`).
          // Os rótulos do painel de busca vêm do pacote em inglês e passam por `phrase`, que é o
          // gancho de i18n dele. As chaves são o texto original do CodeMirror, e é assim que a
          // regra do projeto (texto de interface sai de `m.*`) alcança o painel.
          // `phrase` é o gancho de i18n do CodeMirror, e sobrou só a dobra do merge view: os
          // rótulos da busca passavam por aqui quando o painel era o de fábrica, e o `createPanel`
          // acima monta o nosso, que lê de `m.*` direto.
          EditorState.phrases.of({ '$ unchanged lines': m.arq_linhas_sem_mudanca() }),
          keymap.of(teclas),
          tema,
          EV.lineWrapping,
          EV.editable.of(editavel),
          EV.updateListener.of((u) => {
            if (!u.docChanged) return;
            ultimoTexto = u.state.doc.toString();
            onChange?.(ultimoTexto);
          }),
        ],
      }),
    });
    ultimoTexto = doc;
    montando = false;
    return v;
  }

  // Modo legado: `StreamLanguage.define(modo)` é a ponte oficial do CodeMirror 5 para o 6.
  // Os imports são ESTÁTICOS, um por arquivo de modo: com o caminho montado numa variável o
  // bundler não resolve nada (`Failed to resolve module specifier` em runtime, medido) — ele
  // precisa enxergar o especificador literal pra separar o pedaço.
  const MODOS_LEGADOS: Record<string, () => Promise<Record<string, unknown>>> = {
    clike: () => import('@codemirror/legacy-modes/mode/clike'),
    pascal: () => import('@codemirror/legacy-modes/mode/pascal'),
    shell: () => import('@codemirror/legacy-modes/mode/shell'),
    toml: () => import('@codemirror/legacy-modes/mode/toml'),
    go: () => import('@codemirror/legacy-modes/mode/go'),
    ruby: () => import('@codemirror/legacy-modes/mode/ruby'),
    lua: () => import('@codemirror/legacy-modes/mode/lua'),
    swift: () => import('@codemirror/legacy-modes/mode/swift'),
    powershell: () => import('@codemirror/legacy-modes/mode/powershell'),
  };

  async function legado(arquivo: string, nome: string) {
    const carregar = MODOS_LEGADOS[arquivo];
    if (!carregar) return null;
    const [{ StreamLanguage }, mod] = await Promise.all([import('@codemirror/language'), carregar()]);
    const modo = mod[nome];
    return modo ? StreamLanguage.define(modo as never) : null;
  }

  // Gramática por extensão. Só o que o app realmente encontra — o resto cai em texto plano com
  // numeração e busca, que já é melhor do que um `<pre>`.
  async function gramatica(p: string) {
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    switch (ext) {
      case 'ts': case 'tsx': case 'mts': case 'cts':
        return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: ext === 'tsx' });
      case 'js': case 'jsx': case 'mjs': case 'cjs':
        return (await import('@codemirror/lang-javascript')).javascript({ jsx: ext === 'jsx' });
      case 'py': return (await import('@codemirror/lang-python')).python();
      case 'json': return (await import('@codemirror/lang-json')).json();
      case 'md': case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
      case 'css': return (await import('@codemirror/lang-css')).css();
      case 'html': case 'htm': case 'svelte': case 'vue':
        return (await import('@codemirror/lang-html')).html();
      case 'sql': return (await import('@codemirror/lang-sql')).sql();
      case 'rs': return (await import('@codemirror/lang-rust')).rust();
      case 'c': case 'h': case 'cc': case 'cpp': case 'hpp':
        return (await import('@codemirror/lang-cpp')).cpp();
      case 'java': return (await import('@codemirror/lang-java')).java();
      // C#, Kotlin, Dart e Pascal vêm dos modos LEGADOS (@codemirror/legacy-modes) — os do
      // CodeMirror 5 rodando no 6 via StreamLanguage. São do mesmo autor e não têm árvore de
      // sintaxe (então nada de dobra por bloco ou indentação inteligente), mas colorem certo,
      // que é o que esta tela precisa. Sem eles, Delphi e C# — o que mais se lê aqui — abriam
      // como texto plano.
      case 'cs': return await legado('clike', 'csharp');
      case 'kt': return await legado('clike', 'kotlin');
      case 'dart': return await legado('clike', 'dart');
      case 'pas': case 'dpr': case 'dpk': case 'inc': return await legado('pascal', 'pascal');
      case 'sh': case 'bash': case 'zsh': return await legado('shell', 'shell');
      case 'toml': return await legado('toml', 'toml');
      case 'go': return await legado('go', 'go');
      case 'rb': return await legado('ruby', 'ruby');
      case 'lua': return await legado('lua', 'lua');
      case 'swift': return await legado('swift', 'swift');
      case 'ps1': return await legado('powershell', 'powerShell');
      case 'php': return (await import('@codemirror/lang-php')).php();
      case 'xml': case 'xsd': case 'xsl': return (await import('@codemirror/lang-xml')).xml();
      case 'yml': case 'yaml': return (await import('@codemirror/lang-yaml')).yaml();
      default: return null;
    }
  }

  // Monta/remonta quando a CAIXA ou o ARQUIVO trocam. Trocar de arquivo remonta de propósito: a
  // gramática e o histórico de desfazer são daquele arquivo, e carregar o desfazer de um arquivo
  // dentro de outro seria pior que remontar.
  $effect(() => {
    const el = caixa;
    const p = path;
    // `original` na lista de dependências: trocar de escopo (branch ↔ não commitado) muda a base
    // e a extensão do diff só entra na CRIAÇÃO do estado — sem remontar, a tela mostraria o
    // diff do escopo anterior.
    void original;
    if (!el) return;
    let vivo = true;
    // `untrack`: o texto é só o conteúdo INICIAL do editor. Lido de forma rastreada, cada tecla
    // digitada (que sobe pelo onChange e volta como `texto`) remontava o editor inteiro e
    // devolvia o cursor pro começo do arquivo — digitar era impossível. Texto novo vindo de fora
    // entra pelo efeito de sincronia abaixo, que altera o documento sem recriar o editor.
    const doc = untrack(() => texto);
    const base = original;
    montar(el, doc, base).then((v) => {
      if (!vivo) { v.destroy(); return; }
      view?.destroy();
      view = v;
      void p;
    });
    return () => { vivo = false; };
  });

  // Texto novo vindo de fora (recarregar depois de um conflito, por exemplo) entra no documento.
  // Comparar com `ultimoTexto` é o que impede o laço com o próprio onChange.
  $effect(() => {
    const t = texto;
    const v = view;
    if (!v || montando || t === ultimoTexto) return;
    ultimoTexto = t;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
  });

  // Ligar/desligar a edição sem remontar. `contentEditable` direto: reconfigurar a extensão
  // exigiria um Compartment e mais um estado pra manter, e o efeito visível é o mesmo.
  $effect(() => {
    const podeEditar = editavel;
    view?.contentDOM.setAttribute('contenteditable', podeEditar ? 'true' : 'false');
  });

  $effect(() => {
    const v = view;
    if (!v || linha === null || !Number.isSafeInteger(linha) || linha < 1) return;
    const alvo = v.state.doc.line(Math.min(linha, v.state.doc.lines));
    v.dispatch({ selection: { anchor: alvo.from, head: alvo.to }, scrollIntoView: true });
  });

  onDestroy(() => { view?.destroy(); view = null; });
</script>

<div class="editor" bind:this={caixa} data-editavel={editavel}></div>

<style>
  .editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    /* Herda a superfície do hospedeiro (o `.visor` define `--cp-editor-surface`), pra aba ativa,
       sub-barra e código serem a MESMA cor — é isso que faz o cabeçalho e o código lerem como
       uma peça só. Sem o hospedeiro, cai no fundo opaco do app. */
    background: var(--cp-editor-surface, var(--bg-base));
  }

  /* O painel de busca (Ctrl+F) é DOM do CodeMirror, criado por JS: fica fora do escopo do
     Svelte e só alcança por `:global`. Sem isto ele sai com o visual cru do navegador —
     campo branco e botões cinza de sistema — porque o projeto importa só as cores de sintaxe
     do one-dark, nunca o tema inteiro. */
  .editor :global(.cm-panels) {
    background: var(--bg-surface);
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-default);
  }
  /* Fluxo em linha, com os `<br>` do próprio CodeMirror separando busca, opções e substituição:
     virar flex-wrap quebrava a barra em quatro alturas na largura do visor. */
  /* ── painel de busca próprio (createPanel) ─────────────────────────────────────────────────
     Uma linha: campo largo com a contagem dentro, ‹ › compactos, as três opções como chips de
     uma letra. A linha de substituir fica atrás do chevron e só existe em arquivo editável. */
  .editor :global(.cp-busca) {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 7px 10px;
    font: inherit;
    font-size: 0.82rem;
  }
  .editor :global(.cp-busca-linha),
  .editor :global(.cp-busca-sub) {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  /* O `display: flex` acima ganha do `[hidden]` do navegador, e a linha de substituir ficava
     visível com o atributo posto — dois andares de novo, que é o que este painel existe pra
     acabar. */
  .editor :global(.cp-busca-sub[hidden]) { display: none; }
  .editor :global(.cp-busca-campo) {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1 1 200px;
    min-width: 0;
  }
  .editor :global(.cp-busca-lupa) {
    position: absolute;
    left: 9px;
    display: grid;
    place-items: center;
    color: var(--text-muted);
    pointer-events: none;
  }
  .editor :global(.cp-busca-lupa svg) { width: 13px; height: 13px; }
  .editor :global(.cp-busca-input) {
    flex: 1 1 auto;
    min-width: 0;
    box-sizing: border-box;
    padding: 6px 10px;
    border-radius: 7px;
    border: 1px solid var(--border-default);
    background: var(--surface-inset);
    color: var(--text-primary);
    font: inherit;
  }
  /* Só o campo da BUSCA abre espaço pra lupa e pro contador; o de substituir não tem nenhum dos
     dois, e herdar o recuo deixaria o texto flutuando no meio da caixa. */
  .editor :global(.cp-busca-campo .cp-busca-input) { padding-left: 29px; padding-right: 78px; }
  .editor :global(.cp-busca-input:focus-visible) {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .editor :global(.cp-busca-contador) {
    position: absolute;
    right: 9px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    max-width: 68px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .editor :global(.cp-busca-contador.vazio) { color: var(--error); }
  .editor :global(.cp-busca-nav),
  .editor :global(.cp-busca-opc) { display: flex; gap: 2px; flex: none; }
  .editor :global(.cp-busca-icone) {
    width: 26px;
    height: 26px;
    flex: none;
    display: grid;
    place-items: center;
    border: 0;
    background: none;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .editor :global(.cp-busca-icone svg) { width: 13px; height: 13px; }
  .editor :global(.cp-busca-icone:hover) { background: var(--bg-hover); color: var(--text-primary); }
  .editor :global(.cp-busca-girar svg) { transition: transform 160ms var(--ease-out); }
  .editor :global(.cp-busca-girar.aberto svg) { transform: rotate(90deg); }
  .editor :global(.cp-busca-chip) {
    height: 24px;
    padding: 0 8px;
    flex: none;
    border: 1px solid transparent;
    background: none;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .editor :global(.cp-busca-chip:hover) { background: var(--bg-hover); color: var(--text-primary); }
  .editor :global(.cp-busca-chip.on) {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }
  .editor :global(.cp-busca-txt) {
    flex: none;
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid var(--border-default);
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .editor :global(.cp-busca-txt:hover) { background: var(--bg-hover); color: var(--text-primary); }
</style>
