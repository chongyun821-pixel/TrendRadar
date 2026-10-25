/** 서버 환경 설정(.secrets, 환경 변수) 키 목록 */
export interface Env {
  OPENAI_API_KEY?: string; OPENAI_MODEL?: string; OPENAI_BASE_URL?: string;
  OPENROUTER_API_KEY?: string; OPENROUTER_BASE_URL?: string;
  GROK_BIN?: string; GROK_MODEL?: string; GROK_EFFORT?: string; CODEX_BIN?: string; CODEX_MODEL?: string; CODEX_EFFORT?: string; LOCAL_CLI?: string; CLI_RUNTIME_DIR?: string; CLI_DOCUMENT_TOOLS_PATH?: string;
  FIRECRAWL_API_KEY?: string; FIRECRAWL_MCP_URL?: string;
}
