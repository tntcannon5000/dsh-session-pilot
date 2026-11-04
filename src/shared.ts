/**
 * Shared value-level contracts between the Newchat host and client halves.
 * Side-effect free: types plus string/number constants and pure functions only.
 */

/** Same-origin endpoint owned by the Newchat host plugin. */
export const SESSION_PILOT_PATH = '/session-pilot'

/** Request bodies are tiny operations; 64 KiB is generous and bounds memory. */
export const MAX_REQUEST_BODY_BYTES = 65536

/**
 * Character budget for the excerpt a "continue in new chat" action carries
 * into the new conversation's first user message.
 */
export const MAX_EXCERPT_CHARS = 4000

/** Create an empty conversation beside the source session. */
export interface SessionPilotBlankOperation {
  readonly action: 'blank'
  readonly sourceSessionId?: string
}

/** Create a conversation and immediately admit one seeded first user message. */
export interface SessionPilotContinueOperation {
  readonly action: 'continue'
  readonly sourceSessionId?: string
  readonly prompt: string
  readonly title?: string
}

export type SessionPilotOperation = SessionPilotBlankOperation | SessionPilotContinueOperation

/** Successful host-side creation result, also the tool's canonical value. */
export interface SessionPilotResult {
  readonly sessionId: string
  readonly title?: string
  readonly workspaceId?: string
  /** Agent preset the new conversation runs, when the Host reported one. */
  readonly agentPreset?: string
}

/** Wire error body. */
export interface SessionPilotError {
  readonly error: string
}

/** Locale dictionary keys owned by this plugin (namespace `session-pilot`). */
export type SessionPilotLocaleKey =
  | 'headerBlank'
  | 'headerBlankTitle'
  | 'continueTitle'
  | 'busy'
  | 'failed'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-pilot': SessionPilotLocaleKey
  }
}

/**
 * Trim and bound one message text for carriage into a new conversation.
 * @returns undefined when nothing visible remains.
 */
export function boundedExcerpt(text: string, max: number = MAX_EXCERPT_CHARS): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n…`
}

/**
 * Compose the first user message of a conversation spawned by the
 * "continue in new chat" action: the excerpt plus neutral continuation
 * guidance. Model-facing, so it is English; the excerpt keeps its own language.
 */
export function composeContinuePrompt(excerpt: string): string {
  return [
    'The user moved the following assistant reply from another conversation into',
    'this new one as the shared context. Continue that discussion here.',
    '',
    '<quoted-context>',
    excerpt,
    '</quoted-context>',
    '',
    "Briefly acknowledge the topic in the excerpt's own language, then either",
    'answer the open question it ends with or ask the user what to do next.',
  ].join('\n')
}
