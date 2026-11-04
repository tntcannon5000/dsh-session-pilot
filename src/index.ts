/**
 * Host half of Session Kit: manage conversations from inside a conversation.
 *
 * Model tools:
 * - `new_conversation` — spin a topic or task off into its own independent
 *   sidebar conversation with a seeded first user message;
 * - `rename_session` — rename a conversation (defaults to the current one);
 * - `list_sessions` — list (or content-search) the user's conversations;
 * - `read_session` — read a compact transcript of one conversation;
 * - `archive_session` — archive a conversation out of its workspace list.
 *
 * Plus a same-origin, trust-fenced `/session-pilot` route the Client half's
 * official slot buttons call for blank and excerpt-seeded creation.
 *
 * Everything runs through official seams — `sessionController.create` /
 * `rename` / `prompt` / `list` / `search`, `sessionQuery.readSession`, and
 * `workspaceRegistry.archiveSession` — the same code paths the Web UI uses.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import {
  SESSION_PILOT_PATH,
  type SessionPilotError,
  type SessionPilotResult,
} from './shared.ts'
import {
  BodyTooLargeError,
  archiveSession,
  availablePresetIds,
  callerContext,
  createSessionPilot,
  decodeOperation,
  isTrustedRequest,
  listSessions,
  parseArchiveSessionArgs,
  parseListSessionsArgs,
  parseNewConversationArgs,
  parseReadSessionArgs,
  parseRenameSessionArgs,
  readJsonBody,
  readSessionTranscript,
  renameSession,
  validatePromptText,
} from './host/core.ts'

/** Stable Cordis plugin name. */
export const name = 'session-pilot'

/**
 * Hard dependency: the tool registry. The webServer and workspaceRegistry
 * services stay optional — a headless profile loads the tools and skips the
 * HTTP route, and a session outside every workspace simply creates by cwd.
 */
export const inject = ['tools']

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Resolve the target session: explicit argument, else the calling session. */
function targetSessionId(explicit: string | undefined, exec: ToolRunContext): SessionIdType {
  if (explicit !== undefined) return SessionId(explicit)
  const caller = callerContext(exec.agent)
  if (caller.sessionId === undefined) {
    throw new TypeError('sessionId is required when the calling session cannot be determined.')
  }
  return caller.sessionId
}

const NEW_CONVERSATION_DESCRIPTION = [
  'Create a brand-new top-level conversation and start it with an initial user',
  'message. Use when a topic or task deserves its own independent conversation',
  'that the user can open from the sidebar — for example spinning off a side',
  'question, or handing a well-scoped task a fresh context. The new',
  'conversation shares no history with this one: put everything it needs into',
  '`prompt`. It continues in this conversation\'s agent mode by default: pass',
  '`preset` only when the new conversation genuinely needs a different one,',
  'such as an autonomous or specialized mode for the task being handed off;',
  'otherwise omit it. It is created in the same workspace as this conversation and',
  'starts running immediately. Returns the new session id; tell the user they',
  'can open it from the session list. For background work that should report',
  'back into this conversation, prefer subagent instead.',
].join(' ')

/** The `new_conversation` model tool bound to this plugin's context. */
function newConversationTool(ctx: Context): ToolDefinition {
  return {
    name: 'new_conversation',
    description: NEW_CONVERSATION_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The complete first user message for the new conversation. '
            + 'Self-contained: include every fact, path, and decision it needs.',
        },
        title: {
          type: 'string',
          description: 'Optional short title for the new conversation.',
        },
        preset: {
          type: 'string',
          description: 'Optional agent-preset id, only when the new conversation needs a '
            + 'different mode than this one (for example an autonomous mode). Omit to '
            + 'inherit this conversation\'s preset, which is the default.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          workspaceId: { type: 'string' },
          agentPreset: { type: 'string' },
          accepted: { type: 'boolean' },
        },
        required: ['sessionId', 'accepted'],
      },
      render: (_args, value) => {
        const record = recordOf(value)
        const title = typeof record['title'] === 'string' ? ` "${record['title']}"` : ''
        const preset = typeof record['agentPreset'] === 'string'
          ? ` in the ${record['agentPreset']} preset`
          : ''
        return textBlock(
          `New conversation${title} created${preset} (session ${String(record['sessionId'] ?? '?')}). `
          + 'It is running with your initial message. Tell the user they can open it '
          + 'from the session list in the sidebar.',
        )
      },
    },
    async execute(args, exec) {
      const parsed = parseNewConversationArgs(args)
      const caller = callerContext(exec.agent)
      if (parsed.preset !== undefined) {
        const roster = await availablePresetIds(ctx)
        if (roster !== undefined && !roster.includes(parsed.preset)) {
          throw new TypeError(
            `unknown agent preset "${parsed.preset}"; available presets: ${roster.join(', ')}`,
          )
        }
      }
      const agentPreset = parsed.preset ?? caller.agentPreset
      const result: SessionPilotResult = await createSessionPilot(ctx, {
        ...caller.sessionId === undefined ? {} : { sourceSessionId: caller.sessionId },
        ...caller.cwd === undefined ? {} : { cwd: caller.cwd },
        ...agentPreset === undefined ? {} : { agentPreset },
        prompt: parsed.prompt,
        ...parsed.title === undefined ? {} : { title: parsed.title },
        signal: exec.signal,
      })
      return { ...result, accepted: true }
    },
  }
}

/** The `rename_session` model tool. */
function renameSessionTool(ctx: Context): ToolDefinition {
  return {
    name: 'rename_session',
    description: 'Rename a conversation. Defaults to the current conversation when sessionId is omitted.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The new conversation title.' },
        sessionId: { type: 'string', description: 'Target session id. Omit for the current conversation.' },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['sessionId', 'title'],
      },
      render: (_args, value) => {
        const record = recordOf(value)
        return textBlock(`Renamed conversation ${String(record['sessionId'])} to "${String(record['title'])}".`)
      },
    },
    async execute(args, exec) {
      const parsed = parseRenameSessionArgs(args)
      const sessionId = targetSessionId(parsed.sessionId, exec)
      return renameSession(ctx, { sessionId, title: parsed.title })
    },
  }
}

/** The `list_sessions` model tool. */
function listSessionsTool(ctx: Context): ToolDefinition {
  return {
    name: 'list_sessions',
    description: 'List the user\'s conversations, most recently active first, with title, running state, '
      + 'and workspace directory. Pass `query` to search message content instead of listing recent conversations.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional literal content query; searches conversation messages.' },
        limit: { type: 'number', description: `Maximum rows, 1-100. Defaults to 20.` },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', items: { type: 'object' } },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'hasMore'],
      },
      render: (_args, value) => {
        const record = recordOf(value)
        const items = Array.isArray(record['items']) ? record['items'] : []
        const lines = items.map((candidate) => {
          const row = recordOf(candidate)
          const title = typeof row['title'] === 'string' ? row['title'] : '(untitled)'
          const running = row['running'] === true ? ' (running)' : ''
          const snippet = typeof row['snippet'] === 'string' ? ` — ${row['snippet']}` : ''
          return `- ${title} [${String(row['sessionId'])}]${running}${snippet}`
        })
        const more = record['hasMore'] === true ? '\n…more results available.' : ''
        return textBlock(lines.length === 0 ? 'No conversations found.' : `${lines.join('\n')}${more}`)
      },
    },
    async execute(args, exec) {
      const parsed = parseListSessionsArgs(args)
      return listSessions(ctx, { ...parsed, signal: exec.signal })
    },
  }
}

/** The `read_session` model tool. */
function readSessionTool(ctx: Context): ToolDefinition {
  return {
    name: 'read_session',
    description: 'Read a compact transcript of one conversation: its latest user and assistant text '
      + 'messages, bounded for review. Defaults to the current conversation. Use to check what happened '
      + 'in another conversation before referencing, renaming, or archiving it.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session id. Omit for the current conversation.' },
        maxMessages: { type: 'number', description: 'Maximum transcript messages, 1-100. Defaults to 30.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', enum: ['user', 'assistant'] },
                turn: { type: 'number' },
                seq: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['role', 'seq', 'text'],
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['sessionId', 'messages', 'truncated'],
      },
      render: (_args, value) => {
        const record = recordOf(value)
        const title = typeof record['title'] === 'string' ? record['title'] : String(record['sessionId'])
        const messages = Array.isArray(record['messages']) ? record['messages'] : []
        const lines = messages.map((candidate) => {
          const entry = recordOf(candidate)
          return `${entry['role'] === 'user' ? 'U' : 'A'}: ${String(entry['text'] ?? '')}`
        })
        const truncated = record['truncated'] === true ? ' (older messages truncated)' : ''
        return textBlock(`# ${title}${truncated}\n\n${lines.join('\n\n')}`)
      },
    },
    async execute(args, exec) {
      const parsed = parseReadSessionArgs(args)
      const sessionId = targetSessionId(parsed.sessionId, exec)
      const result = await readSessionTranscript(ctx, {
        sessionId,
        maxMessages: parsed.maxMessages,
        signal: exec.signal,
      })
      if (result.title === null) {
        const { title: _dropped, ...rest } = result
        return rest
      }
      return result
    },
  }
}

/** The `archive_session` model tool. */
function archiveSessionTool(ctx: Context): ToolDefinition {
  return {
    name: 'archive_session',
    description: 'Archive a conversation: remove it from its workspace\'s session list while retaining '
      + 'the durable log. Defaults to the current conversation. Use to tidy the sidebar after a topic '
      + 'is done; the user can still find the session through search.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session id. Omit for the current conversation.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          archived: { type: 'boolean' },
        },
        required: ['sessionId', 'archived'],
      },
      render: (_args, value) => {
        const record = recordOf(value)
        return textBlock(`Archived conversation ${String(record['sessionId'])}. It no longer appears in its workspace's session list.`)
      },
    },
    async execute(args, exec) {
      const parsed = parseArchiveSessionArgs(args)
      const sessionId = targetSessionId(parsed.sessionId, exec)
      return archiveSession(ctx, { sessionId })
    },
  }
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function respondError(response: ServerResponse, status: number, error: unknown): void {
  const body: SessionPilotError = { error: error instanceof Error ? error.message : String(error) }
  respondJson(response, status, body)
}

async function handleRoute(
  ctx: Context,
  webServer: import('@deepseek-ai/dsh-host-webserver').WebServer,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isTrustedRequest(request.headers.origin, request.headers.host, webServer.host, webServer.port)) {
    respondError(response, 403, new Error('request rejected by the trust fence (Origin/Host not allowed).'))
    return
  }
  try {
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end()
      return
    }
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') throw new TypeError('POST must carry application/json.')
    const operation = decodeOperation(await readJsonBody(request))
    const result = await createSessionPilot(ctx, {
      ...operation.sourceSessionId === undefined
        ? {}
        : { sourceSessionId: SessionId(operation.sourceSessionId) },
      ...operation.action === 'continue'
        ? {
            prompt: validatePromptText(operation.prompt),
            ...operation.title === undefined ? {} : { title: operation.title },
          }
        : {},
    })
    respondJson(response, 200, result)
  } catch (error: unknown) {
    const status = error instanceof BodyTooLargeError ? 413 : error instanceof TypeError ? 400 : 409
    respondError(response, status, error)
  }
}

/** Register the tools and, where a web server exists, the reversible route. */
export function apply(ctx: Context): void {
  ctx.tools.register(newConversationTool(ctx))
  ctx.tools.register(renameSessionTool(ctx))
  ctx.tools.register(listSessionsTool(ctx))
  ctx.tools.register(readSessionTool(ctx))
  ctx.tools.register(archiveSessionTool(ctx))

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    return webServer.register({
      kind: 'exact',
      path: SESSION_PILOT_PATH,
      handler: (request, response) => handleRoute(webCtx, webServer, request, response),
    })
  })
}

export {
  boundedExcerpt,
  composeContinuePrompt,
  MAX_EXCERPT_CHARS,
  SESSION_PILOT_PATH,
} from './shared.ts'
export {
  archiveSession,
  availablePresetIds,
  callerContext,
  createSessionPilot,
  decodeOperation,
  isTrustedRequest,
  listSessions,
  parseArchiveSessionArgs,
  parseListSessionsArgs,
  parseNewConversationArgs,
  parseReadSessionArgs,
  parseRenameSessionArgs,
  projectSessionSummary,
  projectTranscript,
  readSessionTranscript,
  renameSession,
  validatePromptText,
} from './host/core.ts'
