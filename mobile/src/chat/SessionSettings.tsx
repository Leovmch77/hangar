import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { parseStatusLine } from '@hangar/core';
import { chatStore } from '../stores/chat';
import { ModelPill } from '../features/pills/ModelPill';
import { EffortPill } from '../features/pills/EffortPill';
import { PermissionPill } from '../features/pills/PermissionPill';
import { CodexPermissionPill } from '../features/pills/CodexPermissionPill';
import { reconcileChosen, type Chosen } from '../features/pills/pills';

interface Props {
  serverId: string;
  name: string;
  provider: string | null;
  headless: boolean;
  // `/model` e `/effort` abrem o seletor certo: cada pedido novo leva um número maior.
  openRequest?: { which: 'model' | 'effort'; n: number } | null;
  // Some da vista sem desmontar: com o Orientar na linha elas viravam "B…", e montadas o
  // `/model` digitado ainda abre o seletor.
  hidden?: boolean;
}

// Controles da sessão direto na linha do composer, como no PWA: modo (Claude e Codex), modelo,
// nível e, no Codex, permissão. Antes moravam numa folha de ajustes, a dois toques.
export function SessionSettingsButton({ serverId, name, provider, headless, openRequest, hidden }: Props) {
  const chat = chatStore(serverId, name);
  const statusLine = chat.use((s) => s.statusLine);
  const statusModel = useMemo(() => parseStatusLine(statusLine), [statusLine]);
  const [chosen, setChosen] = useState<Chosen>({});
  // Solta o modelo otimista quando a statusline confirma: troca feita no terminal volta a aparecer.
  useEffect(() => {
    setChosen((cur) => {
      const next = reconcileChosen(statusModel, cur);
      return next.model === cur.model ? cur : next;
    });
  }, [statusModel]);

  const isCodex = provider === 'codex';
  const isClaude = !provider || provider === 'claude';

  return (
    <View style={[styles.cluster, hidden && styles.hidden]} pointerEvents={hidden ? 'none' : 'auto'}
          accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}>
      {isClaude || isCodex ? <PermissionPill serverId={serverId} name={name} provider={isCodex ? 'codex' : 'claude'} /> : null}
      <ModelPill serverId={serverId} name={name} provider={provider} chosen={chosen} onChosen={setChosen}
                 openSignal={openRequest?.which === 'model' ? openRequest.n : 0} />
      <EffortPill serverId={serverId} name={name} provider={provider} chosen={chosen} onChosen={setChosen}
                  openSignal={openRequest?.which === 'effort' ? openRequest.n : 0} />
      {isCodex ? <CodexPermissionPill name={name} headless={headless} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Ocupa a sobra da linha e encosta à direita; quem não cabe encolhe com reticências.
  hidden: { opacity: 0 },
  cluster: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.base.space[1],
    overflow: 'hidden',
  },
}));
