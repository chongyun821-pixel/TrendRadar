# 무기조달사업예상 · Global Procurement Radar

공개 자료와 보유 장비의 도입 연도·설계 수명·MRO를 바탕으로 교체 시기·수량·금액의 **예측 범위**를 표시하는 로컬 앱입니다. 3D 지구본·2D 지도·툴팁·채팅·6절 보고서가 같은 SQLite 데이터를 사용합니다.

## 실행

Node.js **22.16 이상의 22.x 또는 24 이상**에서 실행합니다. SQLite 백업은 [Node 공식 API](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options)를 사용합니다.

```sh
npm install
npm run dev
# http://localhost:62356
```

`.secrets.example`의 양식대로 `.secrets`에 키를 설정합니다. 기존 `.secrets`에는 Firecrawl 빈 키 항목을 추가했습니다. 키는 브라우저로 보내지 않습니다.

```dotenv
GOOGLE_API_KEY=
OPENROUTER_API_KEY=
FIRECRAWL_API_KEY=
FIRECRAWL_MCP_URL=https://mcp.firecrawl.dev/v2/mcp
```

| 명령 | 동작 |
|---|---|
| `npm run dev` | Vite UI + 로컬 Node API |
| `npm run build` | TypeScript 검사 + UI 빌드 |
| `npm start` / `npm run serve` | 빌드 후 실행 / 기존 빌드 실행 |
| `npm test` | 네트워크를 모킹하는 단위·API·MCP 통합 테스트 |
| `npm run mcp` / `npm run mcp:http` | stdio / Streamable HTTP MCP (:62357) |
| `npm run mcp:check` | 두 MCP 전송의 연결·도구 호출 점검 |
| `npm run shots` / `npm run chat:check` | 화면 캡처 / 대화·첨부·복원·삭제 UI 검증 |
| `npm run markdown:check` | 사용자·모델 Markdown, 대화 복원, 여러 줄 입력·모바일 가로 스크롤 검증 |
| `npm run db:backup -- <새 폴더>` | SQLite와 작업 자료 백업 |
| `npm run db:restore -- <백업 폴더>` | 서버·MCP 종료 후 복구, 기존 DB 사본 자동 보존 |

화면 검증에는 Chrome 또는 `CHROME_PATH`에 지정한 Chromium 계열 브라우저가 필요합니다. Windows Edge 예: `$env:CHROME_PATH='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'`.

## 데이터와 작업 자료

- `db/initial.sqlite`: 최초 실행용 SQLite. 기존 15개국·59개 레코드·61개 출처를 모두 이관했습니다. 전체 객체 비교와 SQLite 무결성 검사를 거쳤으며 이관 기록은 `db/migration-receipt.json`에 있습니다. 원본 JSON과 일회용 이관 스크립트는 삭제했습니다.
- `.local/radar.sqlite`: 실제 운영 DB. **파일이 없을 때만** 초기 SQLite를 복사하며 이후 최신 값을 다시 초기화하지 않습니다. 국가·체계·출처·보유 배치·계약·계획·MRO·동향·예측 가정은 SQLite의 구조 보존 JSON 열에 저장합니다. 대화·메시지·실행·파일·조사·변경·예측·보고서는 별도 테이블에 저장합니다.
- `.local/workspaces/<대화 UUID>/`: `attachments/`, `sources/`, `notes/`, `analysis/`, `reports/`, `runs/`. 원본 파일, 추출 텍스트, 도구 내역과 생성 보고서를 보존합니다.
- `RADAR_STORAGE_DIR`, `RADAR_DB_PATH`로 위치를 바꿀 수 있습니다. 상대경로는 프로젝트 루트 기준입니다. DB 경로 설정은 환경 변수가 `.secrets`보다 우선합니다. 앱과 MCP에 같은 설정을 사용하세요.
- SQLite WAL·busy timeout·트랜잭션·버전 충돌 검사를 사용합니다. 스키마 이력은 `schema_migrations`에 기록합니다. 백업은 실행 중인 조사가 없는 때 수행하고 복구는 모든 서버·MCP를 종료한 상태에서 수행하세요. DB만 복사하면 원문·첨부 파일이 빠지므로 백업 폴더 전체를 보관합니다.
- 대화 삭제는 메시지와 선택 목록에서 대화를 제거합니다. **조달 데이터와 원문·보고서·변경 근거는 보존**합니다. 보존 원문은 `source_read`로 다시 조회할 수 있습니다. 보관 폴더는 자동으로 지우지 않습니다.
- 최초 이관 자료의 출처 URL은 기존 값을 보존한 것이며 이번 구현에서 전체 출처의 사실성을 재검증한 것은 아닙니다. 원문이 없는 이관 출처는 재수집이 필요합니다.
- 기존 계산과 59건을 비교해 시기 범위·수량·금액이 모두 같음을 확인했습니다. 추정값 반영 보완으로 신뢰도 33건, 동향 보정 제거로 남은 기간·점수 각 1건이 달라졌습니다. 비교 기록은 이관 기록 파일에 있습니다.

## 채팅과 조사

입력창 맨 왼쪽 대화 목록 아이콘에서 이전 대화를 선택·삭제하고 `새 대화`로 별도 작업 폴더를 시작합니다. 대화 목록과 자료 메뉴는 입력창 위로 열리며 조사·응답 상태는 채팅 패널 안에 표시합니다. 생성 중에는 사각형 아이콘으로 중지합니다. 선택한 대화와 모델은 새로고침 후 복원됩니다. 모델을 바꿔도 같은 메시지·첨부·조사 파일을 전달합니다. 긴 API 대화는 인계 요약과 `conversation_read` 조회를 사용하며, 원문 메시지는 삭제하거나 잘라 저장하지 않습니다. CLI는 전체 기록을 전달하고 빌드의 기본 문맥 관리 기능을 사용합니다.

사용자 메시지는 전송 후 모델 답변·보고서와 같은 Markdown으로 표시합니다. 표, 코드 블록, 중첩 목록, 제목·인용·취소선 등을 지원하며 저장된 대화에도 동일하게 적용합니다. **Enter는 전송, Shift+Enter는 줄바꿈**입니다. 입력창은 여러 줄에 맞춰 늘어나고, 넓은 표와 긴 코드 줄은 해당 영역 안에서 가로 스크롤합니다. Markdown 원문과 들여쓰기는 저장·전달 시 보존하며 원문 HTML은 실행하지 않습니다.

전송·중지 버튼 옆의 `＋`는 대화 자료 메뉴입니다. `자료 추가`로 파일을 선택하거나 화면에 파일을 끌어 놓으면 대화 폴더에 바로 업로드하며, 자료 목록에서 원본·완성 보고서를 내려받습니다. 생성 중에도 자료 메뉴와 다운로드를 사용할 수 있고 새 업로드는 생성 종료 후 가능합니다. 텍스트·CSV·JSON·DOCX·텍스트 PDF는 추출 텍스트도 저장합니다. PNG/JPEG/WebP는 API 모델에 이미지 입력으로 전달하고 CLI에서는 작업 파일로 읽습니다. 이미지 입력 지원 여부는 선택한 제공 모델에 따릅니다. 스캔 PDF OCR과 기타 바이너리 형식의 자동 해석은 제공하지 않으며 추출 실패·미지원 상태를 표시합니다. 원본은 보존합니다. 업로드는 요청당 40MB입니다.

| 모델 | 조사 경로 |
|---|---|
| 코덱스 | 설치된 Codex CLI의 기본 웹·MCP 도구와 사용자 설정을 사용. 앱의 procurement MCP만 호출별로 추가. 작업 폴더 쓰기 허용 |
| 그록 빌드 | 설치된 Grok Build의 기본 웹·MCP·XSearch 사용. 대화 작업 폴더의 앱 생성 MCP 설정을 신뢰하여 연결 |
| 젬마 | Google API 함수 호출 → Firecrawl **Streamable HTTP MCP** 클라이언트 |
| 네모트론 | OpenRouter 함수 호출(미지원 시 JSON 도구 프로토콜) → 동일 Firecrawl MCP. 기존 대체 모델 경로 유지 |

CLI 로그인은 해당 CLI에서 먼저 수행하세요. `LOCAL_CLI=0`은 두 로컬 모델을 숨깁니다. 모델·실행 파일·추론 노력 설정은 `.secrets.example`을 참고하세요. 전역 CLI 설정 파일은 수정하지 않습니다. 앱이 정한 도구 라운드 수·최대 답변 토큰·5분 전체 실행 제한은 제거했습니다. 제공 서비스·모델·CLI 자체 한도와 MCP SDK의 요청 제한은 여전히 적용됩니다. 기본 도구가 큰 결과를 파일로 저장하면 그 파일을 재조회합니다.

실행은 백그라운드로 진행되며 진행 도구·실패·중지를 표시합니다. 탭을 새로고침해도 실행 ID로 복원합니다. 서버가 재시작된 실행은 `interrupted`로 표시하고 같은 대화에서 후속 요청으로 이어갑니다. 진행 중 실행을 복제해 자동 재개하지 않습니다.

조사 순서는 `research_procurement` → 모델별 검색·원문 읽기 → `save_source`/Firecrawl 원문 보존 → `submit_research` → 예측 재계산 → `write_report`입니다. 조사 양식은 [`templates/research-v1.md`](templates/research-v1.md)에 있습니다. 다음 내용을 검사합니다.

- 검색 요약과 원문·첨부 근거 구분, 원문 해시·수집 시각·인용문 일치
- 변경 필드의 근거, 수치 범위, 출처 연결, 신규 국가 좌표, 기존 ID 보존
- 사업의 구매국·공급자·단계·고유 ID, 중복 사업과 취소 사업의 계산 입력
- 낙관적 버전 충돌, 원자적 변경 이력·예측 저장, 같은 조사 재제출 시 중복 반영 방지

상충·미확인 내용과 선택 이유는 조사 결과의 `analysis`에 남깁니다. 필드별 근거와 구조 검사는 수행하지만 인용문이 주장을 의미상 입증하는지는 에이전트가 판단합니다. 실패·미확인 자료를 확인된 사실로 취급하지 않습니다.

## 보고서·예측

기존 보고서의 **요약 / 현재 보유와 도입 이력 / 수명·MRO / 예측 근거와 계산 / 경쟁 구도와 한화 기회 / 출처** 6절을 유지합니다. 최신 SQL 값과 저장된 분석을 반영하고 사용한 데이터 버전·기준일·Markdown 파일을 저장합니다.

자유 양식·기업 관점·여러 국가나 사업 비교 보고서를 코덱스·그록에 요청하면 기존 문서 작성 도구를 사용하도록 지시합니다. 코덱스는 설치된 Documents 플러그인의 `documents`, 그록은 기본 `docx` 스킬로 목적·독자에 맞는 문서를 직접 구성하고 해당 스킬의 서식·검증 절차를 따릅니다. 앱은 Markdown→Word 변환기를 제공하지 않습니다. 완성된 `.docx`를 대화 폴더의 `reports/`에 저장하고 `publish_artifact`로 다운로드 등록합니다. 파일은 별도 사본·해시로 보존하며 채팅 답변과 대화 자료 메뉴에 표시합니다. 사용 가능한 문서 도구·렌더러는 각 CLI 환경에 따르며 실패를 숨기지 않도록 지시합니다.

문서 렌더러 경로는 `CLI_DOCUMENT_TOOLS_PATH`에 지정할 수 있습니다. `%LOCALAPPDATA%/TrendRadar/tools/libreoffice/program`과 설치된 Codex 기본 런타임의 Poppler도 자동 탐색해 자식 CLI의 PATH에만 추가합니다. 이 PC의 검증용 LibreOffice는 사용자 로컬 도구 폴더에 풀어 사용하며 Office 파일 연결과 전역 PATH는 바꾸지 않습니다. 그록은 기본 문서 스킬의 파일·셸 작업을 실행할 수 있도록 호출별 권한 모드를 설정하며 사용자 전역 설정은 수정하지 않습니다.

교체 시점은 도입 연도 + 설계 수명 + 배치별 수명 연장으로 계산합니다. 계약 교체비율·이미 교체된 배치와 공개 계획을 반영하며 수량 × 체계별 억 원 단가 범위로 금액을 계산합니다. 기준 연도는 실행 연도입니다. **동향 기사만으로 시기를 1년 앞당기던 보정은 제거**했습니다. 같은 URL·콘텐츠를 중복 근거로 세지 않으며 상충·미확인 항목은 신뢰도에 반영합니다. 단가와 환율 가정은 `update_assumptions`로 근거와 함께 갱신합니다. 단가는 KRW 범위 입력이며 환율 메모만 바꿔 단가가 자동 환산되지는 않습니다.

지도는 API 데이터를 읽고 조사 완료·브라우저 활성화·주기적인 버전 확인 시 갱신합니다. MCP에서 외부로 갱신한 값도 같은 DB 버전으로 반영합니다. `!help`, `!모드 자주포`, `!지도`, `!국가 폴란드`, `!예측 폴란드 자주포`, `!보고서 폴란드 자주포`, `!목록 호위함`, `!모델 코덱스`를 지원합니다.

## MCP와 배포

기존 조회 7종과 `research_procurement`, `save_source`, `source_read`, `workspace_list/read/write`, `publish_artifact`, `submit_research`, `update_assumptions`, `research_history`, `conversation_read`를 제공합니다. Firecrawl 도구는 젬마·네모트론 연결부에 제공하며 CLI용 procurement MCP에는 노출하지 않습니다.

외부 MCP 클라이언트의 stdio 설정은 `command`에 Node 절대경로, `args`에 `[프로젝트/node_modules/tsx/dist/cli.mjs, 프로젝트/mcp/server.ts]`를 넣습니다. 외부 클라이언트는 별도 MCP 조사 대화를 만들며, 앱에서 실행한 CLI는 대화·실행 ID를 전달하여 동일 작업 폴더를 사용합니다. HTTP 주소는 `http://localhost:62357/mcp`이며 localhost에 바인딩합니다.

로컬 파일·SQLite를 쓰므로 **Cloudflare Workers/Pages API로 직접 배포하지 않습니다**. 기존 진입점은 503 안내를 반환합니다. 원격 운영은 별도 Node 호스트와 영속 디스크가 필요하며 이번 범위에 원격 배포를 포함하지 않았습니다.

기본 도구 연결은 [Codex 공식 MCP 문서](https://developers.openai.com/codex/mcp), [Grok Build MCP 문서](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md), Firecrawl 주소·인증 방식은 [공식 Firecrawl MCP 문서](https://docs.firecrawl.dev/mcp-server)를 따릅니다. 필수 출처 규칙 자동화와 PowerPoint 생성은 장기 계획으로 남겨 두었습니다.
