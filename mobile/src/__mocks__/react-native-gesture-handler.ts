import React from 'react';
import { Pressable } from './react-native';

// No vitest o Pressable do gesture-handler é o mesmo botão do mock do react-native: o teste olha
// rótulo e toque, não a disputa de gestos nativa.
export { Pressable };
// Props que só valem na disputa nativa ficam fora do DOM.
export const BaseButton = ({ shouldActivateOnStart: _start, disallowInterruption: _block, accessible: _accessible, ...props }: any) =>
  React.createElement(Pressable, props);
