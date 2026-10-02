import * as React from 'react';

// Cada forma vira um elemento DOM inerte: o teste confere o que aparece, não o desenho.
const tag = (name: string) => (props: any) => React.createElement(name.toLowerCase(), null, props.children);

export const Svg = tag('svg');
export const G = tag('g');
export const Path = tag('path');
export const Circle = tag('circle');
export const Ellipse = tag('ellipse');
export const Line = tag('line');
export const Polyline = tag('polyline');
export const Polygon = tag('polygon');
export const Rect = tag('rect');
export const Text = tag('text');
export const Defs = tag('defs');
export const Pattern = tag('pattern');
export const RadialGradient = tag('radialgradient');
export const LinearGradient = tag('lineargradient');
export const Stop = tag('stop');
export const SvgXml = tag('svg');
export default Svg;
