import { expect, test } from 'claude-code/testing'

import { buildSnapshot, formatCores, isClaudeCode, shortCommand } from '../hooks/tree'

// sh (pid 900) is the sampler, its parent 100 the claude session; 900's own
// ps row and 50, a stranger above the session, must stay out of the tree.
const PS = [
  '100 900',
  '   50     1   2048   0.0    01:00 /bin/zsh',
  '  100    50 409600  12.5    10:00 claude',
  '  200   100   8192   0,5    05:00 /bin/zsh -c npm test',
  '  300   200 102400  80.0    00:30 /usr/local/bin/node jest',
  '  250   100  51200   1.0    09:00 /usr/local/bin/node mcp-server.js',
  '  900   100   1024   0.0    00:00 ps -A -ww',
].join('\n')

test('builds the session tree from ps output', async () => {
  const snap = buildSnapshot(PS, 0)

  expect(snap.error).toBe(null)
  expect(snap.rootPid).toBe(100)
  expect(snap.nodes.map(n => n.pid)).toEqual([100, 200, 300, 250])
  expect(snap.nodes.map(n => n.prefix)).toEqual(['', '├─ ', '│  └─ ', '└─ '])
  expect(snap.totalRssKb).toBe(409600 + 8192 + 102400 + 51200)
  expect(snap.nodes[1]?.cpu).toBe(0.5)
})

test('recognizes the native binary and the npm package, not the desktop app', async () => {
  expect(isClaudeCode('claude')).toBe(true)
  expect(isClaudeCode('/Users/me/.local/bin/claude --resume')).toBe(true)
  expect(isClaudeCode('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(true)
  expect(isClaudeCode('/Applications/Claude.app/Contents/MacOS/Claude')).toBe(false)
  expect(isClaudeCode('/bin/zsh')).toBe(false)
})

test('walks up past an intermediate shell to the session', async () => {
  const ps = [
    '110 900',
    '  100     1 409600   1.0    10:00 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '  110   100   2048   0.0    00:01 /bin/sh',
    '  900   110   1024   0.0    00:00 ps',
  ].join('\n')

  expect(buildSnapshot(ps, 0).rootPid).toBe(100)
})

test('never climbs to the desktop app above an unrecognized parent', async () => {
  const ps = [
    '100 900',
    '   10     1 900000   5.0    99:00 /Applications/Claude.app/Contents/MacOS/Claude',
    '  100    10 409600   1.0    10:00 some-wrapper',
    '  900   100   1024   0.0    00:00 ps',
  ].join('\n')

  expect(buildSnapshot(ps, 0).rootPid).toBe(100)
})

test('shortens absolute executables only', async () => {
  expect(shortCommand('/usr/local/bin/node jest --watch')).toBe('node jest --watch')
  expect(shortCommand('claude --resume')).toBe('claude --resume')
})

test('reports a missing session process', async () => {
  expect(buildSnapshot('77 78\n', 0).error).toBe('Claude Code process (pid 77) not found in ps output')
})

test('reads the core count from the first line and shows the total against it', async () => {
  expect(buildSnapshot(PS, 0).cores).toBe(null)
  expect(buildSnapshot(PS.replace('100 900', '100 900 8'), 0).cores).toBe(8)
  expect(formatCores(112.8, 8)).toBe(' (1.1 of 8 cores)')
  expect(formatCores(50, 1)).toBe(' (0.5 of 1 core)')
  expect(formatCores(112.8, null)).toBe('')
})
