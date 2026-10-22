# 조달 정보 도구 사용 안내

앱과 조달 정보 MCP 서버는 같은 도구 정의와 실행 기능을 사용한다. 새 인증키를 발급하지 않고 사용할 수 있는 기본 수집과 양식 정의를 제공한다. 기존 모델 인증과 기본 웹 도구 및 연결된 MCP 설정은 그대로 사용한다.

## 조사와 데이터 반영

1. `research_procurement(country, system)`으로 기존 기록과 버전, 조사 양식과 정제 기준을 확인한다.
2. `search_sources(query, country?, system?)`로 공개 검색 후보를 찾는다. 기본 구현은 GOV.UK와 기존 출처를 검색하므로 다른 국가의 검색은 기본 웹 도구로 보완한다. 후보의 국가와 체계가 요청에 맞는지는 원문에서 확인한다.
3. `collect_source(url)`로 공개 원문을 수집하거나 기본 도구로 읽은 내용을 `save_source`로 보존한다. `collect_source`는 원본 바이트와 추출문을 모두 보존한다. 반환한 `filePath`는 `read_source`로 다시 읽고, 원문에 실제 있는 인용문을 제출한다. 발행일을 확인하지 못하면 미확인으로 남긴다.
4. `normalize_procurement_data(payload)`에 조사 제출 JSON을 전달한다. `record`는 부분 자료도 가능하다. 명칭과 수량 및 사업 단계를 정리하고 기존 기록과 병합하되 상충 값은 반환하여 검토하게 한다. `payload`가 반환되지 않으면 오류나 상충을 해결한다. 배열 전체를 바꿔야 하면 `replaceFields`에 `batches`, `projects`, `signals`, `mro` 중 해당 이름을 명시한다.
5. 반환한 정제 결과의 `payload`를 JSON 문자열로 만들어 `validate_research(payload)`에 전달한다. 검증은 운영 기록을 바꾸지 않는다. 인용문과 주장의 의미를 검토한 뒤 `apply_research(payload)`로 반영한다. 적용 시 근거와 버전 및 실행 상태를 다시 검사한다. 자료와 변경 이력 및 예측은 함께 저장한다.

변환 전 입력과 변환 내역은 대화 작업 폴더의 정제 기록에 보존한다. 취소된 계획이나 계약을 없앨 때는 `removeFields`에 `plan`이나 `awarded`를 명시하고 해당 필드의 변경 근거를 제출한다. 기본 규칙은 `templates/normalization-v1.md`에 있다. 업체별 별칭 사전과 복잡한 계약 관계 추론, 자동 통화 환산은 후속 고도화 대상이다. 계약량과 인도량을 합산하지 않으며 알 수 없는 값을 0으로 채우지 않는다.

`query_procurement`는 저장된 기록과 구조화된 예측을 조회한다. `calculate_forecast`는 계산 결과를 제공하고 `get_country_analysis`는 기존 6절 분석도 함께 제공한다. `search_programs`, `get_forecast`, `forecast`, `write_report` 등 기존 이름도 유지한다. `write_report`는 기존 국가 보고서를 대화에 표시하는 기능이다.

## 화면 맥락과 제어

앱은 화면별 식별자를 만들고 메시지 전송 시 무기체계 필터, 선택 국가, 2D/3D 지도 상태, 활성 자료 화면, 보고서 식별자와 기준일 및 데이터 버전을 보존한다. 현재 앱에 없는 필터를 임의로 생성하지 않는다. 열린 국가 보고서는 서버의 보존 정보와 대조한다. 이 화면 맥락은 모든 모델(그록 빌드·코덱스·지피티·네모트론)의 지시문에 요청마다 JSON으로 들어가고, 보고서가 열려 있으면 원문 위치(작업 폴더 `reports/<보고서 ID>.md`)도 함께 알린다.

지도 툴팁의 보고서 칩과 국가 보고서 제안 버튼은 채팅 요청을 보내지 않는다. `POST /api/conversations/{대화 ID}/reports`(`{country, system?}`)로 보고서를 대화에 저장(`run_id` 없음, 같은 데이터 판의 같은 보고서는 재사용)해 채팅 목록에 바로 표시하고, 상태 줄에 기존 `.chip` 모양의 첨부로 쌓는다(누르면 뺀다). 다음 메시지의 `/api/chat` 본문 `reportIds`로 전달되며, 서버는 이 대화의 보고서인지 확인한 뒤 모델 입력의 마지막 사용자 메시지에 보고서 본문을 붙인다. 화면의 사용자 메시지에는 `첨부: … 보고서`만 남고, 이후 요청에는 보고서 파일 위치만 전한다.

`get_app_context()`의 `request`는 요청 당시 상태, `current`는 지정한 화면의 최신 상태다. `stale`이면 오래된 상태이며, 연결된 화면이 없으면 `available: false`를 반환한다. “이 나라”와 “이 보고서”는 요청 당시 활성 화면으로 해석하고 사용자가 직접 지정한 대상을 우선한다.

`set_map_state(country?, system?, flat?, expectedVersion?)`는 지도 화면을 한 번에 맞춘다. 국가는 한국어 이름·ISO 코드·별칭(예: 폴란드, POL, UK), 체계는 자주포·IFV·대공미사일·다연장로켓·호위함·재래식 잠수함 또는 일반, `flat`은 true=2D·false=3D다. 국가 선택 해제는 `"해제"`다. 폴란드 다연장로켓은 `set_map_state(country="폴란드", system="다연장로켓")` 한 번이다. 예전 `payload` JSON과 `set_mode`·`focus_country`·`toggle_map_mode`·`get_map_state` 이름은 호환용으로만 받고 모델 도구 목록(OpenAI·OpenRouter·MCP)에는 내보내지 않는다. 기본 상태 버전은 요청 당시 값을 사용하며, 같은 실행에서 브라우저가 적용을 확인한 변경만 자동으로 이어받는다. 사용자가 이후에 변경했으면 충돌로 처리한다. 명시한 `expectedVersion`은 정확히 일치해야 한다.

화면 도구(`set_map_state`, `write_report`, `switch_conversation`, `set_chat_model`)는 브라우저 적용을 최대 3초 기다려 최종 상태를 바로 돌려준다: `applied`(완료), `conflict`(사용자가 화면을 바꿈 또는 다른 대화를 보는 중), `failed`(적용 실패), `inactive`(탭이 백그라운드이면 명령을 남겨 두고 탭이 다시 보이면 적용, 화면이 닫혔거나 30초 넘게 응답이 없으면 접수하지 않음), 시간 안에 결과가 없으면 `pending`. `ok:false` 결과의 `message`는 사용자에게 알릴 문장이다. `get_app_command(commandId)`는 `pending`일 때만 최대 3초 다시 기다린다. 앱 화면 없이 호출하면(독립 API 호출) 답과 함께 적용할 동작으로 남고 `queued`를 돌려준다.

`write_report(country, system?)`는 기존 6절 국가 보고서를 저장하고, 해당 국가와 무기체계를 선택해 채팅 패널에 표시한다. 실행이 끝나기 전에도 보고서를 열 수 있다. 결과의 `shown`은 `status=applied`일 때만 true다. 보고서를 불러오는 중 사용자가 화면을 바꾼 경우도 충돌로 보존한다.

대화는 `list_conversations`, `search_conversations`, `read_conversation`으로 조회하고 `create_conversation`, `switch_conversation`, `delete_conversation`으로 관리한다. 새 대화 생성만으로 화면이 전환되지는 않는다. 진행 중 대화는 중지 후 삭제하고 원문과 보고서는 보존한다. `set_chat_model`은 다음 요청의 모델을 선택한다. 코덱스·그록 빌드는 `cliModel`과 `effort`로 세부 모델과 추론 강도도 지정할 수 있고, 허용 목록 밖의 값은 거절한다. `get_run_status`와 `cancel_run`은 실행 조회와 중지를 담당하며 중지 도구는 자신의 실행 종료를 기다리지 않는다.

앱에서 시작한 코덱스와 그록은 대화와 실행 식별자를 MCP에 전달하므로 같은 요청의 화면 맥락을 읽는다. 독립 MCP 연결은 별도 대화에서 시작하며 연결한 앱 화면이 없으면 화면 제어를 수행하지 않는다.

## 보고서 작성과 완성 파일 보존

`get_report_template(format?, templateId?)`은 워드 기본 국가 보고서, 워드 자유 양식, 파워포인트 요약 양식을 제공한다. 현재 양식은 목차와 배치 및 서식과 검수 항목을 담은 버전별 정의이며 회사 양식 원본 파일은 추후 추가한다.

`prepare_report(country?, system?, templateId?, basis?)`는 대상과 계산 가정, 데이터와 규칙 및 양식 버전을 고정한 작성 자료를 파일로 보존한다. 국가와 체계를 생략하면 요청 당시 활성 화면을 사용한다. `system: general`은 해당 국가의 전체 체계다. 열린 보고서에서 기본 기준은 `viewed`이며 보존한 본문을 사용한다. `basis: latest`를 명시하면 현재 데이터로 별도 준비한다.

코덱스와 그록의 기존 문서 작성 도구로 편집 가능한 워드나 파워포인트를 작성하고 내용과 렌더링 결과를 검수한다. 완성 파일을 대화 작업 폴더의 `reports/`에 저장하고 아래처럼 등록한다.

```json
{
  "path": "reports/국가분석.docx",
  "preparationId": "prepare_report가 반환한 id",
  "review": "{\"content\":true,\"layout\":true,\"notes\":\"실제로 수행한 검수 내용\"}"
}
```

`publish_artifact`는 `.docx`와 `.pptx`의 파일 구조를 검사하고 다운로드용 사본과 해시값, 작성 자료 식별자 및 검수 기록을 보존한다. 파일 구조 검사가 실제 내용과 레이아웃 검수를 대신하지 않는다. 기존 `publish_artifact(path)` 호출도 호환되지만 새 작성 자료를 연결하면 검수 결과도 함께 제출해야 한다.

## 판단 점수

`get_score_breakdown(country, system)`은 통과 조건(수출 불가·독자 양산), 항목별 점수(비중 × 원점수 × 출처 신뢰도), 고객 등급 계수와 근거 ID(`표:키`), 보고서용 근거 표 마크다운을 반환한다. 지도는 `GET /api/scores?system=`으로 같은 점수를 받아 제외 국가를 회색으로 표시한다. `prepare_report`의 `evidenceTables`는 케이스별 근거 표 자료다. 수집 방법은 [데이터 수집 실행 안내](data-collection.md)를 따른다.

## 공개 자료 수집

`list_ingest_sources`로 출처(sipri-embargoes, itar, sipri-transfers, sipri-milex, worldbank, ucdp, gdelt, oryx, tiers, tension)와 마지막 실행을 보고, `run_ingest(source, dryRun?, countries?, since?, year?, months?, side?, asOf?, wait?)`로 실행한다. 기본은 미리보기(`dryRun=true`)이며 사용자가 반영을 요청할 때만 `dryRun=false`로 적재한다. 응답은 행 수와 표본 3행뿐이다. 오래 걸리면 `status: running`과 id를 돌려주므로 `get_ingest_run(id, wait?, cancel?)`으로 확인하거나 중지한다. 같은 출처는 동시에 하나만 실행된다. 자세한 동작은 [데이터 수집 실행 안내](data-collection.md#채팅에서-실행)를 따른다.

## API와 검증

새 도구는 `POST /api/tools/{도구 이름}`에서도 사용한다. 요청 본문은 `{"conversationId":"대화 ID","args":{...},"appContext":{...}}` 형식이며 화면 맥락은 필요할 때 전달한다. 응답의 `result`에 도구 결과, `conversationId`와 `runId`에 실행 식별자를 반환한다. 기존 조회 API의 평면 인자는 호환된다.

`npm test`는 격리된 자료와 가상 외부 응답을 사용한다. `npm run mcp:check`는 실제 stdio와 HTTP 전송을 확인한다. `npm run context:check`는 별도 격리 서버에서 요청 시점 상태, 보고서 선택, 지도 명령과 적용 응답, 충돌과 대화 전환 및 모바일 화면을 확인한다. 검증을 위해 운영 대화나 자료를 수정하지 않는다.
