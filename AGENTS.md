# Repository Guidelines

## Project Structure & Module Organization

- `src/`: TypeScript UI, chat, commands, styles, and Three.js globe rendering; `index.html` is the entry page.
- `shared/`: domain types, seed access, forecasting, and reusable tools/report generation.
- `server/`: Hono API, model adapters, local CLI integration, and Node hosting.
- `mcp/server.ts`: stdio and Streamable HTTP MCP server. `functions/api/[[path]].ts` and `worker.ts` provide Cloudflare entry points.
- `data/` and `public/`: seed records, source geography, and browser assets. `db/schema.sql` contains the currently optional database schema.
- `tests/`, `scripts/`, and `docs/`: tests, verification/data utilities, and planning documents. `TODO.md` records future work.

## Build, Test, and Development Commands

Use Node.js 20.3+ and `npm install`.

- `npm run dev`: Vite UI and API at `http://localhost:62356`.
- `npm run build`: strict TypeScript checking and production output in `dist/`.
- `npm start`: build and serve through Node; `npm run serve` uses an existing build.
- `npm test`: run Vitest; target a file with `npm test -- tests/forecast.test.ts`.
- `npm run mcp:check`: verify MCP stdio and HTTP integration.
- `npm run shots`: capture UI screenshots with a running server and installed Chrome.
- `npm run cf:dev`: build and run locally through Cloudflare Wrangler.

## Coding Style & Naming Conventions

Follow existing TypeScript ES modules: two-space indentation, single quotes, and semicolons. Use camelCase for functions/variables, PascalCase for types/classes, and UPPER_SNAKE_CASE for constants. Keep filenames consistent with nearby modules, such as `forecast.ts` and `models.test.ts`. Preserve Korean UI terminology. No dedicated formatter or linter is configured; avoid unrelated formatting changes.

## Testing Guidelines

Tests use Vitest `describe`/`it` in `tests/*.test.ts`. No numeric coverage threshold is configured. Add meaningful tests for forecast boundaries, source integrity, model fallbacks, API behavior, and asynchronous changes. Mock network/model calls for deterministic tests. Run checks appropriate to the change; verify UI changes in desktop and mobile layouts.

## Commit & Pull Request Guidelines

History uses short, descriptive Korean subjects without a mandatory prefix. Keep commits focused. PR descriptions should explain the problem, resulting behavior, relevant validation, and remaining limitations. Link related issues when available and include screenshots for visible UI changes.

## Configuration & Architecture Notes

Keep credentials in ignored `.secrets`; use `.secrets.example` as the template. Never commit secrets or generated build output. Keep shared forecasting/tool behavior consistent across API and MCP. Preserve the existing six-section report format. SQLite migration, research workspaces, and live collection in `TODO.md` are planned work, not current capabilities.
