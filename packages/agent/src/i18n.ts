import type { Locale } from '@pleatkit/runtime/compiler'

/**
 * Progress lines and fixed summaries the end user reads in the chat (DECISIONS items 10 and 20): plain
 * language, no code, file names or technical terms. `{name}` is a panel name such as "customer card".
 */
const en = {
  understanding: 'Understanding the request',
  classifiedBackend: 'This needs a change on the server',
  classifiedUi: 'This can be done on the page',
  classifiedUnclear: 'I need one detail first',
  thinkingOver: 'Thinking it over',
  planning: 'Planning the change',
  thinking: 'Thinking',
  lookingAround: 'Looking around the page',
  looking: 'Looking at {name}',
  changing: 'Changing {name}',
  checking: 'Checking that everything still works',
  checkOk: 'Everything works',
  checkFailed: 'Found a problem, fixing it',
  wrappingUp: 'Wrapping up',
  working: 'Working',
  panel: 'the {name}',
  helper: 'a helper of the page',
  dataHelpers: "the app's data and helpers",
  page: 'the page',
  needsBackendDefault: 'This needs a change on the server, so I passed it to the administrator.',
  outOfTime: 'I ran out of time ({seconds} s) and did not change anything.',
  cancelled: 'Cancelled.',
  agentFailed: 'Something went wrong on our side and nothing was changed. Please try again.',
  limitCalls: 'I reached the limit of {n} steps and did not change anything.',
  limitOutput: 'The change turned out too large for one request and nothing was changed. Try asking for a smaller part of it.',
  refused: 'I cannot help with this request, so nothing was changed.',
  noFinish: 'I could not finish this change, so nothing was changed.',
  limitCost: 'This change turned out more expensive than one request may be, so nothing was changed. Try asking for a smaller part of it.',
  offTopic: 'I can only change how this app looks and works for you. Ask me about its pages and panels.',
  quotaUser: 'You have reached today’s limit of changes. It refills over the day; please try again later.',
  quotaApp: 'Customizing is paused for this app for now because today’s limit is reached. Please try again later.',
  disabled: 'Customizing is switched off for this app right now.',
}

export type MessageKey = keyof typeof en

const ru: Record<MessageKey, string> = {
  understanding: 'Разбираюсь в запросе',
  classifiedBackend: 'Для этого нужна правка на сервере',
  classifiedUi: 'Это можно сделать на странице',
  classifiedUnclear: 'Сначала уточню одну деталь',
  thinkingOver: 'Обдумываю',
  planning: 'Планирую изменение',
  thinking: 'Думаю',
  lookingAround: 'Осматриваю страницу',
  looking: 'Смотрю {name}',
  changing: 'Меняю {name}',
  checking: 'Проверяю, что всё работает',
  checkOk: 'Всё работает',
  checkFailed: 'Нашёл ошибку, исправляю',
  wrappingUp: 'Заканчиваю',
  working: 'Работаю',
  panel: 'панель «{name}»',
  helper: 'вспомогательную часть страницы',
  dataHelpers: 'данные и помощники приложения',
  page: 'страницу',
  needsBackendDefault: 'Для этого нужна правка на сервере, поэтому я передал запрос администратору.',
  outOfTime: 'Не уложился во время ({seconds} с), ничего не изменено.',
  cancelled: 'Отменено.',
  agentFailed: 'У нас что-то пошло не так, ничего не изменено. Попробуйте ещё раз.',
  limitCalls: 'Дошёл до предела в {n} шагов, ничего не изменено.',
  limitOutput: 'Изменение оказалось слишком большим для одного запроса, ничего не изменено. Попробуйте попросить часть.',
  refused: 'С этим запросом я помочь не могу, ничего не изменено.',
  noFinish: 'Не смог довести изменение до конца, ничего не изменено.',
  limitCost: 'Изменение оказалось дороже, чем разрешено для одного запроса, ничего не изменено. Попробуйте попросить часть.',
  offTopic: 'Я могу менять только то, как это приложение выглядит и работает у вас. Спросите про его страницы и панели.',
  quotaUser: 'На сегодня лимит изменений исчерпан. Он восстанавливается в течение дня, попробуйте позже.',
  quotaApp: 'Настройка в этом приложении временно приостановлена: дневной лимит исчерпан. Попробуйте позже.',
  disabled: 'Настройка интерфейса в этом приложении сейчас выключена.',
}

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, ru }

export function normalizeLocale(locale: unknown): Locale {
  return locale === 'ru' ? 'ru' : 'en'
}

/** Translate `key` into `locale`, filling `{param}` placeholders. */
export function t(locale: Locale | undefined, key: MessageKey, params: Record<string, string | number> = {}): string {
  const text = MESSAGES[normalizeLocale(locale)][key]
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}
