import { useRouter } from 'expo-router';
import { Sheet } from '../ui/Sheet';
import { UsagePanel } from './UsagePanel';

interface Props {
  open: boolean;
  onClose: () => void;
  serverId: string;
  name: string;
}

export function UsageSheet({ open, onClose, serverId, name }: Props) {
  const router = useRouter();
  return (
    <Sheet open={open} onDismiss={onClose} sizes={['medium', 'large']} scrollable>
      <UsagePanel serverId={serverId} name={name} onOpenLimits={() => {
        onClose();
        router.push(`/s/${serverId}/${name}/codex-limits` as never);
      }} />
    </Sheet>
  );
}
