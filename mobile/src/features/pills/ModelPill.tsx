import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseStatusLine, getModelOptions, getPiModels, getKimiModels, getCodexModels, setModelEffort, setPiModel, setKimiModel, setCodexModel } from '@hangar/core';
import { chatStore } from '../../stores/chat';
import { useSessions } from '../../stores/sessions';
import * as m from '../../paraglide/messages';
import { PillMenu, type PillMenuItem } from './PillMenu';
import { pillLabels, reconcileChosen } from './pills';
import { SettingRow } from './SettingRow';

interface Props {
  serverId: string;
  name: string;
}

// Linha "Modelo" da folha de ajustes do composer; o anel de contexto mora no botão que abre a folha.
export function ModelPill({ serverId, name }: Props) {
  const chat = chatStore(serverId, name);
  const statusLine = chat.use((s) => s.statusLine);
  const statusFields = useMemo(() => parseStatusLine(statusLine), [statusLine]);
  const provider = useSessions((s) => {
    const r = s.rows.find((x) => x.name === name);
    // multi-server: tenta também por serverId quando houver
    const byServer = s.byServerRecord?.[serverId];
    if (byServer) {
      const hit = byServer.find((x) => x.name === name);
      if (hit?.provider) return hit.provider;
    }
    return (r?.provider ?? null) as string | null;
  });

  const isCodex = provider === 'codex';
  const isPi = provider === 'pi';
  const isKimi = provider === 'kimi';

  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [tempError, setTempError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PillMenuItem[]>([]);

  const display = useMemo(() => {
    if (tempError) return tempError;
    return pillLabels(statusFields, { model: chosenModel }).model ?? '—';
  }, [statusFields, chosenModel, tempError]);

  // reconcilia quando statusline confirma
  useEffect(() => {
    const rec = reconcileChosen(statusFields, { model: chosenModel });
    if (rec.model !== chosenModel) setChosenModel(rec.model ?? null);
  }, [statusFields?.model]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isCodex) {
        const res = await getCodexModels(name);
        setItems(
          res.models.map((mo) => ({
            label: mo.displayName ?? mo.model,
            hint: mo.description ?? undefined,
            selected: (mo.model === (chosenModel ?? statusFields?.model)),
            // guarda id no label? usamos label como chave mas precisamos do id real no select
            // truque: hint guarda description, então usamos um mapa separado — mas pra manter simples,
            // o label do Codex é único o suficiente; o id real é mapeado na hora do select via lookup
          })),
        );
        // guarda models crus para lookup no select: re-busca no select em vez de guardar
      } else if (isPi) {
        const res = await getPiModels(name);
        setItems(
          res.models.map((mo) => ({
            label: mo.name ?? mo.id,
            hint: `${mo.provider}/${mo.id}`,
            selected: (mo.name ?? mo.id) === (chosenModel ?? statusFields?.model),
          })),
        );
      } else if (isKimi) {
        const res = await getKimiModels(name);
        setItems(
          res.models.map((mo) => ({
            label: mo.name,
            hint: mo.alias,
            selected: mo.name === (chosenModel ?? statusFields?.model),
          })),
        );
      } else {
        const res = await getModelOptions(name);
        setItems(
          res.models.map((mo) => ({
            label: mo.name ?? mo.id,
            hint: mo.desc ?? undefined,
            selected: mo.id === chosenModel,
          })),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [name, isCodex, isPi, isKimi, chosenModel, statusFields?.model]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleSelect = useCallback(
    async (it: PillMenuItem) => {
      try {
        if (isCodex) {
          // precisa mapear label -> model id
          const res = await getCodexModels(name);
          const hit = res.models.find((mo) => (mo.displayName ?? mo.model) === it.label) ?? res.models[0];
          const target = hit?.model ?? it.label;
          await setCodexModel(name, target);
          setChosenModel(target);
          setOpen(false);
        } else if (isPi) {
          // hint é provider/id
          const alias = it.hint ?? it.label;
          const slash = alias.indexOf('/');
          const prov = slash >= 0 ? alias.slice(0, slash) : undefined;
          const modelId = slash >= 0 ? alias.slice(slash + 1) : alias;
          const res = await setPiModel(name, { provider: prov, model: modelId });
          const newModel = res.current?.name ?? res.current?.id ?? modelId;
          setChosenModel(newModel);
          setOpen(false);
        } else if (isKimi) {
          const alias = it.hint ?? it.label;
          const res = await setKimiModel(name, { model: alias });
          if (res.current?.name) setChosenModel(res.current.name);
          else setChosenModel(it.label);
          setOpen(false);
        } else {
          // Claude: it.label maps to model id via lookup — busca de novo
          const resList = await getModelOptions(name);
          const hit = resList.models.find((mo) => (mo.name ?? mo.id) === it.label);
          const targetId = hit?.id ?? it.label;
          const res = await setModelEffort(name, { model: targetId, scope: 'session' });
          if (res?.pending_confirm) {
            setOpen(false);
            return;
          }
          if (targetId === 'default') setChosenModel(null);
          else setChosenModel(targetId.charAt(0).toUpperCase() + targetId.slice(1));
          setOpen(false);
        }
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = e instanceof Error ? e.message : String(e);
        if (status === 409) {
          setTempError(msg || m.composer_sessao_trabalhando());
          setOpen(false);
          setTimeout(() => setTempError(null), 8000);
        } else {
          setError(msg);
        }
      }
    },
    [name, isCodex, isPi, isKimi],
  );

  return (
    <>
      <SettingRow label={m.composer_modelo()} value={display} onPress={() => setOpen(true)} />
      <PillMenu
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        loading={loading}
        error={error}
        onRetry={() => void load()}
        onSelect={handleSelect}
        title={m.composer_modelo()}
      />
    </>
  );
}
