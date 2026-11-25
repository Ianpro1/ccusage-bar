import { expect, mock, test } from 'claude-code/testing'

// Stand-ins for the engine, and a record of what the bar writes to turnStats.
// (The test kit has no $.session.machine, so session.start stops there; the
// restore runs before it.)
const engine = (on: any, sessionId: string) => {
  const writes: unknown[] = []
  mock.clock(on)
  on('session.id', () => ({ value: sessionId }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  // a fresh process: nothing in $.state yet
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', (_: any, e: any) => {
    if (e.plugin === 'ccusage-bar' && e.key === 'turnStats') writes.push(e.value)
    return { value: { isSet: true, version: writes.length } }
  })
  return writes
}

test('a restarted session gets its saved turn totals back', async ($, on) => {
  mock.store(on, {
    turnStats: {
      'sess-1': { count: 4, totalMs: 120_000, at: 1 },
      'sess-other': { count: 9, totalMs: 9_000, at: 2 },
    },
  })
  const writes = engine(on, 'sess-1')

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  expect(writes).toEqual([{ count: 4, totalMs: 120_000 }])
})

test('a session with nothing saved writes nothing', async ($, on) => {
  mock.store(on, { turnStats: { 'sess-other': { count: 9, totalMs: 9_000, at: 2 } } })
  const writes = engine(on, 'sess-new')

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  expect(writes).toEqual([])
})
