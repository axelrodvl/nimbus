# Шаг 25 — Качество: линты, покрытие, храповик в CI

**Фаза 0 · Зависит от:** — · **Закрывает находки:** Q1, Q2

## Зачем

Цель «бэкенд полностью покрыт тестами» недостижима без измерения. Этот шаг ставит инструменты и
фиксирует исходную точку: покрытие считается одной командой, CI падает при его снижении, опасные
конструкции (`unwrap`, `todo!`, `dbg!`) запрещены линтером. Новой функциональности нет.

## Текущее состояние

- `backend/Cargo.toml` — workspace без секции `[workspace.lints]`; крейты в `backend/crates/*/Cargo.toml`.
- `justfile` — рецепты `backend-test`, `backend-check`, `test`, `check`; рецепта покрытия нет.
- `.github/workflows/ci.yml` — job `backend`: fmt, clippy (`--features nimbus-api/test-fakes`), `cargo test --workspace`, сверка OpenAPI.
- Тесты БД используют `#[sqlx::test]` и требуют `DATABASE_URL` (Postgres поднимается `just db-up`).
- В боевом коде есть `lock().unwrap()` (например, `crates/musicbrainz/src/client.rs`, `limiter.rs`) и `expect(...)`.

## Что сделать

1. **Линты workspace.** В `backend/Cargo.toml` добавить:
   ```toml
   [workspace.lints.rust]
   unsafe_code = "forbid"

   [workspace.lints.clippy]
   unwrap_used = "deny"
   dbg_macro = "deny"
   todo = "deny"
   unimplemented = "deny"
   print_stdout = "deny"
   print_stderr = "deny"
   ```
   В каждом `crates/*/Cargo.toml` — `[lints] workspace = true`. Создать `backend/clippy.toml` с
   `allow-unwrap-in-tests = true` (и `allow-expect-in-tests = true`, `allow-dbg-in-tests = true`, `allow-print-in-tests = true`).
2. **Исправить нарушения.** Каждое `unwrap()` в боевом коде заменить по смыслу:
   - отравленный мьютекс → `.lock().unwrap_or_else(std::sync::PoisonError::into_inner)`;
   - инвариант программы → `expect("объяснение инварианта")`;
   - данные/сеть/ввод → возврат ошибки.
   `println!` в `main.rs` для `--print-openapi` — оставить с `#[allow(clippy::print_stdout)]` и комментарием.
   Если `unsafe_code = "forbid"` ломает сборку из-за существующего `unsafe` — не удалять линт, а разобраться
   и записать в Журнал (ожидается, что `unsafe` в проекте нет).
3. **Покрытие.** Использовать `cargo-llvm-cov` (`cargo install cargo-llvm-cov --locked`; нужен компонент
   `llvm-tools-preview`: `rustup component add llvm-tools-preview`).
   - Создать `backend/coverage-threshold.txt` с одним целым числом (см. п. 5).
   - Рецепты в `justfile`:
     ```
     backend-cov:
         cd backend && cargo llvm-cov --workspace --features nimbus-api/test-fakes \
           --ignore-filename-regex '(/main\.rs|/fakes\.rs|/fake_swarm\.rs)$' \
           --fail-under-lines "$(cat coverage-threshold.txt)" --summary-only
     backend-cov-html:
         cd backend && cargo llvm-cov --workspace --features nimbus-api/test-fakes \
           --ignore-filename-regex '(/main\.rs|/fakes\.rs|/fake_swarm\.rs)$' --html
     cov: backend-cov
     ```
     Проверь, что набор features совпадает с тем, с которым сейчас гоняются тесты в CI; если тесты с
     `test-fakes` не собираются/не нужны — используй тот же набор, что `cargo test --workspace`, и запиши в Журнал.
   - `backend/.gitignore`: добавить `target/llvm-cov*` если нужно.
4. **CI.** В `.github/workflows/ci.yml`, job `backend`: заменить шаг `cargo test --workspace` на
   установку `cargo-llvm-cov` (`taiki-e/install-action@cargo-llvm-cov`) + `just`-эквивалент команды покрытия
   (тесты при этом выполняются один раз — внутри llvm-cov). Сводку покрытия вывести в `$GITHUB_STEP_SUMMARY`.
   clippy-шаг оставить как есть (он подхватит новые линты).
5. **Исходная точка.** Запустить покрытие, записать результат по крейтам в новый файл `docs/coverage.md`
   (таблица: крейт → % строк, дата; ниже — список из 15 файлов с наименьшим покрытием и числом непокрытых строк).
   В `coverage-threshold.txt` записать `floor(общий %) − 1`. Этот файл — вход для шага 35.
6. **Хелпер ожидания для тестов.** Найти в тестах самодельные циклы ожидания/`sleep`. Создать dev-крейт
   `backend/crates/testkit` (`nimbus-testkit`, `publish = false`) с
   `pub async fn eventually<F, Fut>(timeout: Duration, f: F)` (поллинг каждые 20 мс до `true`, паника с
   сообщением по таймауту) и `pub fn tempdir() -> tempfile::TempDir`. Перевести на него 2–3 самых
   очевидных места (полный перевод — не цель шага). Следующие шаги будут класть сюда общие фейки.
7. **Документация.** В `README.md` (раздел разработки) — как посчитать покрытие. В `CLAUDE.md` в «Полезные команды» добавить `just cov`.

## Тесты

- Для `eventually`: успех до таймаута; паника по таймауту (`#[should_panic]`).
- Все существующие тесты проходят без изменений поведения.

## Критерии приёмки

```
just db-up
just check          # fmt + clippy с новыми линтами, web-check
just test
just cov            # проходит с записанным порогом
cat backend/coverage-threshold.txt docs/coverage.md
```

## Не входит в шаг

- Написание новых тестов ради процента (это шаги 26–35).
- Клиентское покрытие (шаг 36).

## Подводные камни

- `cargo llvm-cov` пересобирает workspace с инструментированием — первый запуск долгий; в CI нужен кэш (`Swatinem/rust-cache` уже есть).
- `#[sqlx::test]` создаёт БД на каждый тест — убедись, что `DATABASE_URL` указывает на пользователя с правом `CREATEDB`.
- Тесты роя (`crates/torrent/tests/swarm.rs`) открывают сокеты на 127.0.0.1 — под покрытием они медленнее;
  если появляются таймауты, увеличь дедлайны в тестах, а не отключай их.
- Линт `expect_used` намеренно **не** включается: `expect` с объяснением — разрешённый способ выразить инвариант.
