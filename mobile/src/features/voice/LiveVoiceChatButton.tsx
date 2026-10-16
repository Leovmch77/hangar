import { useEffect } from 'react';
import { useServers } from '../../stores/servers';
import { LiveVoiceButton } from './LiveVoiceButton';
import { useLiveVoice } from './liveVoiceStore';

export function LiveVoiceChatButton({ serverId, name }: { serverId: string; name: string }) {
  const server = useServers(state => state.servers.find(item => item.id === serverId));
  const view = useLiveVoice(state => state.view);
  const entry = useLiveVoice(state => state.settingsByServer[serverId]);
  const eligible = !!server && !server.invite && !server.inviteEnded && !server.removed;
  const hasCall = view.phase === 'connecting' || view.phase === 'live' || !!view.error;
  const settings = entry && server && entry.server.token === server.token && entry.server.baseUrl === server.baseUrl ? entry.view : null;

  useEffect(() => {
    if (!eligible) return;
    // A captura é desta conversa, não da máquina que ficou selecionada na lista.
    const current = useServers.getState().servers.find(item => item.id === serverId);
    if (current) void useLiveVoice.getState().loadSettings(current);
  }, [serverId, server?.token, server?.baseUrl, eligible]);

  return <LiveVoiceButton phase={hasCall ? view.phase : 'idle'} muted={hasCall && view.muted}
    levels={hasCall ? view.levels : { input: 0, output: 0 }} error={!!view.error || !!settings?.error}
    visible={hasCall || eligible && (!settings?.reply || settings.reply.codex || !!settings.error)}
    onPress={() => useLiveVoice.getState().openFor(serverId, name)} />;
}
