import { useCallback, useEffect, useRef, useState } from 'react';
import { getCodexModels, getPermissionModes, setCodexMode, setPermissionMode } from '@hangar/core';
import { chatStore } from '../../stores/chat';
import * as m from '../../paraglide/messages';
import { PillMenu, type PillMenuItem } from './PillMenu';
import { RowPill } from './RowPill';
import { permissionDescription, permissionLabel, permissionShortLabel } from './permissionLabel';

const CLAUDE_MODES = ['plan', 'auto', 'manual', 'acceptEdits', 'bypassPermissions', 'dontAsk'];

interface Props {
  serverId: string;
  name: string;
  provider: 'claude' | 'codex';
}

// Modo da sessão na linha do composer, como o seletor do PWA: no Claude é o modo de permissão
// (ciclo lido da própria sessão), no Codex é Normal/Planejar. O valor segue o SSE.
export function PermissionPill({ serverId, name, provider }: Props) {
  const chat = chatStore(serverId, name);
  const isCodex = provider === 'codex';
  const sseClaude = chat.use((s) => s.stateEvent?.claude_permission_mode ?? null);
  const sseCodex = chat.use((s) => s.stateEvent?.codex_mode ?? null);
  const sessionState = chat.use((s) => s.stateEvent?.state ?? null);

  const [current, setCurrent] = useState<string | null>(null);
  const [modes, setModes] = useState<string[]>([]);
  const [probeable, setProbeable] = useState(true);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Toda leitura leva um número: resposta velha (ou anterior a uma troca pelo SSE) não pisa na nova.
  const seq = useRef(0);
  // O backend disse "só vale para Claude" (sessão Pi/Kimi que chegou como claude): não insistir.
  const refused = useRef(false);

  useEffect(() => {
    if (isCodex || !sseClaude) return;
    seq.current++;
    setCurrent(sseClaude);
  }, [isCodex, sseClaude]);

  useEffect(() => {
    if (isCodex && sseCodex) setCurrent(sseCodex);
  }, [isCodex, sseCodex]);

  // Claude: lê o modo atual sem teclas a cada mudança de estado; o ciclo só com a pílula aberta.
  useEffect(() => {
    if (isCodex || refused.current) return;
    const my = ++seq.current;
    getPermissionModes(name, false)
      .then((res) => {
        if (my !== seq.current) return;
        setCurrent(res.current);
        if (res.modes.length) setModes(res.modes);
        setProbeable(res.sondavel);
      })
      .catch((e: unknown) => {
        if ((e as { code?: string })?.code === 'erro_permissao_so_claude') refused.current = true;
      });
  }, [isCodex, name, sessionState]);

  useEffect(() => {
    if (!isCodex) return;
    let alive = true;
    getCodexModels(name)
      .then((res) => { if (alive && res.current.mode) setCurrent(res.current.mode); })
      .catch(() => { /* sem catálogo a pílula fica no rótulo genérico */ });
    return () => { alive = false; };
  }, [isCodex, name]);

  // A sonda percorre o ciclo com Shift+Tab e volta; sem ela o servidor devolve [] até ter cache.
  const probe = useCallback(async () => {
    if (isCodex || !probeable || modes.length > 0) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const res = await getPermissionModes(name, true);
      if (my !== seq.current) return;
      setCurrent(res.current);
      setModes(res.modes);
      setProbeable(res.sondavel);
      if (res.restaurado === false) setNotice(m.native_mode_probe_not_restored());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [isCodex, probeable, modes.length, name]);

  const show = () => {
    setNotice(!isCodex && !probeable && modes.length === 0 ? m.permissao_sem_ciclo() : null);
    setOpen(true);
    void probe();
  };

  const available = new Set(isCodex ? ['default', 'plan'] : modes);
  const items: PillMenuItem[] = isCodex
    ? [
      { id: 'default', label: m.chat_mode_normal(), selected: current === 'default' },
      { id: 'plan', label: m.chat_mode_plan(), selected: current === 'plan' },
    ]
    : CLAUDE_MODES.map((mode) => ({
      id: mode,
      label: permissionLabel(mode),
      hint: permissionDescription(mode),
      selected: mode === current,
      unavailable: available.has(mode) ? undefined : m.native_mode_not_in_cycle(),
    }));

  const handleSelect = async (it: PillMenuItem) => {
    const mode = it.id ?? it.label;
    if (applying) return;
    if (mode === current) { setOpen(false); return; }
    setApplying(true);
    setNotice(null);
    try {
      if (isCodex) {
        const res = await setCodexMode(name, mode as 'default' | 'plan');
        setCurrent(res.mode ?? mode);
      } else {
        seq.current++;
        const res = await setPermissionMode(name, mode);
        // O backend devolve o que FICOU, que pode não ser o pedido.
        setCurrent(res.mode ?? res.current ?? mode);
      }
      setOpen(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      if (!isCodex) {
        // Mostrar o modo antigo depois de uma troca que pode ter pegado afirma uma permissão falsa.
        getPermissionModes(name).then((res) => {
          setCurrent(res.current);
          if (res.modes.length) setModes(res.modes);
        }).catch(() => {});
      }
    } finally {
      setApplying(false);
    }
  };

  const value = !current ? m.chat_mode_label()
    : current === 'plan' ? (isCodex ? m.chat_mode_plan() : permissionShortLabel('plan'))
      : isCodex ? m.chat_mode_normal() : permissionShortLabel(current);

  return (
    <>
      <RowPill label={m.chat_mode_label()} value={value} onPress={show} accent={current === 'plan'} />
      <PillMenu
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        loading={loading || applying}
        notice={notice}
        onSelect={(it) => void handleSelect(it)}
        title={m.chat_mode_label()}
      />
    </>
  );
}
