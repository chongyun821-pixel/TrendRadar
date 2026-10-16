# Repository Guidelines

## Project Structure

- `src/`: TypeScript UI, chat, commands, styles, and Three.js globe rendering; `index.html` is the entry page.
- `shared/`: domain types, API-loaded data, forecasting, and shared API/MCP tools and country reports.
- `server/store.ts`: SQLite and workspaces; `runs.ts`/`execution.ts`: persistent jobs and cancellation; `research.ts`: research validation and Firecrawl; `attachments.ts`: uploads and extraction; `artifacts.ts`: completed Word file registration. Other server modules host Hono and model adapters.
- `mcp/server.ts`: stdio and Streamable HTTP MCP. `functions/api/[[path]].ts` and `worker.ts` only return an unsupported-runtime response; production requires local Node hosting.
- `db/initial.sqlite`: first-run database. `db/schema.sql` defines storage and `db/migration-receipt.json` records the completed seed migration. Runtime data lives in ignored `.local/`; source geography/assets live in `data/` and `public/`.
- `templates/research-v1.md`: versioned research submission contract. `tests/` and `scripts/`: verification and utilities. Read `README.md` for operation and `TODO.md` for unfinished work; older planning documents are not proof of current capabilities.

## Commands and Configuration

Use Node.js 22.16+ (22.x) or 24+ and `npm install`.

- `npm run dev`: Vite UI and API at `http://localhost:62356`.
- `npm run build`: strict TypeScript checking and production output in `dist/`.
- `npm start`: Vite build and Node hosting; `npm run serve` uses an existing build. Use `npm run build` for strict TypeScript checking. The start command is not `node start`.
- `npm test`: run Vitest; target a file with `npm test -- tests/forecast.test.ts`.
- `npm run mcp:check`: verify MCP stdio and HTTP integration.
- `npm run shots`: capture UI screenshots with a running server and installed Chrome.
- `npm run chat:check`: verify history, file selection/drop uploads, popovers, in-panel status, square stop icon, model changes, and desktop/mobile layouts.
- `npm run markdown:check`: verify Markdown rendering, raw-message persistence, multiline input, and mobile table/code scrolling with a running server and Chrome/Edge.
- `npm run db:backup -- <folder>` / `npm run db:restore -- <folder>`: database and workspace backup/restore; stop server and MCP for restore.

Keep keys in ignored `.secrets`, using `.secrets.example` for supported settings. Its parser accepts literal `KEY=VALUE` and does not expand environment variables. API/model settings from `.secrets` override process environment in Node/Vite; `RADAR_STORAGE_DIR` and `RADAR_DB_PATH` give process environment priority. MCP host settings and browser-check settings such as `MCP_PORT`, `BASE_URL`, and `CHROME_PATH` are process environment variables.

Run UI checks with a running server and Chrome or Edge selected by `CHROME_PATH`; `BASE_URL` selects the server. For isolated checks, set a temporary storage directory and DB path and use another port. Do not interrupt an existing user server or alter operational data just to run checks. Restart Node after backend/config changes.

## Architecture Rules

- SQLite is the only source of operating data. Copy `db/initial.sqlite` only when the operating DB is absent. Do not restore seed JSON, a recurring seed importer, or initialization that overwrites updated data. API and MCP must share the same DB and forecasting/tool behavior.
- Preserve full messages, original attachments, source evidence, and conversation workspaces. Long API histories use handoff summaries plus original-message lookup. Conversation deletion removes the chat but retains source/report evidence. Cancellation and version checks must prevent late writes from stopped jobs.
- Research follows `research_procurement` → actual search/read → `save_source` → `submit_research` → recalculation. Preserve URLs, hashes, publication/collection dates, quotations, uncertainty, and change history. Search snippets alone are not verified source text.
- Codex and Grok use their existing CLI tools, settings, and authentication; Grok also uses XSearch. Gemma/Nemotron use Firecrawl MCP. Do not edit global CLI configuration or replace native tools with app-specific restrictions or arbitrary overall time/output limits.
- Preserve the existing six-section country report. Freeform Word reports use Codex Documents or Grok's native `docx` skill for authoring, layout, and verification. The app registers completed `.docx` files through `publish_artifact` and preserves download snapshots; never substitute a Markdown-to-Word converter or publish unregistered drafts automatically. `CLI_DOCUMENT_TOOLS_PATH` adds renderer directories to child CLI PATH only.
- Keep the conversation menu at the left of the composer and the resources/upload menu above its `＋` button. Show job status inside the chat panel and use a square stop icon. User/model/report messages share safe Markdown rendering; preserve raw text and indentation. Enter sends, Shift+Enter adds a line, and IME composition must not trigger sending.

## Coding Style

Follow existing TypeScript ES modules: two-space indentation, single quotes, and semicolons. Use camelCase for functions/variables, PascalCase for types/classes, and UPPER_SNAKE_CASE for constants. Keep filenames consistent with nearby modules, such as `forecast.ts` and `models.test.ts`. Preserve Korean UI terminology. No dedicated formatter or linter is configured; avoid unrelated formatting changes.

## Testing Guidelines

Tests use Vitest `describe`/`it` in `tests/*.test.ts`. No numeric coverage threshold is configured. Add meaningful tests for forecast boundaries, source integrity, model fallbacks, persistence/cancellation, API/MCP behavior, and artifact downloads. Mock network/model calls for deterministic tests. Verify visible UI changes in desktop and mobile layouts. Distinguish mocked tests from actual provider/CLI checks and record failed or unavailable verification accurately.

## Commit & Pull Request Guidelines

History uses short, descriptive Korean subjects without a mandatory prefix. Keep commits focused. PR descriptions should explain the problem, resulting behavior, relevant validation, and remaining limitations. Link related issues when available and include screenshots for visible UI changes.

## Configuration & Architecture Notes

Never commit credentials, `.local/` operating data, screenshots, generated reports/build output, or SQLite WAL/SHM files. The tracked initial database is intentional. Keep this guide and `.secrets.example` aligned with implementation; summarize completed work in `TODO.md` while retaining unresolved items and limitations. Long-term source-rule automation and PowerPoint generation remain out of scope unless requested.
