import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseStatusLine, getPiModels, getKimiModels, getCodexModels, setModelEffort, setPiModel, setKimiModel, setCodexModel } from '@hangar/core';
import { chatStore } from '../../stores/chat';
import * as m from '../../paraglide/messages';
import { PillMenu, type PillMenuItem } from './PillMenu';
import { pillLabels, semEsforco, type Chosen } from './pills';
import { RowPill } from './RowPill';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

interface Props {
  serverId: string;
  name: string;
  provider: string | null;
  chosen: Chosen;
  onChosen: (next: Chosen) => void;
  openSignal?: number;
}

export function EffortPill({ serverId, name, provider, chosen, onChosen, openSignal = 0 }: Props) {
  const chat = chatStore(serverId, name);
  const statusLine = chat.use((s) => s.statusLine);
  const statusFields = useMemo(() => parseStatusLine(statusLine), [statusLine]);

  const isCodex = provider === 'codex';
  const isPi = provider === 'pi' || provider === 'omp';
  const isKimi = provider === 'kimi';
  const isClaude = !isCodex && !isPi && !isKimi;

  const [tempError, setTempError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<PillMenuItem[]>([]);
  // Modelo do Codex a que os níveis pertencem: o POST exige o modelo junto.
  const codexModel = useRef<string | null>(null);

  const labels = pillLabels(statusFields, chosen);
  // Haiku não usa esforço (o picker responde "Effort not supported"): pílula ausente, não inútil.
  const hidden = isClaude && semEsforco(labels.model);

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    const current = labels.effort;
    const mark = (lv: string) => ({ label: lv, selected: lv === current });
    try {
      if (isPi) {
        const res = await getPiModels(name);
        setItems((res.levels ?? []).map(mark));
      } else if (isKimi) {
        const res = await getKimiModels(name);
        const curName = (labels.model ?? '').toLowerCase();
        const entry = res.models.find((mo) => mo.name.toLowerCase() === curName);
        setItems((entry?.efforts ?? []).map(mark));
      } else if (isCodex) {
        // Os níveis são do modelo ATUAL; sem modelo conhecido não há o que oferecer (cair no primeiro
        // do catálogo trocaria o modelo calado).
        const res = await getCodexModels(name);
        codexModel.current = res.current.model ?? null;
        const line = res.models.find((mo) => mo.model === codexModel.current);
        const active = chosen.effort ?? res.current.effort ?? line?.defaultEffort ?? null;
        setItems((line?.efforts ?? []).map((e) => ({ label: e.value, hint: e.description ?? undefined, selected: e.value === active })));
      } else {
        setItems(CLAUDE_EFFORTS.map(mark));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [name, isPi, isKimi, isCodex, labels.effort, labels.model, chosen.effort]);

  useEffect(() => {
    if (open && !hidden) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSelect = useCallback(
    async (it: PillMenuItem) => {
      try {
        if (isPi) {
          const res = await setPiModel(name, { effort: it.label });
          // Pi ajusta ao que o modelo suporta: pinta o que voltou.
          onChosen({ ...chosen, effort: res.thinking ?? it.label });
        } else if (isKimi) {
          const res = await setKimiModel(name, { effort: it.label });
          onChosen({ ...chosen, effort: res.effort ?? it.label });
        } else if (isCodex) {
          if (!codexModel.current) return;
          await setCodexModel(name, codexModel.current, it.label);
          onChosen({ ...chosen, effort: it.label });
        } else {
          const res = await setModelEffort(name, { effort: it.label, scope: 'session' });
          // Confirmação aberta no terminal: o nível só vale se a pessoa aceitar lá.
          if (!res?.pending_confirm) onChosen({ ...chosen, effort: it.label });
        }
        setOpen(false);
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = e instanceof Error ? e.message : String(e);
        if (status === 409) {
          setOpen(false);
          setTempError(msg || m.composer_sessao_trabalhando());
          setTimeout(() => setTempError(null), 8000);
        } else {
          setNotice(msg);
        }
      }
    },
    [name, isPi, isKimi, isCodex, chosen, onChosen],
  );

  if (hidden) return null;

  return (
    <>
      <RowPill label={m.composer_esforco_raciocinio()} value={tempError ?? labels.effort ?? m.composer_nivel()} onPress={() => setOpen(true)} />
      <PillMenu
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        loading={loading}
        error={error}
        notice={notice}
        emptyText={m.modelo_sem_niveis()}
        onRetry={() => void load()}
        onSelect={handleSelect}
        title={m.composer_nivel()}
      />
    </>
  );
}
