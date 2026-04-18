import type { InterviewState } from '../../../types/bootstrap'

export interface PersistedSessionRow {
  tenant_id: string | null
  jwt_sub: string | null
  interview_state: string | null
}

type SessionSql = <TRow = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => TRow[]

export function ensureSessionTable(sql: SessionSql): void {
  sql`
    CREATE TABLE IF NOT EXISTS mcp_agent_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tenant_id TEXT,
      jwt_sub TEXT,
      interview_state TEXT,
      updated_at INTEGER NOT NULL
    )
  `
}

export function readPersistedSession(sql: SessionSql): PersistedSessionRow | null {
  return sql<PersistedSessionRow>`
    SELECT tenant_id, jwt_sub, interview_state
    FROM mcp_agent_session
    WHERE id = 1
  `[0] ?? null
}

export function writePersistedSession(
  sql: SessionSql,
  update: {
    tenantId: string | null
    jwtSub: string | null
    interviewState: InterviewState | null
  },
): void {
  const interviewStateJson = update.interviewState
    ? JSON.stringify(update.interviewState)
    : null
  sql`
    INSERT INTO mcp_agent_session (id, tenant_id, jwt_sub, interview_state, updated_at)
    VALUES (1, ${update.tenantId}, ${update.jwtSub}, ${interviewStateJson}, ${Date.now()})
    ON CONFLICT(id) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      jwt_sub = excluded.jwt_sub,
      interview_state = excluded.interview_state,
      updated_at = excluded.updated_at
  `
}
