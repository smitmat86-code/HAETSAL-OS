import { Container } from '@cloudflare/containers'
import type { Env } from '../../../types/env'

const GRAPHITI_PORT = 8000
export const GRAPHITI_HEALTH_ENDPOINT = 'localhost/health'
export const GRAPHITI_READY_ENDPOINT = 'localhost/ready'

function buildGraphitiContainerEnv(env: Env): Record<string, string> {
  return {
    GRAPHITI_HOST: '0.0.0.0',
    GRAPHITI_PORT: String(GRAPHITI_PORT),
    GRAPHITI_KUZU_PATH: env.GRAPHITI_KUZU_PATH?.trim() || '/tmp/graphiti.kuzu',
    GRAPHITI_LOG_LEVEL: 'info',
  }
}

export class GraphitiContainer extends Container<Env> {
  defaultPort = GRAPHITI_PORT
  requiredPorts = [GRAPHITI_PORT]
  sleepAfter = '10m'
  enableInternet = false
  pingEndpoint = GRAPHITI_READY_ENDPOINT

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as DurableObjectState<{}>, env)
    this.envVars = buildGraphitiContainerEnv(env)
  }

  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, GRAPHITI_PORT)
  }

  override onError(error: unknown): void {
    console.error('Graphiti container error:', error)
  }
}
