# 🛡️ 글로벌 방산 동향 검색 (Defense Trends)

방산 기업 보도자료, 방산 전문 매체, 각국 군/국방부 발표, 학술/연구 자료를 모아서 검색하는 로컬 웹앱입니다.
FastAPI, SQLite(FTS5 전문 검색), APScheduler로 만들었고 Windows, macOS, Linux에서 모두 실행됩니다.

## 설치
Python 3.9 이상이 필요합니다.
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate   /  macOS·Linux: source .venv/bin/activate
pip install -r requirements.txt
```

## 실행
```bash
python run.py
```
브라우저에서 http://localhost:8000 이 자동으로 열립니다. 자동으로 열지 않으려면 `python run.py --no-browser`로 실행하세요.
- 처음 실행할 때(DB가 비어 있을 때) 바로 수집을 시작합니다. 그 뒤로는 앱이 켜져 있는 동안 **3시간마다** 자동으로 수집합니다.
- 화면의 **"지금 수집"** 버튼이나 `POST /api/collect`로 바로 수집할 수도 있습니다.
- 데이터는 `data/defense.db`에 저장됩니다. 같은 URL은 한 번만 저장됩니다.

## 기능
### 원문 탭
- 키워드 검색: FTS5를 쓰며 여러 단어는 AND로, 접두어로도 일치합니다.
- 분류, 출처, 기간 필터를 쓸 수 있습니다.
- 결과는 **출처별 그룹**으로 묶입니다. 그룹 순서는 분류(기업 → 언론 → 군/국방부 → 학술) 다음 출처명이고, 그룹 안에서는 최신순입니다.

### 요약 탭 (뉴스레터)
- 최근 1/3/7일(기본 7일) 기사에서 **서로 겹치지 않는 핵심 이슈 4개**를 골라 뉴스레터 형식으로 보여 줍니다.
- 이슈마다 한국어 헤드라인, 2~4문장 요약, 같은 이슈를 다룬 여러 매체의 원문 링크가 붙습니다.
- 생성 방식은 다음 순서로 자동 선택됩니다(뉴스레터 날짜 아래에 `생성: Codex` 또는 `생성: 자동 묶기(번역)`로 표시).
  1. **Codex CLI**: PC에서 `codex` 명령을 찾으면 기본으로 사용합니다. ChatGPT 계정으로 로그인되어 있으면 API 키 없이 동작합니다.
  2. **OpenAI API**: 환경변수 `OPENAI_API_KEY`가 있으면 사용합니다(`OPENAI_MODEL`, `OPENAI_BASE_URL` 지정 가능).
  3. **자동 묶기**: LLM 없이 TF-IDF와 코사인 유사도로 기사를 묶고 무료 번역(deep-translator)을 붙입니다.
- 먼저 비슷한 기사를 묶어 후보 이슈를 최대 150개로 줄이고, 주가·애널리스트 관련 기사는 제외합니다.

### Codex로 요약 만들기
1. Codex CLI를 설치하고 로그인합니다: `npm i -g @openai/codex`, `codex login`(ChatGPT 계정)
2. 평소처럼 `python run.py`로 실행하면 Codex가 자동으로 사용됩니다.
   - Windows에서는 `C:\Users\<사용자>\AppData\Roaming\npm\codex.cmd`를 PATH에서 찾아 셸 없이 실행하고 콘솔 창도 띄우지 않습니다.
3. 앱이 실제로 실행하는 명령(프롬프트는 stdin으로 전달):
   ```
   codex exec --skip-git-repo-check --ephemeral --sandbox read-only -C <프로젝트>/data
         --output-schema <프로젝트>/data/digest_schema.json -o <프로젝트>/data/digest_output_<기간>.json --color never -
   ```
   Codex는 `data/digest_input_<기간>.json`(후보 이슈, 기사 제목·출처·URL·요약·날짜·link_id)을 읽기 전용으로 읽고,
   이슈 4개(`headline`, `summary`, `link_ids`)를 JSON으로 출력합니다. 앱은 link_ids를 입력 파일의 실제 URL로만 연결하므로
   지어낸 링크는 들어갈 수 없습니다(이슈당 최대 6개).
4. 실행에 실패하면(로그인 안 됨, 종료 코드 오류, 출력 검증 실패, 시간 초과 기본 600초) 자동으로 대체 방식으로 만들고 화면에 경고를 표시합니다.

환경변수:
| 변수 | 설명 |
|---|---|
| `DIGEST_PROVIDER` | `codex`, `openai`, `heuristic` 중 하나로 고정 (기본: 자동 선택) |
| `CODEX_MODEL` | 지정하면 `-m <모델>`을 추가 |
| `CODEX_TIMEOUT` | Codex 제한 시간(초), 기본 600 |

예 (Windows PowerShell): `$env:DIGEST_PROVIDER="codex"; $env:CODEX_MODEL="gpt-5-codex"; python run.py`

### 생성 방식과 캐시
- 요약은 **백그라운드**에서 만들어집니다. 캐시가 있으면 바로 보여 주고, 없으면 `요약 생성 중...`을 표시한 뒤 5초마다 확인합니다.
- **요약 다시 만들기** 버튼(`/api/digest?days=7&refresh=true`)으로 새로 만들 수 있습니다.
- 자동 수집이든 수동 수집이든 수집이 끝나면 최근 7일 요약을 백그라운드에서 다시 만듭니다.
- 캐시는 (기간, 생성 방식)마다 SQLite `digests` 테이블에 저장됩니다. 새로 수집한 뒤 열면 다시 만듭니다.

### 기사 읽기 (앱 안 리더)
- 원문 탭의 각 기사 제목 옆 **읽기** 버튼을 누르면 `/article/<id>` 리더가 열립니다. 제목 링크는 예전처럼 원본 사이트로 엽니다.
- 서버가 원본 URL에서 본문 단락을 추출해 SQLite `article_text` 테이블에 캐시합니다. 실패하면(403 차단, Google News 링크 등) 수집 때 저장된 요약을 보여 줍니다.
  실패한 기사는 6시간 뒤 다시 시도하며, 리더의 **본문 다시 가져오기** 버튼으로 바로 다시 시도할 수 있습니다.

### AI 챗봇 (Arli AI + 예비 Google Gemma)
화면 오른쪽 아래 💬 버튼을 누르면 AI 도우미가 열립니다.
- 기본 모델은 [Arli AI](https://www.arliai.com)의 `Qwen3.5-27B-Derestricted`입니다. Arli 호출이 실패하면(키 오류, 한도 초과 429, 서버 오류 5xx,
  시간 초과, 빈 응답) **Google AI Studio의 Gemma 4 26B(`gemma-4-26b-a4b-it`)** 로 같은 요청을 자동으로 다시 보냅니다.
  답변 아래 작은 회색 글씨로 어느 모델이 답했는지 표시합니다(전환된 경우 "Arli 실패 → 자동 전환").
- 지금 보는 화면 정보(검색어·필터·보이는 기사 상위 20개 / 요약 탭 이슈 4개 / 리더의 기사 본문)를 함께 보내므로 "지금 보이는 기사 요약해줘", "이 기사 핵심 3줄로" 같은 질문에 답합니다.
- 요청하면 직접 **검색·필터 적용·탭 전환·기사 열기**를 실행합니다. 예: "한화 관련 최신 소식 요약해줘" → 검색을 실행하고, DB 검색 결과를 모델에 한 번 더 보내 요약 답변을 만듭니다(이 경우 API 요청 2회).
- 대화는 브라우저 탭을 닫기 전까지(sessionStorage) 유지되며 **지우기** 버튼으로 지울 수 있습니다.

**API 키 설정 (`.secrets`)** — 둘 중 하나만 있어도 됩니다. `.secrets`는 `.gitignore`에 들어 있으니 공유하지 마세요.
1. Arli AI: arliai.com 가입 → **My API Keys**에서 키 복사 → `ARLIAI_API_KEY=` 뒤에 붙여 넣기
2. Google AI Studio: https://aistudio.google.com/apikey 에서 키 발급 → `GOOGLE_API_KEY=` 뒤에 붙여 넣기
3. 앱을 다시 시작합니다. 키가 하나도 없으면 챗봇이 설정 방법을 안내합니다.

| 키 | 설명 |
|---|---|
| `CHAT_PROVIDER` | `auto`(기본: Arli 키가 있으면 Arli, 실패 시 Google / Arli 키가 없으면 바로 Google), `arli`(Arli만), `google`(Google만) |
| `ARLIAI_API_KEY`, `ARLIAI_MODEL` | Arli 키와 모델(기본 `Qwen3.5-27B-Derestricted`) |
| `GOOGLE_API_KEY`, `GOOGLE_MODEL` | Google 키와 모델(기본 `gemma-4-26b-a4b-it`). 키는 URL이 아니라 `x-goog-api-key` 헤더로만 보냅니다 |

**제한과 토큰 예산** (2026-10 기준)
- Arli 무료 플랜([요금제](https://www.arliai.com/pricing), [문서](https://www.arliai.com/docs/textgen)): 컨텍스트 최대 12K(입력+출력), 동시 1요청, 응답 지연, **모델당 2일에 5회 요청**.
  기본 예산: 출력 1536, 여유 1200 → 입력 약 9550 토큰.
- Google Gemma 4 26B([Gemma on Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api), [요금](https://ai.google.dev/gemini-api/docs/pricing)): 무료 등급 전용(무료).
  모델 컨텍스트는 256K이지만 무료 등급 분당/일일 한도는 공식 문서에 숫자가 없고 AI Studio 화면에서만 볼 수 있습니다.
  보수적으로 컨텍스트 32768, 출력 2048, 여유 2000 → 입력 약 28700 토큰으로 잡았고 화면 정보·대화 기록도 Arli보다 넉넉하게 보냅니다.
- 토큰 수는 한글 1글자=1토큰, 영문 3글자=1토큰으로 보수적으로 추정합니다. 예산을 넘으면 오래된 대화 → 화면 정보 → 검색 결과 순으로 줄이고,
  대체 모델로 넘어갈 때는 그 모델 예산으로 다시 조립합니다. 생각(thinking) 출력은 끄고(Arli `reasoning_effort=none`, Google `thinkingLevel=minimal`) `<think>`/thought 부분도 제거합니다.
- 바꿀 수 있는 값(`.secrets` 또는 환경변수): `ARLIAI_*`/`GOOGLE_*` 뒤에 `CONTEXT_TOKENS`, `MAX_OUTPUT_TOKENS`, `SAFETY_TOKENS`, `TIMEOUT`, `BASE_URL`, `TEMPERATURE`,
  `ARLIAI_REASONING_EFFORT`(기본 none), `GOOGLE_THINKING_LEVEL`(기본 minimal), `GOOGLE_SYSTEM_MODE`(`instruction` 기본 / `fold`=시스템 프롬프트를 첫 메시지에 합침),
  `CHAT_AGENT_ROUNDS`(기본 3, 도구 호출 왕복 최대 횟수), `CHAT_TOOLS`(기본 1, 0이면 네이티브 도구 대신 텍스트 동작 블록), `CHAT_DEBUG_LOG`(기본 1, 0이면 끔). 값을 `default`로 두면 해당 옵션을 보내지 않습니다.
- 챗봇 지식은 `app/knowledge/global.md`(`{MODEL}` 자리에 지금 답하는 모델 이름이 들어감), 페이지별 지침은 `app/knowledge/pages.yaml`에서 고칠 수 있습니다.
- **도구 호출**: 명령 레지스트리(`app/commands.py`)에서 도구 정의를 만들어 Arli에는 OpenAI `tools`+`tool_choice:"auto"`, Gemma에는 `tools.functionDeclarations`+`toolConfig.functionCallingConfig.mode=AUTO`로 보냅니다(화면 종류별로 필요한 도구만, 스키마 토큰도 예산에 포함).
  검색·필터·요약 데이터·소스·북마크·내보내기는 서버가 실행해 결과를 모델에 돌려주고(최대 `CHAT_AGENT_ROUNDS`회), 화면 조작은 순서대로 화면에서 실행합니다. 확인 명령은 서버에서 실행하지 않고 실행/취소 버튼으로만 실행됩니다.
  화면 조작만 있으면 추가 호출 없이 끝내 요청 한도를 아낍니다. 제공자가 tools를 거부(400)하면 자동으로 텍스트 동작 블록 방식으로 바꾸고(앱 재시작 전까지 기억),
  ```` ```action ````/```` ```json ````/맨 JSON/`<tool_call>`/Qwen `<function=…>` 형식도 읽어 실행하고 답변에서 지웁니다.
- 검색어는 `A OR B`, `"정확한 구문"`, `AND`, `NOT`, 괄호를 지원합니다. 한글 검색어는 연산자 위치를 유지한 채 구간별로 영어로 바뀝니다.
- **디버그 로그**: `data/chat_debug.log`(1MB×3 회전, JSON 한 줄/턴). 제공자·모델·모드, 도구 호출과 결과 요약, 오류, 모델 원문(2000자)만 남기고 API 키와 전체 프롬프트는 남기지 않습니다.
- 테스트(모델 호출은 모의): `python tests/test_chat.py`, `python tests/test_commands.py`, `python tests/test_tools.py`

### 챗봇 명령 (앱 조작)
챗봇은 앱을 직접 조작합니다. 자연어로 요청하면("지난주 드론 기사 찾아서 CSV로 줘") 모델이 아래 명령을 최대 5개까지 순서대로 실행하고,
`!`로 시작하는 메시지는 **AI를 호출하지 않고**(요청 한도 사용 없음) 바로 실행합니다. `!help`로 목록, `!help <명령>`으로 자세한 설명을 봅니다.
- 문법: `!명령 위치인자 키=값 키="공백 있는 값"`. 날짜는 `YYYY-MM-DD` 또는 `7d`(7일 전), `오늘`, `어제`. 분류는 영어 또는 기업/언론/군/학술.
- **확인** 표시 명령은 모델이 요청해도, `!`로 입력해도 채팅에 `실행`/`취소` 버튼이 나오고 눌러야 실행됩니다(서버도 확인 없이는 거부).
- `!요약`은 AI를 호출합니다. 기간·정렬은 화면에 입력칸이 없고 명령으로만 지정합니다(`!reset`으로 초기화).
- 소스 켜기/끄기/추가/삭제는 `sources.yaml`을 고치지 않고 DB `source_overrides` 테이블에 저장되며 다음 수집부터 적용됩니다. 추가할 때 피드를 실제로 받아 항목이 있는지 확인합니다.
- 북마크는 DB `bookmarks` 테이블에 저장됩니다. 새 테이블은 앱 시작 시 자동으로 만들어집니다.

| 명령 | 별칭 | 설명 | 확인 | 예 |
|---|---|---|---|---|
| `!search` | `!검색`, `!찾기` | 기사 검색 (키워드·분류·출처·기간·정렬) |  | `!search 드론 category=company source="Defense News" from=2026-10-01` |
| `!filter` | `!필터` | 분류·출처 필터만 변경 |  | `!filter category=media` |
| `!reset` | `!초기화`, `!리셋` | 검색어·필터·기간 초기화 |  | `!reset` |
| `!more` | `!더보기` | 검색 결과 더 불러오기 |  | `!more` |
| `!tab` | `!탭` | 탭 전환 |  | `!tab digest` |
| `!open` | `!열기`, `!읽기` | 기사 리더 열기 |  | `!open 123` |
| `!back` | `!뒤로` | 이전 화면으로 |  | `!back` |
| `!digest_days` | `!기간`, `!요약기간` | 요약 탭 기간 변경 |  | `!digest_days 14` |
| `!regen` | `!재생성`, `!요약다시` | 요약(뉴스레터) 다시 만들기 |  | `!regen` |
| `!collect` | `!수집` | 지금 바로 전체 소스 수집 | 예 | `!collect` |
| `!sources` | `!출처목록`, `!소스` | 수집 소스 목록과 상태 |  | `!sources` |
| `!source_enable` | `!출처켜기` | 수집 소스 켜기 | 예 | `!source_enable "Defense News"` |
| `!source_disable` | `!출처끄기` | 수집 소스 끄기 | 예 | `!source_disable "Defense News"` |
| `!source_add` | `!출처추가` | RSS 소스 추가 | 예 | `!source_add "Naval Today" https://www.navaltoday.com/feed/ media` |
| `!source_remove` | `!출처삭제` | 수집 소스 삭제 | 예 | `!source_remove "Naval Today"` |
| `!bookmark` | `!북마크`, `!즐겨찾기` | 기사 북마크 |  | `!bookmark 123` |
| `!unbookmark` | `!북마크해제` | 북마크 해제 |  | `!unbookmark 123` |
| `!bookmarks` | `!북마크목록` | 북마크 목록 |  | `!bookmarks` |
| `!export` | `!내보내기`, `!csv` | 현재 검색 결과 CSV 내려받기 (인자를 주면 그 조건) |  | `!export` |
| `!summarize` | `!요약` | 보이는 기사 또는 현재 기사 요약 (AI 호출) |  | `!요약` |
| `!help` | `!도움말`, `!명령어`, `!?` | 명령 목록 / 명령 설명 |  | `!help search` |

## API
| 경로 | 설명 |
|---|---|
| `GET /api/search?q=&category=&source=&date_from=YYYY-MM-DD&date_to=&limit=&offset=` | 검색 |
| `GET /api/search?...&sort=source` | 출처별로 정렬 (원문 탭) |
| `GET /api/digest?days=7&refresh=false` | 요약(핵심 이슈 4개). `status`: ready 또는 generating, `method`, `error` 포함 |
| `GET /api/sources` | 출처별 건수 |
| `GET /api/status` | 수집 상태와 소스별 결과 |
| `POST /api/collect` | 즉시 수집 |
| `GET /api/article/{id}?refresh=false` | 저장된 기사 + 원문 본문(`text`, `text_source`: original 또는 summary) |
| `GET /api/commands` | 명령 레지스트리(이름·별칭·인자·설명·예시·확인 여부) |
| `POST /api/command` | `!명령` 파싱 `{text}` → `{ok, cmd}` (실행 안 함) |
| `POST /api/command/run` | 서버 명령 실행 `{name, args, confirmed}` (확인 명령은 confirmed=true 필요) |
| `GET /api/export?q=&category=&source=&date_from=&date_to=&sort=` | 검색 결과 CSV (UTF-8 BOM, 최대 5000행) |
| `POST /api/chat` | 챗봇. 본문 `{messages:[{role,content}], page:{type,...}}` → `{reply, action, meta}` |
| `GET /article/{id}` | 기사 리더 화면 |

## 소스 설정 (`sources.yaml`)
분류(category)는 `company`, `media`, `military`, `academic` 중 하나입니다. 기본 형식은 RSS/Atom이고,
HTML 스크래핑을 쓰려면 `type: html`과 `link_selector`(CSS 선택자)를 지정합니다.
소스 하나가 실패해도 다른 소스 수집은 계속됩니다. 오류 내용은 `/api/status`에서 볼 수 있습니다.

### 피드 검증 결과 (2026-10-14)
아래 공식 피드는 막혀 있거나 작동하지 않아서 **Google News RSS 검색**으로 대신 수집합니다(출처명에 "(Google News)" 표기).
- RTX: rtx.com RSS와 뉴스 페이지가 403(봇 차단)을 반환합니다. PRNewswire의 company=rtx 피드는 RTX와 관계없는 기사가 섞여 나와서 제외했습니다.
- BAE Systems: baesystems.com RSS가 403입니다.
- Northrop Grumman: `?pagetemplate=rss`는 항목이 0개이고 `/rss`는 404입니다. 뉴스 페이지는 JS로 그려져서 스크래핑할 수 없습니다.
- General Dynamics: gd.com RSS와 뉴스룸 모두 403입니다.
- Hanwha Aerospace: 공식 RSS는 항목이 0개이고 뉴스 목록 페이지는 내용이 거의 없습니다(JS 렌더링).
- Janes: RSS가 404이고 뉴스 페이지는 JS로 그려져서 스크래핑할 수 없습니다.

아래 소스는 제외했습니다.
- NATO: RSS가 404입니다.
- The Defense Post: 피드 항목이 0개입니다.
- RAND 주제별 피드: 항목이 0개라서 `news.xml`로 바꿨습니다.
- arXiv `http://`: 연결 시간이 초과돼서 `https://`를 씁니다.
