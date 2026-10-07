// Run: npx tsx src/lib/retainRisk.test.ts
// (tsconfig excludes src/**/*.test.ts from the build.)
import { alignRewrite } from './retainRisk'
import type { Risk, Word } from '../types'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('  ✗ ' + msg)
    failed++
  }
}
function eq<T>(a: T, b: T, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

function w(text: string, risk: Risk = 'low', start?: number, end?: number): Word {
  const x: Word = { text, risk }
  if (start != null) x.start = start
  if (end != null) x.end = end
  return x
}

const tests: Array<[string, () => void]> = [
  ['unchanged sentence → all keep, times retained', () => {
    const orig = [w('It', 'low', 0, 0.5), w('is', 'low', 0.5, 1), w('morning', 'high', 1, 2)]
    const a = alignRewrite('It is morning', orig, 0, 2)
    eq(a.map((t) => t.op), ['keep', 'keep', 'keep'], 'all keep')
    eq(a.map((t) => t.originalIndex), [0, 1, 2], 'indices')
    eq([a[2].start, a[2].end], [1, 2], 'morning keeps real time')
  }],

  ['single insert mid → neighbours unchanged, insert inside gap', () => {
    const orig = [w('It', 'low', 0, 0.5), w('is', 'low', 0.5, 1), w('morning', 'high', 1.5, 2)]
    const a = alignRewrite('It is the morning', orig, 0, 2)
    eq(a.map((t) => t.op), ['keep', 'keep', 'insert', 'keep'], 'one insert')
    eq([a[1].start, a[1].end], [0.5, 1], 'is unchanged')
    eq([a[3].start, a[3].end], [1.5, 2], 'morning unchanged')
    const ins = a[2]
    assert(ins.start! >= 1 && ins.end! <= 1.5 && ins.start! < ins.end!, 'insert time inside [is.end, morning.start]')
  }],

  ['single delete → survivors unchanged, deleted absent', () => {
    const orig = [w('It', 'low', 0, 1), w('really', 'med', 1, 2), w('is', 'low', 2, 3)]
    const a = alignRewrite('It is', orig, 0, 3)
    eq(a.map((t) => t.op), ['keep', 'keep'], 'two keeps')
    eq(a.map((t) => t.text), ['It', 'is'], 'really dropped')
    eq([a[1].start, a[1].end], [2, 3], 'is keeps time')
  }],

  ['substitution → delete+insert, neighbours keep risk+time', () => {
    const orig = [w('a', 'low', 0, 1), w('gun', 'high', 1, 2), w('here', 'low', 2.5, 3)]
    const a = alignRewrite('a knife here', orig, 0, 3)
    eq(a.map((t) => t.op), ['keep', 'insert', 'keep'], 'sub = keep/insert/keep')
    eq(a[2].word?.risk, 'low', 'here keep risk')
    eq([a[0].start, a[0].end], [0, 1], 'a unchanged')
    eq([a[2].start, a[2].end], [2.5, 3], 'here unchanged')
  }],

  ['clause replace (>=3) → one block over the gap', () => {
    const orig = [w('A', 'low', 0, 1), w('x', 'low', 1, 2), w('y', 'low', 2, 3), w('z', 'low', 3, 4), w('B', 'low', 4, 5)]
    const a = alignRewrite('A one two three B', orig, 0, 5)
    eq(a.map((t) => t.op), ['keep', 'insert', 'insert', 'insert', 'keep'], 'block run')
    const ins = a.slice(1, 4)
    assert(ins.every((t) => t.blockId === ins[0].blockId && t.blockId != null), 'shared blockId')
    assert(ins.every((t) => t.start === 1 && t.end === 4), 'block spans [A.end, B.start]')
  }],

  ['all-new segment → single block over [segStart, segEnd]', () => {
    const a = alignRewrite('brand new sentence', [], 10, 20)
    eq(a.map((t) => t.op), ['insert', 'insert', 'insert'], 'all insert')
    assert(a.every((t) => t.start === 10 && t.end === 20 && t.blockId === a[0].blockId), 'one block over segment')
  }],

  ['no-timestamp originals → no times anywhere', () => {
    const orig = [w('It', 'low'), w('is', 'low'), w('gun', 'high')]
    const a = alignRewrite('It is a gun', orig, 0, 3)
    assert(a.every((t) => t.start === undefined && t.end === undefined), 'all untimed')
    eq(a.find((t) => t.text === 'gun')?.word?.risk, 'high', 'gun keeps risk')
  }],

  ['duplicate words → both kept, right indices, no theft', () => {
    const orig = [w('the'), w('man'), w('saw'), w('the'), w('gun', 'high')]
    const a = alignRewrite('the man saw the big gun', orig, 0, 5)
    eq(a.map((t) => t.op), ['keep', 'keep', 'keep', 'keep', 'insert', 'keep'], 'big inserted before gun')
    eq(a.filter((t) => t.op === 'keep').map((t) => t.originalIndex), [0, 1, 2, 3, 4], 'second the → idx 3')
  }],

  ['interpolation monotonic + within gap', () => {
    const orig = [w('A', 'low', 0, 1), w('B', 'low', 3, 4)]
    const a = alignRewrite('A x y B', orig, 0, 4)
    const [x, y] = [a[1], a[2]]
    assert(x.start! >= 1 && x.start! < x.end! && x.end! <= y.start! && y.start! < y.end! && y.end! <= 3, 'monotonic, in [1,3]')
  }],

  ['insert at start/end → anchored to segStart/segEnd', () => {
    const orig = [w('A', 'low', 1, 2), w('B', 'low', 2, 3)]
    const start = alignRewrite('x A B', orig, 0, 5)
    eq(start[0].op, 'insert', 'leading insert')
    eq(start[0].start, 0, 'anchored to segStart')
    const end = alignRewrite('A B y', orig, 0, 5)
    eq(end[2].op, 'insert', 'trailing insert')
    eq(end[2].end, 5, 'anchored to segEnd')
  }],
]

for (const [name, fn] of tests) {
  const before = failed
  fn()
  if (failed === before) console.log('  ✓ ' + name)
}
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll retainRisk (alignRewrite) tests passed.')
