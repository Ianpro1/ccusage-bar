import { expect, mock, test } from 'claude-code/testing'

const SNAPSHOT = {
  sessionCost: 1, sessionTokens: 1000, folderCost: 2, folderTokens: 2000, folderSessions: 2,
  todayCost: 1, sessionCacheHit: 90, folderCacheHit: 90, sessionModels: [], folderModels: [],
  fetchedAt: 1, error: null,
}

const BAND = {
  plugin: 'ccusage-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6 },
} as const

test('the Dashboard button runs the builder and opens the page', async ($, on) => {
  const runs: string[][] = []
  mock.clock(on)
  on('state.get', (_: any, e: any) => ({ value: { value: e.key === 'snapshot' ? SNAPSHOT : undefined, version: 1 } }))
  on('session.usage', () => ({ value: { context: { percent: 12 }, cost: { usd: 1 } } }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('process.run', (_: any, e: any) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '/data/dashboard.html', stderr: '' } }
  })
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'dashboard' })
  await ui.unmount()

  const build = runs.find(argv => argv.some(a => a.endsWith('dashboard/build.mjs')))
  expect(build?.[0]).toBe('node')
  expect(build).toContain('--open')
  expect(toasts).toEqual(['Building the dashboard…', 'Dashboard opened in your browser.'])
})
