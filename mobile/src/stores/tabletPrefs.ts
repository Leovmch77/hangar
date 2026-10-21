import { create } from 'zustand';
import { prefs } from './prefs';

export type SessionsBarPlacement = 'left' | 'bottom' | 'top';

type TabletPrefs = {
  placement: SessionsBarPlacement;
  collapsed: boolean;
  panelOpen: boolean;
  setPlacement: (placement: SessionsBarPlacement) => void;
  toggleCollapsed: () => void;
  togglePanel: () => void;
};

const PLACEMENTS: SessionsBarPlacement[] = ['left', 'bottom', 'top'];
const PLACEMENT_KEY = 'tablet.sessionsBar';
const COLLAPSED_KEY = 'tablet.sessionsBarCollapsed';
const PANEL_KEY = 'tablet.panelOpen';

function readPlacement(): SessionsBarPlacement {
  const value = prefs.getString(PLACEMENT_KEY) as SessionsBarPlacement | undefined;
  return value && PLACEMENTS.includes(value) ? value : 'bottom';
}

export const useTabletPrefs = create<TabletPrefs>((set, get) => {
  if (prefs.getString(PLACEMENT_KEY) === 'rail') {
    prefs.set(PLACEMENT_KEY, 'left');
    prefs.set(COLLAPSED_KEY, true);
  }
  return {
    placement: readPlacement(),
    collapsed: prefs.getBoolean(COLLAPSED_KEY) ?? false,
    panelOpen: prefs.getBoolean(PANEL_KEY) ?? true,
    setPlacement(placement) {
      prefs.set(PLACEMENT_KEY, placement);
      set({ placement });
    },
    toggleCollapsed() {
      const collapsed = !get().collapsed;
      prefs.set(COLLAPSED_KEY, collapsed);
      set({ collapsed });
    },
    togglePanel() {
      const panelOpen = !get().panelOpen;
      prefs.set(PANEL_KEY, panelOpen);
      set({ panelOpen });
    },
  };
});
