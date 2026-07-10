# Production Readiness P0 Remediation Plan

Статус: **Proposed**

Область: template и профиль `single-vps-production`

Аудит: 2026-07-10

## 1. Назначение документа

Этот документ определяет обязательные P0-работы, после которых template можно позиционировать как
production-ready для небольших проектов, разворачиваемых на одном VPS через Docker Compose и Ansible.

Документ является не списком пожеланий, а acceptance contract:

- у каждого P0 есть описанный риск и целевое состояние;
- указан рекомендуемый путь реализации и допустимые альтернативы;
- перечислены затрагиваемые части репозитория;
- Definition of Done проверяется командами, тестами или результатами drill;
- P0 нельзя закрыть только документацией или ручной проверкой на машине разработчика.

### 1.1. Что означает production-ready в рамках этого template

Профиль `single-vps-production` не является high-availability архитектурой: отказ VPS приводит к
недоступности до восстановления хоста или переноса deployment. Для этого профиля production-ready
означает:

- публичный трафик защищён TLS, наружу выставлены только необходимые порты;
- production не может стартовать с template-секретами или известными credentials;
- deploy воспроизводим, использует immutable artifacts и имеет проверенный rollback;
- committed migrations проверяются тем же способом, которым применяются в production;
- данные регулярно копируются за пределы VPS, а восстановление проверяется;
- high/critical vulnerabilities блокируют release либо имеют временное формальное исключение;
- состояние системы после deploy подтверждается smoke tests и health checks.

До утверждения проектом собственных NFR template использует стартовые цели:

| NFR | Стартовая цель `single-vps-production` |
| --- | --- |
| Availability | 99.5% в месяц, исключая согласованные maintenance windows |
| PostgreSQL RPO | не более 24 часов для nightly backup; не более 15 минут при включённом PITR |
| PostgreSQL RTO | не более 4 часов |
| Deployment rollback | не более 15 минут для application rollback |
| Secret exposure response | отзыв/ротация затронутого секрета не более чем за 1 час |
| Critical vulnerability | блокирует release |
| High vulnerability | блокирует release либо имеет исключение с owner и expiry не более 30 дней |

Проект, которому нужны более строгие цели, должен использовать managed/HA PostgreSQL, внешний object
storage и отдельный HA deployment profile. Уменьшать цели без явного архитектурного решения нельзя.

### 1.2. P0 scope

| ID | Workstream | Обязательный результат |
| --- | --- | --- |
| P0-01 | Data resilience и release lifecycle | Проверенные migrations, off-host backup/restore, immutable artifacts и rollback |
| P0-02 | Production perimeter и hardening | TLS, минимальная public surface, segmented networks и hardened containers |
| P0-03 | Secrets и admin bootstrap | Fail-fast production config, обязательный vault и отсутствие известных credentials |
| P0-04 | Vulnerabilities и security gates | Исправленный audit и blocking dependency/image/supply-chain checks |

## 2. Общие правила закрытия P0

Любой P0 считается закрытым только когда выполнены все общие условия:

1. Изменение реализовано кодом или Infrastructure as Code и проходит code review.
2. Positive и negative paths проверяются автоматически там, где это возможно.
3. Проверка включена в CI/CD и не зависит от памяти оператора.
4. Есть runbook с командой запуска, ожидаемым результатом и rollback/recovery процедурой.
5. Проверка выполнена на clean clone или на CI runner из immutable commit.
6. Результат drill или CI run сохранён как артефакт/лог и связан с release или PR.
7. Временные исключения имеют advisory/risk ID, обоснование, owner и дату окончания.

## 3. P0-01 — Data resilience и безопасный release lifecycle

### 3.1. Риск

Текущие e2e создают схему через `zen db push --accept-data-loss`, тогда как production использует
`zen migrate deploy`. Поэтому повреждённая, отсутствующая или несовместимая committed migration может
пройти CI. Deployment собирает образы на VPS из checkout, применяет migration и выполняет Compose
recreate. Автоматизированных backup/restore, upgrade test, artifact promotion и DB-safe rollback нет.

Последствия:

- deploy может впервые обнаружить проблему migration уже на production БД;
- rollback application image не откатывает несовместимое изменение схемы;
- потеря VPS или Docker volume означает потерю данных без гарантированного восстановления;
- build на сервере не гарантирует, что запущен проверенный CI artifact.

Исходные точки в текущем репозитории:

- e2e применяет [`zen db push --accept-data-loss`](../apps/backend/test/global-setup.ts#L10);
- основной CI прямо указывает, что migration step не выполняется: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml#L23);
- production playbook собирает images на VPS: [`infra/ansible/deploy.yml`](../infra/ansible/deploy.yml#L77).

### 3.2. Целевое состояние

Release собирается один раз в CI, проходит security и migration gates, публикуется как immutable image
по digest и только затем продвигается в staging/production. База данных имеет off-host backup,
определённые RPO/RTO и проверенную процедуру восстановления. Схема изменяется forward-compatible
миграциями по expand/contract модели.

### 3.3. Рекомендуемый путь решения

#### A. Отдельный migration gate в CI

Добавить job, который использует чистый PostgreSQL и выполняет production-команду:

```bash
pnpm db:generate
pnpm db:migrate
pnpm --filter @app/backend exec zen migrate status --schema src/zenstack/schema.zmodel
```

Job должен проверять два сценария:

1. **Fresh install:** пустая БД → все committed migrations → application smoke test.
2. **Upgrade:** схема предыдущего release → migrations текущего release → application smoke test.

`db push` можно сохранить для быстрых e2e, но он не заменяет migration gate. Для upgrade test допустимы
два подхода:

- восстановить versioned schema fixture/dump предыдущего release;
- развернуть предыдущий release tag, применить его migrations, затем переключиться на текущий commit.

Второй подход предпочтителен: он проверяет реальный release path и не требует вручную поддерживать dump.

#### B. Expand/contract migrations

Все изменения, несовместимые с предыдущей версией приложения, разбивать минимум на два release:

1. **Expand:** добавить nullable column/table/index, не удаляя старую структуру.
2. Выпустить код, умеющий читать/писать обе формы; выполнить backfill отдельным ограниченным job.
3. Убедиться по telemetry, что старый путь больше не используется.
4. **Contract:** удалить старую структуру в следующем release.

Большие index/table rewrites должны иметь оценку lock duration и быть проверены на production-like объёме.
Автоматический down migration не является основным rollback: безопаснее откатить приложение и выполнить
отдельную forward-fix migration.

#### C. Backup и restore

Для стартового профиля реализовать:

- nightly `pg_dump --format=custom`;
- шифрование backup до отправки или server-side encryption с отдельным ключом;
- отправку в off-host S3-compatible storage;
- retention минимум 7 daily, 4 weekly, 6 monthly;
- checksum и автоматическую проверку, что backup не пустой и читается `pg_restore --list`;
- alert при пропущенном/неуспешном backup;
- ежемесячный restore drill в изолированную БД.

Для RPO менее 24 часов подключить WAL archiving/PITR или managed PostgreSQL с PITR. Redis хранит сессии
бота и может быть объявлен disposable; если бизнес-требования считают эти сессии данными, Redis также
включается в backup scope. Требования к OpenObserve задаются отдельно: telemetry обычно имеет меньшую
критичность, но retention должен быть явным.

Backup encryption key не должен находиться только на том же VPS, что и backup source.

#### D. Immutable artifacts и promotion

Добавить release workflow:

1. Checkout конкретного commit SHA.
2. Запустить lint, typecheck, unit/e2e, migration gate и security gates.
3. Собрать backend/frontend/bot images один раз.
4. Сгенерировать SBOM и provenance attestation.
5. Подписать images.
6. Push в registry с tag release и digest.
7. Deploy в staging по digest и запустить smoke tests.
8. После approval продвинуть те же digests в production — без повторной сборки.

Ansible должен получать `backend_image`, `frontend_image`, `bot_image` как immutable digest references и
выполнять `docker compose pull`, а не `docker compose build` на production VPS. `repo_version: main` не
должен быть допустим для production inventory.

#### E. Rollback и post-deploy verification

Release manifest должен хранить предыдущие image digests и migration version. Rollback приложения:

1. переключает Compose на предыдущие digests;
2. выполняет `docker compose up -d`;
3. ждёт readiness backend;
4. проверяет frontend, backend и bot smoke paths;
5. подтверждает error rate/latency после переключения.

DB rollback выполняется только по заранее подготовленному плану: application rollback при
forward-compatible схеме, forward-fix migration или restore/PITR при разрушительном инциденте.

### 3.4. Основные точки изменения

- `.github/workflows/ci.yml` — fresh/upgrade migration jobs.
- `.github/workflows/release.yml` — build, SBOM, signing, registry push, promotion.
- `infra/docker/docker-compose.yml` — image references вместо production build context.
- отдельный `docker-compose.dev.yml` — локальные build и published DB/Redis ports.
- `infra/ansible/deploy.yml` — pull/deploy по digest, pre/post checks и rollback metadata.
- `infra/ansible/group_vars/*` — environment-specific image digests и backup policy.
- `infra/ansible/roles/backup/` или эквивалент — backup timer, upload, retention, alerts.
- `docs/runbooks/BACKUP_RESTORE.md` и `docs/runbooks/ROLLBACK.md`.

### 3.5. Definition of Done

- [ ] CI с нуля создаёт БД исключительно через committed `zen migrate deploy` и затем запускает smoke/e2e.
- [ ] CI успешно обновляет БД предыдущего release до текущего и запускает current application smoke test.
- [ ] Удаление migration file или намеренно невалидная migration гарантированно делает CI красным.
- [ ] Production deployment использует image digests, собранные и проверенные в CI.
- [ ] На VPS не выполняются `git clone`/`docker compose build` как часть production deploy.
- [ ] Release manifest связывает commit SHA, image digests, SBOM и migration version.
- [ ] Staging и production получают одни и те же image digests.
- [ ] Nightly encrypted backup автоматически уходит за пределы VPS и имеет retention policy.
- [ ] Failure backup job создаёт проверяемый alert.
- [ ] Restore drill восстанавливает последнюю копию в изолированную БД и проходит integrity/application checks.
- [ ] Зафиксированы фактически измеренные RPO и RTO; они не хуже принятых NFR.
- [ ] Rollback drill возвращает предыдущую application version не более чем за 15 минут.
- [ ] Для каждой destructive migration есть отдельный review шага expand/contract и recovery plan.
- [ ] Runbooks позволяют выполнить backup restore и rollback оператору, который не писал реализацию.

## 4. P0-02 — Production perimeter и container/host hardening

### 4.1. Риск

Текущий Compose напрямую публикует backend/frontend, а optional OpenObserve и OTLP collector доступны на
всех host interfaces. В template нет TLS termination, production firewall, разделения Docker networks,
ограничения публичного OTLP ingest, log rotation и системного container hardening. OpenObserve использует
floating tag `latest` и имеет рабочие default credentials.

Компрометация любого контейнера в общей сети потенциально открывает путь к PostgreSQL, Redis и telemetry
storage. Публичный collector без защиты позволяет отправлять мусорную telemetry и расходовать диск.

Исходные точки в текущем репозитории:

- backend публикует host port напрямую: [`docker-compose.yml`](../infra/docker/docker-compose.yml#L116);
- OpenObserve использует `latest`, default credentials и public port: [`docker-compose.yml`](../infra/docker/docker-compose.yml#L191);
- collector запускается root и публикует OTLP port: [`docker-compose.yml`](../infra/docker/docker-compose.yml#L216);
- frontend nginx слушает HTTP без TLS termination: [`nginx.conf`](../infra/docker/nginx.conf#L3).

### 4.2. Целевое состояние

На публичном интерфейсе VPS открыты только `80/443` и контролируемый SSH. TLS автоматически выпускается и
обновляется. Backend, database, Redis, OpenObserve и collector доступны только через необходимые internal
networks. Browser telemetry, если включена, проходит через ограниченный reverse-proxy endpoint.

### 4.3. Рекомендуемый путь решения

#### A. Reverse proxy и TLS

Для single-VPS профиля предпочтителен Caddy как Compose service из-за автоматического ACME. Допустимы
Traefik или nginx, если сертификаты и renewal полностью автоматизированы.

Рекомендуемая маршрутизация:

- `app.example.com` → frontend:80;
- `api.example.com` → backend:3000;
- `observe.example.com` → OpenObserve только через TLS и дополнительный access layer;
- `/otlp/v1/traces` → collector только если включён browser tracing.

Backend/frontend services должны использовать `expose`, а не публичные `ports`. PostgreSQL и Redis в
production Compose не публикуются даже на loopback; локальные ports переносятся в dev override.

Для frontend/API включить HSTS после проверки TLS, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy` и CSP. Swagger в production либо выключается, либо защищается отдельным access rule;
CSP не следует отключать глобально только ради Swagger.

#### B. Docker network segmentation

Ввести минимум три сети:

| Network | Участники | Назначение |
| --- | --- | --- |
| `edge` | reverse proxy, frontend, backend | публичная маршрутизация |
| `app_internal` | backend, bot, PostgreSQL, Redis | application data plane |
| `observability_internal` | backend, bot, collector, OpenObserve | telemetry data plane |

`app_internal` и `observability_internal` должны быть `internal: true`, если это совместимо с outbound
requirements. Frontend nginx не должен иметь маршрут к PostgreSQL/Redis. OpenObserve не должен иметь
маршрут в application database network.

#### C. Public browser OTLP

Не публиковать collector `:4318` напрямую. Reverse proxy endpoint должен иметь:

- точный CORS allowlist production origins;
- разрешённые методы и headers;
- request body size limit;
- rate limit;
- отдельный tenant/API path, если backend это поддерживает;
- WAF/firewall ограничения, где применимо.

Если browser tracing отключён, collector остаётся полностью internal.

#### D. Container hardening

Для каждого stateless service применить максимально возможный набор:

- non-root `user`;
- `read_only: true`;
- `tmpfs` для `/tmp` и runtime cache;
- `cap_drop: [ALL]` и возврат только необходимой capability;
- `security_opt: [no-new-privileges:true]`;
- `init: true` и ограниченный `stop_grace_period`;
- memory/CPU/PID limits;
- pinned image version, а для production release — digest;
- runtime image без compiler toolchain и dev dependencies.

PostgreSQL, Redis и OpenObserve требуют writable volumes, но остальные ограничения применяются и к ним по
возможности. Bot runtime сейчас наследует build base с `python3/make/g++`; для runner нужен отдельный slim
stage.

#### E. Host hardening и logs

Ansible должен конфигурировать или явно проверять:

- firewall: публично только 80/443 и SSH из разрешённой сети;
- automatic security updates или documented patch cadence;
- Docker daemon и Compose minimum versions;
- disk usage alerts;
- Docker logging limits (`max-size`, `max-file`) для всех services;
- NTP/time synchronization;
- запрет password SSH и root login, если host provisioning входит в scope.

Image tags `latest` запрещены. Base images и GitHub Actions должны быть закреплены digest/full commit SHA
либо обновляться контролируемым dependency bot.

### 4.4. Основные точки изменения

- `infra/docker/docker-compose.yml` — networks, expose, hardening, logging, immutable images.
- `infra/docker/docker-compose.dev.yml` — local ports и local build.
- `infra/docker/Caddyfile` или конфигурация выбранного proxy.
- `infra/docker/nginx.conf` — frontend security headers.
- `infra/docker/Dockerfile.*` — минимальные runtime stages и pinned bases.
- `infra/ansible/deploy.yml` или отдельная host role — firewall и host preflight.
- `infra/ansible/group_vars/*` — domains, public features, SSH/firewall policy.
- `docs/runbooks/TLS.md` и `docs/runbooks/HOST_HARDENING.md`.

### 4.5. Definition of Done

- [ ] На чистом production host публично слушают только 80/443 и согласованный SSH port.
- [ ] Backend, PostgreSQL, Redis, OpenObserve и collector не имеют прямых public port bindings.
- [ ] TLS certificate валиден, renewal проверен staging ACME или controlled renewal test.
- [ ] HTTP перенаправляется на HTTPS; HSTS и утверждённые security headers присутствуют.
- [ ] Production CORS разрешает только утверждённые origins и не использует wildcard с credentials.
- [ ] Из frontend container невозможно подключиться к PostgreSQL и Redis.
- [ ] Из внешней сети невозможно обратиться к OpenObserve/collector в обход reverse proxy/access policy.
- [ ] При выключенном browser tracing OTLP collector полностью internal.
- [ ] Публичный OTLP endpoint имеет body limit, CORS allowlist и rate limit; negative tests получают 4xx/429.
- [ ] Все application containers работают non-root и с `no-new-privileges`.
- [ ] Stateless containers имеют read-only root filesystem либо документированное исключение.
- [ ] Bot/backend runtime images не содержат compiler toolchain и ненужные dev dependencies.
- [ ] Нет production images с tag `latest`; deployed digests совпадают с release manifest.
- [ ] Docker logs ротируются; disk exhaustion test/расчёт подтверждает bounded usage.
- [ ] External smoke проверяет frontend, API, certificate chain и отсутствие неожиданных open ports.
- [ ] Host-hardening и TLS runbooks проверены другим участником команды.

## 5. P0-03 — Production secrets и безопасный bootstrap администратора

### 5.1. Риск

Template placeholders удовлетворяют текущим минимальным Zod-ограничениям и могут попасть в production.
Ansible Vault optional: playbook способен продолжить deploy без vault, используя `change-me` значения.
Seed имеет известные admin credentials, доступен в production и печатает пароль в stdout.

Также конфигурация содержит `JWT_REFRESH_SECRET`, хотя refresh tokens являются opaque random tokens и этот
secret не используется. Лишний обязательный секрет усложняет rotation и создаёт ложное впечатление, что
refresh tokens им подписаны.

Исходные точки в текущем репозитории:

- secrets проверяются преимущественно только по минимальной длине: [`packages/config`](../packages/config/src/index.ts#L17);
- production group vars содержат рабочие `change-me` defaults: [`group_vars/all.yml`](../infra/ansible/group_vars/all.yml#L48);
- seed создаёт и печатает известные admin credentials: [`seed.ts`](../apps/backend/src/zenstack/seed.ts#L13).

### 5.2. Целевое состояние

Production процесс не стартует и deployment не начинается, если присутствует placeholder, слабый secret,
небезопасный origin или отсутствующий vault. Создание первого администратора является явной одноразовой
операцией с внешне заданными credentials; пароль никогда не хранится в git и не попадает в логи.

### 5.3. Рекомендуемый путь решения

#### A. Cross-field production validation

Расширить `@app/config` production refinements:

- JWT access secret — минимум 32 random bytes энтропии;
- service token — минимум 32 random bytes;
- разные типы secrets не могут быть равны;
- запрещены `change-me`, `replace-with`, example/test значения и известные defaults;
- `CORS_ORIGIN` и public API URL используют HTTPS;
- cookie domain соответствует production host policy;
- `DATABASE_URL`, `REDIS_URL`, OTLP URL валидируются как URL соответствующего протокола;
- boolean env принимает только утверждённые значения, а не превращает опечатку в `false`;
- production config не принимает `localhost`, если явно выбран Compose deployment mode.

Не следует пытаться оценивать пароль только регулярным выражением. Secrets должны генерироваться CSPRNG и
передаваться как base64/hex с документированной длиной.

`JWT_REFRESH_SECRET` рекомендуется удалить из schema, `.env.example`, Compose, Ansible и docs. Если принято
решение перейти на signed refresh JWT, это должно быть отдельным ADR и redesign текущей token rotation.

#### B. Ansible preflight assertions

Перед изменением server state playbook должен проверять:

- production vault file загружен;
- ни одна secret variable не совпадает с placeholder/default pattern;
- `repo_version`/release version immutable;
- public domains не являются `example.com`;
- `node_env == production` для production inventory;
- Redis password и `REDIS_URL` согласованы, если Redis auth включён;
- обязательные frontend build-time variables заданы до сборки/release.

`ansible-playbook --check` может работать с placeholder inventory, но реальный deploy должен требовать
явный `deployment_environment=production` и проходить строгий preflight.

#### C. Safe admin bootstrap

У seed не должно быть production defaults. Предпочтительная модель:

- отдельный `bootstrap-admin` CLI;
- `SEED_ADMIN_EMAIL` и `SEED_ADMIN_PASSWORD` обязательны при вызове;
- пароль минимум 12–16 символов или generated one-time secret;
- в production требуется дополнительный `CONFIRM_PRODUCTION_BOOTSTRAP=true`;
- команда завершается с ошибкой, если admin уже существует, либо работает строго idempotent без смены пароля;
- пароль не выводится в stdout/stderr;
- после первого использования secret удаляется/ротируется;
- событие создания администратора попадает в audit log без password/token.

Для продуктов с регистрацией предпочтительнее invite/first-user flow с одноразовым bootstrap token.

#### D. Rotation runbook

Описать безопасную ротацию:

- access JWT keys: переходное окно с key id/key ring либо явный logout всех sessions;
- service token: два одновременно принимаемых token hashes на период смены;
- DB/Redis/OpenObserve credentials: порядок изменения consumer → server → удаления старого секрета;
- Telegram token: отзыв у BotFather и controlled restart;
- Sentry/OTLP credentials: обновление collector/application без публикации в logs.

Секреты не должны попадать в `docker compose config`, CI artifacts, shell history или Ansible output;
secret-bearing Ansible tasks используют `no_log: true`.

### 5.4. Основные точки изменения

- `packages/config/src/index.ts` и новые config tests.
- `.env.example` — только non-working placeholders с явной генерацией.
- `apps/backend/src/zenstack/seed.ts` или новый `bootstrap-admin.ts`.
- `apps/backend/package.json` и root scripts.
- `infra/ansible/deploy.yml` — production assertions до server mutation.
- `infra/ansible/group_vars/*` и `templates/env.j2`.
- `infra/docker/docker-compose.yml` — убрать working production defaults.
- `docs/runbooks/SECRET_ROTATION.md` и `docs/runbooks/ADMIN_BOOTSTRAP.md`.

### 5.5. Definition of Done

- [ ] Backend и bot отказываются стартовать в `NODE_ENV=production` со всеми template placeholders.
- [ ] Unit tests покрывают каждый запрещённый placeholder и слабый secret.
- [ ] Опечатка в boolean env приводит к validation error, а не молча превращается в `false`.
- [ ] Production Ansible deploy без vault завершается до clone/build/migration.
- [ ] Production deploy с `main`, `example.com`, `localhost` или `change-me` завершается на preflight.
- [ ] Реальные secrets отсутствуют в git history текущего release и в CI artifacts.
- [ ] `JWT_REFRESH_SECRET` удалён либо его назначение закреплено ADR и реализацией.
- [ ] Redis server auth и `REDIS_URL` согласованы и проверены integration test, если auth обязателен.
- [ ] Admin bootstrap не имеет email/password defaults и требует явного подтверждения в production.
- [ ] Admin password не появляется в stdout, structured logs, traces или Ansible output.
- [ ] Повторный bootstrap не создаёт второго администратора и не меняет credentials неожиданно.
- [ ] Создание администратора создаёт безопасную audit запись.
- [ ] Rotation runbook проверен минимум для JWT access key и service token.
- [ ] После test rotation старые credentials больше не принимаются по окончании transition window.

## 6. P0-04 — Vulnerability remediation и blocking security gates

### 6.1. Риск

На момент аудита `pnpm audit` обнаруживает `multer@2.1.1` с high и moderate DoS advisories; исправленная
версия — `>=2.2.0`. Сейчас application не имеет upload endpoint, что снижает непосредственную
эксплуатируемость, но transitive dependency уже находится в production graph и станет reachable при
первом использовании Nest upload interceptor.

CI собирает и сканирует images, но Trivy настроен как advisory: `continue-on-error`, `exit-code: 0`.
Dependency audit, secret scanning, SBOM enforcement и формализованные исключения отсутствуют.

Исходные точки в текущем репозитории:

- vulnerable transitive version закреплена в [`pnpm-lock.yaml`](../pnpm-lock.yaml#L3273);
- Trivy scan намеренно non-gating: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml#L214).

### 6.2. Целевое состояние

Release не может быть создан при known critical/high runtime vulnerability. Security findings видимы в
SARIF и одновременно являются gate. Исключение возможно только временно, с owner, анализом reachability,
компенсирующими мерами и expiry. Dependencies и CI actions обновляются контролируемо.

### 6.3. Рекомендуемый путь решения

#### A. Исправить текущий Multer advisory

Порядок действий:

1. Обновить NestJS platform packages до версии, разрешающей `multer >=2.2.0`.
2. Если upstream update временно отсутствует, использовать root `pnpm.overrides` на `multer >=2.2.0`.
3. Проверить peer/dependency graph и отсутствие второй vulnerable версии в lockfile.
4. Выполнить весь unit/e2e suite и добавить минимальный multipart compatibility test до появления реального
   upload feature.
5. Удалить temporary override после обновления upstream dependency.

Override допустим только после проверки совместимости и должен иметь комментарий/issue с условием удаления.

#### B. Dependency audit gate

Добавить CI job:

```bash
pnpm audit --prod --audit-level high
```

Policy:

- critical/high production advisory блокирует PR/release;
- moderate обязательно triage, но может не блокировать template baseline;
- dev/build high также triage, потому что build dependency способна скомпрометировать artifact;
- audit network/API outage отличается от `0 findings`, но всё равно не считается успешной проверкой.

Одного registry audit недостаточно: его дополняют image scan и dependency update automation.

#### C. Blocking image scan

Изменить Trivy:

- убрать `continue-on-error` у gating scan;
- установить `exit-code: 1` для fixable HIGH/CRITICAL;
- сохранить отдельный SARIF upload step с `if: always()`;
- сканировать final runtime image, а не только filesystem/build stage;
- добавить config/secret scan;
- не скрывать `unfixed` finding без записи в risk register.

Допустима отдельная policy для unfixed CVE, но она должна требовать временное исключение.

#### D. Security exception process

Создать machine-readable allowlist, например `.security/exceptions.yaml`, с полями:

```yaml
- advisory: GHSA-xxxx-xxxx-xxxx
  component: package-or-image
  reason: not reachable because ...
  compensating_controls: ...
  owner: team-or-person
  created: YYYY-MM-DD
  expires: YYYY-MM-DD
```

CI проверяет schema, expiry и запрещает бессрочные исключения. Максимальный срок high exception — 30 дней.

#### E. Supply-chain hardening

Минимальный набор:

- Renovate или Dependabot для npm, GitHub Actions и Docker images;
- GitHub Actions закреплены full commit SHA;
- weekly scheduled dependency/image rescan;
- gitleaks/эквивалент на PR и full-history baseline;
- SBOM в CycloneDX/SPDX для каждого image;
- image signing и provenance attestation;
- проверка подписи перед production deploy;
- AI skills installer использует pinned CLI version и pinned source refs, а `skills-lock.json` hash реально
  проверяется до активации skill.

### 6.4. Основные точки изменения

- `package.json`/`pnpm-lock.yaml` — dependency fix и при необходимости temporary override.
- `.github/workflows/ci.yml` — audit, secret scan и blocking Trivy.
- `.github/workflows/security-scan.yml` — scheduled rescan.
- `.github/workflows/release.yml` — SBOM, signing и provenance.
- `.github/dependabot.yml` или `renovate.json`.
- `.security/exceptions.yaml` и schema validator.
- `scripts/install-skills.mjs`/`skills-lock.json` — AI skill integrity enforcement.
- `docs/SECURITY.md` и `docs/runbooks/VULNERABILITY_RESPONSE.md`.

### 6.5. Definition of Done

- [ ] `pnpm audit --prod --audit-level high` возвращает exit code 0.
- [ ] В lockfile отсутствует vulnerable `multer@2.1.1`; разрешённая версия `>=2.2.0`.
- [ ] Unit, backend e2e и frontend e2e проходят после dependency update.
- [ ] Намеренно добавленная vulnerable test dependency делает audit job красным.
- [ ] Trivy возвращает non-zero на fixable HIGH/CRITICAL и блокирует merge/release.
- [ ] SARIF загружается даже при падении gating scan.
- [ ] Unfixed high/critical либо блокирует release, либо имеет непросроченное exception.
- [ ] CI отклоняет exception без owner/reason/expiry или с истёкшей датой.
- [ ] Secret scanner проходит на repository baseline и блокирует новый test secret fixture без allow rule.
- [ ] Для каждого release опубликованы SBOM, provenance и signatures.
- [ ] Production deploy проверяет image signature/digest до запуска.
- [ ] Dependency bot создаёт PR для npm, Actions и Docker updates; его PR проходят полный CI.
- [ ] Scheduled scan запускается минимум еженедельно и имеет уведомление при failure/finding.
- [ ] Все third-party GitHub Actions закреплены full commit SHA.
- [ ] Skill installer проверяет pinned source и hash; намеренно изменённый skill не активируется.
- [ ] Vulnerability response runbook содержит triage, containment, patch, deploy и verification шаги.

## 7. Cross-P0 implementation order

Рекомендуемый порядок уменьшает повторную работу и не допускает deployment нового pipeline поверх
небезопасной конфигурации.

### Wave 1 — Контракты и немедленные риски

1. Утвердить NFR/RPO/RTO и production profile.
2. Исправить Multer advisory.
3. Запретить placeholders и default admin seed.
4. Добавить blocking dependency/security gates.

### Wave 2 — Данные и release artifact

1. Добавить fresh/upgrade migration CI.
2. Реализовать off-host backup и restore drill.
3. Создать immutable image release pipeline, SBOM/signing и registry promotion.
4. Перевести Ansible с build-on-VPS на deploy-by-digest.

### Wave 3 — Perimeter и operational verification

1. Разделить dev/prod Compose.
2. Добавить reverse proxy/TLS, network segmentation и container hardening.
3. Добавить staging, public smoke tests и rollback automation.
4. Провести restore, rollback и host exposure drills.

P0-01 и P0-02 могут разрабатываться параллельно после утверждения production profile, но финальный drill
должен выполняться на одном и том же release pipeline.

## 8. Итоговая release acceptance matrix

| Gate | Evidence | Критерий принятия |
| --- | --- | --- |
| Config preflight | CI/Ansible log без secret values | placeholders и unsafe production URLs отклоняются |
| Dependency audit | `pnpm audit` artifact | нет critical/high runtime findings без exception |
| Image scan | Trivy SARIF + job status | fixable critical/high отсутствуют |
| Secret scan | scanner report | новых secrets нет |
| Fresh migration | CI job | пустая БД обновлена committed migrations, app smoke green |
| Upgrade migration | CI job | previous release DB обновлена, app smoke green |
| Backup | object metadata + checksum | off-host encrypted backup существует и соответствует retention |
| Restore drill | drill report | данные восстановлены, integrity checks green, RTO/RPO соблюдены |
| Artifact integrity | registry/provenance/signature | deployed digest подписан и связан с commit/SBOM |
| Staging | deployment + smoke report | те же digests, что планируются для production |
| Perimeter | port/TLS/header/network tests | публичны только разрешённые endpoints |
| Production deploy | deploy manifest | readiness/smoke/telemetry checks green |
| Rollback | drill report | предыдущая версия восстановлена в пределах target time |

## 9. Global Definition of Done для P0 milestone

P0 milestone закрыт, когда:

- [ ] Все DoD пункты P0-01…P0-04 выполнены либо имеют одобренное, непросроченное exception.
- [ ] CI, release и deployment запускаются из clean immutable commit.
- [ ] Реальный staging deployment прошёл migration, security, perimeter и smoke gates.
- [ ] На production-like host выполнены backup restore и application rollback drills.
- [ ] Ни один production step не требует копирования команды/секрета из личных заметок разработчика.
- [ ] Runbooks проверены человеком, не участвовавшим в их написании.
- [ ] `AGENTS.md`, README и QUICKSTART не обещают поведение, которое не проверяется automation.
- [ ] Результаты audit/drills привязаны к release candidate.
- [ ] Ответственный владелец template формально принимает остаточные риски single-VPS архитектуры.

После выполнения этого milestone template можно позиционировать как production-ready для
`single-vps-production`. Термины HA, zero-downtime и disaster-resilient нельзя использовать без отдельного
профиля, infrastructure design и проверенных более строгих NFR.

## 10. Не входит в P0

Следующие важные пункты остаются P1 и не должны блокировать P0 milestone, если не повышают риск конкретного
проекта:

- API versioning и OpenAPI compatibility diff;
- refresh-token family/reuse detection и полный account lifecycle;
- frontend single-flight refresh/retry;
- OTel preload и полная frontend observability wiring;
- coverage thresholds и load/chaos tests сверх P0 drills;
- template initializer, optional feature profiles и package watch mode;
- HA application replicas, managed PostgreSQL failover и multi-region DR.

Если проект обрабатывает платежи, медицинские данные, критичные PII или имеет regulatory requirements,
часть этих P1 автоматически становится P0 для конкретного проекта.
