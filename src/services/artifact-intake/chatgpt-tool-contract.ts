export const CHATGPT_ARTIFACT_FILE_TOOL_CONTRACT = Object.freeze({
  name: 'capture_artifact_file',
  title: 'Capture attached file',
  description: 'Use this only when a directly attached ChatGPT file is in scope. Read the attachment first, then provide a model-generated searchable extraction. Do not copy the temporary URL, file ID, or file name into other fields.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'object',
        properties: {
          download_url: { type: 'string' },
          file_id: { type: 'string' },
          mime_type: { type: 'string' },
          file_name: { type: 'string' },
        },
        required: ['download_url', 'file_id'],
        additionalProperties: false,
      },
      searchable_content: { type: 'string' },
      title: { type: 'string' },
      scope: { type: 'string' },
      model_runtime: { type: 'string' },
    },
    required: ['file', 'searchable_content'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  _meta: {
    'openai/fileParams': ['file'],
    ui: { visibility: ['model', 'app'] },
    'openai/widgetAccessible': true,
  },
} as const)
