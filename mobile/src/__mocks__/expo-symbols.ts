import * as React from 'react';

export const SymbolView = (props: { name: string }) => React.createElement('i', { 'data-symbol': props.name });
