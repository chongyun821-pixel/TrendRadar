// (선택) Workers 단독 배포용 진입점: 정적 파일은 [assets], API는 Hono
import { app } from './server/app';
export default { fetch: app.fetch };
