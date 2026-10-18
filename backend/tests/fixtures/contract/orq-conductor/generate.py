"""Congela a resposta do Python anterior à migração; executar da raiz com `python caminho/generate.py`."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types

SOURCE = '70d0b9ef4'
ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / 'backend'))
import app
os.environ['TZ'] = 'UTC'
if hasattr(time, 'tzset'):
    time.tzset()
orq_source = subprocess.check_output(['git', 'show', f'{SOURCE}:backend/app/orq.py'], cwd=ROOT, text=True)
orq_module = types.ModuleType('orq_characterization')
sys.modules[orq_module.__name__] = orq_module
exec(compile(orq_source, 'orq.py@' + SOURCE, 'exec'), orq_module.__dict__)
app.orq = orq_module
source = subprocess.check_output(['git', 'show', f'{SOURCE}:backend/app/orq_conductor.py'], cwd=ROOT, text=True)
ns = {'__name__': 'conductor_characterization'}
exec(compile(source, 'orq_conductor.py@' + SOURCE, 'exec'), ns)
TS = '2026-09-25T13:00:00+00:00'
cases = []
def case(name, journal='', shadow='', events=''):
    files = {'registro.md': journal, 'jev-shadow.jsonl': shadow, 'eventos.jsonl': events}
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        for path, content in files.items():
            (root / path).write_text(content, encoding='utf-8')
        try:
            expected = ns['feed'](root)
            json.dumps(expected, ensure_ascii=False, allow_nan=False).encode('utf-8')
            cases.append({'name': name, 'files': files, 'expected': expected, 'expected_json':json.dumps(expected, ensure_ascii=False, separators=(',', ':'), allow_nan=False)})
        except Exception as error:
            cases.append({'name': name, 'files': files, 'error': type(error).__name__})
def line(text, ts=TS):
    return f'- {ts} · {text}\n'
def row(**kwargs):
    return json.dumps({'ts': TS, **kwargs}, ensure_ascii=False) + '\n'
case('empty')
case('prefixes', ''.join(line(p + 'T3 ação') for p, _, _ in ns['_PREFIXES']))
case('ignored-prefixes', line('orq init: arbitro') + line('screen taken by ex1'))
case('journal-invalid', '\n \t\n## solta\n- sem-data · texto\n- ' + TS + ' errado\n')
case('physical-ids-ties', '\n' + line('notify → arbiter: T2 x') + line('aviso: y'), events='\n' + row(tipo='entrega', task=2, rodada=1))
case('journal-tail', ''.join(line('aviso: ' + str(i)) for i in range(305)))
case('shadow-tail', line('notify → arbiter: x'), ''.join(row(text='x', p=i/1000) for i in range(305)))
case('all-event-types', events=''.join(row(tipo=t, task=3, rodada=2, resultado='aprova', commit='abc', sessao='rev', executor='ex', par='r', de='a', para='b', motivo='ação', reincide=True) for t in sorted(ns['orq']._TIPOS)))
case('event-types-invalid', events='\n{torto\n[]\nnull\ntrue\n'+row(tipo='futuro')+row(tipo='entrega', ts='x'))
case('event-shapes', events=row(tipo='entrega', task=True, rodada='2', resultado=False, commit=0, sessao=[], executor={}, par=None, de='', para=[1, None], motivo={'a': True}, reincide=1))
case('event-none-missing', events=row(tipo='entrega')+row(tipo='entrega', task=None, rodada=None))
case('event-big-integers', events=row(tipo='entrega', task=10**40, rodada=-(10**25), commit=10**30))
case('task-unicode', ''.join(line('aviso: '+t) for t in ['T٣', 'Task ٤', 'T99999999999999999999999999', 'XT2 T5', 'T1 Task 8', 'Task 8 T1', 'éT4', 'T4é', 'T0']))
case('timestamps', events=''.join(row(tipo='entrega', ts=t) for t in ['2026-09-25T13:00:00', '2026-09-25', '20260925T130000Z', '2026-09-25X13:00:00,123456Z', '2026-09-25T10:00:00-03:00', '2026-09-25T13:00:00+00:00:00.5', '2026-W39-5T13:00:00Z']))
case('calendar-edges', events=''.join(row(tipo='entrega', ts=t) for t in ['0001-01-01T00:00:00', '0001-01-01T00:00:00+14:00', '9999-12-31T23:59:59', '2026-09-25T24:00:00Z']))
case('shadow-shapes', line('notify → arbiter: x'), '\n[]\n{}\n{torto\n'+row(text=3)+row(text='x', ts='x')+row(text='x'))
case('shadow-normalization', line('notify → arbiter: tela ⏎ outra'), row(text='  tela\r\noutra\n'))
case('shadow-unicode-lines', line('notify → arbiter: tela ⏎ outra'), row(text='tela\votra')+row(text='tela\u2028outra'))
case('shadow-first-once', line('notify → arbiter: x')*3, row(text='x', mode='a')+row(text='x', mode='b'))
case('shadow-window', ''.join(line('notify → arbiter: '+str(i)) for i in range(4)), ''.join(row(text=str(i), ts='2026-09-25T13:00:'+t+'+00:00') for i,t in enumerate(['10','11','00','09'])))
case('shadow-negative-window', line('notify → arbiter: x'), row(text='x', ts='2026-09-25T12:59:50+00:00'))
case('shadow-only-wake-drop', ''.join(line(p+'x') for p in ['aviso: ', 'notify → arbiter: ', '(jev: no action) ', '(regex: no action) ']), row(text='x')*4)
case('shadow-cut-codepoints', line('notify → arbiter: '+'é'*500+'fim') + line('notify → arbiter: '+'é'*499+'fim'), row(text='é'*500)+row(text='é'*499))
case('jev-numbers-order', line('notify → arbiter: x'), row(text='x', p=True, veto={'b': None, 'a': .4, 'c': .40001, 'd': '0.9', 'e': False, 'f': float('nan'), 'g': float('inf'), 'h': -float('inf')}, mode={'x': 1}, choice=['act'], would_drop=None, error=4))
case('jev-nonfinite', line('notify → arbiter: x'), row(text='x', p=float('nan'), veto={'a': float('inf')}))
case('feed-cap500', events=''.join(row(tipo='entrega', rodada=i) for i in range(500)))
case('feed-truncated501', events=''.join(row(tipo='entrega', rodada=i) for i in range(501)))
case('unicode-splitlines', journal=line('aviso: a').replace('\n', '\r\n')+line('aviso: b').replace('\n', '\u2028'))
case('task-unicode-boundaries', ''.join(line('aviso: '+text) for text in ['T2\u200d', 'T3\u0301', 'T4²', '²T5', 'T6א', 'T7\u05b0', 'T8_', '_T9']))
case('nonfinite-string-values', line('notify → arbiter: x'), row(text='x', mode='\U0010fffforq-nonfinite:NaN', p='NaN', veto={'a':'NaN'}))
case('event-nested-big-numbers', events=row(tipo='entrega', resultado=[10**40, {'a':10**35}], commit={'n':10**40}))
case('high-year-order', events=row(tipo='entrega', ts='9998-12-31T23:59:59.000001Z', rodada=1)+row(tipo='entrega', ts='9998-12-31T23:59:59.000002Z', rodada=2))
for depth in [200, 2000]:
    nested = '[' * depth + '0' + ']' * depth
    case(f'deep-event-text-{depth}', events='{"ts":"'+TS+'","tipo":"entrega","resultado":'+nested+'}\n')
    case(f'deep-unused-field-{depth}', events='{"ts":"'+TS+'","tipo":"entrega","extra":'+nested+'}\n')
    case(f'deep-shadow-mode-{depth}', line('notify → arbiter: x'), '{"ts":"'+TS+'","text":"x","mode":'+nested+'}\n')
for field in ['mode', 'choice', 'error', 'would_drop']:
    case('nonfinite-output-'+field, line('notify → arbiter: x'), row(text='x', **{field:float('nan')}))
case('lone-surrogate-output', events='{"ts":"'+TS+'","tipo":"entrega","resultado":"\\ud800"}\n')
case('surrogate-p-is-null', line('notify → arbiter: x'), '{"ts":"'+TS+'","text":"x","p":"\\ud800"}\n')
case('iso-week-reduced', events=''.join(row(tipo='entrega',ts=stamp) for stamp in ['2026-W39','2026W39','2026W395T13:00:00Z','2026-W39T13:00:00Z']))
case('calendar-interior-extreme-years', events=''.join(row(tipo='entrega',ts=stamp) for stamp in ['0001-01-02T00:00:00','0001-06-15T13:00:00','9999-12-30T23:59:59','9999-06-15T13:00:00']))
case('nested-surrogate-string-repr', events='{"ts":"'+TS+'","tipo":"entrega","resultado":["\\ud800"],"commit":{"x":"a\\udfff"}}\n')
case('float-exponent-overflow-text', events='{"ts":"'+TS+'","tipo":"entrega","resultado":1e400,"commit":[-1e400]}\n')
case('float-exponent-overflow-output', line('notify → arbiter: x'), '{"ts":"'+TS+'","text":"x","mode":1e400}\n')
case('serde-magic-key-remains-object', events=row(tipo='entrega', resultado={'$serde_json::private::Number':'123'}, commit={'$serde_json::private::Number':'não é número'}))
case('serde-magic-key-raw-output', line('notify → arbiter: x'), row(text='x',mode={'$serde_json::private::Number':'123'}))
case('serde-raw-key-remains-object', events=row(tipo='entrega', resultado={'$serde_json::private::RawValue':'123'}))
case('serde-raw-key-raw-output', line('notify → arbiter: x'), row(text='x', mode={'$serde_json::private::RawValue':'123'}))
case('task-text-integer-limit4300', line('aviso: T'+'9'*4300))
case('python-bug-task-integer-limit4301', line('aviso: T'+'9'*4301))
case('python-bug-surrogate-timestamp-output', events='{"ts":"2026-09-25\\ud80013:00:00Z","tipo":"entrega"}\n')
case('shadow-surrogate-timestamp', line('notify → arbiter: x'), '{"ts":"2026-09-25\\ud80013:00:00Z","text":"x","p":0.7}\n')
case('journal-python-whitespace-class', line('aviso: x','2026-09-25\x1f13:00:00Z'))
invalid_keys = ['NaN', 'Infinity', '-Infinity', '1e400', '-1e400', '18446744073709551616', '-9223372036854775809']
for token in invalid_keys:
    for space in ['', ' \t ']:
        key = token + space + ':0'
        label = token + ('-spaced' if space else '-tight')
        case('invalid-unquoted-event-key-'+label, events='{"tipo":"entrega","ts":"'+TS+'",'+key+'}\n')
        case('invalid-unquoted-shadow-key-'+label, line('notify → arbiter: x'), '{"ts":"'+TS+'","text":"x",'+key+'}\n')
case('invalid-nested-unquoted-keys', events=''.join('{"tipo":"entrega","ts":"'+TS+'","resultado":[{'+token+' : 0}]}\n' for token in invalid_keys))
case('invalid-shadow-veto-unquoted-keys', line('notify → arbiter: x'), ''.join('{"ts":"'+TS+'","text":"x","veto":{'+token+' : 0.9}}\n' for token in invalid_keys))
case('quoted-special-keys-and-values-stay-valid', events='{"tipo":"entrega","ts":"'+TS+'","resultado":{"NaN":NaN,"Infinity":Infinity,"-Infinity":-Infinity,"18446744073709551616":18446744073709551616}}\n')
case('quoted-shadow-special-keys-stay-valid', line('notify → arbiter: x'), row(text='x', veto={'NaN':0.4, 'Infinity':0.5, '-Infinity':None, '18446744073709551616':0.1}))
case('python-bug-type-list', events=row(tipo=[]))
case('python-bug-num-overflow', journal=line('notify → arbiter: x'), shadow=row(text='x', p=10**400))
# Bytes inválidos precisam atravessar a leitura com replacement, não a escrita Unicode do fixture.
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    raw = line('aviso: ação').encode() + b'- 2026-09-25T13:00:00Z \xc2\xb7 aviso: \xff\n'
    (root/'registro.md').write_bytes(raw)
    cases.append({'name':'utf8-replacement', 'bytes':list(raw), 'files':{}, 'expected':ns['feed'](root), 'expected_json':json.dumps(ns['feed'](root),ensure_ascii=False,separators=(',', ':'),allow_nan=False)})
for item in cases:
    item.pop('expected', None)
output = {'source': SOURCE, 'command': 'python backend/tests/fixtures/contract/orq-conductor/generate.py', 'timezone':'UTC', 'cases':cases}
Path(__file__).with_name('feed.json').write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':'), allow_nan=False)+'\n', encoding='utf-8')
print(f'{len(cases)} cenários congelados, {sum("error" in case for case in cases)} erros Python documentados')
