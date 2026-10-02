import { useCallback, useEffect, useState } from 'react';
import { getCodexPermissions, setCodexPermission } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { PillMenu, type PillMenuItem } from './PillMenu';
import { RowPill } from './RowPill';

interface Props {
  name: string;
  headless: boolean;
}

// Nome e descrição vêm do picker vivo do Codex, em inglês: são dado do agente, não interface.
// Só o rótulo curto da pílula é traduzido, para caber na linha.
function shortLabel(mode: string | null): string {
  if (mode === 'Ask for approval') return m.permissao_codex_curta_perguntar();
  if (mode === 'Approve for me') return m.permissao_codex_curta_auto();
  if (mode === 'Full Access') return m.permissao_codex_curta_total();
  return mode ?? m.composer_permissao();
}

export function CodexPermissionPill({ name, headless }: Props) {
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<PillMenuItem[]>([]);

  // Sem terminal o modo está no sidecar e pode ser lido a qualquer hora. Com terminal, ler
  // dirigiria o `/permissions` no pane: só com a pílula aberta.
  useEffect(() => {
    setCurrent(null);
    if (!headless) return;
    let alive = true;
    getCodexPermissions(name).then((res) => { if (alive) setCurrent(res.current); }).catch(() => {});
    return () => { alive = false; };
  }, [name, headless]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await getCodexPermissions(name);
      setCurrent(res.current);
      setItems(res.modes.map((mo) => ({ id: mo.nome, label: mo.nome, hint: mo.desc, selected: mo.nome === res.current })));
    } catch (e) {
      setError(e instanceof Error ? e.message : m.comum_falha_aplicar());
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleSelect = async (it: PillMenuItem) => {
    const mode = it.id ?? it.label;
    if (applying) return;
    if (mode === current) { setOpen(false); return; }
    setApplying(true);
    setNotice(null);
    try {
      const res = await setCodexPermission(name, mode);
      setCurrent(res.current);
      setOpen(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : m.comum_falha_aplicar());
      // A troca pode ter chegado e falhado na volta: relê o que ficou valendo.
      getCodexPermissions(name).then((res) => setCurrent(res.current)).catch(() => {});
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <RowPill label={m.composer_permissao()} value={shortLabel(current)} onPress={() => setOpen(true)} />
      <PillMenu
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        loading={loading || applying}
        error={error}
        notice={notice}
        emptyText={headless ? m.permissao_codex_headless_sem_lista() : m.permissao_codex_sem_lista()}
        onRetry={() => void load()}
        onSelect={(it) => void handleSelect(it)}
        title={m.composer_permissao()}
      />
    </>
  );
}
