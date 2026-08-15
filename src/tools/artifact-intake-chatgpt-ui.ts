import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  artifactStatusAnnotations,
  prepareArtifactFileCaptureToolSchema,
} from './artifact-intake-tool-contracts'
import { CHATGPT_ARTIFACT_CAPTURE_UI_HTML } from './artifact-intake-chatgpt-ui-template'

export { CHATGPT_ARTIFACT_CAPTURE_UI_HTML } from './artifact-intake-chatgpt-ui-template'

export const CHATGPT_ARTIFACT_CAPTURE_UI_URI = 'ui://haetsal/artifact-capture-v6.html'

export function registerChatGptArtifactCaptureUi(server: McpServer): void {
  server.registerResource(
    'haetsal-artifact-capture',
    CHATGPT_ARTIFACT_CAPTURE_UI_URI,
    {},
    async () => ({
      contents: [{
        uri: CHATGPT_ARTIFACT_CAPTURE_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: CHATGPT_ARTIFACT_CAPTURE_UI_HTML,
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          'openai/widgetDescription': 'Select one existing ChatGPT file to complete a governed HAETSAL capture.',
          'openai/widgetPrefersBorder': true,
        },
      }],
    }),
  )

  server.registerTool(
    'prepare_artifact_file_capture',
    {
      title: 'Prepare attached file capture',
      description: 'Use only after inspecting a directly attached ChatGPT file and capture_artifact_file could not receive a retrievable descriptor. Pass the model-generated extraction; the user will select that existing ChatGPT-hosted file in a private capture card.',
      inputSchema: prepareArtifactFileCaptureToolSchema,
      outputSchema: prepareArtifactFileCaptureToolSchema.extend({
        status: z.literal('selection_required'),
      }),
      annotations: artifactStatusAnnotations,
      _meta: {
        ui: { resourceUri: CHATGPT_ARTIFACT_CAPTURE_UI_URI, visibility: ['model', 'app'] },
        'openai/outputTemplate': CHATGPT_ARTIFACT_CAPTURE_UI_URI,
        'openai/widgetAccessible': true,
        'openai/toolInvocation/invoking': 'Preparing secure capture…',
        'openai/toolInvocation/invoked': 'Capture card ready.',
      },
    },
    async (input) => {
      const typed = prepareArtifactFileCaptureToolSchema.parse(input)
      return {
        structuredContent: { status: 'selection_required' as const, ...typed },
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ status: 'selection_required' }),
        }],
      }
    },
  )
}
