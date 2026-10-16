import { create } from 'zustand';
import { prefs } from './prefs';
import { toast } from '../ui/Toast';
import * as m from '../paraglide/messages';

const KEY = 'mods.visible';

export const useMods = create<{ visible: boolean; setVisible: (value: boolean) => void }>(set => ({
  visible: prefs.getString(KEY) === '1',
  setVisible(value) {
    set({ visible: value });
    try { prefs.set(KEY, value ? '1' : '0'); }
    catch { toast.erro(m.mods_celular_guardar_falhou()); }
  },
}));
