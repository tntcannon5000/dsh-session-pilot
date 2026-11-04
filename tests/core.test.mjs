/** Pure-helper and package-contract tests for dsh-session-pilot. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  boundedExcerpt,
  composeContinuePrompt,
  decodeOperation,
  isTrustedRequest,
  parseArchiveSessionArgs,
  parseListSessionsArgs,
  parseNewConversationArgs,
  parseReadSessionArgs,
  parseRenameSessionArgs,
  projectSessionSummary,
  projectTranscript,
  validatePromptText,
  MAX_EXCERPT_CHARS,
  LIST_SESSIONS_DEFAULT_LIMIT,
  LIST_SESSIONS_MAX_LIMIT,
  READ_SESSION_DEFAULT_MESSAGES,
  TRANSCRIPT_PER_MESSAGE_CHARS,
} from '../testing.mjs'

test('boundedExcerpt trims and rejects blank text', () => {
  assert.equal(boundedExcerpt('   '), undefined)
  assert.equal(boundedExcerpt(''), undefined)
  assert.equal(boundedExcerpt('  hello  '), 'hello')
})

test('boundedExcerpt bounds long text with an ellipsis marker', () => {
  const long = 'x'.repeat(MAX_EXCERPT_CHARS + 100)
  const excerpt = boundedExcerpt(long)
  assert.ok(excerpt !== undefined)
  assert.ok(excerpt.length <= MAX_EXCERPT_CHARS + 2)
  assert.ok(excerpt.endsWith('…'))
})

test('composeContinuePrompt embeds the excerpt inside the quoted context', () => {
  const prompt = composeContinuePrompt('讨论 plugin 设计')
  assert.ok(prompt.includes('<quoted-context>\n讨论 plugin 设计\n</quoted-context>'))
  assert.ok(prompt.startsWith('The user moved'))
})

test('validatePromptText rejects non-strings and blank strings', () => {
  assert.throws(() => validatePromptText(undefined), TypeError)
  assert.throws(() => validatePromptText(42), TypeError)
  assert.throws(() => validatePromptText('   '), TypeError)
  assert.equal(validatePromptText(' go '), ' go ')
})

test('parseNewConversationArgs accepts a minimal call and a titled call', () => {
  assert.deepEqual(parseNewConversationArgs({ prompt: 'do it' }), { prompt: 'do it' })
  assert.deepEqual(
    parseNewConversationArgs({ prompt: 'do it', title: '  Side quest ' }),
    { prompt: 'do it', title: 'Side quest' },
  )
})

test('parseNewConversationArgs carries an optional preset id', () => {
  assert.deepEqual(
    parseNewConversationArgs({ prompt: 'do it', preset: ' daily ' }),
    { prompt: 'do it', preset: 'daily' },
  )
  assert.deepEqual(
    parseNewConversationArgs({ prompt: 'do it', title: 'T', preset: 'cordis' }),
    { prompt: 'do it', title: 'T', preset: 'cordis' },
  )
  assert.throws(() => parseNewConversationArgs({ prompt: 'x', preset: '' }), TypeError)
  assert.throws(() => parseNewConversationArgs({ prompt: 'x', preset: 'Daily Mode' }), TypeError)
  assert.throws(() => parseNewConversationArgs({ prompt: 'x', preset: 7 }), TypeError)
})

test('parseNewConversationArgs rejects malformed calls', () => {
  assert.throws(() => parseNewConversationArgs(null), TypeError)
  assert.throws(() => parseNewConversationArgs({}), TypeError)
  assert.throws(() => parseNewConversationArgs({ prompt: '' }), TypeError)
  assert.throws(() => parseNewConversationArgs({ prompt: 'x', title: '' }), TypeError)
})

test('decodeOperation round-trips blank and continue operations', () => {
  assert.deepEqual(decodeOperation({ action: 'blank' }), { action: 'blank' })
  assert.deepEqual(
    decodeOperation({ action: 'blank', sourceSessionId: 'session-1' }),
    { action: 'blank', sourceSessionId: 'session-1' },
  )
  assert.deepEqual(
    decodeOperation({ action: 'continue', prompt: 'go', title: 'T' }),
    { action: 'continue', prompt: 'go', title: 'T' },
  )
})

test('decodeOperation rejects malformed operations', () => {
  assert.throws(() => decodeOperation('blank'), TypeError)
  assert.throws(() => decodeOperation({ action: 'fork' }), TypeError)
  assert.throws(() => decodeOperation({ action: 'continue' }), TypeError)
  assert.throws(() => decodeOperation({ action: 'blank', sourceSessionId: '' }), TypeError)
})

test('isTrustedRequest accepts loopback origins on the server port', () => {
  assert.equal(isTrustedRequest('http://localhost:3080', undefined, '127.0.0.1', 3080), true)
  assert.equal(isTrustedRequest('http://127.0.0.1:3080', undefined, '127.0.0.1', 3080), true)
  assert.equal(isTrustedRequest('http://localhost:9999', undefined, '127.0.0.1', 3080), false)
  assert.equal(isTrustedRequest('https://evil.example:3080', undefined, '127.0.0.1', 3080), false)
  assert.equal(isTrustedRequest('not-a-url', undefined, '127.0.0.1', 3080), false)
})

test('isTrustedRequest falls back to a loopback Host header', () => {
  assert.equal(isTrustedRequest(undefined, 'localhost:3080', '127.0.0.1', 3080), true)
  assert.equal(isTrustedRequest(undefined, 'example.com', '127.0.0.1', 3080), false)
  assert.equal(isTrustedRequest(undefined, undefined, '127.0.0.1', 3080), false)
  assert.equal(isTrustedRequest('https://anything.example:443', undefined, '0.0.0.0', 3080), true)
})

test('parseRenameSessionArgs accepts title with or without sessionId', () => {
  assert.deepEqual(parseRenameSessionArgs({ title: '  New name ' }), { title: 'New name' })
  assert.deepEqual(
    parseRenameSessionArgs({ title: 'T', sessionId: 'session-1' }),
    { title: 'T', sessionId: 'session-1' },
  )
  assert.throws(() => parseRenameSessionArgs({}), TypeError)
  assert.throws(() => parseRenameSessionArgs({ title: ' ' }), TypeError)
  assert.throws(() => parseRenameSessionArgs({ title: 'T', sessionId: 7 }), TypeError)
})

test('parseListSessionsArgs defaults, trims, bounds, and rejects bad shapes', () => {
  assert.deepEqual(parseListSessionsArgs(undefined), { limit: LIST_SESSIONS_DEFAULT_LIMIT })
  assert.deepEqual(parseListSessionsArgs({ query: '  fork ' }), { query: 'fork', limit: LIST_SESSIONS_DEFAULT_LIMIT })
  assert.deepEqual(parseListSessionsArgs({ limit: 500 }), { limit: LIST_SESSIONS_MAX_LIMIT })
  assert.throws(() => parseListSessionsArgs({ query: ' ' }), TypeError)
  assert.throws(() => parseListSessionsArgs({ limit: 0 }), TypeError)
  assert.throws(() => parseListSessionsArgs({ limit: 2.5 }), TypeError)
})

test('parseReadSessionArgs defaults and validates', () => {
  assert.deepEqual(parseReadSessionArgs(null), { maxMessages: READ_SESSION_DEFAULT_MESSAGES })
  assert.deepEqual(
    parseReadSessionArgs({ sessionId: 's-1', maxMessages: 5 }),
    { sessionId: 's-1', maxMessages: 5 },
  )
  assert.throws(() => parseReadSessionArgs({ sessionId: '' }), TypeError)
  assert.throws(() => parseReadSessionArgs({ maxMessages: -1 }), TypeError)
})

test('parseArchiveSessionArgs accepts empty and targeted calls', () => {
  assert.deepEqual(parseArchiveSessionArgs(undefined), {})
  assert.deepEqual(parseArchiveSessionArgs({ sessionId: 's-1' }), { sessionId: 's-1' })
  assert.throws(() => parseArchiveSessionArgs({ sessionId: 3 }), TypeError)
})

test('projectSessionSummary reads the title projection and optionals', () => {
  assert.deepEqual(
    projectSessionSummary({
      sessionId: 's-1',
      updatedAt: 42,
      running: true,
      blank: false,
      cwd: '/tmp/work',
      projections: { values: { title: 'Hello' } },
    }),
    { sessionId: 's-1', title: 'Hello', running: true, blank: false, updatedAt: 42, cwd: '/tmp/work' },
  )
  assert.deepEqual(
    projectSessionSummary({ sessionId: 's-2', updatedAt: 1, running: false, blank: true }),
    { sessionId: 's-2', title: null, running: false, blank: true, updatedAt: 1 },
  )
})

test('projectTranscript keeps the latest bounded user/assistant text', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'first question' }] } },
    {
      type: 'assistant/message',
      seq: 2,
      data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'first answer' }] } },
    },
    { type: 'tool/call', seq: 3, data: {} },
    { type: 'user/message', seq: 4, data: { content: [{ type: 'image', attachment: {} }] } },
    { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: 'second question' }] } },
  ]
  const projection = projectTranscript(events)
  assert.deepEqual(
    projection.messages.map(entry => `${entry.role}:${entry.text}`),
    ['user:first question', 'assistant:first answer', 'user:second question'],
  )
  assert.equal(projection.truncated, false)
})

test('projectTranscript bounds count, per-message chars, and reports truncation', () => {
  const events = Array.from({ length: 10 }, (_, index) => ({
    type: 'user/message',
    seq: index,
    data: { content: [{ type: 'text', text: `m${index}-${'y'.repeat(TRANSCRIPT_PER_MESSAGE_CHARS + 50)}` }] },
  }))
  const projection = projectTranscript(events, { maxMessages: 3 })
  assert.equal(projection.messages.length, 3)
  assert.equal(projection.truncated, true)
  assert.ok(projection.messages.every(entry => entry.text.length <= TRANSCRIPT_PER_MESSAGE_CHARS + 1))
  assert.equal(projection.messages.at(-1)?.text.startsWith('m9-'), true)
})

test('package contract: bundle patch, client export, plugin keyword', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.keywords.includes('dsh-plugin'))
  assert.ok(pkg.files.includes('index.mjs'))
  assert.ok(pkg.files.includes('client.js'))
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')

  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(patch.includes('id: session-pilot'))
  assert.ok(patch.includes('name: dsh-session-pilot'))
})

test('built host bundle exposes the cordis plugin shape', async () => {
  const host = await import('../index.mjs')
  assert.equal(host.name, 'session-pilot')
  assert.deepEqual(host.inject, ['tools'])
  assert.equal(typeof host.apply, 'function')
})
