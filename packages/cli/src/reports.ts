/**
 * The report store moved to @magpie/client on 2026-09-23 so the MCP server can
 * persist reports too. This module stays so `commands.ts` keeps its import.
 */
export { saveReport, listReports, readReport, renderReport, outcomeLabel } from '@magpie/client';
