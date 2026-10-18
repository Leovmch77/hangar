import { useContext, useEffect } from 'react';
import { useIsFocused } from 'expo-router';
import { useServers } from '../../stores/servers';
import { WorkingMarkPaused } from '../../ui/WorkingMark';
import { LiveVoiceButton } from './LiveVoiceButton';
import { useLiveVoice } from './liveVoiceStore';

export function LiveVoiceChatButton({ serverId, name = '' }: { serverId: string; name?: string }) {
  const server = useServers(state => state.servers.find(item => item.id === serverId));
  // Campos soltos: a vista inteira muda a cada nível de áudio (10 por segundo).
  const phase = useLiveVoice(state => state.view.phase);
  const muted = useLiveVoice(state => state.view.muted);
  const failed = useLiveVoice(state => !!state.view.error);
  const entry = useLiveVoice(state => state.settingsByServer[serverId]);
  const paused = useContext(WorkingMarkPaused);
  // Tela empilhada por cima mantém a conversa montada: as barras param com ela escondida.
  const focused = useIsFocused();
  const eligible = !!server && !server.invite && !server.inviteEnded && !server.removed;
  const hasCall = phase === 'connecting' || phase === 'live' || failed;
  const settings = entry && server && entry.server.token === server.token && entry.server.baseUrl === server.baseUrl ? entry.view : null;

  useEffect(() => {
    if (!eligible) return;
    // A captura é desta conversa, não da máquina que ficou selecionada na lista.
    const current = useServers.getState().servers.find(item => item.id === serverId);
    if (current) void useLiveVoice.getState().loadSettings(current);
  }, [serverId, server?.token, server?.baseUrl, eligible]);

  return <WorkingMarkPaused.Provider value={paused || !focused}>
    <LiveVoiceButton phase={hasCall ? phase : 'idle'} muted={hasCall && muted} error={failed || !!settings?.error}
      visible={hasCall || eligible && (!settings?.reply || settings.reply.codex || !!settings.error)}
      onPress={() => useLiveVoice.getState().openFor(serverId, name)} />
  </WorkingMarkPaused.Provider>;
}
