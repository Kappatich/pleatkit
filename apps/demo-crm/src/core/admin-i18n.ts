import type { Locale } from '@pleatkit/runtime'
import { translator, type UiKey } from '@pleatkit/ui'

/**
 * Strings that only the admin v3 layout uses (brainstorm 14 §5, DECISIONS 56). The shared en/ru dictionary
 * (DECISIONS 20) lives in @pleatkit/ui, which the architect owns; these keys stay here until they move there.
 * Everything else falls through to the shared dictionary.
 */
const en = {
  'adm.week': 'This week:',
  'adm.week.requests': '{n} requests',
  'adm.week.requests.one': '{n} request',
  'adm.week.applied': '{n} applied',
  'adm.week.backend': '{n} needs backend',
  'adm.filter.review': 'Awaiting review',
  'adm.filter.review.tip': 'Show only edits awaiting review',
  'adm.filter.all.tip': 'Show all requests',
  'adm.reviewChip': 'Review: {state}',
  'adm.on': 'on',
  'adm.off': 'off',
  'adm.reviewChip.tip': 'Change it in Settings, top right',
  'adm.settings': 'Settings',
  'adm.col.time': 'Time',
  'adm.col.outcome': 'Outcome',
  'adm.open': 'Show details',
  'adm.undoFor': 'Undo for {user}',
  'adm.undoFor.tip': '{user} goes back to the version before this edit. Nothing else changes.',
  'adm.approve.tip': 'Keep this edit. It leaves the review queue; nothing changes for the user.',
  'adm.reject.tip': 'Mark the request as rejected. If the edit is live, the user goes back to the version before it.',
  'adm.take.tip': 'Mark the request as taken into work by your team.',
  'adm.tech': 'Technical details',
  'adm.files': 'Files after the edit',
  'adm.unchanged': '{n} unchanged lines',
  'adm.toolCalls': '{n} tool calls',
  'adm.changed': '{n} files changed',
  'adm.changed.one': '{n} file changed',
}

type AdminKey = keyof typeof en

const ru: Record<AdminKey, string> = {
  'adm.week': 'За неделю:',
  'adm.week.requests': 'запросов {n}',
  'adm.week.requests.one': 'запросов {n}',
  'adm.week.applied': 'применено {n}',
  'adm.week.backend': 'нужен бэкенд {n}',
  'adm.filter.review': 'Ждут проверки',
  'adm.filter.review.tip': 'Показать только правки, которые ждут проверки',
  'adm.filter.all.tip': 'Показать все запросы',
  'adm.reviewChip': 'Проверка: {state}',
  'adm.on': 'вкл',
  'adm.off': 'выкл',
  'adm.reviewChip.tip': 'Меняется в настройках справа вверху',
  'adm.settings': 'Настройки',
  'adm.col.time': 'Время',
  'adm.col.outcome': 'Итог',
  'adm.open': 'Подробнее',
  'adm.undoFor': 'Отменить у {user}',
  'adm.undoFor.tip': '{user} вернётся к версии до этой правки. Больше ничего не меняется.',
  'adm.approve.tip': 'Оставить правку. Она уходит из очереди проверки; у пользователя ничего не меняется.',
  'adm.reject.tip': 'Отметить запрос отклонённым. Если правка действует, пользователь вернётся к версии до неё.',
  'adm.take.tip': 'Отметить, что команда взяла запрос в работу.',
  'adm.tech': 'Технические подробности',
  'adm.files': 'Файлы после правки',
  'adm.unchanged': 'без изменений строк: {n}',
  'adm.toolCalls': 'вызовов инструментов: {n}',
  'adm.changed': 'изменено файлов: {n}',
  'adm.changed.one': 'изменено файлов: {n}',
}

export type AdminTranslate = (key: AdminKey | UiKey, params?: Record<string, string | number>) => string

/** The shared translator plus the admin-only keys above. */
export function adminTranslator(locale: Locale = 'en'): AdminTranslate {
  const shared = translator(locale)
  const dict: Record<AdminKey, string> = locale === 'ru' ? ru : en
  return (key, params = {}) =>
    key in en
      ? (dict[key as AdminKey] ?? en[key as AdminKey]).replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
      : shared(key as UiKey, params)
}
