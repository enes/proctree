import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PS = [
  '100 900 8',
  '  100    50 409600  12.5    10:00 claude',
  '  200   100   8192   0.5    05:00 /bin/zsh -c npm test',
  '  300   200 102400  80.0    00:30 /usr/local/bin/node jest',
  '  250   100  51200   1.0    09:00 /usr/local/bin/node mcp-server.js',
  '  900   100   1024   0.0    00:00 ps -A -ww',
].join('\n')

const PANE = {
  plugin: 'proctree',
  component: 'Pane',
  requestId: 'proctree',
  props: {
    title: 'Process tree',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const COMMAND = {
  command: 'proctree',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

function stubUi(on: On, toasts: string[] = [], opened: { focus?: true }[] = []) {
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async (_$, e) => {
    opened.push({ focus: e.focus })
    return { value: { isPlaced: true as const } }
  })
}

test('the pane draws the tree on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  stubUi(on)
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: PS, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.command.run(COMMAND)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /4 processes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CPU 94\.0% \(0\.9 of 8 cores\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /node jest/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /mcp-server/ })).toBeDefined()

    await ui.press({ key: 'pause' })
    expect(await ui.find({ key: 'pause', text: 'resume' })).toBeDefined()
    await ui.press({ key: 'pause' })
    await ui.unmount()
  }
})

test('stops sampling after repeated failures until /proctree runs again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const toasts: string[] = []
  let runs = 0
  stubUi(on, toasts)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: { command: 'proctree' } }))
  on('process.run', async () => {
    runs += 1
    return { deny: 'spawn sh ENOENT' }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  await clock.advance(2_000)
  expect(runs).toBe(3)
  expect(toasts.length).toBe(1)

  await clock.advance(10_000)
  expect(runs).toBe(3)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /needs macOS or Linux/ })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  await ui.unmount()

  await $.command.run(COMMAND)
  expect(runs).toBe(4)
})

test('c closes the pane', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  stubUi(on)
  const closed: string[] = []
  on('ui.close', async (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: PS, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.command.run(COMMAND)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'close' })
  expect(closed).toEqual(['proctree'])
  await ui.unmount()
})

test('a long tree in a short pane keeps the footer and counts the rest', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  stubUi(on)
  const many = ['100 900', '  100    50 409600  12.5    10:00 claude']
  for (let pid = 200; pid < 240; pid++) many.push(`  ${pid}   100   1024   0.0    00:10 /bin/zsh`)
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: many.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.command.run(COMMAND)

  // 12 rows: 3 for summary and headings, 1 for the footer, 8 for the tree,
  // of which 7 are processes and 1 is the "more" line.
  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } },
  })
  expect(await ui.find({ type: 'Text', text: '… 34 more' })).toBeDefined()
  expect(await ui.find({ key: 'close' })).toBeDefined()
  await ui.unmount()
})

test('/proctree focuses the pane, and an unfocused pane says how to reach the keys', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const opened: { focus?: true }[] = []
  stubUi(on, [], opened)
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: PS, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.command.run(COMMAND)
  expect(opened).toEqual([{ focus: true }])

  const unfocused = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await unfocused.find({ type: 'Text', text: 'ctrl+x tab: use keys' })).toBeDefined()
  await unfocused.unmount()

  const focused = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, isFocused: true } })
  expect(await focused.find({ type: 'Text', text: 'ctrl+x tab: use keys' })).toBeUndefined()
  await focused.unmount()
})

test('sampling stops while paused and picks up again on resume', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  let runs = 0
  stubUi(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: { command: 'proctree' } }))
  on('process.run', async () => {
    runs += 1
    return {
      value: { exitCode: 0, stdout: PS, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, isFocused: true } })
  await clock.advance(2_000)
  const before = runs

  await ui.press({ key: 'pause' })
  await clock.advance(6_000)
  expect(runs).toBe(before)

  await ui.press({ key: 'pause' })
  expect(await ui.find({ key: 'pause', text: 'pause' })).toBeDefined()
  await clock.advance(4_000)
  expect(runs).toBeGreaterThan(before)
  await ui.unmount()
})
