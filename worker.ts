// CLI·로컬 문서 작업 폴더는 Node 호스트에서 제공한다.
export default { fetch: () => new Response('이 버전은 CLI·작업 폴더를 사용하는 Node 서버가 필요합니다. npm start로 실행하세요.', { status: 503 }) };
