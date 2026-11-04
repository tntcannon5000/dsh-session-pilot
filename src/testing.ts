/**
 * Testing entry: the pure, Host-independent helpers, re-exported so the
 * node:test suite drives exactly what the bundles ship.
 */
export {
  SESSION_PILOT_PATH,
  MAX_REQUEST_BODY_BYTES,
  MAX_EXCERPT_CHARS,
  boundedExcerpt,
  composeContinuePrompt,
} from './shared.ts'
export type { SessionPilotOperation, SessionPilotResult, SessionPilotLocaleKey } from './shared.ts'
export {
  BodyTooLargeError,
  archiveSession,
  callerContext,
  createSessionPilot,
  decodeOperation,
  inheritPermissionPreset,
  isTrustedRequest,
  listSessions,
  parseArchiveSessionArgs,
  parseListSessionsArgs,
  parseNewConversationArgs,
  parseReadSessionArgs,
  parseRenameSessionArgs,
  projectSessionSummary,
  projectTranscript,
  readJsonBody,
  readSessionTranscript,
  renameSession,
  validatePromptText,
  LIST_SESSIONS_DEFAULT_LIMIT,
  LIST_SESSIONS_MAX_LIMIT,
  READ_SESSION_DEFAULT_MESSAGES,
  READ_SESSION_MAX_MESSAGES,
  TRANSCRIPT_PER_MESSAGE_CHARS,
  TRANSCRIPT_TOTAL_CHARS,
} from './host/core.ts'
