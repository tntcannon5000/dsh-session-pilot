/**
 * Browser half of Newchat: a header action for blank conversations and a
 * per-assistant-message action for excerpt-seeded continuation — all through
 * official slots, no DOM injection. Copy ships through the `session-pilot` locale
 * namespace (zh/en); without the locale service a local template
 * interpolator falls back to the English dictionary.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session/types'
import type { SessionPilotLocaleKey } from '../shared.ts'
import { SessionPilotController } from './controller.ts'
import { SESSION_PILOT_EN, SESSION_PILOT_ZH } from './locales.ts'
import { ContinueInSessionPilotAction } from './ContinueInSessionPilotAction.tsx'

export const inject = ['slots', 'conversation', 'connection', 'sessions']

/** Browser context narrowed away from the host SessionStore augmentation. */
type ClientContext = Omit<Context, 'sessions'> & { readonly sessions: ISessions }

function templateFallback(template: string, params?: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (
    params === undefined || params[name] === undefined ? `{${name}}` : String(params[name])
  ))
}

/** Register both UI contributions over one per-session controller identity. */
export function apply(ctx: ClientContext): void {
  const locale = ctx.get('locale')
  const t: Translate<SessionPilotLocaleKey> = locale !== undefined
    ? locale.bind('session-pilot')
    : (key, params) => templateFallback(SESSION_PILOT_EN[key], params)

  if (locale !== undefined) {
    ctx.effect(() => locale.register('session-pilot', {
      zh: SESSION_PILOT_ZH,
      en: SESSION_PILOT_EN,
    }), 'session-pilot: locale dictionaries')
  }

  const controllers = new Map<SessionIdType, SessionPilotController>()
  const controllerFor = (sessionId: SessionIdType): SessionPilotController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new SessionPilotController(ctx, sessionId, t)
      controllers.set(sessionId, controller)
    }
    return controller
  }

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'session-pilot-continue',
    order: 110,
    ...locale === undefined ? {} : { locale: 'session-pilot' as const },
    inject: sessionId => controllerFor(SessionId(sessionId)).face,
  }, ContinueInSessionPilotAction))
}
