/**
 * Host-side core of Newchat: operation decoding, the HTTP trust fence, and
 * the single `createSessionPilot` transaction shared by the model tool and the
 * same-origin route. Everything goes through the official
 * `sessionController.create` / `rename` / `prompt` seam — the exact code path
 * the Web UI uses — so created conversations are ordinary durable Sessions.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { IncomingMessage } from 'node:http'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  MAX_REQUEST_BODY_BYTES,
  type SessionPilotOperation,
  type SessionPilotResult,
} from '../shared.ts'

/** Loopback hostnames accepted by the HTTP trust fence. */
const TRUSTED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
])

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large')
  }
}

/**
 * Origin/Host loopback fence, mirroring the dsh-turn-fork convention: with an
 * Origin, require a loopback origin whose port matches the server's; without
 * one, require a loopback Host header. A server bound to 0.0.0.0 is already
 * network-exposed by deployment choice, so the Origin check passes there.
 */
export function isTrustedRequest(
  origin: string | undefined,
  host: string | undefined,
  serverHost: '127.0.0.1' | '0.0.0.0',
  serverPort: number,
): boolean {
  if (origin !== undefined) {
    if (serverHost === '0.0.0.0') return true
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (!TRUSTED_HOSTNAMES.has(url.hostname)) return false
    const originPort = url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port)
    return originPort === serverPort
  }
  if (host === undefined) return false
  const withoutPort = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return TRUSTED_HOSTNAMES.has(withoutPort ?? '')
}

/** Read one JSON request body with a hard byte ceiling. */
export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length'] ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      reject(new BodyTooLargeError())
      return
    }
    const chunks: Uint8Array[] = []
    let total = 0
    request.on('data', (chunk: Uint8Array) => {
      total += chunk.length
      if (total > MAX_REQUEST_BODY_BYTES) {
        reject(new BodyTooLargeError())
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const decoder = new TextDecoder()
      const parts: string[] = []
      for (const chunk of chunks) parts.push(decoder.decode(chunk, { stream: true }))
      parts.push(decoder.decode())
      try {
        resolve(JSON.parse(parts.join('')) as unknown)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    request.on('error', reject)
  })
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('request body must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function optionalSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('sourceSessionId must be a non-empty string when present.')
  }
  return value
}

/** Validate the prompt text shared by the tool arguments and the route. */
export function validatePromptText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('prompt must be a string.')
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new TypeError('prompt must not be empty.')
  return value
}

function optionalTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('title must be a non-empty string when present.')
  }
  return value.trim()
}

/** Decode one route operation. */
export function decodeOperation(value: unknown): SessionPilotOperation {
  const record = objectValue(value)
  const sourceSessionId = optionalSessionId(record['sourceSessionId'])
  switch (record['action']) {
    case 'blank':
      return { action: 'blank', ...sourceSessionId === undefined ? {} : { sourceSessionId } }
    case 'continue': {
      const prompt = validatePromptText(record['prompt'])
      const title = optionalTitle(record['title'])
      return {
        action: 'continue',
        ...sourceSessionId === undefined ? {} : { sourceSessionId },
        prompt,
        ...title === undefined ? {} : { title },
      }
    }
    default:
      throw new TypeError('action must be "blank" or "continue".')
  }
}

/** Parsed `new_conversation` tool arguments. */
export interface NewConversationArgs {
  readonly prompt: string
  readonly title?: string
  /** Agent preset for the new conversation; omitted inherits the caller's. */
  readonly preset?: string
}

/** Agent-preset ids are lowercase letters, digits, and hyphens. */
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

function optionalPresetId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('preset must be a non-empty string when present.')
  }
  const trimmed = value.trim()
  if (!PRESET_ID_PATTERN.test(trimmed)) {
    throw new TypeError('preset must be a lowercase preset id such as "standard".')
  }
  return trimmed
}

/**
 * Preset ids the mounted agent-preset registry offers, or undefined when this
 * deployment mounts no roster. Best-effort: a failing registry must not block
 * conversation creation, so the caller falls back to passing the id through.
 */
export async function availablePresetIds(ctx: Context): Promise<string[] | undefined> {
  const registry = ctx.get('agentPresets') as { list(): Promise<readonly { id: string }[]> } | undefined
  if (registry === undefined) return undefined
  try {
    return (await registry.list()).map(preset => preset.id)
  } catch {
    return undefined
  }
}

/** Validate the raw model arguments (raw-JSON-Schema tools self-validate). */
export function parseNewConversationArgs(value: unknown): NewConversationArgs {
  const record = objectValue(value)
  const prompt = validatePromptText(record['prompt'])
  const title = optionalTitle(record['title'])
  const preset = optionalPresetId(record['preset'])
  return {
    prompt,
    ...title === undefined ? {} : { title },
    ...preset === undefined ? {} : { preset },
  }
}

/** Caller facts recoverable from the executing Agent, when one is present. */
export interface CallerContext {
  readonly sessionId?: SessionId
  readonly cwd?: string
  readonly agentPreset?: string
}

/**
 * Read the calling Agent's session facts defensively: a disposed Agent may
 * throw on session access, and tool calls without an owning Agent (manual
 * dispatch) simply create an unanchored conversation. The preset follows the
 * session's latest `agent-preset/selected` event, falling back to the header.
 */
export function callerContext(agent: Agent | undefined): CallerContext {
  if (agent === undefined) return {}
  let sessionId: CallerContext['sessionId']
  try {
    sessionId = agent.id
    const header = agent.session.header
    let agentPreset = header.agentPreset
    try {
      const events = agent.session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'agent-preset/selected') {
          agentPreset = event.data.agentPreset
          break
        }
      }
    } catch {
      // Preset refinement is best-effort; the header value stands.
    }
    return {
      sessionId,
      ...header.cwd === undefined ? {} : { cwd: header.cwd },
      ...agentPreset === undefined ? {} : { agentPreset },
    }
  } catch {
    return sessionId === undefined ? {} : { sessionId }
  }
}

/** Direct workspace attachment of one session, when a registry is mounted. */
export function resolveWorkspace(ctx: Context, sessionId: SessionId | undefined): Workspace | undefined {
  if (sessionId === undefined) return undefined
  const registry = ctx.get('workspaceRegistry') as {
    list(): Workspace[]
  } | undefined
  if (registry === undefined) return undefined
  return registry.list().find(workspace => workspace.sessionIds.includes(sessionId))
}

/** Narrowed face of the session-controller service this plugin consumes. */
export interface SessionControllerFace {
  create(request: {
    workspaceId?: Workspace['id']
    cwd?: string
    agentPreset?: string
  }): Promise<{ sessionId: SessionId; agentPreset?: string }>
  rename(request: { sessionId: SessionId; title: string }): Promise<{ title: string; seq: number }>
  prompt(request: {
    requestId: string
    sessionId: SessionId
    mode: 'queue' | 'steer'
    content: readonly { type: 'text'; text: string }[]
  }, signal: AbortSignal): Promise<{ accepted: true }>
}

function requireSessionController(ctx: Context): SessionControllerFace {
  const controller = ctx.get('sessionController') as SessionControllerFace | undefined
  if (controller === undefined) {
    throw new Error('this deployment mounts no session controller; cannot create conversations')
  }
  return controller
}

export interface CreateSessionPilotInput {
  readonly sourceSessionId?: SessionId
  readonly cwd?: string
  readonly agentPreset?: string
  readonly prompt?: string
  readonly title?: string
  /** Id factory, injectable for tests. */
  readonly requestId?: string
  /** Caller cancellation forwarded to prompt admission (the tool's exec.signal). */
  readonly signal?: AbortSignal
}

/**
 * Create one ordinary Session next to the source: same workspace when the
 * source is attached to one, same cwd otherwise. `create` already attaches
 * the workspace host-side; `rename` and `prompt` follow when requested.
 */
export async function createSessionPilot(ctx: Context, input: CreateSessionPilotInput): Promise<SessionPilotResult> {
  const controller = requireSessionController(ctx)
  const workspace = resolveWorkspace(ctx, input.sourceSessionId)
  const created = await controller.create(
    workspace !== undefined
      ? {
          workspaceId: workspace.id,
          ...input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset },
        }
      : {
          ...input.cwd === undefined ? {} : { cwd: input.cwd },
          ...input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset },
        },
  )
  if (input.title !== undefined) {
    await controller.rename({ sessionId: created.sessionId, title: input.title })
  }
  if (input.prompt !== undefined) {
    await controller.prompt({
      requestId: input.requestId ?? `session-pilot-${crypto.randomUUID()}`,
      sessionId: created.sessionId,
      // 'queue' is the follow-up admission mode on every supported version.
      mode: 'queue',
      content: [{ type: 'text', text: input.prompt }],
    }, input.signal ?? new AbortController().signal)
  }
  return {
    sessionId: created.sessionId,
    ...input.title === undefined ? {} : { title: input.title },
    ...workspace === undefined ? {} : { workspaceId: workspace.id },
    ...created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset },
  }
}

// ---------------------------------------------------------------------------
// Conversation management: rename, list, read, archive
// ---------------------------------------------------------------------------

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string when present.`)
  }
  return value
}

function optionalBoundedLimit(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`)
  }
  return Math.min(value, max)
}

/** Parsed `rename_session` tool arguments. */
export interface RenameSessionArgs {
  readonly title: string
  readonly sessionId?: string
}

export function parseRenameSessionArgs(value: unknown): RenameSessionArgs {
  const record = objectValue(value)
  const title = optionalTitle(record['title'])
  if (title === undefined) throw new TypeError('title must be a non-empty string.')
  const sessionId = optionalSessionId(record['sessionId'])
  return { title, ...sessionId === undefined ? {} : { sessionId } }
}

/** Parsed `list_sessions` tool arguments. */
export interface ListSessionsArgs {
  readonly query?: string
  readonly limit: number
}

export const LIST_SESSIONS_DEFAULT_LIMIT = 20
export const LIST_SESSIONS_MAX_LIMIT = 100

export function parseListSessionsArgs(value: unknown): ListSessionsArgs {
  if (value === undefined || value === null) return { limit: LIST_SESSIONS_DEFAULT_LIMIT }
  const record = objectValue(value)
  const query = optionalNonEmptyString(record['query'], 'query')
  const limit = optionalBoundedLimit(record['limit'], 'limit', LIST_SESSIONS_DEFAULT_LIMIT, LIST_SESSIONS_MAX_LIMIT)
  return { ...query === undefined ? {} : { query: query.trim() }, limit }
}

/** Parsed `read_session` tool arguments. */
export interface ReadSessionArgs {
  readonly sessionId?: string
  readonly maxMessages: number
}

export const READ_SESSION_DEFAULT_MESSAGES = 30
export const READ_SESSION_MAX_MESSAGES = 100

export function parseReadSessionArgs(value: unknown): ReadSessionArgs {
  if (value === undefined || value === null) return { maxMessages: READ_SESSION_DEFAULT_MESSAGES }
  const record = objectValue(value)
  const sessionId = optionalSessionId(record['sessionId'])
  const maxMessages = optionalBoundedLimit(
    record['maxMessages'], 'maxMessages', READ_SESSION_DEFAULT_MESSAGES, READ_SESSION_MAX_MESSAGES,
  )
  return {
    ...sessionId === undefined ? {} : { sessionId },
    maxMessages,
  }
}

/** Parsed `archive_session` tool arguments. */
export interface ArchiveSessionArgs {
  readonly sessionId?: string
}

export function parseArchiveSessionArgs(value: unknown): ArchiveSessionArgs {
  if (value === undefined || value === null) return {}
  const record = objectValue(value)
  const sessionId = optionalSessionId(record['sessionId'])
  return sessionId === undefined ? {} : { sessionId }
}

/** Narrowed face of the session-query service (live-preferred full reads). */
export interface SessionQueryFace {
  readSession(sessionId: SessionId): Promise<{
    session: { id: SessionId } & Record<string, unknown>
    events: readonly unknown[]
  }>
  readTitle?(sessionId: SessionId, signal?: AbortSignal): Promise<{ title: string } | undefined>
}

/** Controller face additions used by the management tools. */
export interface SessionControllerListFace {
  list(request: Record<string, never>, signal: AbortSignal): Promise<{
    items: readonly Record<string, unknown>[]
  }>
  search(request: { query: string }, signal: AbortSignal): Promise<{
    items: readonly { sessionId: string; snippet: string }[]
    hasMore: boolean
  }>
}

/** Compact list row projected from one SessionSummary. */
export interface SessionListRow {
  readonly sessionId: string
  readonly title: string | null
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
  readonly cwd?: string
  readonly parentSessionId?: string
}

/** Project one wire SessionSummary into the compact row the model consumes. */
export function projectSessionSummary(summary: Record<string, unknown>): SessionListRow {
  const projections = summary['projections'] as { values?: Record<string, unknown> } | undefined
  const titleValue = projections?.values?.['title']
  const cwd = summary['cwd']
  const parentSessionId = summary['parentSessionId']
  return {
    sessionId: String(summary['sessionId']),
    title: typeof titleValue === 'string' ? titleValue : null,
    running: summary['running'] === true,
    blank: summary['blank'] === true,
    updatedAt: typeof summary['updatedAt'] === 'number' ? summary['updatedAt'] : 0,
    ...typeof cwd === 'string' ? { cwd } : {},
    ...typeof parentSessionId === 'string' ? { parentSessionId } : {},
  }
}

/** List visible sessions (or content-search them), newest activity first. */
export async function listSessions(
  ctx: Context,
  input: { query?: string; limit: number; signal?: AbortSignal },
): Promise<{ items: readonly unknown[]; hasMore: boolean }> {
  const controller = ctx.get('sessionController') as SessionControllerFace & SessionControllerListFace | undefined
  if (controller === undefined) {
    throw new Error('this deployment mounts no session controller; cannot list conversations')
  }
  const signal = input.signal ?? new AbortController().signal
  if (input.query !== undefined) {
    const result = await controller.search({ query: input.query }, signal)
    return { items: result.items.slice(0, input.limit), hasMore: result.hasMore }
  }
  const result = await controller.list({}, signal)
  const items = result.items.slice(0, input.limit).map(projectSessionSummary)
  return { items, hasMore: result.items.length > input.limit }
}

/** One transcript entry: a user or assistant text message, bounded. */
export interface TranscriptEntry {
  readonly role: 'user' | 'assistant'
  readonly turn?: number
  readonly seq: number
  readonly text: string
}

export interface TranscriptProjection {
  readonly messages: readonly TranscriptEntry[]
  /** True when older messages were dropped by the bounds. */
  readonly truncated: boolean
}

export const TRANSCRIPT_PER_MESSAGE_CHARS = 600
export const TRANSCRIPT_TOTAL_CHARS = 12000

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
      const candidate = block as { type?: unknown; text?: unknown }
      if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
    }
  }
  return parts.join('\n\n')
}

function boundText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Project raw session events into the latest user/assistant text messages,
 * bounded per message, per count, and in total characters.
 */
export function projectTranscript(
  events: readonly unknown[],
  options: { maxMessages?: number; maxCharsPerMessage?: number; maxTotalChars?: number } = {},
): TranscriptProjection {
  const maxMessages = options.maxMessages ?? READ_SESSION_DEFAULT_MESSAGES
  const perMessage = options.maxCharsPerMessage ?? TRANSCRIPT_PER_MESSAGE_CHARS
  const totalBudget = options.maxTotalChars ?? TRANSCRIPT_TOTAL_CHARS
  const entries: TranscriptEntry[] = []
  for (const candidate of events) {
    const event = candidate as {
      type?: unknown
      seq?: unknown
      data?: Record<string, unknown> | undefined
    }
    if (event.type === 'user/message' && event.data !== undefined) {
      const text = textOfContent(event.data['content'])
      if (text.trim().length === 0) continue
      entries.push({
        role: 'user',
        seq: typeof event.seq === 'number' ? event.seq : 0,
        text: boundText(text, perMessage),
      })
      continue
    }
    if (event.type === 'assistant/message' && event.data !== undefined) {
      const message = event.data['message'] as { content?: unknown } | undefined
      const text = textOfContent(message?.content)
      if (text.trim().length === 0) continue
      const turn = event.data['turn']
      entries.push({
        role: 'assistant',
        ...typeof turn === 'number' ? { turn } : {},
        seq: typeof event.seq === 'number' ? event.seq : 0,
        text: boundText(text, perMessage),
      })
    }
  }
  const latest = entries.slice(-maxMessages)
  const messages: TranscriptEntry[] = []
  let total = 0
  for (let index = latest.length - 1; index >= 0; index -= 1) {
    const entry = latest[index]
    if (entry === undefined) continue
    if (total + entry.text.length > totalBudget) break
    total += entry.text.length
    messages.unshift(entry)
  }
  return { messages, truncated: messages.length < entries.length }
}

/** Read one session's compact transcript through the session-query seam. */
export async function readSessionTranscript(
  ctx: Context,
  input: { sessionId: SessionId; maxMessages: number; signal?: AbortSignal },
): Promise<{ sessionId: string; title: string | null; messages: readonly TranscriptEntry[]; truncated: boolean }> {
  const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
  if (query === undefined) {
    throw new Error('this deployment mounts no session-query service; cannot read conversations')
  }
  const snapshot = await query.readSession(input.sessionId)
  let title: string | null = null
  if (query.readTitle !== undefined) {
    try {
      const snapshotTitle = await query.readTitle(input.sessionId, input.signal)
      title = snapshotTitle === undefined ? null : snapshotTitle.title
    } catch {
      title = null
    }
  }
  const projection = projectTranscript(snapshot.events, { maxMessages: input.maxMessages })
  return {
    sessionId: input.sessionId,
    title,
    messages: projection.messages,
    truncated: projection.truncated,
  }
}

/** Rename one session through the official controller seam. */
export async function renameSession(
  ctx: Context,
  input: { sessionId: SessionId; title: string },
): Promise<{ sessionId: string; title: string }> {
  const controller = requireSessionController(ctx)
  const renamed = await controller.rename({ sessionId: input.sessionId, title: input.title })
  return { sessionId: input.sessionId, title: renamed.title }
}

/** Archive one session out of its workspace's session list. */
export async function archiveSession(
  ctx: Context,
  input: { sessionId: SessionId },
): Promise<{ sessionId: string; archived: true }> {
  const registry = ctx.get('workspaceRegistry') as {
    archiveSession(sessionId: SessionId): Promise<void>
  } | undefined
  if (registry === undefined) {
    throw new Error('this deployment mounts no workspace registry; cannot archive conversations')
  }
  await registry.archiveSession(input.sessionId)
  return { sessionId: input.sessionId, archived: true }
}
