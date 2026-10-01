import { Box, ConfigRow, ServerConfigPage } from '../../src/features/config/ServerConfigParts';
import { useServerConfig } from '../../src/features/config/serverConfig';
import * as m from '../../src/paraglide/messages';

export default function Attachments() {
  const cfg = useServerConfig();
  return (
    <ServerConfigPage title={m.native_settings_page_attachments()} cfg={cfg}>
      <Box><ConfigRow cfg={cfg} k="upload_retention_days" /></Box>
    </ServerConfigPage>
  );
}
