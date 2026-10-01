import { useEffect, useState } from 'react';
import { estilosDitado } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { useDitadoEstiloStore } from './ditadoEstiloStore';
import { PillMenu } from '../pills/PillMenu';

// Rótulo do estilo vigente: é o que a pessoa precisa ler antes de falar.
export function useDictationStyleLabel(): string {
  const valor = useDitadoEstiloStore((s) => s.valor);
  // carrega na montagem
  useEffect(() => {
    void useDitadoEstiloStore.getState().carregar();
  }, []);
  return estilosDitado().find((e) => e.valor === valor)?.rotulo ?? m.ditado_estilo_prosa();
}

// Seletor do estilo do ditado sem gatilho próprio: no composer ele abre pelo toque longo no microfone.
export function DictationStyleMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const valor = useDitadoEstiloStore((s) => s.valor);
  const revalidar = useDitadoEstiloStore((s) => s.revalidar);
  const trocar = useDitadoEstiloStore((s) => s.trocar);

  const [erro, setErro] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState<string | null>(null);

  // Revalida a cada abertura: a lista não pode exibir um valor trocado noutro aparelho.
  useEffect(() => {
    if (!open) return;
    setErro(null);
    setAplicando(null);
    void revalidar();
  }, [open, revalidar]);

  const lista = estilosDitado();
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
      setErro(e instanceof Error ? e.message : 'falha');
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
      error={erro}
      title={m.ditado_estilo_titulo()}
    />
  );
}
