export const MCP_STREAMABLE_HTTP_PREFIX = 'streamable-http:'

export function getMcpAgentObjectName(tenantId: string): string {
  return `${MCP_STREAMABLE_HTTP_PREFIX}${tenantId}`
}

export function getMcpAgentObjectId(
  namespace: DurableObjectNamespace,
  tenantId: string,
): DurableObjectId {
  return namespace.idFromName(getMcpAgentObjectName(tenantId))
}
