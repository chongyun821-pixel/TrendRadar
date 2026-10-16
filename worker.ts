// 이전 Workers 진입점. 로컬 SQLite·작업 폴더는 Node 서버에서만 제공한다.
export default { fetch: () => new Response('이 버전은 로컬 SQLite·작업 폴더를 사용하는 Node 서버가 필요합니다. npm start로 실행하세요.', { status: 503 }) };
