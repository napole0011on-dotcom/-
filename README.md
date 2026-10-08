# Content Agents

Команда ИИ-агентов для контент-продакшна под Instagram и Telegram, с обязательным согласованием
человеком. Готовы **этап 0 (каркас)** и **этап 1 (ядро)**: модели данных, автомат статусов с audit-логом,
очередь задач, учёт расходов и бюджеты, LLM-клиент с проверкой схем. Агентов, бота и панели пока нет — см.
статус этапов в [CLAUDE.md](CLAUDE.md).

## Что нужно

- Windows 11 + [Docker Desktop](https://www.docker.com/products/docker-desktop/) (WSL2) — или Linux/macOS с Docker
- Node.js 22 LTS (≥ 22.12)
- pnpm: один раз выполнить `corepack enable` (в PowerShell от администратора), версия pnpm возьмётся из `package.json`

## Установка

```powershell
git clone <repo-url> content-agents
cd content-agents
pnpm install
copy .env.example .env      # в bash: cp .env.example .env
```

Откройте `.env` и заполните пустые значения:

- `POSTGRES_PASSWORD` — любой надёжный пароль;
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — любые строки (это логин/пароль локального хранилища,
  docker compose создаст такого пользователя).

`.env` в git не попадает.

## Запуск

```powershell
pnpm infra:up       # Postgres + хранилище; ждёт, пока оба станут healthy
pnpm db:migrate     # применить миграции
pnpm dev:api        # API на http://127.0.0.1:3000
```

## Проверка, что всё живо

```powershell
curl.exe http://127.0.0.1:3000/health    # в bash: curl ...
# {"status":"ok","checks":{"db":"ok","storage":"ok"}}   -> HTTP 200
```

Если какая-то зависимость недоступна, ответ будет `HTTP 503` и `"fail"` напротив неё; причина — в логе API.

Полная проверка (то же, что в CI):

```powershell
pnpm lint
pnpm typecheck
pnpm test                 # unit-тесты, без Docker
pnpm test:integration     # нужен pnpm infra:up
pnpm build
```

## Демо ядра (этап 1)

```powershell
pnpm infra:up
pnpm demo:core
```

Демо создаёт временную базу, проводит задачу через гейт плана (агент сам утвердить не может), запускает
агента через очередь с фейковой моделью (первый ответ не проходит схему и чинится), показывает защиту от
дублей, паузу по бюджету, audit-лог, вызовы LLM и расходы. Реальных запросов к API нет, денег не тратит.

## Бюджет

По умолчанию: $5 в сутки, $50 в месяц, $2 на задачу (`BUDGET_*` в `.env`). На 80% придёт предупреждение.
Перед каждым платным вызовом система резервирует его максимальную стоимость; если вызов может выйти за
лимит, задача встаёт на паузу и спрашивает вас. Продолжение — только после вашего подтверждения.
Цены моделей лежат в `config/model-pricing.json`.

## Миграции

```powershell
pnpm db:status            # что применено
pnpm db:rollback          # откатить последнюю миграцию (--steps N — несколько)
pnpm db:migrate           # применить снова
```

Новая миграция: поменять `packages/db/src/schema.ts` → `pnpm db:generate` → рядом с созданным
`NNNN_name.sql` написать `NNNN_name.down.sql`.

## Режимы безопасности (по умолчанию)

| Переменная        | По умолчанию | Смысл                                                                          |
| ----------------- | ------------ | ------------------------------------------------------------------------------ |
| `PROVIDERS_MODE`  | `mock`       | Никаких внешних вызовов; `real` пока не реализован и падает с понятной ошибкой |
| `DRY_RUN`         | `true`       | Ничего не уходит наружу                                                        |
| `PUBLISH_ENABLED` | `false`      | Публикации нет (только экспорт); `true` запрещено при `DRY_RUN=true`           |

Если обязательная переменная не задана, приложение не стартует и пишет, какая именно:

```
Invalid configuration. Fix these environment variables (see .env.example):
  - POSTGRES_PASSWORD: is required (PostgreSQL password, same value docker compose uses)
```

## Остановка

```powershell
pnpm infra:down                 # данные сохраняются в docker volumes
docker compose down -v          # снести вместе с данными
```

## Частые проблемы

- **Порт 5432 или 8333 занят** — поменяйте `POSTGRES_PORT` / `S3_PORT` (и `S3_ENDPOINT`) в `.env`.
- **`password authentication failed`** после смены `POSTGRES_PASSWORD` — Postgres запоминает пароль при первом
  создании тома. Либо верните старый, либо `docker compose down -v` (удалит данные).
