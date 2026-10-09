# CLAUDE.md

Мульти-агентная система для контент-продакшна (Instagram/Telegram). Агенты: CEO, Copywriter,
Image Generator, Video Ideas, Instagram Analyst, SEO Specialist, Critic. Ничего не публикуется и не
считается финальным без согласования человеком (гейт 1 — план, гейт 2 — итог).

## Текущий статус

| Этап                                                    | Статус                     |
| ------------------------------------------------------- | -------------------------- |
| 0. Каркас                                               | готово                     |
| 1. Ядро (модели, автомат статусов, очередь, LLM-клиент) | готово                     |
| 2. Copywriter + Critic + CEO + Telegram-гейты           | готово, ждёт подтверждения |
| 3. Image (Magnific), Video Ideas, SEO, DAG              | не начат                   |
| 4. Instagram Analyst (CSV → Graph API)                  | не начат                   |
| 5. Панель, эксплуатация, деплой                         | не начат                   |
| 6. Eval, нагрузка, ревью безопасности                   | не начат                   |

## Стек

TypeScript (strict) · Node.js ≥ 22.12 · pnpm workspaces · PostgreSQL 16 · Drizzle ORM (+ свой
раннер миграций) · Fastify · pino · Zod 4 · Vitest · ESLint 10 + Prettier · Docker Compose
(Postgres + SeaweedFS как S3) · pg-boss 12 (очередь в Postgres) · @anthropic-ai/sdk. Дальше по плану: grammY,
React + Vite, sharp.

## Структура

```
apps/api            Fastify HTTP API (пока только /health)
apps/bot            Telegram-бот + воркер очереди + обслуживание в одном процессе (pnpm dev:bot)
  src/bot.ts           белый список, команды, кнопки, ввод комментариев (ForceReply)
  src/callbacks.ts     формат callback_data (≤ 64 байт)
  src/telegram-channel.ts, format.ts  сообщения гейтов (HTML, ≤ 4096 символов)
  src/smoke.ts         pnpm smoke:llm — первый реальный вызов с лимитом $0.02
packages/agents     агенты и сценарий
  prompts/*.md         системные промпты (front matter version: N); ai-cliches.ru.txt — штампы
  src/agents/          ceo, copywriter, critic — вход/выход по Zod, без побочных эффектов
  src/workflow.ts      оркестратор: бриф → план → гейт 1 → copy⇄critic → гейт 2 → правки → экспорт
  src/schemas.ts       схемы и правила площадок; src/lint.ts — детерминированный поиск штампов
  src/mock-llm.ts      LLM_PROVIDER=mock: правдоподобные ответы без API
config/brands/default.yaml  профиль бренда по умолчанию (/brand reload в боте)
packages/core       конфиг (Zod-валидация env), логгер (pino с редактированием секретов)
packages/db         Drizzle-схема, клиент, раннер миграций с откатом, CLI
packages/db/migrations  NNNN_name.sql (drizzle-kit) + NNNN_name.down.sql (вручную, обязателен)
packages/providers  интерфейсы провайдеров, mock-реализации, хранилище (local/S3), заглушка Publisher
packages/engine     рантайм: переходы статусов, идемпотентность, бюджет, LLM-клиент, очередь (pg-boss), обслуживание
  src/transitions.ts   transitionTask() — единственный способ сменить tasks.status; pause/resume
  src/idempotency.ts   withIdempotency(key, fn) — побочный эффект ровно один раз
  src/budget.ts        резерв → факт; лимиты задача/день/месяц; предупреждение 80%; доплата только человеком
  src/llm/             LlmClient.callStructured(), транспорты Anthropic и Token Harbor, RateLimiter, wrapExternalData()
  src/reconcile.ts     /reconcile — сверка записанных расходов с балансом кошелька провайдера
  src/runs.ts, queue.ts  жизненный цикл запусков агентов, pg-boss, dead-letter
  src/maintenance.ts   зависшие запуски, протухшие резервы, напоминания на гейтах
  src/testkit.ts       хелперы для интеграционных тестов (временная БД, FakeTransport)
config/model-pricing.json  цены моделей Anthropic (USD за 1M токенов) — меняются без релиза
config/model-pricing.tokenharbor.json  цены шлюза; бесплатная claude-haiku-5.5:free = 0 (TODO: бесплатна ограниченное время)
scripts/            кроссплатформенные node-скрипты (никакого bash)
```

Ещё не созданы (появятся на своих этапах): `apps/web` (этап 5).

## Команды (работают одинаково в PowerShell, cmd и bash)

```
pnpm install
pnpm infra:up            # docker compose up -d --wait (Postgres + S3)
pnpm infra:down
pnpm db:migrate          # применить все миграции
pnpm db:rollback         # откатить последнюю; pnpm db:rollback --steps 2 — две
pnpm db:status
pnpm db:generate         # drizzle-kit generate после изменения schema.ts → потом написать .down.sql
pnpm dev:api             # API с перезапуском, из исходников
pnpm build && pnpm start:api
pnpm lint                # eslint + prettier --check
pnpm format
pnpm typecheck
pnpm test                # unit, без внешних сервисов
pnpm test:integration    # нужен pnpm infra:up
pnpm check               # всё сразу (lint, typecheck, unit, integration, build)
pnpm demo:core           # демо ядра во временной БД с фейковым LLM (нужен pnpm infra:up)
pnpm dev:bot             # бот + воркер (нужны TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID)
pnpm smoke:llm           # 2 реальных вызова через LLM_PROVIDER (anthropic|tokenharbor), лимит $0.02: ответ, usage, кэш, стоимость
```

## Правила кода

- Код, комментарии, имена, логи — на английском. Контент для пользователя — на русском.
- `process.env` читает только `packages/core/src/config.ts`. Новая переменная → схема + `.env.example` + тест.
- Секреты не логируем. Конфиг в лог — только через `describeConfig()`. Новые секретные ключи → `SECRET_KEYS` в `logger.ts`.
- Пути — только `path.join/resolve`. Скрипты — только node (`scripts/*.mjs`), без `rm -rf`, `&&`-цепочек с env-переменными и т.п.
- Внутренние пакеты экспортируют `src` через условие `@cms/source` (dev, tsx, vitest) и `dist` для `node`.
  Новый пакет: `exports` как в соседних, `tsconfig.json` с `references`, ссылка в корневом `tsconfig.json`.
- Тесты: `*.test.ts` — unit (без сети/БД), `*.int.test.ts` — интеграционные (реальный Postgres/S3).
  Интеграционные тесты БД создают временную базу через `createTempDatabase()` и удаляют её.
- Каждая миграция обязана иметь `.down.sql` (иначе раннер падает). Уже применённые миграции не редактировать — раннер сверяет checksum.
- Внешние провайдеры только за интерфейсами из `packages/providers/src/types.ts`. Реальный режим без реализации должен падать явно, а не тихо уходить в mock.
- Всё, что касается внешних API, — по актуальной документации. Не уверен → `TODO(verify)`.
- Conventional commits, маленькие коммиты.
- Статус задачи — только через `transitionTask()` (DB-триггер отклоняет прямой UPDATE). Пауза — флаг, не статус.
- Решения на гейтах (`awaiting_*` → дальше) — только `actor.kind === 'human'`; это проверяет `checkTransition()`.
- Любой внешний побочный эффект (LLM, уведомление, экспорт) — через ключ идемпотентности.
- Любой платный вызов — через `reserveCost()` → `finalizeCost()`/`releaseCost()`; LlmClient делает это сам.
- Внешние тексты в промпт — только через `wrapExternalData()`; в system-промпте — `EXTERNAL_DATA_RULES`.
- Ошибки: `TransientError` (повтор), `PermanentError` (сразу fail), `BudgetExceededError` (пауза).
- `drizzle-orm` импортировать только из `@cms/db` (`sql`, `eq`, `and`) — иначе две копии пакета ломают типы.
- В тестах ошибки Postgres лежат в `err.cause` (drizzle их оборачивает).
- Промпт поменял — подними `version` в front matter; хэш содержимого всё равно попадёт в версию (`copywriter@1#a1b2c3d4`).
- Агент возвращает только данные. Статусы, артефакты, сообщения владельцу — только в `workflow.ts`.
- Каждый шаг рана идемпотентен: LLM-вызовы, версии артефактов и сообщения — через ключи от `run.id`.
- Структурные ограничения схем (`enum`, `minItems`) SDK переносит в описание, API их не гарантирует — проверяет Zod.
- Модели по ролям — только через `LLM_MODEL_*` в `.env`. Новая модель → цена в файле прайса провайдера, иначе она считается по `unknownModelRates`.
- Цена — только по модели из ЗАПРОСА, не по `response.model` (шлюз отвечает `claude-haiku-5.5` на `claude-haiku-5.5:free`). `aliases` в прайсе — только чтобы узнать имя из ответа; запрос под именем алиаса ими не тарифицируется. Исключение — `fallback_message` в `usage.iterations` (refusal fallback Anthropic): по своей модели.
- Шлюзу не отправлять бета-поля (`betas`, `fallbacks`) и не использовать `client.beta.*` (добавляет `?beta=true`).
- Вывод «кэш работает» — только по `cache_read_input_tokens > 0` на реальном ответе провайдера.

## Принятые решения

| Решение                                                                                | Почему                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Drizzle, а не Prisma                                                                   | Схема в TS, SQL почти как есть, без отдельного движка и шага генерации клиента; удобные транзакции и блокировки строк для автомата статусов                              |
| Свой раннер миграций поверх SQL от drizzle-kit                                         | У drizzle-kit нет down-миграций, а откат — требование. Раннер: advisory lock, транзакция на миграцию, checksum с нормализацией CRLF                                      |
| SeaweedFS вместо MinIO                                                                 | MinIO перестал публиковать community-образы на Docker Hub (`minio/minio` недоступен). SeaweedFS `weed mini` — S3-совместимый, ключи из env, анонимный доступ закрыт      |
| Postgres 16                                                                            | Поддерживается до ноября 2028, образ уже стабилен; переход на 17 — отдельным решением                                                                                    |
| TypeScript 6.0, не 7                                                                   | typescript-eslint поддерживает TS < 6.1                                                                                                                                  |
| DB-подключение собирается из `POSTGRES_*`, а не из `DATABASE_URL`                      | Один источник правды для compose и приложения, нельзя рассинхронизировать пароль                                                                                         |
| Пустая переменная в `.env` = не задана                                                 | Скопированный `.env.example` даёт понятную ошибку «X is required», а не странное поведение                                                                               |
| `PUBLISH_ENABLED=true` запрещено при `DRY_RUN=true`                                    | Публикация включается только двумя явными действиями                                                                                                                     |
| Порты compose слушают только 127.0.0.1                                                 | БД и хранилище не торчат в сеть                                                                                                                                          |
| `.gitattributes` `eol=lf`                                                              | Одинаковые файлы на Windows и Linux; checksum миграций всё равно нормализует CRLF                                                                                        |
| Приложения пока не в Docker                                                            | На этапе 0 compose — только инфраструктура; контейнеры для api/bot/web — этап 5 (деплой)                                                                                 |
| CI: Linux (всё + интеграция) и Windows (lint/typecheck/unit/build)                     | Пользователь работает на Windows 11 — ловим несовместимость скриптов автоматически                                                                                       |
| Structured outputs (`output_config.format`), а не tool use                             | У Opus 5.5 / Sonnet 5.5 принудительный `tool_choice` даёт 400; structured outputs гарантируют JSON, Zod проверяет смысловые ограничения, до 2 повторов с текстом ошибок  |
| Thinking не передаём, `effort` — по агенту                                             | У Opus 5.5 thinking нельзя выключить (400), управление глубиной — через effort (по умолчанию medium)                                                                     |
| `fallbacks: "default"` при отказе модели (LLM_REFUSAL_FALLBACK)                        | Рекомендация Anthropic; стоимость считается по `usage.iterations` — каждая попытка по цене своей модели                                                                  |
| Ретраи HTTP — SDK, ретраи задач — pg-boss                                              | SDK сам повторяет 408/409/429/5xx с backoff; после исчерпания ошибка классифицируется: временная → pg-boss повторит задачу с экспоненциальным backoff, затем dead-letter |
| Резерв бюджета до вызова (worst case) под advisory lock                                | Параллельные вызовы не могут вместе превысить лимит; пауза наступает, когда _следующий_ вызов может выйти за 100%                                                        |
| Пауза — флаг на задаче, а не статус                                                    | После подтверждения задача продолжается с того же места                                                                                                                  |
| DB-триггеры: смена статуса только через transitionTask, audit_log только на добавление | Правило держится даже при ошибке в коде                                                                                                                                  |
| Пакет `engine` отдельно от `core`                                                      | `core` без зависимостей от БД — его смогут импортировать бот и веб                                                                                                       |
| Цены моделей в `config/model-pricing.json`                                             | Цены меняются чаще релизов; неизвестная модель считается по самым дорогим ценам с пометкой estimated                                                                     |
| Часовой пояс бюджета `APP_TIMEZONE` (по умолчанию Europe/Moscow)                       | «Сутки» должны совпадать с днём владельца, а не с UTC                                                                                                                    |

## Ответы владельца (зафиксировано)

- Картинки: Magnific (Nano Banana и др.), адаптер на этапе 3 по актуальной документации.
- Instagram Graph API — позже (этап 4); до этого `CsvImportProvider` (CSV и ссылки на посты).
- Локально: Windows 11 + Docker Desktop (WSL2). VPS — этап 5.
- Автопубликации нет: только экспорт (папка + сообщение в Telegram). Publisher — интерфейс и заглушка.
- Один бренд, но `brandId` во всех таблицах. Профиль бренда — дефолтный YAML, `/brand` в боте, форма в панели.
- Бюджет по умолчанию: $5 в сутки, $50 в месяц; предупреждение на 80%, пауза на 100%, возобновление только после подтверждения.
- SEO только для Instagram/Telegram.
- Секреты в `.env` пользователь заполняет сам; ключи в чат не просить и не выводить.
