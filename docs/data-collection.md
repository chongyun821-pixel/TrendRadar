# 데이터 수집 실행 안내

[데이터 수집 요구서](데이터수집요구서.md)의 무료 공개 자료를 `db/migrations/004_data_collection*.sql`이 만든 수집 테이블에 적재한다. 모든 행에 `source_id`, `confidence`, `collected_at`을 남기고, 출처는 `sources` 표에도 기록한다.

## 준비

1. 빈 스키마라면 먼저 `npm run supabase -- migrate`로 초기 자료를 넣는다.
2. `npm run supabase -- schema`로 대기 중인 마이그레이션(004: 수집 테이블, 장갑차→IFV 이름 변경, 레이저대공무기, 기본 비중 / 005: 수집 작업 기록 `ingest_runs`)을 버전별 트랜잭션으로 적용한다. 같은 명령을 다시 실행해도 이미 적용한 버전은 건너뛴다. SQL 파일을 직접 실행하려면 `db/migrations/004_data_collection.postgres.sql`을 사용한다.
3. 로컬 SQLite(테스트·이전용)는 저장소를 열 때 같은 마이그레이션을 자동 적용한다.

## 실행

모든 스크립트는 `--dry-run`(DB를 열지 않고 정규화 결과와 표본만 출력), `--file <경로>`(네트워크 대신 저장한 파일 사용), `--countries POL,ROU`(국가 한정)를 지원한다. 결과 요약은 JSON으로 출력한다.

| 명령 | 출처 | 적재 표 | 인증키 |
|---|---|---|---|
| `npm run ingest:sipri-embargoes` | SIPRI 무기 금수 DB(UN·EU·기타) | `export_controls` | 불필요 |
| `npm run ingest:itar` | 22 CFR 126.1(d) (Cornell LII 사본) | `export_controls` | 불필요 |
| `npm run ingest:sipri-transfers` | SIPRI 무기 이전 DB(거래 목록 CSV) | `signals`, `inventory` | 불필요 |
| `npm run ingest:sipri-milex` | SIPRI 국방비 XLSX | `budgets` | 불필요 |
| `npm run ingest:worldbank` | World Bank 지표 API(국방비·GDP) | `budgets` 보완 | 불필요 |
| `npm run ingest:ucdp` | UCDP 전투 사망자(dyadic) 내려받기 | `pair_events` | 불필요 |
| `npm run ingest:gdelt` | GDELT 1.0 일별 이벤트 파일 | `pair_events` | 불필요 |
| `npm run ingest:oryx` | Oryx 러시아·우크라이나 손실 목록 | `consumption` | 불필요 |
| `npm run ingest:tiers` | 위 자료 + `data/reference/export-controls.json`(수기 통제·수출 불가 지정) | `export_tiers` | 해당 없음 |
| `npm run ingest:tension` | 위 자료 + 국경·`data/reference/*.json` | `neighbors` | 해당 없음 |

`npm run ingest:all`은 위 순서대로 실행하고 실패한 단계를 마지막에 보여준다(`--skip gdelt,oryx`로 제외). 등급·긴장도는 앞 단계 결과를 DB에서 읽으므로 드라이런에서도 DB 연결이 필요하다. 매월 `gdelt` → `tension` → `tiers` 순으로 다시 실행한다.

주요 옵션: `--year`(기준 연도), `--since`(시작 연도), GDELT의 `--months 12 --days 1,8,15,22 --to 2026-09 --force`, Oryx의 `--side RUS|UKR`, SIPRI 국방비·UCDP의 `--url`(새 판 파일).

## 채팅에서 실행

채팅 모델(그록 빌드·코덱스는 procurement MCP, 나머지는 공용 도구)이 같은 라이브러리(`server/ingest/`)를 호출한다. CLI(`scripts/ingest/`)는 인자 해석만 하는 얇은 진입점이다.

- `list_ingest_sources`: 출처별 채우는 표, 마지막 실행·적재, 저장 행 수.
- `run_ingest(source, dryRun=true, countries, since, year, months, side, asOf, wait)`: 기본은 미리보기. `dryRun=false`면 적재하고 `changes`에 `@ingest:<출처>` 기록(근거: 출처 ID·주소·작업 id)을 남긴다.
- `get_ingest_run(id, wait, cancel)`: 진행 확인·중지.
- 작업은 백그라운드로 돌고 응답은 최대 `wait`초(기본 40, 최대 50) 기다린다. 넘으면 `status: running`과 id를 돌려준다. 진행 상황은 `ingest_runs`(005)와 대화 실행의 `ingest.progress` 이벤트로 채팅 상태줄에 표시한다.
- 같은 출처는 동시에 하나만 실행한다(`ingest_runs`의 부분 고유 색인). 작업은 시작한 프로세스 안에서만 돌아서, 코덱스·그록의 MCP 프로세스가 끝나면 함께 멈추고 3분 동안 생존 신호가 없으면 다음 조회 때 `failed`로 정리된다. 긴 GDELT 수집은 같은 대화 안에서 `get_ingest_run`으로 이어 확인하거나 CLI로 실행한다.
- 결과에는 표별 행 수와 표본 3행만 담는다.

## 출처별 주의

- SIPRI 무기 이전: 공개 웹앱이 쓰는 비공식 백엔드(`atbackend.sipri.org`)라 형식이 바뀔 수 있다. 공급국 필터가 무시되어 전체를 받아 로컬에서 거른다. 보유 현황은 인도 기록 누적 추정치라 신뢰도 0.7.
- SIPRI 국방비: 파일 이름에 판 번호가 있어 새 판이 나오면 `--url`로 바꾼다. 증가율은 불변 달러 기준 실질 증가율, GDP 비율은 %.
- World Bank: 응답이 30초 이상 걸릴 때가 있어 90초 제한과 재시도를 둔다. SIPRI 값이 있으면 유지하고 빈 칸과 GDP만 채운다.
- UCDP: API(`ucdpapi.pcr.uu.se`)는 `x-ucdp-access-token`이 필요해 쓰지 않고 공개 CSV 묶음을 쓴다. 국가 간 분쟁(type 2)은 `source='ucdp'`, 그 밖의 정부 대 정부 쌍은 `ucdp_intl`.
- GDELT: 하루 파일이 5~7MB라 달마다 표본일만 받아 일수로 환산한다(신뢰도 0.7). 이미 적재된 달은 건너뛴다. 평문 HTTP는 막힐 수 있어 HTTPS 주소를 쓴다.
- ITAR: eCFR은 자동 요청을 403/406으로 막아 Cornell LII 사본을 읽는다.
- 금수: 비국가 대상(NGF 등)과 법적 구속력 없는 EU 정치 선언은 `partial`로 두어 조건부 수출 가능(승인 필요)으로 판정한다. 이집트(EGY)·중국(CHN)은 `data/reference/export-controls.json`의 수기 지정(`regime: MANUAL`, 사유 포함)으로 수출 불가다.
- 한국 수출통제 목록과 체계별 미국산 부품 여부는 `data/reference/export-controls.json`에서 수기로 관리한다(현재 부품 여부 미확인). 방산 협정 목록은 아직 수집하지 않는다.
- 영토 분쟁(`data/reference/territorial-disputes.json`)은 위키백과 기준 정적 목록(신뢰도 0.4), 동맹(`alliances.json`)은 수기 목록이다.

## 판단 점수

`get_score_breakdown(country, system)` 도구(MCP·채팅 공통)와 `GET /api/scores?system=`이 통과 조건, 항목별 점수(비중 × 원점수 × 출처 신뢰도), 등급 계수와 근거 ID(`표:키`)를 돌려준다. 비중은 `weights` 표에서 바로 바꾼다. 조사 제출의 `signalRows`(템플릿 참고)는 원문 인용 검사 후 `signals`에 들어가고, 반영 시 `forecasts.data.score`에 점수가 함께 저장된다.
