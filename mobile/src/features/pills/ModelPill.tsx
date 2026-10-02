import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseStatusLine, getModelOptions, getPiModels, getKimiModels, getCodexModels, setModelEffort, setEngineModel, setPiModel, setKimiModel, setCodexModel } from '@hangar/core';
import type { CodexModelsResponse } from '@hangar/core';
import { chatStore } from '../../stores/chat';
import * as m from '../../paraglide/messages';
import { PillMenu, type PillMenuItem } from './PillMenu';
import { pillLabels, type Chosen } from './pills';
import { RowPill } from './RowPill';
import { spacedModel } from '../../chat/usage';

interface Props {
  serverId: string;
  name: string;
  provider: string | null;
  chosen: Chosen;
  onChosen: (next: Chosen) => void;
  // Cada incremento abre o seletor (`/model` digitado ou escolhido na lista de comandos).
  openSignal?: number;
}

// A statusline escreve "Opus5.5·1M" e a lista do Claude, "Opus 5.5": compara sem espaço, pontuação
// e o sufixo de contexto, senão o modelo atual nunca aparece marcado.
const semEnfeite = (s: string) => s.split('·')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
function mesmoModelo(nome: string, statusModel: string | null | undefined): boolean {
  return !!statusModel && semEnfeite(nome) === semEnfeite(statusModel);
}

type Catalog =
  | { kind: 'codex'; data: CodexModelsResponse }
  | { kind: 'claude' | 'engine'; names: Map<string, string> }
  | { kind: 'other' };

export function ModelPill({ serverId, name, provider, chosen, onChosen, openSignal = 0 }: Props) {
  const chat = chatStore(serverId, name);
  const statusLine = chat.use((s) => s.statusLine);
  const statusFields = useMemo(() => parseStatusLine(statusLine), [statusLine]);

  const isCodex = provider === 'codex';
  // omp é o fork do Pi: mesmo seletor, mesmos endpoints.
  const isPi = provider === 'pi' || provider === 'omp';
  const isKimi = provider === 'kimi';

  const [tempError, setTempError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<PillMenuItem[]>([]);
  const catalog = useRef<Catalog>({ kind: 'other' });

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  const flash = useCallback((msg: string) => {
    setTempError(msg);
    setTimeout(() => setTempError(null), 8000);
  }, []);

  const model = pillLabels(statusFields, chosen).model;
  const display = tempError ?? (model ? spacedModel(model) : m.composer_modelo());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    const current = chosen.model ?? statusFields?.model;
    try {
      if (isCodex) {
        const res = await getCodexModels(name);
        catalog.current = { kind: 'codex', data: res };
        setItems(res.models.map((mo) => ({
          id: mo.model, label: mo.displayName ?? mo.model, hint: mo.description ?? undefined,
          selected: mo.model === (chosen.model ?? res.current.model),
        })));
      } else if (isPi) {
        const res = await getPiModels(name);
        setItems(res.models.map((mo) => ({
          label: mo.name ?? mo.id, hint: `${mo.provider}/${mo.id}`, selected: (mo.name ?? mo.id) === current,
        })));
      } else if (isKimi) {
        const res = await getKimiModels(name);
        setItems(res.models.map((mo) => ({ id: mo.alias, label: mo.name, hint: mo.alias, selected: mo.name === current })));
      } else {
        const res = await getModelOptions(name);
        catalog.current = { kind: res.kind, names: new Map(res.models.map((mo) => [mo.id, mo.name ?? mo.id])) };
        setItems(res.models.map((mo) => ({
          id: mo.id, label: mo.name ?? mo.id, hint: mo.desc ?? undefined,
          selected: chosen.model ? (mo.name ?? mo.id) === chosen.model || mo.id === chosen.model : mesmoModelo(mo.name ?? mo.id, current),
        })));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [name, isCodex, isPi, isKimi, chosen.model, statusFields?.model]);

  useEffect(() => {
    if (open) void load();
    // Só ao abrir: recarregar a cada statusline nova piscaria a lista aberta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSelect = useCallback(
    async (it: PillMenuItem) => {
      const id = it.id ?? it.label;
      let closedEarly = false;
      try {
        const cat = catalog.current;
        if (isCodex && cat.kind === 'codex') {
          // Trocar de modelo leva o nível padrão do NOVO: o antigo pode nem existir na lista dele.
          const md = cat.data.models.find((x) => x.model === id);
          const effort = id === cat.data.current.model
            ? (cat.data.current.effort ?? md?.defaultEffort ?? null)
            : (md?.defaultEffort ?? md?.efforts[0]?.value ?? null);
          await setCodexModel(name, id, effort);
          onChosen({ model: id, effort });
          setOpen(false);
        } else if (isPi) {
          const alias = it.hint ?? it.label;
          const slash = alias.indexOf('/');
          const res = await setPiModel(name, { provider: slash >= 0 ? alias.slice(0, slash) : undefined, model: slash >= 0 ? alias.slice(slash + 1) : alias });
          onChosen({ ...chosen, model: res.current?.name ?? res.current?.id ?? it.label, effort: res.thinking ?? chosen.effort });
          setOpen(false);
        } else if (isKimi) {
          const res = await setKimiModel(name, { model: id });
          onChosen({ ...chosen, model: res.current?.name ?? it.label });
          setOpen(false);
        } else if (cat.kind === 'engine') {
          // Sessão de motor: o id do provedor é o rótulo, e a troca vale só nesta sessão.
          const res = await setEngineModel(name, { model: id, effort: chosen.effort ?? statusFields?.effort ?? undefined });
          onChosen({ ...chosen, model: res.model });
          if (res.effort_error) {
            setNotice(m.modelo_trocado_esforco_nao({ erro: res.effort_error }));
            return;
          }
          setOpen(false);
        } else {
          // Fecha antes da resposta: a troca pode abrir uma confirmação na conversa, que a folha taparia.
          closedEarly = true;
          setOpen(false);
          const res = await setModelEffort(name, { model: id, scope: 'session' });
          if (res?.pending_confirm) return;
          const label = cat.kind === 'claude' ? cat.names.get(id) : undefined;
          onChosen({
            ...chosen,
            model: id === 'default' ? null : label?.replace(/\s*\(1M context\)/i, '·1M').trim() || id.charAt(0).toUpperCase() + id.slice(1),
          });
        }
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = e instanceof Error ? e.message : String(e);
        if (status === 409 || closedEarly) {
          setOpen(false);
          flash(msg || m.composer_sessao_trabalhando());
        } else {
          setNotice(msg);
        }
      }
    },
    [name, isCodex, isPi, isKimi, chosen, onChosen, statusFields?.effort, flash],
  );

  return (
    <>
      <RowPill label={m.composer_modelo()} value={display} onPress={() => setOpen(true)} shrink={3} />
      <PillMenu
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        loading={loading}
        error={error}
        notice={notice}
        onRetry={() => void load()}
        onSelect={handleSelect}
        title={m.composer_modelo()}
      />
    </>
  );
}
