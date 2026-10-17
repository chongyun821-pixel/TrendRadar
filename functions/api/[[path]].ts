// CLI·문서 작업은 Node 호스트를 사용한다.
export const onRequest = () => new Response('CLI·작업 폴더를 사용하는 Node 서버가 필요합니다. npm start로 실행하세요.', { status: 503 });
