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

### 4.1. Типы

```ts
type FileMap = Record<string, string>              // path → source
interface Snapshot {
  id: string            // ulid
  parentId: string | null
  userId: string
  files: FileMap        // полный снимок dynamic
  message: string       // что попросил пользователь / что сделал агент
  author: 'base' | 'agent' | 'user' | 'admin'
  createdAt: string
  status: 'applied' | 'rejected' | 'pending-admin'
}
interface SnapshotStore {
  head(userId): Promise<Snapshot | null>
  get(id): Promise<Snapshot>
  list(userId, limit?): Promise<Snapshot[]>
  put(snapshot): Promise<void>
  setHead(userId, id): Promise<void>
  bundleCache: { get(hash): Promise<string | null>, put(hash, js): Promise<void> }
}
```

### 4.2. Компилятор

- `esbuild-wasm`, грузится лениво при первом `commit`, wasm кешируется через Cache API. Инициализация один раз.
- Плагин `virtual-fs`: резолвит `@/` → `/src/`, пробует `.tsx/.ts/.css`, читает из `FileMap`. Всё из `externals` помечается `external: true`.
- Формат вывода: `iife` c `globalName` не нужен, используем `format: 'esm'` и загрузку через `import(blobUrl)`. Externals переписываются на `window.__morphkit.externals['react']` через небольшой banner/footer или через import map (import map проще: `<script type="importmap">` с blob URL на модули-шимы, которые экспортируют из реестра).
- Результат: `{ js, css, hash }`. Hash = sha256 по отсортированному `FileMap`, по нему кеш бандла в `SnapshotStore.bundleCache`.
- Ошибки компиляции возвращаются структурированно: `{ file, line, column, text }[]`.

### 4.3. Реестр динамических компонентов

```tsx
<MorphkitProvider store={...} userId={...} manifest={manifest} isolated={false}>
  <Dynamic id="customer-card" props={{ customer }} />
</MorphkitProvider>
```

- `id` соответствует файлу `src/dynamic/<id>.tsx` с `export default`.
- Provider держит `Map<id, React.ComponentType>`; при смене head перезагружает модуль и вызывает `forceUpdate` подписчиков `Dynamic`.
- `ErrorBoundary` вокруг каждого `Dynamic`: если компонент упал в рантайме (не на компиляции), показываем плашку «правка сломала панель» с кнопкой «откатить», и автоматически откатываем через 10 с, если пользователь не нажал «оставить».
- `isolated` режим: `Dynamic` рендерит iframe с `srcdoc`, внутрь передаются props через `postMessage` (только сериализуемые), стили через тот же css. Для демо достаточно одного компонента в этом режиме.

### 4.4. API рантайма (используется агентом через сервер и UI)

```ts
const pm = useMorphkit()
pm.draft.start(message)               // копия head в черновик
pm.draft.write(path, source)          // только пути внутри dynamic
pm.draft.read(path)
pm.draft.list()
pm.draft.check(): Promise<CompileResult>   // компилирует, не применяет
pm.draft.commit(): Promise<Snapshot>       // check + put + setHead + swap
pm.draft.discard()
pm.undo()                              // head = head.parentId (если есть)
pm.redo()                              // по локальной истории навигации
pm.history(): Snapshot[]
pm.reset()                             // head = base
```

Агент на сервере **не держит** своё состояние файлов: он вызывает те же операции через HTTP на `@morphkit/agent`, который проксирует в браузер по SSE/WebSocket? Нет, проще: **браузер является источником правды для черновика**. Поток такой:

1. UI отправляет на сервер агента `POST /agent/run { userId, request, files: draft.list() с исходниками, readonly, coreTypes }`.
2. Сервер запускает цикл модели. Инструменты `read_file`, `write_file`, `check` работают над **копией файлов в памяти сервера**; `check` на сервере делает `esbuild` (нативный, быстрый) с тем же плагином virtual-fs и теми же externals.
3. По окончании сервер отвечает `{ files: FileMap (изменённые), summary, log, verdict: 'ok' | 'needs-backend' | 'failed' }` и стримит прогресс по SSE для UI.
4. Браузер пишет изменённые файлы в черновик, делает `draft.check()` (esbuild-wasm) и `commit()`. Так одна и та же проверка выполняется дважды, но зато рантайм не зависит от сервера для undo/истории, а сервер агента stateless.

---

## 5. `@morphkit/agent` (Node)

- Hono-сервер, один эндпоинт `POST /agent/run` (SSE-ответ) + `GET /health`.
- Провайдеры: интерфейс `ModelProvider { run(ctx, tools): AsyncIterable<Event> }`. Реализации в MVP: `anthropic` (официальный SDK, модель по умолчанию `claude-sonnet-5-5`, thinking adaptive, effort `medium`; классификатор запроса на `claude-haiku-5-5`), `openai-compatible` (base URL + key, покрывает OpenAI и OpenRouter). Ключи только из env: `MORPHKIT_PROVIDER`, `MORPHKIT_API_KEY`, `MORPHKIT_MODEL`, `MORPHKIT_BASE_URL`.
- Если ключа нет: провайдер `scripted` для тестов и демо без сети: берёт сценарий из `fixtures/*.json` (запрос → набор файлов), чтобы весь пайплайн можно было прогнать в CI.
- Инструменты (строгие схемы, `strict: true`):
  - `list_files()` → пути dynamic + readonly с пометкой зоны;
  - `read_file(path)`;
  - `write_file(path, content)` → только dynamic, иначе ошибка инструмента (и это логируется как нарушение);
  - `check()` → результат компиляции;
  - `finish(summary, verdict)`.
- Системная инструкция: правила зон, стек (React 19, Tailwind 4, shadcn), «если запрос требует изменений вне dynamic или новых данных с сервера, не пиши код, вызови finish с verdict `needs-backend` и объясни пользователю одной фразой». Передаём `coreTypes` и список generic-полей сущностей (`meta: Record<string, unknown>`), чтобы простые фичи делались без бэкенда (идея автора из комментариев).
- Классификатор (Haiku): перед основным циклом один вызов «ui / needs-backend / unclear». `needs-backend` сразу уходит в дашборд, без траты токенов большой модели.
- Лимиты: максимум 12 обращений к модели, таймаут 90 с, бюджет вывода 8k токенов на правку. Журнал всех вызовов инструментов сохраняется в ответе (`log`) и в store-server.
- Кеширование промпта: системная инструкция + readonly + coreTypes в одном `cache_control` блоке.

---

## 6. `@morphkit/store-server` и дашборд

- Hono + Drizzle. Таблицы: `snapshots` (как `Snapshot` + `appId`), `requests` (`id, userId, text, verdict, summary, log json, snapshotId?, status: applied|rejected|pending-admin|rolled-back`), `bundles` (`hash, js, css`).
- Эндпоинты: `GET/PUT /snapshots`, `POST /snapshots/:id/head`, `GET /requests`, `POST /requests/:id/approve|reject|rollback`, `GET/PUT /bundles/:hash`.
- Авторизация в демо: заголовок `x-morphkit-user`, админ по `x-morphkit-admin: 1`. Настоящую авторизацию не делаем, это оговорено в README.
- Дашборд `/admin` в demo-crm: таблица запросов (пользователь, текст, вердикт, время, статус), раскрытие строки показывает diff файлов снимка относительно родителя и журнал инструментов, кнопки «откатить у пользователя», «отклонить», для `pending-admin` «взять в работу». Счётчики сверху: правок за неделю, доля успешных, доля `needs-backend`.

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
