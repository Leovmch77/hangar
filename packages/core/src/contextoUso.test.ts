import { describe, expect, it } from 'vitest';
import { parseContextoUso, tokensDeTexto } from './contextoUso';

const SAIDA = `## Context Usage

**Model:** claude-haiku-4-5-20251001
**Tokens:** 37.3k / 200k (19%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 6.4k | 3.2% |
| MCP tools (deferred) | 7.4k | 3.7% |
| Messages | 3.8k | 1.9% |
| Free space | 162.7k | 81.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__brave-search__brave_web_search | brave-search | 212 |

### Plan limits

| Limit | Used | Resets |
|-------|------|--------|
| 5h | 38% | 1789400000 |
| 7d | 71% |  |`;

describe('parseContextoUso', () => {
  it('lê total, categorias, MCP e limites da saída real', () => {
    const c = parseContextoUso(SAIDA)!;
    expect(c).toMatchObject({ modelo: 'claude-haiku-4-5-20251001', usado: 37300, total: 200000, pct: 19 });
    expect(c.categorias.map((x) => [x.nome, x.tokens])).toEqual([
      ['System prompt', 6400], ['MCP tools (deferred)', 7400], ['Messages', 3800], ['Free space', 162700],
    ]);
    expect(c.mcp).toEqual([{ nome: 'mcp__brave-search__brave_web_search', servidor: 'brave-search', tokens: 212 }]);
    expect(c.limites).toEqual([{ rotulo: '5h', pct: 38, resetTs: 1789400000 }, { rotulo: '7d', pct: 71, resetTs: null }]);
  });
  it('texto que não é /context -> null', () => {
    expect(parseContextoUso('## Outra coisa')).toBeNull();
    expect(parseContextoUso('## Context Usage\n\nsem tokens')).toBeNull();
  });
  it('tokens com sufixo', () => {
    expect(tokensDeTexto('1.2M')).toBe(1200000);
    expect(tokensDeTexto('999')).toBe(999);
  });
});
