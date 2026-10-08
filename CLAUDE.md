# CLAUDE.md

Мульти-агентная система для контент-продакшна (Instagram/Telegram). Агенты: CEO, Copywriter,
Image Generator, Video Ideas, Instagram Analyst, SEO Specialist, Critic. Ничего не публикуется и не
считается финальным без согласования человеком (гейт 1 — план, гейт 2 — итог).

## Текущий статус

| Этап                                                    | Статус                     |
| ------------------------------------------------------- | -------------------------- |
| 0. Каркас                                               | готово, ждёт подтверждения |
| 1. Ядро (модели, автомат статусов, очередь, LLM-клиент) | не начат                   |
| 2. Copywriter + Critic + CEO + Telegram-гейты           | не начат                   |
| 3. Image (Magnific), Video Ideas, SEO, DAG              | не начат                   |
| 4. Instagram Analyst (CSV → Graph API)                  | не начат                   |
| 5. Панель, эксплуатация, деплой                         | не начат                   |
| 6. Eval, нагрузка, ревью безопасности                   | не начат                   |

## Стек

TypeScript (strict) · Node.js ≥ 22.12 · pnpm workspaces · PostgreSQL 16 · Drizzle ORM (+ свой
раннер миграций) · Fastify · pino · Zod 4 · Vitest · ESLint 10 + Prettier · Docker Compose
(Postgres + SeaweedFS как S3). Дальше по плану: pg-boss, @anthropic-ai/sdk, grammY, React + Vite, sharp.

## Структура

```
apps/api            Fastify HTTP API (пока только /health)
packages/core       конфиг (Zod-валидация env), логгер (pino с редактированием секретов)
packages/db         Drizzle-схема, клиент, раннер миграций с откатом, CLI
packages/db/migrations  NNNN_name.sql (drizzle-kit) + NNNN_name.down.sql (вручную, обязателен)
packages/providers  интерфейсы провайдеров, mock-реализации, хранилище (local/S3), заглушка Publisher
scripts/            кроссплатформенные node-скрипты (никакого bash)
```

Ещё не созданы (появятся на своих этапах): `apps/bot` (этап 2), `apps/web` (этап 5),
`packages/agents` (этап 2).

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

## Принятые решения

| Решение                                                            | Почему                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drizzle, а не Prisma                                               | Схема в TS, SQL почти как есть, без отдельного движка и шага генерации клиента; удобные транзакции и блокировки строк для автомата статусов                         |
| Свой раннер миграций поверх SQL от drizzle-kit                     | У drizzle-kit нет down-миграций, а откат — требование. Раннер: advisory lock, транзакция на миграцию, checksum с нормализацией CRLF                                 |
| SeaweedFS вместо MinIO                                             | MinIO перестал публиковать community-образы на Docker Hub (`minio/minio` недоступен). SeaweedFS `weed mini` — S3-совместимый, ключи из env, анонимный доступ закрыт |
| Postgres 16                                                        | Поддерживается до ноября 2028, образ уже стабилен; переход на 17 — отдельным решением                                                                               |
| TypeScript 6.0, не 7                                               | typescript-eslint поддерживает TS < 6.1                                                                                                                             |
| DB-подключение собирается из `POSTGRES_*`, а не из `DATABASE_URL`  | Один источник правды для compose и приложения, нельзя рассинхронизировать пароль                                                                                    |
| Пустая переменная в `.env` = не задана                             | Скопированный `.env.example` даёт понятную ошибку «X is required», а не странное поведение                                                                          |
| `PUBLISH_ENABLED=true` запрещено при `DRY_RUN=true`                | Публикация включается только двумя явными действиями                                                                                                                |
| Порты compose слушают только 127.0.0.1                             | БД и хранилище не торчат в сеть                                                                                                                                     |
| `.gitattributes` `eol=lf`                                          | Одинаковые файлы на Windows и Linux; checksum миграций всё равно нормализует CRLF                                                                                   |
| Приложения пока не в Docker                                        | На этапе 0 compose — только инфраструктура; контейнеры для api/bot/web — этап 5 (деплой)                                                                            |
| CI: Linux (всё + интеграция) и Windows (lint/typecheck/unit/build) | Пользователь работает на Windows 11 — ловим несовместимость скриптов автоматически                                                                                  |

## Ответы владельца (зафиксировано)

- Картинки: Magnific (Nano Banana и др.), адаптер на этапе 3 по актуальной документации.
- Instagram Graph API — позже (этап 4); до этого `CsvImportProvider` (CSV и ссылки на посты).
- Локально: Windows 11 + Docker Desktop (WSL2). VPS — этап 5.
- Автопубликации нет: только экспорт (папка + сообщение в Telegram). Publisher — интерфейс и заглушка.
- Один бренд, но `brandId` во всех таблицах. Профиль бренда — дефолтный YAML, `/brand` в боте, форма в панели.
- Бюджет по умолчанию: $5 в сутки, $50 в месяц; предупреждение на 80%, пауза на 100%, возобновление только после подтверждения.
- SEO только для Instagram/Telegram.
- Секреты в `.env` пользователь заполняет сам; ключи в чат не просить и не выводить.
