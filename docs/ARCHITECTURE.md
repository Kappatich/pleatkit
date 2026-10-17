# Morphkit: архитектура демо

Рабочее имя: **morphkit** (npm scope `@morphkit/*`). Либа, которая позволяет агенту внутри веб-приложения переписывать разрешённые части интерфейса в рантайме, с коммитом, откатом и персональными версиями на пользователя.

Решения приняты 2026-10-17: архитектура здесь (Fable 5.1), код пишет Opus 5.5 high. Локальные модели не используем. Провайдер модели по умолчанию Anthropic через ключ клиента (BYOK), провайдер сменный.

Контекст и обоснование: `../../polymorphic_ui_plan.md`, спека автора: `../../telegram_posts.md` (пост 100).

---

## 1. Принципы

1. **Три зоны в проекте клиента.** `core` компилируется и минифицируется, агент видит только `.d.ts`. `readonly` агент читает как исходник, но не правит. `dynamic` агент правит, и именно эта папка собирается в рантайме. Зоны задаются в конфиге плагина Vite по глобам.
2. **Снимок, а не патч.** Состояние динамической зоны пользователя это полный снимок файлов (`Snapshot`). Версии это цепочка снимков. Undo это переход к родительскому снимку. Никаких diff-форматов в MVP.
3. **Черновик → коммит.** Агент пишет в черновик (`draft`). Приложение не меняется, пока не вызван `commit`. Коммит компилирует весь `dynamic` целиком; если ошибка, коммит отклонён, агент получает текст ошибки. Это пункт 7 спеки.
4. **Подмена без перезагрузки.** Каждый файл динамической зоны экспортирует React-компоненты. Приложение обращается к ним через `<Dynamic id="customer-card" />`, а не через import. Рантайм держит реестр `id → текущий модуль` и перерисовывает при коммите.
5. **Ключ модели никогда не в браузере.** Агент работает на сервере клиента (`@morphkit/agent`, Node). Браузер общается с ним по HTTP/SSE.
6. **Хранилище сменное.** Интерфейс `SnapshotStore` с двумя реализациями: `LocalStore` (IndexedDB, для демо и десктопа) и `HttpStore` (наш сервер, Postgres). Выбор в конфиге рантайма.
7. **Песочница по уровням.** В MVP правки пользователя выполняются в том же окне (угроза только себе). Режим `isolated: true` рендерит динамические компоненты в iframe с `sandbox="allow-scripts"` и CSP. Делаем как флаг, в демо показываем оба.

---

## 2. Монорепо

```
morphkit/
  package.json            pnpm workspaces, turbo не нужен
  pnpm-workspace.yaml
  packages/
    vite-plugin/          @morphkit/vite-plugin
    runtime/              @morphkit/runtime      (браузер)
    agent/                @morphkit/agent        (Node)
    ui/                   @morphkit/ui           (чат-шторка, выделение элемента)
    store-server/         @morphkit/store-server (Node + Postgres или SQLite для демо)
  apps/
    demo-crm/             Vite + React + TS + Tailwind + shadcn
    admin/                дашборд администратора (можно внутри demo-crm как /admin)
  docs/
    ARCHITECTURE.md       этот файл
    TASKS.md              разбивка на этапы
```

Стек: TypeScript 5.x, Node 22, pnpm, Vite 6, React 19, Tailwind 4, shadcn/ui, Vitest, Playwright (headless, никаких окон на экране Minte), esbuild-wasm, Hono для серверов, Drizzle + SQLite (better-sqlite3) для демо, Postgres через тот же Drizzle для прода.

---

## 3. `@morphkit/vite-plugin`

```ts
// vite.config.ts у клиента
import morphkit from '@morphkit/vite-plugin'
export default defineConfig({
  plugins: [react(), morphkit({
    zones: {
      dynamic:  ['src/dynamic/**'],
      readonly: ['src/readonly/**', 'src/components/ui/**'],
      // всё остальное = core
    },
    externals: ['react', 'react-dom', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils'],
  })]
})
```

Что делает:
1. На сборке и в dev собирает **манифест** `morphkit.manifest.json`:
   - `dynamic`: `{ path, source }` для каждого файла (исходник TSX как есть), это **базовый снимок** (`baseSnapshot`), версия 0 для каждого нового пользователя;
   - `readonly`: `{ path, source }` исходники для чтения агентом;
   - `coreTypes`: `.d.ts` для `core`, сгенерированные `tsc --declaration --emitDeclarationOnly` (в демо можно ограничиться `.d.ts` для файлов, которые `dynamic` импортирует);
   - `externals`: список имён, которые рантайм подставит из реестра.
2. Виртуальный модуль `virtual:morphkit/manifest` импортирует манифест в приложение.
3. Виртуальный модуль `virtual:morphkit/externals` генерирует реестр: `{ 'react': React, '@/components/ui/button': () => import('...') ... }`. Externals с `*` раскрываются по файловой системе на этапе сборки.
4. Файлы из `dynamic` в основной бандл **тоже попадают** как fallback (чтобы приложение работало до первой правки и чтобы SSR/первая отрисовка не ждали esbuild-wasm). Рантайм на старте использует fallback, если у пользователя нет снимков.

---

## 4. `@morphkit/runtime` (браузер)

Состояние на этап 4b; отклонения от первоначального плана внесены сюда же (DECISIONS 43).

### 4.1. Типы

```ts
type FileMap = Record<string, string>              // path → source
interface Snapshot {
  id: string            // ulid
  parentId: string | null
  userId: string
  files: FileMap        // полный снимок dynamic
  message: string
  author: 'base' | 'agent' | 'user' | 'admin'      // store-server проверяет: base только без родителя, admin только админ
  createdAt: string                                // ставит store-server
  status: 'applied' | 'rejected' | 'pending-admin' // от клиента принимается только applied | rejected
  baseHash?: string     // идентичность релиза: исходные dynamic + readonly, externals, alias, тема Tailwind, компилятор
  baseFiles?: Record<string, string>               // хеши по файлам (V1 B5)
  requestId?: string; schemaVersion?: number
}
interface SnapshotStore {
  head(userId): Promise<Snapshot | null>
  get(id): Promise<Snapshot>
  list(userId, limit?): Promise<Snapshot[]>
  put(snapshot): Promise<void>                     // снимки insert-only
  setHead(userId, id, expectedHeadId?): Promise<void> // CAS: HeadConflictError, если head сдвинулся
  bundleCache: { get(key): Promise<CompiledBundle | null>, put(key, bundle): Promise<void> } // best effort
  linkRequest?(...); flags?(): Promise<Record<string, unknown>>
}
```

### 4.2. Компиляция и `check`

- Режим по умолчанию `server` (DECISIONS 22): агент компилирует нативным esbuild, подписывает ed25519 и кладёт в store-server; браузер грузит `/morphkit/b/<app>/<key>.js` через `<script integrity>` + `import()`. Режим `browser`: esbuild-wasm в странице, при ошибке wasm сам уходит на `server`.
- **Один `check` для браузера и сервера** (`Compiler.compile` в `@morphkit/runtime/compiler`, code review 06 п. 12): сборка virtual-fs с externals, затем статические правила, защищённые элементы и правило default export по одному AST (esbuild `transform` снимает TypeScript, acorn + acorn-jsx разбирают, позиции возвращаются по source map). В браузере модуль правил грузится лениво, только в режиме `browser`.
- Ключ бандла: версия компилятора, формат, namespace, CSS-режим, `contextHash` (readonly, externals, alias, корни зон, хеш темы Tailwind) и хеш файлов. `baseHash` снимка считается из тех же частей, поэтому релиз с новым readonly API или темой делает снимки устаревшими, и они переносятся сами (B5).
- CSS правок: `.css` зоны оборачивается в `@scope ([data-morphkit-id])` при компиляции, весь CSS правок кладётся в `@layer morphkit-edits` (несвязанный CSS хоста всегда сильнее). UI morphkit рендерится в shadow root (`MorphkitUiRoot`), поэтому CSS правки не может его спрятать.
- Без `crypto.subtle` (http не на localhost) хеши считаются на JS; подпись бандлов проверить нельзя, и с `publicKey` правки отклоняются (doctor `secure-context`).
- Inline source map только в dev-сборке (`virtual:morphkit` `dev`).

### 4.3. Реестр динамических компонентов

```tsx
<MorphkitProvider config={config} store={store} userId={userId} token={...} onAuthExpired={...}>
  <Dynamic id="customer-card" props={{ customer }} />
</MorphkitProvider>
```

- Движок создаётся в `useMemo` по пользователю и конфигурации; конструктор без побочных эффектов, слушатели подключает `engine.attach()` в эффекте. Смена пользователя не размонтирует дерево хоста.
- Store недоступен или висит: через 5 с (`storeTimeoutMs`) состояние `ready`, исходная версия, `offline: true`; `refresh()` пробует снова. У `HttpStore` таймаут на каждый запрос и один повтор после 401 со свежим токеном.
- Подмена модулей: LRU-кеш из 8 вычисленных бандлов (undo/redo без повторного `import()`), `panelVersions` по панелям: перемонтируются только панели, чей код изменился.
- `ErrorBoundary` вокруг каждой панели, откат только по вине правки (B3); `rollback` проверяет head внутри очереди, две упавшие панели откатывают одну правку один раз.
- `isolated`: iframe `sandbox="allow-scripts"` со скриптом-хостом отдельным файлом (DECISIONS 16); сообщения в iframe обрабатываются по одному. `isolateEdits` в плагине отправляет в iframe каждую изменённую панель; по умолчанию выключено (тот же realm, граница это правила + CSP).

### 4.4. API рантайма

```ts
const engine = useMorphkit()
engine.draft.start(message) / write(path, source) / read / list / check() / commit(author, { requestId, bundle, expectedHeadId }) / discard()
engine.undo() / redo() / reset() / rollback(snapshotId)
engine.revertPlan(snapshotId) / revert(snapshotId)   // откат правки из середины цепочки (05 #13)
engine.previewOriginal(on)                          // «показать оригинал», head не меняется (05 #12)
engine.diagnostics()                                // id снимка, «изменено», панели, режим, offline (05 #12)
engine.agentRequest(text, extra)                    // с expectedHeadId
engine.history() / tags() / moduleStats() / refresh()
```

Браузер остаётся источником правды для файлов, сервер агента stateless по файлам:

1. Чат отправляет `POST /agent/v1/run` с файлами, `expectedHeadId` и (при указании на панель) DOM-снимком панели. По умолчанию в DOM-снимке только структура: теги, классы, test id и длины текстов; текст только при `sendDomText: true` (почта и номера маскируются), поддеревья `data-morphkit-private` и значения полей никогда (05 #3).
2. Агент берёт контекст правил, readonly и `.d.ts` из своего манифеста (`MORPHKIT_MANIFEST`), а не из тела запроса; работает над копией файлов в памяти; `check` тот же, что в браузере.
3. Результат: `{ files, verdict: ok | partial | needs-backend | not-editable | declined | failed | clarify | refused, expectedHeadId, bundle? }`, прогресс по SSE с комментарием-heartbeat каждые 15 с. Отмена в чате обрывает запрос, сервер прерывает вызов модели.
4. Браузер коммитит только поверх того же head (`expectedHeadId`, CAS на `setHead`); при конфликте head перечитывается и правка не применяется.

---

## 5. `@morphkit/agent` (Node)

- Hono: `POST /agent/v1/run` (SSE), `POST /agent/v1/compile`, `GET /agent/v1/b/:app/:file`, `GET /agent/health`. Тело ограничено (16 МБ по умолчанию, 413), токен проверяется до разбора JSON.
- Провайдеры: `anthropic` (SDK, `claude-sonnet-5-5`, adaptive thinking, effort `medium`; классификатор `claude-haiku-5-5`), `openai-compatible`, `scripted` (фикстуры, без сети). Ключи только из env.
- Инструменты (строгие схемы): `list_files`, `read_file`, `write_file`, `check`, `finish`. Результаты инструментов не длиннее 24 000 символов, ошибки дедуплицируются, не больше 10.
- `max_tokens` одного вызова = остаток видимого бюджета правки + 8k на размышление (не больше 16k). Ответ, обрезанный по `max_tokens`, не исполняет последний вызов инструмента: модель получает об этом результат.
- Лимиты из конфигурации (по умолчанию 12 вызовов, 90 с, 8k видимых токенов, $ на правку по тарифу); текст промпта берёт их оттуда же.
- В production сервер не стартует без ключа приложения, секрета JWT и `MORPHKIT_MANIFEST`.

---

## 6. `@morphkit/store-server` и дашборд

- Hono + Drizzle, SQLite. Таблицы: `snapshots` (PK `(app_id, id)`, insert-only: триггер запрещает UPDATE всего, кроме однократной привязки `request_id`), `heads`, `requests`, `bundle_files` (ключ, владелец, подпись; публичные только подписанные агентом), `events` и `audit` (append-only), `flags`, `idempotency`, `quota_buckets`, `app_plans`, `app_settings`. Старая таблица `bundles` не используется.
- Эндпоинты под `/v1/`: снимки и головы (`POST /snapshots/:id/head` с `expectedHeadId` это CAS, 409 `head-conflict`), бандлы, запросы, квоты, события, флаги, админ (`/admin/requests` сортирует в SQL и считает `isHead` одним join), аудит, экспорт.
- Авторизация: ключ приложения (сервер→сервер), JWT пользователя, демо-заголовки только вне production. Тело запроса ограничено (4 МБ по умолчанию, 413) и читается после авторизации.
- Дашборд `/admin` в demo-crm: таблица запросов, diff, журнал инструментов, откат, отклонение, «взять в работу».

---

## 7. `@morphkit/ui`

- `<MorphkitChat />`: шторка справа, поле ввода, стрим прогресса агента («читаю customer-card.tsx», «проверяю сборку»), кнопки «Отменить последнюю правку», «История», «Сбросить к исходному».
- Выделение элемента: кнопка «указать на экране» включает режим, при наведении подсвечивается ближайший `Dynamic`, клик подставляет в запрос `[панель: customer-card]`.
- Тосты: «Применено», «Отменено», «Передано администратору».

---

## 8. `apps/demo-crm`

- Сущности: `Customer { id, name, email, status, dueDate, meta }`, `Deal { id, customerId, title, amount, stage, meta }`. Данные в памяти сервера demo (Hono) + REST, `meta` это jsonb-подобное поле.
- `src/dynamic/`: `customer-card.tsx`, `deals-table.tsx`, `dashboard-panels.tsx`. `src/readonly/`: `api.ts` (типизированные вызовы), `format.ts`. `src/components/ui/` shadcn (readonly). Всё остальное core.
- Два пользователя для демо: `alice` и `bob` (переключатель в шапке), чтобы показать персональность правок.
- Сценарии для ролика (и для e2e-тестов со `scripted` провайдером):
  1. «В карточке клиента добавь поля телефон, город, источник, просроченную дату выделяй красным» → `verdict ok`, карточка меняется, undo возвращает.
  2. «Добавь в сделку поле скидка и пересчитывай сумму на сервере» → `needs-backend`, запись в дашборде.
  3. Правка, которая не компилируется (fixture с ошибкой) → коммит отклонён, агент получает ошибку и чинит (во второй итерации fixture).
  4. Правка, которая падает в рантайме (`throw` в рендере) → ErrorBoundary, автооткат.

---

## 9. Тесты и критерии готовности

- Vitest: VirtualFS, hash снимка, цепочка undo/redo, запрет записи вне dynamic, парсинг ошибок esbuild.
- Playwright headless (`--headless`, никаких окон): четыре сценария выше со `scripted` провайдером; проверка, что у `bob` карточка не изменилась после правки `alice`.
- Метрики, которые печатает e2e: время от запроса до перерисовки, размер и время инициализации esbuild-wasm.
- Готово, когда: `pnpm install && pnpm build && pnpm test && pnpm e2e` проходят на чистой машине; `pnpm dev` поднимает demo-crm + agent + store-server одной командой; README объясняет установку в чужой Vite-проект за 5 шагов.

---

## 10. Что сознательно не делаем в демо

Next.js и webpack, настоящая авторизация, многопользовательские общие правки, мерж правок при обновлении базового снимка (при изменении `dynamic` в новом релизе приложения пользовательский снимок просто помечается `stale`, и в UI предлагается «сбросить» или «попросить агента перенести»), десктоп/Tauri, проверка типов в браузере (только на сервере агента через `tsc --noEmit` по желанию, флаг `typecheck: true`).
