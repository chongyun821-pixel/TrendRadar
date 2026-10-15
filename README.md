# 무기조달사업예상 · Global Procurement Radar

세계 주요국이 **언제, 어떤 무기를, 얼마나 큰 규모로** 새로 살지 지구본 히트맵으로 보여 주는 웹앱입니다.
보유 장비의 도입 연도·설계 수명·MRO(수명 연장) 기록으로 다음 교체 사업 시점과 규모를 **예측 범위**로 계산합니다.

- 화면 전체 3D 지구본(드래그 회전·휠 확대) ↔ **지도 모드** 2D 세계지도(펼침 전환), 히트맵은 두 모드 공통
- 모드 7개: 일반 · 자주포 · 장갑차 · 대공미사일 · 다연장로켓 · 호위함 · 재래식 잠수함
- 색 = 임박도(🔴 2년 이내 · 🟠 3~5년 · 🟡 6~10년 · 🔵 10년 이후 · ⚪ 데이터 부족), 막대 높이·진하기 = 예상 금액(억 원, 로그)
- 마우스 오버 툴팁(현재 주력·도입 연도·수량, 설계 수명, 교체 예상, 최근 MRO, 예상 수량·금액, 신뢰도, 출처), 클릭 = 카메라 이동 + 툴팁 고정(출처 링크 클릭 가능) + 채팅에 「보고서」 제안
- 하단 채팅: 모델 4개 선택(그록 빌드 · 코덱스 · 제마 · 네모트론). 도구로 화면을 조작하고 보고서 작성. 키가 없어도 `!명령`은 동작
- 같은 도구를 MCP 서버로 제공(MCP 지원 클라이언트에서 사용)

기획 원문은 [`docs/기획안.md`](docs/기획안.md)에 있습니다.

## 실행 (Windows / macOS / Linux 공통)

Node.js 20.3 이상.

```bash
npm install
npm run dev          # → http://localhost:62356  (Vite 개발 서버 + /api)
```

| 명령 | 내용 |
|---|---|
| `npm run dev` | 개발 서버 (포트 62356, 프런트 + API 같은 포트) |
| `npm start` | 빌드 후 Node 서버로 `dist` + `/api` 실행 (포트 62356) |
| `npm run cf:dev` | 빌드 후 `wrangler pages dev` 로 Cloudflare 환경 그대로 로컬 실행 (포트 62356) |
| `npm run build` | 타입 검사 + `dist/` 정적 빌드 |
| `npm test` | 예측 모듈·모델별 채팅 루프(제마·네모트론 전환·CLI 출력 파싱·세션 정리)·API 단위 테스트 (vitest) |
| `npm run mcp` / `npm run mcp:http` | MCP 서버 (stdio / Streamable HTTP :62357) |
| `npm run mcp:check` | MCP 서버 기동·도구 목록·호출 점검 |
| `npm run shots` | Playwright 스크린샷 → `shots/` (서버 실행 중일 때, Chrome 필요. 경로 지정: `CHROME_PATH`) |

### 채팅 모델

입력창 왼쪽 선택 상자 또는 `!모델 <이름>` 으로 바꿉니다. 선택은 브라우저(localStorage)에 저장되고 기본은 제마입니다.

| 이름 | 모델 | 도구 연결 | 실행 위치 |
|---|---|---|---|
| 그록 빌드 | 로컬 Grok Build CLI `grok-4.7`, `--reasoning-effort xhigh` | `~/.grok/config.toml` 에 등록된 `procurement` MCP 서버 + 답 끝 JSON 액션 블록 | 로컬 전용 |
| 코덱스 | 로컬 Codex CLI `gpt-6.1-sol`, `model_reasoning_effort="xhigh"` | 호출마다 `-c mcp_servers.procurement.*` 로 MCP 서버 연결 + JSON 액션 블록 | 로컬 전용 |
| 제마 | Google AI Studio `gemma-4-26b-a4b-it` | `functionDeclarations` (공유 도구 정의) | 로컬 · Cloudflare |
| 네모트론 | OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` → 실패 시 `nvidia/nemotron-3-super-120b-a12b:free` | OpenAI `tools` (같은 공유 도구 정의). 도구 미지원이면 텍스트 JSON 블록 | 로컬 · Cloudflare |

- 제마·네모트론은 `server/agent.ts` 의 도구 정의 하나를 Gemini/OpenAI 형식으로 바꿔 쓰고, 실행은 MCP 서버와 같은 `shared/tools.ts` 입니다. 에이전트 루프 최대 3회
- 그록 빌드: `grok --prompt-file … -m grok-4.7 --reasoning-effort xhigh --output-format streaming-json -s <새 uuid> --tools web_search,web_fetch --no-plan --no-subagents --system-prompt-override <짧은 프롬프트> --permission-mode dontAsk --allow "MCPTool(procurement__*)" --allow WebFetch`. 환경 변수 `GROK_MEMORY=0`, `GROK_{CLAUDE,CURSOR}_{AGENTS,HOOKS,MCPS,RULES,SKILLS}_ENABLED=false` 로 메모리·호환 스캔을 끄고, 저장소 밖 빈 폴더(`%TEMP%\procurement-radar-cli\grok`)에서 실행해 AGENTS.md 등이 로드되지 않게 함. 남는 도구: MCP 메타 도구(`search_tool`/`use_tool`) + 웹(`web_search`, `open_page`, `web_fetch`). 기록을 남기지 않도록 실행이 끝나면(성공·오류·시간 초과 모두) `grok sessions delete <uuid>` 후 `~/.grok/sessions/*/<uuid>` 폴더까지 삭제하고, 서버 시작 시 남은 세션도 지웁니다. 로그인 안 돼 있으면 "그록 로그인 필요"
- 코덱스: `codex exec --ephemeral --ignore-user-config --skip-git-repo-check --sandbox read-only --json` + 호출별 `-c`(`web_search="live"`, `mcp_servers.procurement.default_tools_approval_mode="approve"`, `include_*_instructions=false`, `include_environment_context=false`, `project_doc_max_bytes=0`, 짧은 `model_instructions_file`)와 `--disable`(셸·unified_exec·view_image·멀티 에이전트·플러그인·앱·이미지 생성·브라우저/컴퓨터 사용·스킬 등). 사용자 `~/.codex/config.toml` 은 읽지도 고치지도 않고, 저장소 밖 빈 폴더에서 실행. 웹 검색은 유지
- 두 CLI 모두 시간 제한 5분, 모델별 동시 실행 1개. 화면 조작은 답 끝의 `{"actions":[…]}` 블록을 서버가 읽어 실행
- 응답의 `model` 필드에 실제 답한 모델 id(네모트론 전환 여부 포함), CLI 모델은 `usage`(입력·캐시·출력 토큰)가 들어가고, 말풍선에 마우스를 올리면 보입니다
- `GET /api/models` 가 사용 가능한 모델을 알려 주며, Cloudflare(Workers)에서는 그록 빌드·코덱스가 자동으로 숨겨집니다

### 비밀값 (.secrets)

```bash
copy .secrets.example .secrets    # Windows (macOS/Linux: cp)
```

| 키 | 용도 |
|---|---|
| `GOOGLE_API_KEY` | 제마 (Google AI Studio 키) |
| `OPENROUTER_API_KEY` | 네모트론 (OpenRouter 키) |
| `GEMMA_MODEL`, `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODEL`, `GROK_MODEL`, `GROK_EFFORT`, `CODEX_MODEL`, `CODEX_EFFORT` | (선택) 모델 변경 |
| `LOCAL_CLI=0` | (선택) 그록 빌드·코덱스 끄기 |

`npm run dev`·`npm start`·`npm run cf:dev` 모두 이 파일을 읽으며, 개발 서버는 요청마다 다시 읽으므로 재시작이 필요 없습니다. `.secrets` 는 `.gitignore` 에 포함돼 있습니다. 그록 빌드·코덱스는 키 대신 각 CLI 로그인(`grok login`, `codex login`)을 씁니다.

- 제마 호출: `POST https://generativelanguage.googleapis.com/v1beta/models/{모델}:generateContent`, 헤더 `x-goog-api-key`, 5xx는 2회 재시도
- 네모트론 호출: `POST https://openrouter.ai/api/v1/chat/completions`. 429·402·404·408·5xx·시간 초과면 Super로 전환, 401은 "OpenRouter 키 오류"
- 키가 없으면 "Google 키 없음"/"OpenRouter 키 없음"으로 짧게 답하고, `!명령`과 "폴란드 자주포 보고서" 같은 간단한 요청은 브라우저에서 바로 처리

### 채팅 명령

| 명령 | 동작 |
|---|---|
| `!help` | 명령 목록 |
| `!모드 자주포` · `!모드 일반` | 히트맵 모드 |
| `!지도` | 3D ↔ 2D |
| `!국가 폴란드` | 카메라 이동 |
| `!예측 폴란드 자주포` | 예측 요약 |
| `!보고서 폴란드 자주포` | 보고서 (체계 생략 시 그 나라 전체) |
| `!목록 호위함` | 임박 순 목록 |
| `!모델 코덱스` | 채팅 모델 변경 (그록 빌드 · 코덱스 · 제마 · 네모트론) |

AI가 쓰는 도구: `set_mode`, `toggle_map_mode`, `focus_country`(화면 조작, 브라우저에서 실행), `get_forecast`, `list_forecasts`, `search_programs`, `get_lifespan`, `search_mro`, `write_report`.

## Cloudflare 배포

정적 파일(`dist/`)은 Cloudflare Pages, API는 Pages Functions(`functions/api/[[path]].ts` → `server/app.ts` Hono 앱)입니다.

```bash
npx wrangler login
npx wrangler pages project create procurement-radar     # 최초 1회
npm run deploy                                            # vite build + wrangler pages deploy dist
npx wrangler pages secret put GOOGLE_API_KEY --project-name procurement-radar
npx wrangler pages secret put OPENROUTER_API_KEY --project-name procurement-radar
```

- 설정: `wrangler.toml` (`pages_build_output_dir = "./dist"`, `GEMMA_MODEL` 변수)
- Git 연동 배포 시: 빌드 명령 `npm run build`, 출력 폴더 `dist`, 환경 변수/비밀값 `GOOGLE_API_KEY`, `OPENROUTER_API_KEY` (그록 빌드·코덱스는 로컬 전용이라 Cloudflare에서는 숨김)
- Workers 단독 배포가 필요하면 `worker.ts`(같은 Hono 앱)를 진입점으로 쓰고 정적 파일은 `[assets]` 로 지정
- D1(선택): `db/schema.sql` 스키마. 현재 앱은 `data/seed.json` 을 번들에 포함해 사용
- `wrangler` 는 Node 20에서도 동작하는 4.86.0 으로 고정

## MCP 서버

`mcp/server.ts` (공식 `@modelcontextprotocol/sdk`). 웹앱과 같은 데이터·예측 모듈(`shared/`)을 씁니다.

| 도구 | 내용 |
|---|---|
| `search_programs(country?, system?)` | 보유 장비, 최근 계약, 사업 계획, 동향 + 출처 |
| `get_lifespan(system?, model?)` | 설계 수명(추정 기본값), 모델별 교체 시점 |
| `search_mro(country?, model?, system?)` | MRO·성능개량·수명연장 기록 |
| `get_inventory(country?, system?)` | 보유 대수·도입 연도(추정 표시) |
| `forecast(country, system?)` | 예상 시기·수량·금액 범위와 계산 과정 |
| `list_forecasts(system?, limit?)` | 히트맵용 예측 목록(임박 순) — 기획안의 `update_heatmap` 대체 |
| `write_report(country, system?)` | Markdown 보고서 |

실행: stdio `npx tsx mcp/server.ts`, HTTP `npx tsx mcp/server.ts --http --port 62357` → `http://localhost:62357/mcp`

MCP 지원 클라이언트 설정 예시 (경로는 실제 폴더로 바꾸세요. Windows는 `C:/Users/me/procurement-radar` 처럼 슬래시 사용 가능):

Codex CLI `~/.codex/config.toml`:

```toml
[mcp_servers.procurement]
command = "npx"
args = ["-y", "tsx", "C:/path/to/procurement-radar/mcp/server.ts"]
```

일반 JSON(`mcpServers`) 형식:

```json
{
  "mcpServers": {
    "procurement": {
      "command": "npx",
      "args": ["-y", "tsx", "C:/path/to/procurement-radar/mcp/server.ts"]
    }
  }
}
```

Windows에서 클라이언트가 `npx` 를 실행하지 못하면 `command` 를 `node`, `args` 를 `["C:/path/to/procurement-radar/node_modules/tsx/dist/cli.mjs", "C:/path/to/procurement-radar/mcp/server.ts"]` 로 지정합니다.

Streamable HTTP를 받는 클라이언트는 `npm run mcp:http` 후 URL `http://localhost:62357/mcp` 를 등록합니다. 클라이언트마다 설정 키 이름이 다를 수 있으니 각 클라이언트 문서를 확인하세요.

## 예측 방법 (`shared/forecast.ts`)

1. 배치별 교체 시점 = 도입 연도 + 설계 수명 + MRO 연장
2. 다음 사업 = 가장 이른 교체 시점부터 8년 안에 몰린 배치. 교체 창 = 배치 교체 시점 −2 ~ +3년(기준 연도 2026 이전이면 2026부터)
3. 이미 교체 계약이 끝났으면(`covers=1`) 후속 주기 = 인도 완료 + 수명. 공개 사업 계획(`plan`)이 있으면 계획을 우선
4. 남은 기간 = 창 시작 − 2026 (최근 1년 내 동향 신호가 있으면 1년 앞당김) → 임박도 색. 점수 = 100·e^(−남은기간/7) + 노후 비율·신호 가산
5. 수량 = 미교체 보유 × 교체 비율(기본 0.6~1.0, 추정) · 금액 = 수량 × 최근 유사 사업 대당 단가(억 원, 체계별 범위)
6. 신뢰도 상/중/하 = 근거 수(최대 4) + 최신성(2025년 이후 +2, 2022년 이후 +1) − 추정 항목 수/3

## 데이터와 주의점

`data/seed.json`: 15개국, 59개 레코드(자주포 12 · 장갑차 12 · 대공미사일 8 · 다연장로켓 10 · 호위함 9 · 재래식 잠수함 8), 출처 61건. 수집 2026-10-15.

- 모든 레코드에 출처 URL이 있습니다(Wikipedia 장비 목록·함급 문서, 각국 정부·제조사 발표, Reuters·Defense News·연합뉴스 등). 지어낸 출처는 없습니다.
- 출처에서 확인하지 못한 값은 `est`(추정)로 표시하고 툴팁·보고서에 **추정**으로 나옵니다.
  - 보유 수량: 61개 배치 중 54개 출처 확인, 7개 추정
  - 도입 연도: 61개 중 45개 추정(대부분 모델의 최초 배치 연도로 대체) — 가장 약한 부분
  - 최근 계약 34건 중 25건은 인도 완료 연도 등 일부 항목이 추정
  - 설계 수명(체계별 30~35년)과 기본 교체 비율(0.6~1.0)은 전부 추정값
  - 단가: 최근 계약(베트남·이집트 K9, 루마니아 Lynx, 호주 레드백, 사우디·UAE 천궁-II, 노르웨이 Type 26, 호주 Mogami, 폴란드 A26, 필리핀 잠수함 사업 규모)으로 산출. 다연장로켓 하한은 추정. 환율은 고정 가정값(USD 1,400 등)
- 예측은 모두 **범위**이며 확정 정보가 아닙니다. 대공미사일 일부 수량은 발사대 수를 포대로 환산한 추정입니다.
- 공개 자료 위주라 국가별로 빈칸이 있습니다(예: 호주 재래식 잠수함은 AUKUS 핵잠으로 대체되어 후속 없음 → 회색).
- 국경: Natural Earth 1:110m (`data/ne_110m_admin_0_countries.geojson`, public domain) → `public/countries.json` (`npm run data:countries`)

## 파일 구성

```
index.html, src/            프런트엔드 (globe.ts 렌더러·지도 모드, main.ts UI·툴팁, chat.ts, commands.ts, md.ts, style.css)
shared/                     공용 TS: types, data(이름 해석), forecast(예측), tools(도구·보고서)
server/                     Hono API(app.ts), Gemma 에이전트(gemma.ts), Node 서버(node.ts), .secrets 로더
functions/api/[[path]].ts   Cloudflare Pages Functions 진입점
worker.ts                   (선택) Workers 진입점
mcp/server.ts               MCP 서버 (stdio / Streamable HTTP)
data/seed.json              시드 데이터 + 출처
db/schema.sql               (선택) D1 스키마
public/countries.json       국가 경계
tests/                      vitest
scripts/                    shots.mjs, mcp-check.mjs, slim-countries.mjs
docs/기획안.md              기획안
```
