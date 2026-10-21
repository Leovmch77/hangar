import { create } from 'zustand';
import { prefs } from './prefs';

export type SessionsBarPlacement = 'left' | 'rail' | 'bottom' | 'top';

type TabletPrefs = {
  placement: SessionsBarPlacement;
  panelOpen: boolean;
  setPlacement: (placement: SessionsBarPlacement) => void;
  togglePanel: () => void;
};

const PLACEMENTS: SessionsBarPlacement[] = ['left', 'rail', 'bottom', 'top'];
const PLACEMENT_KEY = 'tablet.sessionsBar';
const PANEL_KEY = 'tablet.panelOpen';

function readPlacement(): SessionsBarPlacement {
  const value = prefs.getString(PLACEMENT_KEY) as SessionsBarPlacement | undefined;
  return value && PLACEMENTS.includes(value) ? value : 'bottom';
}

export const useTabletPrefs = create<TabletPrefs>((set, get) => ({
  placement: readPlacement(),
  panelOpen: prefs.getBoolean(PANEL_KEY) ?? true,
  setPlacement(placement) {
    prefs.set(PLACEMENT_KEY, placement);
    set({ placement });
  },
  togglePanel() {
    const panelOpen = !get().panelOpen;
    prefs.set(PANEL_KEY, panelOpen);
    set({ panelOpen });
  },
}));
