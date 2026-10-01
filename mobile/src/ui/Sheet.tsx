import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { TrueSheet, type SheetDetent } from '@lodev09/react-native-true-sheet';
import { useUnistyles } from 'react-native-unistyles';
import { alphaDoVidro, useReduceTransparency } from './Glass';
import { toast } from './Toast';
import * as m from '../paraglide/messages';

export type SheetRef = TrueSheet;
type Size = 'auto' | 'medium' | 'large';
// A API do true-sheet 3.11 é `detents: SheetDetent[]` ('auto' | 'peek' | fração 0..1).
const DETENT: Record<Size, SheetDetent> = { auto: 'auto', medium: 0.5, large: 0.92 };

type Props = {
  sizes?: Size[];
  children: ReactNode;
  open?: boolean;
  onDismiss?: () => void;
  onDidPresent?: () => void;
  scrollable?: boolean;
};

// true-sheet exige New Arch (ligada: app.json newArchEnabled). Teto de 3 detents: Android trunca em 3.
// Fundo do vidro: a sheet é navegação, então leva o modalAlpha; conteúdo dentro dela usa surfaceAlpha.
// No Android a true-sheet não desfoca (`backgroundBlur` é só do iOS): sem desfoque, a folha
// translúcida deixa o texto da conversa vazar por trás do dela — mesmo a 97%, folha sobre folha
// mostrava o texto de baixo. Lá ela é opaca.
const alphaFolha = (theme: Parameters<typeof alphaDoVidro>[0]) =>
  Platform.OS === 'android' ? 1 : alphaDoVidro(theme, 'modal');

export const Sheet = forwardRef<TrueSheet, Props>(function Sheet({ sizes = ['auto'], open, children, onDismiss, onDidPresent, scrollable }, ref) {
  const { theme, rt } = useUnistyles();
  const reduzir = useReduceTransparency();
  const innerRef = useRef<TrueSheet>(null);
  // present()/dismiss() nativos rejeitam se a view nunca montou (lazy no 1º present); rastreia pra não
  // chamar dismiss() antes de qualquer present(), e pra saber quando reapresentar após swipe-to-close.
  const apresentada = useRef(false);

  useImperativeHandle(ref, () => innerRef.current as TrueSheet);

  useEffect(() => {
    if (open === undefined) return; // sem a prop, controle é só imperativo (ref.current.present()/.dismiss())
    if (open) {
      innerRef.current
        ?.present()
        .then(() => { apresentada.current = true; })
        .catch((e: unknown) => {
          console.error('Sheet: present() falhou', e);
          toast.erro(m.erro_desconhecido());
        });
    } else if (apresentada.current) {
      innerRef.current?.dismiss().catch((e: unknown) => console.error('Sheet: dismiss() falhou', e));
    }
  }, [open]);

  const [r, g, b] = theme.tokens.glass.panelRgb;
  return (
    <TrueSheet
      ref={innerRef}
      detents={sizes.slice(0, 3).map((s) => DETENT[s])}
      cornerRadius={theme.base.radius.xl}
      backgroundBlur={reduzir ? undefined : rt.themeName === 'dark' ? 'dark' : 'light'}
      backgroundColor={reduzir ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alphaFolha(theme)})`}
      grabber
      // A alça sobe e ganha uma faixa própria: no padrão (16 dp do topo) ela caía em cima do título
      // de toda folha, que começa logo ali.
      grabberOptions={{ topMargin: 8, color: theme.tokens.text.muted }}
      header={<View style={{ height: 16 }} />}
      scrollable={scrollable}
      onDidPresent={onDidPresent}
      onDidDismiss={() => {
        apresentada.current = false;
        onDismiss?.();
      }}
    >
      {children}
    </TrueSheet>
  );
});
