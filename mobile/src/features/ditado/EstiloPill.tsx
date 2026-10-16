import { useEffect, useState } from 'react';
import { estilosDitado } from '@hangar/core';
import type { Server } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { dictationStyleStore } from './ditadoEstiloStore';
import { PillMenu } from '../pills/PillMenu';
import { useDictationOrganization } from './dictationOrganization';

// Rótulo do estilo vigente: é o que a pessoa precisa ler antes de falar.
export function useDictationStyleLabel(server?: Server | null): string {
  const useStyleStore = dictationStyleStore(server);
  const valor = useStyleStore((s) => s.valor);
  const pronto = useStyleStore((s) => s.pronto);
  const falhou = useStyleStore((s) => s.falhou);
  const organization = useDictationOrganization(server);
  useEffect(() => {
    void useStyleStore.getState().carregar();
  }, [useStyleStore]);
  if (organization === 'off') return m.ditado_organizacao_desligada_rotulo();
  if (falhou) return m.dictation_style_unavailable();
  if (!pronto) return m.comum_carregando();
  return estilosDitado().find((e) => e.valor === valor)?.rotulo ?? m.ditado_estilo_prosa();
}

// Seletor do estilo do ditado sem gatilho próprio: no composer ele abre pelo toque longo no microfone.
// Com a organização desligada no servidor, mostra só o aviso: todo estilo voltaria cru.
export function DictationStyleMenu({ open, onClose, server }: { open: boolean; onClose: () => void; server?: Server | null }) {
  const organization = useDictationOrganization(server, open);
  const useStyleStore = dictationStyleStore(server);
  const valor = useStyleStore((s) => s.valor);
  const pronto = useStyleStore((s) => s.pronto);
  const falhou = useStyleStore((s) => s.falhou);
  const revalidar = useStyleStore((s) => s.revalidar);
  const trocar = useStyleStore((s) => s.trocar);

  const [erro, setErro] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState<string | null>(null);

  // Revalida a cada abertura: a lista não pode exibir um valor trocado noutro aparelho.
  useEffect(() => {
    if (!open) return;
    setErro(null);
    setAplicando(null);
    void revalidar();
  }, [open, revalidar]);

  const off = organization === 'off';
  const lista = off ? [] : estilosDitado();
  const items = lista.map((e) => ({
    label: e.rotulo,
    hint: e.hint,
    selected: e.valor === valor,
  }));

  const handleSelect = async (item: { label: string }) => {
    const hit = lista.find((e) => e.rotulo === item.label);
    if (!hit || aplicando) return;
    setAplicando(hit.valor);
    setErro(null);
    try {
      await trocar(hit.valor);
      onClose();
    } catch (e) {
      setErro(e instanceof Error ? e.message : m.erro_desconhecido());
    } finally {
      setAplicando(null);
    }
  };

  return (
    <PillMenu
      open={open}
      onClose={onClose}
      items={items.map((it) => ({
        ...it,
        label: it.label + (aplicando && lista.find((x) => x.valor === aplicando)?.rotulo === it.label ? ' …' : ''),
      }))}
      onSelect={handleSelect}
      loading={!off && !pronto && !falhou}
      error={erro ?? (!off && falhou ? m.dictation_style_load_failed() : null)}
      onRetry={() => { setErro(null); void revalidar(); }}
      title={m.ditado_estilo_titulo()}
      emptyText={off ? m.ditado_organizacao_desligada() : undefined}
    />
  );
}
