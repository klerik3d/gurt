# docs/ — индекс

Здесь лежат исторические спеки и дизайн-заметки (work orders), по которым gurt
строился; актуальная документация — в корневом [README.md](../README.md).
Многие файлы частично перекрыты более поздними (пометки «Superseded in part
by…» внутри) — самый поздний «главный» док модели контейнеров/сессий:
[requirements-session-container.md](requirements-session-container.md).

| Документ | О чём | Статус |
| --- | --- | --- |
| [design-orchestration.md](design-orchestration.md) | Заметки об оркестрации: пайплайны поверх сессий, типизированные артефакты. Помечен «UNDER DISCUSSION — DO NOT IMPLEMENT»; вместо него принят простой путь ролей (requirements-session-roles.md). Из описанного реализован только turn contract. | план |
| [logging.md](logging.md) | Локальное логирование: `~/.gurt/logs`, уровни, редакция секретов, словарь слагов. Описание as-built; кнопка «Send Report» — заглушка. | реализовано |
| [requirements-changes-panel.md](requirements-changes-panel.md) | Первая версия панели Changes в task pane (dirty/ahead, Commit/Push/PR). Модель и layout (§2, §3.1–3.2) заменены requirements-changes-thread.md, остальное действует. | частично |
| [requirements-changes-thread.md](requirements-changes-thread.md) | Панель Changes как «delivery thread» ветки `gurt/<task>`: Uncommitted / On gurt/<task>, состояния pushed/local/integrated. | реализовано |
| [requirements-dashboard.md](requirements-dashboard.md) | Дашборд: карточки агентов с лимитами плана, доска сессий, turn-ledger. | реализовано |
| [requirements-env-devcontainer.md](requirements-env-devcontainer.md) | Нормальная форма env: обязательный devcontainer.json в gurt, сборка образа по content-tag, pre-build из Settings. | реализовано |
| [requirements-env-repo-split.md](requirements-env-repo-split.md) | Разделение Env и Repo на уровне workspace. Split сделан, но модель контейнеров и стартовый гейт заменены requirements-session-container.md. | история (superseded) |
| [requirements-event-bus.md](requirements-event-bus.md) | Доменная шина событий в main (`src/main/bus.ts`) + карта `src/shared/events.ts`. Шина работает, но env-события переименованы в session-scoped более поздним доком. | история (superseded) |
| [requirements-git-access.md](requirements-git-access.md) | Нативный git в контейнере: credential-брокер, store, forge-провайдеры. Реализована phase 1 (HTTPS); ssh (phase 2) и GitHub App (phase 3) не подключены к рантайму. | частично |
| [requirements-kernel.md](requirements-kernel.md) | Вынос ядра из `ipc.ts` в electron-независимый `kernel.ts`, типизированный IPC через `src/shared/api.ts`. Сделано, но `EnvManager` из §3 стал `ContainerManager`, а `KernelEvents` заменён шиной. | история (superseded) |
| [requirements-manual-review.md](requirements-manual-review.md) | Ручное ревью: split-diff, инлайновые комментарии, review-lock, «Launch fix». Содержит секцию «As built». | реализовано |
| [requirements-multirepo-sessions.md](requirements-multirepo-sessions.md) | Несколько репозиториев в одной сессии (ныне роль researcher); монтирование клонов сиблингами. | реализовано |
| [requirements-notifications.md](requirements-notifications.md) | Уведомления: подписчик шины, колокольчик, матрица настроек. Внешняя доставка (Slack/email/push) — заявленная заглушка. | реализовано |
| [requirements-session-container.md](requirements-session-container.md) | Модель «один контейнер = одна сессия» 1:1, reconcile при старте. Самый поздний док модели — перекрывает части env-repo-split, kernel, event-bus, session-queue, stable-keys. | реализовано |
| [requirements-session-log.md](requirements-session-log.md) | Append-only лог сессии: seq-записи entry/append/patch, JSONL, дельты вместо полного снапшота. | реализовано |
| [requirements-session-queue.md](requirements-session-queue.md) | Сессия как первичная сущность, состояния draft→started, FIFO-очередь. Очередь живёт, но условия старта и модель ACP-соединений переписаны requirements-session-container.md. | история (superseded) |
| [requirements-session-roles.md](requirements-session-roles.md) | Роли сессий (executor / researcher / reviewer): монтирования, клон-лок, набор MCP-инструментов от роли. | реализовано |
| [requirements-stable-keys.md](requirements-stable-keys.md) | Централизация ключей сущностей в `src/shared/keys.ts`. Правило действует, но половина инвентаря (`envKey`, `connKey`) удалена session-container'ом. | частично |
| [requirements-turn-contract.md](requirements-turn-contract.md) | Контракт хода: MCP-сервер `gurt` с инструментом `complete`, артефакт ChangeProposal, авто-nudge. Форма сервера уточнена requirements-session-roles.md. | реализовано |
