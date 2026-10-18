# Pleatkit: архитектура демо

Имя: **pleatkit** (npm scope `@pleatkit/*`; до 2026-10-18 morphkit, решение 68). Либа, которая позволяет агенту внутри веб-приложения переписывать разрешённые части интерфейса в рантайме, с коммитом, откатом и персональными версиями на пользователя.

Решения приняты 2026-10-17: архитектура здесь (Fable 5.1), код пишет Opus 5.5 high. Локальные модели не используем. Провайдер модели по умолчанию Anthropic через ключ клиента (BYOK), провайдер сменный.

Контекст и обоснование: `../../polymorphic_ui_plan.md`, спека автора: `../../telegram_posts.md` (пост 100).

---

## 1. Принципы

1. **Три зоны в проекте клиента.** `core` компилируется и минифицируется, агент видит только `.d.ts`. `readonly` агент читает как исходник, но не правит. `dynamic` агент правит, и именно эта папка собирается в рантайме. Зоны задаются в конфиге плагина Vite по глобам.
2. **Снимок, а не патч.** Состояние динамической зоны пользователя это полный снимок файлов (`Snapshot`). Версии это цепочка снимков. Undo это переход к родительскому снимку. Никаких diff-форматов в MVP.
3. **Черновик → коммит.** Агент пишет в черновик (`draft`). Приложение не меняется, пока не вызван `commit`. Коммит компилирует весь `dynamic` целиком; если ошибка, коммит отклонён, агент получает текст ошибки. Это пункт 7 спеки.
4. **Подмена без перезагрузки.** Каждый файл динамической зоны экспортирует React-компоненты. Приложение обращается к ним через `<Dynamic id="customer-card" />`, а не через import. Рантайм держит реестр `id → текущий модуль` и перерисовывает при коммите.
5. **Ключ модели никогда не в браузере.** Агент работает на сервере клиента (`@pleatkit/agent`, Node). Браузер общается с ним по HTTP/SSE.
6. **Хранилище сменное.** Интерфейс `SnapshotStore` с двумя реализациями: `LocalStore` (IndexedDB, для демо и десктопа) и `HttpStore` (наш сервер, Postgres). Выбор в конфиге рантайма.
7. **Песочница по уровням.** В MVP правки пользователя выполняются в том же окне (угроза только себе). Режим `isolated: true` рендерит динамические компоненты в iframe с `sandbox="allow-scripts"` и CSP. Делаем как флаг, в демо показываем оба.

---

## 2. Монорепо

```
pleatkit/
  package.json            pnpm workspaces, turbo не нужен
  pnpm-workspace.yaml
  packages/
    vite-plugin/          @pleatkit/vite-plugin
    runtime/              @pleatkit/runtime      (браузер)
    agent/                @pleatkit/agent        (Node)
    ui/                   @pleatkit/ui           (чат-шторка, выделение элемента)
    store-server/         @pleatkit/store-server (открытое ядро стора, MIT; SQLite, Postgres через тот же Drizzle)
    store-cloud/          @pleatkit/store-cloud  (модули управляемого облака поверх ядра; private, UNLICENSED)
  apps/
    demo-crm/             Vite + React + TS + Tailwind + shadcn
    admin/                дашборд администратора (можно внутри demo-crm как /admin)
  evals/                  эвал-харнесс агента (@pleatkit/evals, private): задачи, оценщики, транскрипты, baseline, отчёт
  docs/
    ARCHITECTURE.md       этот файл
    TASKS.md              разбивка на этапы
```

Совместимость со старым именем снята в 0.2 (решения 69, 71): ни переменные `MORPHKIT_*`, ни алиасы `Morphkit*`, ни бинари `morphkit*`, ни `virtual:morphkit/*`, ни заголовки `x-morphkit-*`, ни копирование IndexedDB `morphkit*` больше не поддерживаются (CHANGELOG, 0.2.0, «Removed»). Исключение до правки архитектора: алиасы `MorphkitChat`, `MorphkitChatProps`, `useMorphkitUiStyles` в `packages/ui` (пакет архитектора; патч в `docs/release/ui-0.2.patch`). Классы `.mk-*` и префикс ключей `mk_live_` не менялись.

Стек: TypeScript 5.x, Node 22, pnpm, Vite 6, React 19, Tailwind 4, shadcn/ui, Vitest, Playwright (headless, никаких окон на экране Minte), esbuild-wasm, Hono для серверов, Drizzle + SQLite (better-sqlite3) для демо, Postgres через тот же Drizzle для прода.

---

## 3. `@pleatkit/vite-plugin`

```ts
// vite.config.ts у клиента
import pleatkit from '@pleatkit/vite-plugin'
export default defineConfig({
  plugins: [react(), pleatkit({
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
1. На сборке и в dev собирает **манифест** `pleatkit.manifest.json`:
   - `dynamic`: `{ path, source }` для каждого файла (исходник TSX как есть), это **базовый снимок** (`baseSnapshot`), версия 0 для каждого нового пользователя;
   - `readonly`: `{ path, source }` исходники для чтения агентом;
   - `coreTypes`: `.d.ts` для `core`, сгенерированные `tsc --declaration --emitDeclarationOnly` (в демо можно ограничиться `.d.ts` для файлов, которые `dynamic` импортирует);
   - `externals`: список имён, которые рантайм подставит из реестра.
2. Виртуальный модуль `virtual:pleatkit/manifest` импортирует манифест в приложение.
3. Виртуальный модуль `virtual:pleatkit/externals` генерирует реестр: `{ 'react': React, '@/components/ui/button': () => import('...') ... }`. Externals с `*` раскрываются по файловой системе на этапе сборки.
4. Файлы из `dynamic` в основной бандл **тоже попадают** как fallback (чтобы приложение работало до первой правки и чтобы SSR/первая отрисовка не ждали esbuild-wasm). Рантайм на старте использует fallback, если у пользователя нет снимков.

---

## 4. `@pleatkit/runtime` (браузер)

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

- Режим по умолчанию `server` (DECISIONS 22): агент компилирует нативным esbuild, подписывает ed25519 и кладёт в store-server; браузер грузит `/pleatkit/b/<app>/<key>.js` через `<script integrity>` + `import()`. Режим `browser`: esbuild-wasm в странице, при ошибке wasm сам уходит на `server`.
- **Один `check` для браузера и сервера** (`Compiler.compile` в `@pleatkit/runtime/compiler`, code review 06 п. 12): сборка virtual-fs с externals, затем статические правила, защищённые элементы и правило default export по одному AST (esbuild `transform` снимает TypeScript, acorn + acorn-jsx разбирают, позиции возвращаются по source map). В браузере модуль правил грузится лениво, только в режиме `browser`.
- Ключ бандла: версия компилятора, формат, namespace, CSS-режим, `contextHash` (readonly, externals, alias, корни зон, хеш темы Tailwind) и хеш файлов. `baseHash` снимка считается из тех же частей, поэтому релиз с новым readonly API или темой делает снимки устаревшими, и они переносятся сами (B5).
- CSS правок: `.css` зоны оборачивается в `@scope ([data-pleatkit-id])` при компиляции, весь CSS правок кладётся в `@layer pleatkit-edits` (несвязанный CSS хоста всегда сильнее). UI pleatkit рендерится в shadow root (`PleatkitUiRoot`), поэтому CSS правки не может его спрятать.
- Без `crypto.subtle` (http не на localhost) хеши считаются на JS; подпись бандлов проверить нельзя, и с `publicKey` правки отклоняются (doctor `secure-context`).
- Inline source map только в dev-сборке (`virtual:pleatkit` `dev`).

- **URL из данных** (решение 74.3): статическое правило пропускает вычисленный URL в `src`, `href`, `poster`, `action`, `formAction` обычного элемента (тег со строчной буквы), если он не начинается с записанного в коде абсолютного адреса или `javascript:`; решает рантайм. Реестр externals (`loader.ts`) отдаёт бандлам правок `react/jsx-runtime`, `react` и `react-dom` через `guardModule` (`url-guard.ts`): `jsx`/`jsxs`/`jsxDEV`, `createElement`, `cloneElement` убирают у создаваемого строкового элемента URL-пропсы, которые по разбору WHATWG URL против `document.baseURI` уходят с origin страницы (схема не http(s), другой хост или порт, `//host`, `/\host`, `user@host`, `javascript:`, `data:`), а также `dangerouslySetInnerHTML`, `srcDoc` и `url()` других хостов в `style`; `mailto:`/`tel:` остаются в `href`; списки (`srcSet`, `ping`) остаются, только если все адреса свои; ресурсные подсказки `react-dom` (`preinit`, `preload`, …) работают только для своего origin. При непрозрачном origin страницы не остаётся ни один URL из данных. Компоненты (не строковый тип) не трогаются: их URL-пропсы из данных по-прежнему отклоняет статическое правило. Внешние хосты из списка `allowedHosts` (63.1) ещё не реализованы.

### 4.3. Реестр динамических компонентов

```tsx
<PleatkitProvider config={config} store={store} userId={userId} token={...} onAuthExpired={...}>
  <Dynamic id="customer-card" props={{ customer }} />
</PleatkitProvider>
```

- Движок создаётся в `useMemo` по пользователю и конфигурации; конструктор без побочных эффектов, слушатели подключает `engine.attach()` в эффекте. Смена пользователя не размонтирует дерево хоста.
- Store недоступен или висит: через 5 с (`storeTimeoutMs`) состояние `ready`, исходная версия, `offline: true`; `refresh()` пробует снова. У `HttpStore` таймаут на каждый запрос и один повтор после 401 со свежим токеном.
- Подмена модулей: LRU-кеш из 8 вычисленных бандлов (undo/redo без повторного `import()`), `panelVersions` по панелям: перемонтируются только панели, чей код изменился.
- `ErrorBoundary` вокруг каждой панели, откат только по вине правки (B3); `rollback` проверяет head внутри очереди, две упавшие панели откатывают одну правку один раз.
- `isolated`: iframe `sandbox="allow-scripts"` со скриптом-хостом отдельным файлом (DECISIONS 16); сообщения в iframe обрабатываются по одному. `isolateEdits` в плагине отправляет в iframe каждую изменённую панель; по умолчанию выключено (тот же realm, граница это правила + CSP).

### 4.4. API рантайма

```ts
const engine = usePleatkit()
engine.draft.start(message) / write(path, source) / read / list / check() / commit(author, { requestId, bundle, expectedHeadId }) / discard()
engine.undo() / redo() / reset() / rollback(snapshotId)
engine.revertPlan(snapshotId) / revert(snapshotId)   // откат правки из середины цепочки (05 #13)
engine.previewOriginal(on)                          // «показать оригинал», head не меняется (05 #12)
engine.diagnostics()                                // id снимка, «изменено», панели, режим, offline (05 #12)
engine.agentRequest(text, extra)                    // с expectedHeadId
engine.history() / tags() / moduleStats() / refresh()
```

Браузер остаётся источником правды для файлов, сервер агента stateless по файлам:

1. Чат отправляет `POST /agent/v1/run` с файлами, `expectedHeadId` и (при указании на панель) DOM-снимком панели. По умолчанию в DOM-снимке только структура: теги, классы, test id и длины текстов; текст только при `sendDomText: true` (почта и номера маскируются), поддеревья `data-pleatkit-private` и значения полей никогда (05 #3).
2. Агент берёт контекст правил, readonly и `.d.ts` из своего манифеста (`PLEATKIT_MANIFEST`), а не из тела запроса; работает над копией файлов в памяти; `check` тот же, что в браузере.
3. Результат: `{ files, verdict: ok | partial | needs-backend | not-editable | declined | failed | clarify | refused, expectedHeadId, bundle? }`, прогресс по SSE с комментарием-heartbeat каждые 15 с. Отмена в чате обрывает запрос, сервер прерывает вызов модели.
4. Браузер коммитит только поверх того же head (`expectedHeadId`, CAS на `setHead`); при конфликте head перечитывается и правка не применяется.

---

## 5. `@pleatkit/agent` (Node)

- Hono: `POST /agent/v1/run` (SSE), `POST /agent/v1/compile`, `GET /agent/v1/b/:app/:file`, `POST /agent/v1/wishes` (карта хотелок, только админ), `GET /agent/health`. Тело ограничено (16 МБ по умолчанию, 413), токен проверяется до разбора JSON.
- Этап 4c, блок 2. Карта хотелок (C9, `wishes.ts`): запросы диапазона, которые зона не обслужила (`needs-backend`, `partial`, `not-editable`, метка `out-of-zone`), группируются в темы по панелям **одним** вызовом классификатора (`ModelProvider.cluster`, structured output; у scripted темы из фикстуры `wishes`, у replay из транскрипта); ответ нормализуется (только известные id, каждый один раз, остаток в запасные темы) и сохраняется в store-server. Недельный дайджест (C5, `digest.ts`): отчёт store-server + ждущее админа + проверка цепочки аудита + карта хотелок, markdown, отправка через синки алертов (вид `digest`). Массовый перенос (C10, `carry-over.ts`): по каждому head, как рантайм (B5): без конфликтов файлы пользователя поверх релиза без модели; при конфликте агент с `migration` в пределах бюджета; новые снимки получают `baseHash` релиза, посчитанный из манифеста (`manifestReleaseHash`, тот же, что пишет браузер), голова переносится CAS; ход записывается в store-server, повторный запуск продолжает.
- Этап 4c, блок 3. Карта хотелок читает не больше `maxItems` запросов (новые первыми, 500 по умолчанию) и стоит не больше `budgetUsd` ($0.50): перед вызовом стоимость оценивается сверху (≈3 символа на входной токен плюс весь `max_tokens` 4096 по цене классификатора, `ModelProvider.clusterModel`); не влезающие старые запросы группируются без модели (запасные темы), если не влезает ни один, вызова нет. `PLEATKIT_WISHES_MAX_ITEMS`, `PLEATKIT_WISHES_BUDGET_USD`, флаги `pleatkit digest`. Перенос релиза: лимит на пользователя это `perEditUsd` тарифа приложения из store-server (`GET /v1/plan`), без тарифа `PLEATKIT_PLAN`/`PLEATKIT_LIMITS`, затем `free`; `--per-user-usd` его переопределяет. Компиляция бандла (`BundleService.compile`) отвечает «скомпилировано» только после того, как бандл записан в store-server: запись в кеш процесса после записи в стор, параллельные компиляции одного ключа ждут одну запись, неудачная запись не кешируется (решение 70.8).
- Этап 5, блок 2 (решение 73). **Классификатор параллельно основной модели** (73.3): `runAgent` отправляет запрос классификатора, сразу стартует сессию основной модели и её первый вызов (`classifierMode: parallel` по умолчанию, `PLEATKIT_CLASSIFIER=sequential` возвращает старый порядок); ответ классификатора решает: `ui` (и `needs-backend` с `screen_part`) — первый ход уже идёт и используется, `needs-backend`, вопрос, `off-topic` или `adversarial` — первый вызов отменяется (`AbortController`), его токены API не сообщает. `timings.overlapMs` — сколько первый вызов шёл, пока классификатор думал. На ответах классификатора `needs-backend` администратор получает `backendNote` из gist, метки и фразы пользователю (73.4). Промпт 5c: классификатор видит контракт данных приложения (`dataContracts.digest`) вместо одних файлов api/types/models, про `meta` говорит только если оно есть, помечает вывод данных наружу и обманные элементы как `adversarial` (не `ui` → `declined`) и отдаёт `screen_part` (смешанный запрос идёт к основной модели за `partial`).
- Манифест (этап 5, блок 2): дайджест дизайн-системы показывает пропсы компонентов и их варианты (таблицы `cva()` через `VariantProps<typeof x>`, локальные union-типы, `export { A }` и `export default A`, 73.7); `coreTypes` несут ambient-объявления приложения (`src/**/*.d.ts` с `declare module`/`declare global`: аугментации TanStack Table, `*.svg?react`); контракт данных берёт все файлы `readonly/` (кроме компонентов дизайн-системы) и раскрывает то, что они реэкспортируют или импортируют из core, из `.d.ts` (типы zod и иконок сокращаются). Проверка типов агента отклоняет правку только за ошибки, которых нет в файлах релиза (`input.base`), и берёт ambient-объявления корнями программы. Статическое правило `no-computed-url` не проверяет проп `data` у компонентов (`<BarChart data>`), только у элементов.
- Этап 5, блок 3 (решение 74). **Ранний вызов стримится** (74.1): первый вызов основной модели, стартующий вместе с классификатором, идёт через `messages.stream` (`TurnOptions.stream`), инструменты те же (без `eager_input_streaming`, если не `PLEATKIT_STREAM=1`), так что кешируемый префикс один для стримленных и обычных вызовов. Отмена закрывает поток и останавливает генерацию; что поток успел сообщить (`message_start`: вход и кеш; выход по увиденным дельтам, размышление не видно) попадает в `usage` и `cancelledCall` результата (`started: false`, если отмена раньше `message_start`: тогда API не сообщает ничего, а префилл, судя по записи кеша, всё равно выполнен). **typecheck в цикле по умолчанию** (74.2, как 63.4): `typecheckFromEnv` включает его, когда найдена папка приложения с `node_modules` (`PLEATKIT_TYPECHECK_ROOT` или папка над `dist/` манифеста; для `PLEATKIT_MANIFESTS` своя у каждого приложения по `context.namespace`); `0` выключает, `1` включает и для серверной компиляции коммитов (`commitTypecheck`, как раньше). Проверяются только изменённые файлы и динамические файлы, которые их импортируют (`affectedFiles`), ошибки релиза отбрасываются; файлы релиза теперь доходят до рабочей области всегда, а не только при защищённых элементах (без них каждая правка shadcn-admin отклонялась бы за `CheckedState` самих панелей релиза). Цена: тёплая проверка shadcn-admin ≈ 1,2–1,6 с (его типы TanStack и Recharts), TailAdmin ≈ 0,1–0,3 с, первая в процессе ≈ 5 с. **Модель под лимитами** (`rate-limit.ts`): каждый вызов модели в цикле (классификатор, ранний и обычные ходы) идёт через общий для процесса FIFO-семафор `modelGate` (`PLEATKIT_MODEL_CONCURRENCY`, 8) и `callModel`: 429, 529 и `overloaded_error` повторяются после `retry-after` (иначе 1, 2, 4 с с разбросом) не больше `PLEATKIT_RATE_LIMIT_RETRIES` (3) раз с шагом «The AI service is busy, retrying» в SSE; 408, 409, 5xx и обрыв соединения повторяются так же, молча; повтор, который не успел бы до дедлайна прогона, не начинается. Не помогло — вердикт `failed`, `rateLimited: true`, `stopReason: 'rate-limited'`, событие `edit.rate_limited` (экран Plan в /admin считает их по дням). Собственные повторы SDK выключены (`maxRetries: 0`), кроме карты хотелок; провайдеры откатывают историю диалога при неудачном вызове, чтобы ход можно было повторить. Классификатор (промпт 5f): инструкции и контекст приложения в системном промпте под точкой кеша, в сообщении пользователя только запрос (кеш классификатора 0 % → 74 % входа).
- **Подрезанный контекст агента** (74.6, `vite-plugin/src/context.ts`): плагин строит `manifest.agentContext` — `.d.ts` модулей readonly и core-типов, достижимых из импортов файлов релиза: имена идут через баррели (`export { X } from './x'` только для X, который нужен), модуль, чьи собственные экспорты используются, тянет то, что импортируют его объявления (а не исходник: `cn` в теле компонента не попадает), строки импорта ассетов (`*.svg?react`) убираются. Предел `agentContext.capTokens` (12 000 оценочных токенов по умолчанию, `pleatkit({ agentContext: false })` выключает): сверх него отбрасываются самые дальние модули, их список в промпте как «read_file при нужде»; сборка печатает размер. Промпт (`digestsFromManifest` → `PromptDigests.context`) показывает `<readonly_context>` вместо `<readonly_sources>` и `<core_types>`; `read_file`, проверки и typecheck по-прежнему видят все исходники. Дайджест дизайн-системы подробно описывает только достижимые компоненты, остальные одной строкой «Also available» с путями. Браузерная копия манифеста `agentContext` не несёт. Префикс по `count_tokens`: shadcn-admin 33 819 → 13 086, TailAdmin 12 767 → 6 048, демо 7 727 → 6 218.
- `pleatkit doctor` (этап 5, блок 2): проверка `release` гоняет `check` агента по файлам релиза (панель релиза, которую check отклоняет, ломает каждую правку); `context-budget` при `PLEATKIT_API_KEY` считает префикс и хвост через `count_tokens` API (бесплатно, `countPromptTokens` в агенте, тот же промпт, что у сервера), без ключа оценивает (2,2 символа на токен кода, инструкции и инструменты 3 500, откалибровано по счётчику, 73.5).
- Провайдеры: `anthropic` (SDK, `claude-sonnet-5-5`, adaptive thinking, effort `medium`; классификатор `claude-haiku-5-5`), `openai-compatible`, `scripted` (фикстуры, без сети). Ключи только из env.
- Инструменты (строгие схемы): `list_files`, `read_file`, `write_file`, `check`, `finish`. Результаты инструментов не длиннее 24 000 символов, ошибки дедуплицируются, не больше 10.
- `max_tokens` одного вызова = остаток видимого бюджета правки + 8k на размышление (не больше 16k). Ответ, обрезанный по `max_tokens`, не исполняет последний вызов инструмента: модель получает об этом результат.
- Лимиты из конфигурации (по умолчанию 12 вызовов, 90 с, 8k видимых токенов, $ на правку по тарифу); текст промпта берёт их оттуда же.
- В production сервер не стартует без ключа приложения, секрета JWT и `PLEATKIT_MANIFEST`.

---

## 6. `@pleatkit/store-server` и дашборд

**Открытое ядро и облако (решение 70.1).** Self-host: открытый стор (`@pleatkit/store-server`, MIT, публикуется). Облако: то же ядро плюс приватный `@pleatkit/store-cloud`. Ядро содержит всё, что нужно своему стору: снимки, головы, бандлы, журнал запросов, квоты и лимиты приложения (`app_plans` как данные квот, F14), события (учёт), цепочку аудита, роли и «глазами пользователя», флаги и kill switch, отчёт, карту хотелок (хранение), релизы и перенос, поиск по коду, экспорт, удаление, хранение L0 (`applyRetention`: текст 90 дней, журнал 30). В облачный пакет ушло то, что нужно только управляемому облаку: слой обучения (`request_facts`, `app_salts`, флаг `learning` теперь в таблице `learning_settings`, `PUT /v1/admin/learning`, поле `learning` в `/v1/admin/settings`, запись L1 на каждый запрос, метки исходов, хранение фактов `factsDays`, факты в удалении). Биллинга и маршрутизации по регионам в коде пока нет; когда появятся, они живут там же.

Точка расширения (`src/extension.ts`): `StoreExtension { name, ddl, migrate, routes(api, ctx), jobs, onRequestLogged, onOutcome, erase, count, settings }`. `createStoreApp(db, { extensions })` создаёт таблицы расширений и монтирует их маршруты за той же авторизацией, лимитом тела, идемпотентностью и правилом «/admin только admin/support». `runMaintenance` (ежечасно в бинаре) делает `edit.alive24h`, хранение L0 и задачи расширений. Бинарь `pleatkit-store` загружает модули из `PLEATKIT_STORE_EXTENSIONS` (список или `none`); без переменной берёт `@pleatkit/store-cloud`, только если `package.json` рабочей папки (развёртывания) объявляет его зависимостью: в воркспейсе пакет может резолвиться и без этого (скрытый hoisting pnpm, `NODE_PATH`), и открытый стор не должен подхватить облако случайно. У открытого пакета нет зависимости от закрытого. Демо и `examples/t1-vite` работают на открытом ядре: пакета облака у них нет.

**Удаление (решение 70.2).** `DELETE /v1/admin/users/:id` и `DELETE /v1/admin/apps/:id` (только admin; support и user получают 403, вызов «от имени» 400). Без `?confirm=` (или с устаревшим) ничего не удаляется: 409 со счётчиками и токеном; токен это хеш субъекта и счётчиков, так что он меняется, когда меняются данные. С токеном в одной транзакции удаляются снимки, головы, запросы, события (учёт), бандлы пользователя и подписанные бандлы его файлов (по `filesHash` подписи; корневой снимок общий и не трогается), записи прогонов, ответы идемпотентности, корзины квот `user:<id>:*`, флаги пользователя, строки переноса, ссылки в картах хотелок, строки расширений (факты облака). Для приложения то же по всем таблицам `app_id`, включая цепочку аудита, план и настройки. В цепочку дописывается надгробие `erase.user` / `erase.app` со счётчиками и случайным id `erased:<16 hex>` без персональных данных. `events` и `audit` остаются append-only: триггер DELETE пропускает удаление только при строке-метке в таблице `erasing`, которую удаление вставляет и убирает в своей же транзакции (аудит удаляется только при удалении приложения). Удаление пользователя цепочку аудита не трогает: её строки связаны хешами, в них id пользователя остаются (открытый вопрос DEVLOG). CLI: `pleatkit erase`.

- Hono + Drizzle, SQLite. Таблицы: `snapshots` (PK `(app_id, id)`, insert-only: триггер запрещает UPDATE всего, кроме однократной привязки `request_id`), `heads`, `requests`, `bundle_files` (ключ, владелец, подпись; публичные только подписанные агентом), `events` и `audit` (append-only), `flags`, `idempotency`, `quota_buckets`, `app_plans`, `app_settings`, `releases` и `release_items` (прогоны переноса C10), `wish_maps` (C9). Старая таблица `bundles` не используется.
- Эндпоинты под `/v1/`: снимки и головы (`POST /snapshots/:id/head` с `expectedHeadId` это CAS, 409 `head-conflict`), бандлы, запросы, квоты, события, флаги, админ (`/admin/requests` сортирует в SQL и считает `isHead` одним join), аудит, экспорт.
- Авторизация: ключ приложения (сервер→сервер), JWT пользователя, демо-заголовки только вне production. Тело запроса ограничено (4 МБ по умолчанию, 413) и читается после авторизации.
- Роли (C8): `user`, `support`, `admin` в JWT. `support` читает всё под `/admin` (кроме экспорта) и ничего там не меняет; `admin` всё. Заголовок `x-pleatkit-act-as: <user>` с токеном `support`/`admin` делает вызов от имени пользователя (`Caller.viewer`); каждый такой вызов, включая чтения, пишется в цепочку аудита (`impersonate.read|write`, актор `<role>:<viewer>:as:<user>`). Запись от имени пользователя разрешена только `admin` (решение 70.5): у `support` любая запись с `x-pleatkit-act-as` получает 403 `support-read-only`, попытка тоже пишется в аудит со статусом 403. `HttpStore({ viewer })` шлёт этот заголовок.
- Эндпоинты блока 2: `GET /v1/report?from&to` (CSV по дням и организациям, `format=json`; только админ), `GET /v1/admin/wish-items?from&to&limit` (фильтр в SQL, новые первыми, `limit` 500 по умолчанию, не больше 2000, плюс `total`), `GET|PUT /v1/admin/wishes`, `GET /v1/admin/snapshots?grep=&scope=heads|all` (поиск по коду версий), `POST /v1/admin/snapshots/rollback { grep, confirm }` (каждая текущая версия с текстом уходит на ближайшую раннюю без него; `confirm` должен совпасть с числом, иначе 409), `GET /v1/admin/releases[/:release]`, `PUT /v1/admin/releases/:release { budgetUsd }` (старт или продолжение), `PUT …/items/:userId`, `POST …/finish`, `POST …/rollback` (головы, которые прогон сдвинул, возвращаются; кто правил после, сохраняет новую).
- Дашборд `/admin` в demo-crm: разделы `?view=` requests (таблица запросов, diff, журнал инструментов, откат, отклонение, «взять в работу», «глазами пользователя»), wishes, snapshots, releases, flags, events, audit, plan. Режим поддержки в демо: `/?user=<u>&as=support` (баннер, без шторки).

---

## 7. `@pleatkit/ui`

- `<PleatkitChat />`: шторка справа, поле ввода, стрим прогресса агента («читаю customer-card.tsx», «проверяю сборку»), кнопки «Отменить последнюю правку», «История», «Сбросить к исходному».
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
- Эвал-харнесс (`evals/`, `docs/evals.md`): задачи `evals/tasks/*.json` (демо) и `evals/tasks/apps/*.json` (35 задач на двух чужих приложениях в `evals/apps`, решение 73.1) гоняются через тот же `runAgent` в процессе, с доверенным входом из манифеста сборки своего приложения, как у `POST /agent/v1/run`; браузерный оценщик поднимает сборку нужного приложения (`EVAL_APP`), панели чужих приложений находит по `data-pleatkit-id`, проверки по структуре и тексту (`selector`, `role`, `matches`, `click`, `maxHeight`, `css`); оценщики: вердикт, изменение, общий `check`, `tsc` (корень с `node_modules` приложения), текстовые инварианты, предикаты, бюджет и Playwright (результат коммитится в собранное демо через `draft.commit('agent')` под `?eval=1`, проверяются отсутствие баннера падения, testid полей по соглашению демо (`apps/demo-crm/docs/design-system.md`: поля данных держат `data-testid` = имя поля; документ попадает в кешируемый префикс как `designSystem.docs`) и текст/классы того, что видит пользователь). `pnpm eval:sanity` (эталоны проходят, нулевой агент проваливает задачи с изменением), `eval:replay` (транскрипты `ReplayProvider`: scripted против `evals/baseline.scripted.json`, `--set live` — три попытки на задачу живой серии против `evals/baseline.json`), `eval:pin`, `eval:report` (с попытками: задачи по попыткам, задержка медиана/p90, цена правки, `cacheHitRate()`). Живая запись: `eval:record -- --live [--set] [--trials] [--no-classifier]`, результаты записи с реальными задержками лежат в `evals/recordings/<set>/record.json`. Изменение промпта или модели идёт с этим отчётом (решения 43, 63).
- Метрики, которые печатает e2e: время от запроса до перерисовки, размер и время инициализации esbuild-wasm.
- Готово, когда: `pnpm install && pnpm build && pnpm test && pnpm e2e` проходят на чистой машине; `pnpm dev` поднимает demo-crm + agent + store-server одной командой; README объясняет установку в чужой Vite-проект за 5 шагов.

---

## 10. Что сознательно не делаем в демо

Next.js и webpack, настоящая авторизация, многопользовательские общие правки, мерж правок при обновлении базового снимка (при изменении `dynamic` в новом релизе приложения пользовательский снимок просто помечается `stale`, и в UI предлагается «сбросить» или «попросить агента перенести»), десктоп/Tauri, проверка типов в браузере (только на сервере агента через `tsc --noEmit` по желанию, флаг `typecheck: true`).
