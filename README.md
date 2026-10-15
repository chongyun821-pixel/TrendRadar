# 무기조달사업예상 · Global Procurement Radar

세계 주요국이 **언제, 어떤 무기를, 얼마나 큰 규모로** 새로 살지 지구본 히트맵으로 보여 주는 웹앱입니다.
보유 장비의 도입 연도·설계 수명·MRO(수명 연장) 기록으로 다음 교체 사업 시점과 규모를 **예측 범위**로 계산합니다.

- 화면 전체 3D 지구본(드래그 회전·휠 확대) ↔ **지도 모드** 2D 세계지도(펼침 전환), 히트맵은 두 모드 공통
- 모드 7개: 일반 · 자주포 · 장갑차 · 대공미사일 · 다연장로켓 · 호위함 · 재래식 잠수함
- 색 = 임박도(🔴 2년 이내 · 🟠 3~5년 · 🟡 6~10년 · 🔵 10년 이후 · ⚪ 데이터 부족), 막대 높이·진하기 = 예상 금액(억 원, 로그)
- 마우스 오버 툴팁(현재 주력·도입 연도·수량, 설계 수명, 교체 예상, 최근 MRO, 예상 수량·금액, 신뢰도, 출처), 클릭 = 카메라 이동 + 툴팁 고정(출처 링크 클릭 가능) + 채팅에 「보고서」 제안
- 하단 채팅: Gemma 4(`gemma-4-26b-a4b-it`)가 도구로 화면을 조작하고 보고서 작성. 키가 없어도 `!명령`은 동작
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
| `npm test` | 예측 모듈·채팅 루프·API 단위 테스트 (vitest) |
| `npm run mcp` / `npm run mcp:http` | MCP 서버 (stdio / Streamable HTTP :62357) |
| `npm run mcp:check` | MCP 서버 기동·도구 목록·호출 점검 |
| `npm run shots` | Playwright 스크린샷 → `shots/` (서버 실행 중일 때, Chrome 필요. 경로 지정: `CHROME_PATH`) |

### AI 키 (.secrets)

```bash
copy .secrets.example .secrets    # Windows (macOS/Linux: cp)
```

`.secrets` 에 `GOOGLE_API_KEY=` (Google AI Studio 키)를 넣습니다. `npm run dev`·`npm start`·`npm run cf:dev` 모두 이 파일을 읽으며, 개발 서버는 요청마다 다시 읽으므로 재시작이 필요 없습니다. `.secrets` 는 `.gitignore` 에 포함돼 있습니다.

- 모델 변경: `GEMMA_MODEL=` (기본 `gemma-4-26b-a4b-it`)
- 호출 방식: `POST https://generativelanguage.googleapis.com/v1beta/models/{모델}:generateContent`, 헤더 `x-goog-api-key`, `tools.functionDeclarations`
- 에이전트 루프 최대 3회 도구 호출, 5xx는 2회 재시도, 무료 등급용으로 프롬프트·기록 최소화(최근 6개 메시지)
- 키가 없으면 채팅은 "AI 키 없음"으로 짧게 답하고, `!명령`과 "폴란드 자주포 보고서" 같은 간단한 요청은 브라우저에서 바로 처리

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

AI가 쓰는 도구: `set_mode`, `toggle_map_mode`, `focus_country`(화면 조작, 브라우저에서 실행), `get_forecast`, `list_forecasts`, `search_programs`, `get_lifespan`, `search_mro`, `write_report`.

## Cloudflare 배포

정적 파일(`dist/`)은 Cloudflare Pages, API는 Pages Functions(`functions/api/[[path]].ts` → `server/app.ts` Hono 앱)입니다.

```bash
npx wrangler login
npx wrangler pages project create procurement-radar     # 최초 1회
npm run deploy                                            # vite build + wrangler pages deploy dist
npx wrangler pages secret put GOOGLE_API_KEY --project-name procurement-radar
```

- 설정: `wrangler.toml` (`pages_build_output_dir = "./dist"`, `GEMMA_MODEL` 변수)
- Git 연동 배포 시: 빌드 명령 `npm run build`, 출력 폴더 `dist`, 환경 변수/비밀값 `GOOGLE_API_KEY`
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
