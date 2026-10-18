import { useMemo } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { OrchestrationTeam } from '../../../../src/features/orchestration/OrchestrationTeam';
import { useGlassHeader } from '../../../../src/ui/glassHeader';
import * as m from '../../../../src/paraglide/messages';

export default function OrchestrationTeamRoute() {
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = Array.isArray(params.server) ? params.server[0] : (params.server ?? '');
  const name = Array.isArray(params.name) ? params.name[0] : (params.name ?? '');
  const header = useGlassHeader();
  const title = m.orqcfg_aba_papeis();
  const headerOptions = useMemo(() => ({ ...header, title }), [header, title]);
  return <>
    <Stack.Screen options={headerOptions} />
    <OrchestrationTeam serverId={serverId} name={name} />
  </>;
}
