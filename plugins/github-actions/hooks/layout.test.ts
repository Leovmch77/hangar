import { expect, test } from 'claude-code/testing'
import { chaveDe, desenharFaixa } from './faixa'
import type { GhView, Pr, Workflow } from '../types'

type Node = { type: string; props: Record<string, unknown>; children?: unknown[] }
const elements = (n: Node): Node[] => (n.children ?? []).filter((c): c is Node => !!c && typeof c === 'object' && 'type' in c)
const text = (n: unknown): string => {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  const node = n as Node
  return [node.props?.label ?? '', ...(node.children ?? []).map(text)].filter(Boolean).join('|')
}
const svgCount = (n: Node): number => Number(n.type === 'Svg') + elements(n).reduce((sum, c) => sum + svgCount(c), 0)

const workflow: Workflow = {
  id: 41, nome: 'Build e publicação multiplataforma com integração completa', sha: 'abcdef0123456789',
  situacao: 'rodando', url: 'https://github.com/example/repo/actions/runs/41', inicio: 1, fim: null,
  jobs: Array.from({ length: 23 }, (_, i) => ({
    nome: `build-${i}`, situacao: 'rodando', passo: 'Run cargo build', feitos: 1, total: 2,
    passos: [{ nome: 'Set up job', situacao: 'ok' }, { nome: 'Run cargo build', situacao: 'rodando' }],
  })),
}
const pr: Pr = {
  numero: 103, titulo: 'Correção da faixa de integração e publicação multiplataforma',
  url: 'https://github.com/example/repo/pull/103', estado: 'OPEN', rascunho: false, revisao: 'REVIEW_REQUIRED',
  checks: { ok: 0, falhou: 0, rodando: 23 },
}
const summary = '0/23 jobs · 123h 45m'
const props = { hasSurvey: true, isWorking: false, maxRows: 40, bodyColumns: 110 } as never

for (const surface of ['desktop', 'mobile', 'terminal'] as const) {
  for (const withPr of [false, true]) {
    test(`${surface}: faixa com ${withPr ? 'PR' : 'branch'} e 110 colunas separa identidade, resumo e barra sem mudar o terminal`, async ($, on) => {
      const view: GhView = { branch: 'fix/mods-largura-celular', pr: withPr ? pr : null, workflows: [workflow] }
      let collapsed = true
      let opened: string[] = []
      on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'processo indisponível no teste de layout' } }) as never)
      on('ui.render', { component: 'AbovePrompt' }, ($, e) => desenharFaixa($.ui.resolve(e), view, {
        superficie: e.surface, colunas: e.props.bodyColumns, recolhida: collapsed,
        agora: 1 + (123 * 60 + 45) * 60_000, abertos: opened,
      }, {
        abrir: () => {}, alternar: () => {}, alternarItem: () => {},
      }))
      const ui = await $.ui.mount({ plugin: 'github-actions', surface, component: 'AbovePrompt', props })
      const header = (await ui.find({ key: 'cab' }))!
      const [identity, metadata, progress] = elements(header)
      expect(text(identity)).toContain(withPr ? 'PR #103' : '⎇ fix/mods-largura-celular')
      expect(text(identity)).toContain('●23')
      expect(text(metadata)).toContain(summary)
      if (withPr) expect(text(identity)).toContain(pr.titulo)

      if (surface === 'terminal') {
        expect(header.props).toEqual({ key: 'cab', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: 110, columnGap: 1 })
        expect(elements(header)).toHaveLength(2)
        expect(identity!.props).toEqual({ flexDirection: 'row', alignItems: 'center', flexShrink: 1, columnGap: 1 })
        expect(metadata!.props).toEqual({ flexDirection: 'row', alignItems: 'center', columnGap: 1, flexShrink: 0 })
        expect(elements(metadata!)[0]!.props).toEqual({ flexDirection: 'row', flexShrink: 0 })
        expect(text(elements(metadata!)[0])).toContain('━')
        expect(svgCount(header)).toBe(0)
      } else {
        expect(header.props.flexDirection).toBe('column')
        expect(elements(header)).toHaveLength(3)
        expect(identity!.props.flexWrap).toBe('wrap')
        expect(identity!.props.flexShrink).toBe(0)
        expect(metadata!.props.flexWrap).toBe('wrap')
        expect(metadata!.props.flexShrink).toBe(0)
        expect(svgCount(metadata!)).toBe(0)
        expect(progress!.type).toBe('Box')
        expect(elements(progress!)).toHaveLength(1)
        expect(elements(progress!)[0]!.type).toBe('Svg')
        expect(text(progress)).toBe('')
        expect(svgCount(header)).toBe(1)
      }
      if (withPr) expect((await ui.find({ key: 'abrir-pr' }))!.props.label).toBe('abrir PR')

      collapsed = false
      await ui.redraw()
      const expandedHeader = (await ui.find({ key: 'cab' }))!
      expect(elements(expandedHeader)).toHaveLength(2)
      expect(text(expandedHeader)).toContain('●23')
      expect(svgCount(expandedHeader)).toBe(0)
      const row = (await ui.find({ key: 'wf-41' }))!
      const [name, details] = elements(row)
      expect(text(name)).toContain('▸ Build e publicação multiplataforma')
      expect(text(name)).toContain('abcdef0')
      expect(text(details)).toContain(summary)
      expect(text(details)).toContain('50%')
      expect(text(details)).toContain(`abrir ${workflow.nome}`)
      const bar = (await ui.find({ key: 'br-41' }))!
      expect(elements(bar)).toHaveLength(1)
      if (surface === 'terminal') {
        expect(row.props).toEqual({ key: 'wf-41', flexDirection: 'row', justifyContent: 'space-between', width: 108, columnGap: 1, marginTop: 1 })
        expect(name!.props).toEqual({ flexDirection: 'row', flexShrink: 1, columnGap: 1 })
        expect(details!.props).toEqual({ flexDirection: 'row', columnGap: 2, flexShrink: 0 })
        expect(bar.props).toEqual({ key: 'br-41', flexDirection: 'row', paddingLeft: 2 })
        expect(elements(bar)[0]!.props).toEqual({ flexDirection: 'row', flexShrink: 0 })
      } else {
        expect(row.props.flexDirection).toBe('column')
        expect(name!.props.flexWrap).toBe('wrap')
        expect(name!.props.flexShrink).toBe(0)
        expect(details!.props.flexWrap).toBe('wrap')
        expect(details!.props.flexShrink).toBe(0)
        expect(svgCount(row)).toBe(0)
        expect(elements(bar)[0]!.type).toBe('Svg')
        expect(text(bar)).toBe('')
      }
      expect((await ui.find({ key: 'abrir-41' }))!.props.label).toBe(`abrir ${workflow.nome}`)
      opened = [chaveDe('wf', workflow.nome)]
      await ui.redraw()
      expect((await ui.find({ key: chaveDe('wf', workflow.nome) }))!.props.label).toContain('▾ Build')
      expect((await ui.findAll({ type: 'Box' })).filter(n => n.key?.startsWith('j-41-'))).toHaveLength(23)
      expect(text(await ui.drawn())).toContain('1/2 passos')
    })
  }
}
