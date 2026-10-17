# 무기조달사업예상

국가별 무기 보유 현황과 공개된 조달 계획을 바탕으로 장비 교체 수요를 살펴보는 앱입니다. 지도에서 교체 시기와 예상 규모를 비교하고, 채팅으로 자료를 조사해 데이터를 갱신하거나 보고서를 작성할 수 있습니다.

![지구본 지도와 국가별 장갑차 보고서 화면](docs/images/app-overview.png)

## 주요 기능

### 지도에서 교체 수요 확인

3D 지구본과 2D 지도에서 국가별 교체 시기, 수량, 예상 사업 금액을 비교합니다. 무기체계를 선택하고 국가를 누르면 현재 주력 장비, 설계 수명, 교체 예상 시기, 예상 사업 규모, 신뢰도와 출처를 국가 정보 카드로 확인할 수 있습니다. 자주포, 장갑차, 대공미사일, 다연장로켓, 호위함, 재래식 잠수함을 지원합니다. 수치는 공개 자료와 장비의 도입 연도, 설계 수명, 정비 이력을 바탕으로 계산한 예측 범위입니다.

### 공개 자료 조사와 데이터 갱신

코덱스, 그록 빌드, 젬마, 네모트론으로 조사를 요청할 수 있습니다. 모델이 사용할 수 있는 검색 도구로 자료를 찾고 원문과 출처를 보존한 뒤, 검증을 거쳐 데이터와 예측을 갱신합니다. 화면에서 보고 있던 국가와 보고서를 대화에 활용하고, 첨부 자료를 함께 검토하거나 같은 대화에서 모델을 바꿔 작업할 수 있습니다.

### 상세 보고서 작성

상세 조사가 필요하면 인공지능 에이전트를 통해 워드나 파워포인트 보고서를 작성할 수 있습니다.

## 전체 흐름

![공개 자료 수집부터 앱 분석과 보고서 제공까지의 MCP 구성도](docs/images/mcp-architecture.svg)

## 설치와 실행

Node.js 22.16 이상의 22.x 또는 24 이상, Git, Supabase 프로젝트를 준비합니다. 앱은 내 컴퓨터의 Node.js 서버에서 실행하고 데이터와 파일은 Supabase에 보관합니다.

### 1. 코드 받기

```sh
git clone --branch "무기조달사업예상" --single-branch https://github.com/chongyun821-pixel/TrendRadar.git
cd TrendRadar
npm install
```

### 2. Supabase 연결 설정

프로젝트 폴더의 `.secrets.example`을 `.secrets`라는 이름으로 복사합니다.

```sh
cp .secrets.example .secrets
```

Windows PowerShell에서는 `Copy-Item .secrets.example .secrets`를 사용합니다.

`.secrets`를 열어 다음 값을 입력합니다.

```dotenv
SUPABASE_URL=
SUPABASE_SECRET_KEY=
DATABASE_URL=
SUPABASE_STORAGE_BUCKET=trendradar-private
```

Supabase 대시보드에서 프로젝트 URL과 서버용 Secret API key를 가져옵니다. `DATABASE_URL`에는 Connect의 Session pooler 연결 주소를 입력하고, 비밀번호 자리를 프로젝트 DB 비밀번호로 바꿉니다. 비밀번호에 특수문자가 있으면 URL 인코딩해야 합니다.

### 3. 채팅 모델 준비

사용할 모델 하나를 준비하면 됩니다.

| 모델 | 준비할 것 |
| --- | --- |
| 코덱스 | Codex CLI 설치와 로그인 |
| 그록 빌드 | Grok Build CLI 설치와 로그인 |
| 젬마 | `.secrets`에 `GOOGLE_API_KEY` 입력 |
| 네모트론 | `.secrets`에 `OPENROUTER_API_KEY` 입력 |

젬마와 네모트론에 Firecrawl을 연결하려면 `FIRECRAWL_API_KEY`도 입력합니다. 지도 조회와 국가별 예측 확인은 모델 인증 없이 사용할 수 있습니다.

### 4. 데이터 준비 후 실행

Supabase 연결을 확인하고 초기 자료를 가져옵니다.

```sh
npm run supabase -- check
npm run supabase -- migrate
```

이전 결과에 `"verified": true`가 나오면 앱을 실행합니다.

```sh
npm run dev
```

브라우저에서 [http://localhost:62356](http://localhost:62356)을 엽니다. 종료할 때는 터미널에서 Ctrl+C를 누릅니다.

빌드한 화면으로 실행하려면 `npm run build` 후 `npm run serve`를 사용합니다. 설정을 바꾼 뒤에는 서버를 다시 시작하세요.

## 처음 사용하기

1. 상단에서 살펴볼 무기체계를 선택합니다.
2. 지도에서 국가를 눌러 국가 정보 카드의 장비 현황과 교체 예측, 출처를 확인합니다.
3. 채팅 모델을 선택하고 조사할 내용을 입력합니다.

예를 들어 다음과 같이 요청할 수 있습니다.

> 폴란드 자주포의 최근 조달 계획을 공식 자료로 확인하고, 기존 데이터와 달라진 내용과 근거를 알려줘.

첨부 자료는 입력창의 `＋`에서 추가합니다. 조사 결과를 파일로 정리하고 싶다면 Word나 PowerPoint 작성을 요청하고, 완성된 파일을 채팅이나 자료 메뉴에서 내려받으면 됩니다.
