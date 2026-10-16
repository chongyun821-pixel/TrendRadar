// 이전 Pages 진입점. 로컬 SQLite 버전은 Node 서버를 사용한다.
export const onRequest = () => new Response('로컬 SQLite 버전은 Node 서버가 필요합니다. npm start로 실행하세요.', { status: 503 });
