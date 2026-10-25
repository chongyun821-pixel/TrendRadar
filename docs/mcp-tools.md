# MCP tools

HORUS starts or reuses one shared Streamable HTTP MCP server at `http://127.0.0.1:62357/mcp`. App launched CLI clients use that HTTP endpoint and pass `X-Radar-Conversation-Id` and `X-Radar-Run-Id` on each request. The HTTP server ignores conversation and run ID environment variables; IDs are request scoped. External clients may omit the headers and use an external conversation.

The server also supports direct stdio mode with `npx tsx mcp/server.ts`. Stdio mode may use `RADAR_CONVERSATION_ID` and `RADAR_RUN_ID`. `RADAR_MCP_HTTP=0` is ignored by the app CLI, which always ensures and uses the shared HTTP server; it does not switch the app CLI to stdio. The app does not fall back to stdio when its shared HTTP MCP is unavailable.

The map catalog currently contains 179 country and region entries.

## Registered tools

The MCP registry exposes 54 tools from the shared app definitions and one compatibility alias, `forecast`. Internal Firecrawl tools are excluded from MCP.

### Screen and app context

`set_map_state`, `get_app_context`, `write_report`, `list_conversations`, `search_conversations`, `read_conversation`, `switch_conversation`, `create_conversation`, `delete_conversation`, `set_chat_model`, `set_app_view`, `set_chat_open`, `open_search`, `open_settings`, `get_run_status`, `cancel_run`.

### Country and procurement

`find_country`, `add_country`, `get_country_data_status`, `save_equipment`, `save_program`, `lookup_weapon`, `query_procurement`, `calculate_forecast`, `get_country_analysis`, `get_forecast`, `forecast` (compatibility alias for `get_forecast`), `list_forecasts`, `search_programs`, `get_inventory`, `get_lifespan`, `search_mro`, `get_score_breakdown`.

### Research, sources, workspace, reports

`research_procurement`, `save_source`, `workspace_list`, `publish_artifact`, `source_read`, `workspace_read`, `workspace_write`, `submit_research`, `update_assumptions`, `research_history`, `conversation_read`, `search_sources`, `collect_source`, `read_source`, `normalize_procurement_data`, `validate_research`, `apply_research`, `get_report_template`, `prepare_report`.

### Public data ingestion

`list_ingest_sources`, `run_ingest`, `get_ingest_run`.
