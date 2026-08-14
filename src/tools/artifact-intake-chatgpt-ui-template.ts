export const CHATGPT_ARTIFACT_CAPTURE_UI_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;padding:12px;background:transparent;color:CanvasText}
main{display:grid;gap:10px}h2{font-size:15px;margin:0}p{font-size:13px;line-height:1.4;margin:0;color:color-mix(in srgb,CanvasText 72%,transparent)}
button{width:fit-content;border:0;border-radius:8px;padding:9px 13px;font:inherit;font-weight:650;color:white;background:#216e39;cursor:pointer}button:disabled{cursor:wait;opacity:.65}
#status{min-height:18px;font-size:13px}#receipt{display:none;grid-template-columns:max-content 1fr;gap:4px 10px;margin:0;font-size:12px}#receipt dt{font-weight:650}#receipt dd{margin:0;overflow-wrap:anywhere}
</style></head><body><main>
<h2>Complete governed attachment capture</h2>
<p>Select the ChatGPT-hosted file that the model just inspected. HAETSAL receives a temporary descriptor, not file bytes in MCP arguments.</p>
<button id="capture" type="button">Select ChatGPT file and capture</button>
<div id="status" role="status" aria-live="polite">Ready.</div>
<dl id="receipt"><dt>Capture</dt><dd id="capture-id"></dd><dt>Document</dt><dd id="document-id"></dd><dt>Upload</dt><dd id="upload-id"></dd><dt>Status</dt><dd id="capture-status"></dd></dl>
</main><script>
(() => {
  'use strict';
  const button = document.getElementById('capture');
  const status = document.getElementById('status');
  const receipt = document.getElementById('receipt');
  const pending = new Map();
  let nextId = 1;
  let toolInput = window.openai && window.openai.toolInput;
  let toolOutput = window.openai && window.openai.toolOutput;

  function request(method, params) {
    const id = nextId++;
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('host_unavailable')); }, 60000);
      pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      const handler = pending.get(message.id); pending.delete(message.id);
      if (message.error) handler.reject(message.error); else handler.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-input') toolInput = message.params;
    if (message.method === 'ui/notifications/tool-result') toolOutput = message.params && message.params.structuredContent;
  }, { passive: true });

  function preparedInput() {
    const value = toolInput || toolOutput;
    if (!value || typeof value.searchable_content !== 'string' || value.searchable_content.trim() === '') throw new Error('extraction_unavailable');
    const input = { searchable_content: value.searchable_content };
    if (typeof value.title === 'string') input.title = value.title;
    if (typeof value.scope === 'string') input.scope = value.scope;
    if (typeof value.model_runtime === 'string') input.model_runtime = value.model_runtime;
    return input;
  }

  function parseReceipt(result) {
    const envelope = result && result.content ? result : result && result.result ? result.result : result;
    const item = envelope && Array.isArray(envelope.content)
      ? envelope.content.find(value => value && value.type === 'text' && typeof value.text === 'string') : null;
    if (!item) throw new Error('receipt_unavailable');
    const parsed = JSON.parse(item.text);
    if (envelope.isError || parsed.status !== 'finalized') throw new Error(parsed.error_code || 'capture_failed');
    return parsed;
  }

  function showReceipt(value) {
    document.getElementById('capture-id').textContent = String(value.captureId || '—');
    document.getElementById('document-id').textContent = String(value.documentId || '—');
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
    document.getElementById('upload-id').textContent = String((artifacts[0] && artifacts[0].uploadId) || '—');
    document.getElementById('capture-status').textContent = String(value.status || '—');
    receipt.style.display = 'grid';
  }

  function safeErrorCode(error) {
    const value = error && typeof error.message === 'string' ? error.message : '';
    const allowed = new Set(['bulk_import_required','capture_failed','chatgpt_file_picker_unavailable','download_timeout','extraction_unavailable','host_unavailable','mime_mismatch','raw_bytes_unavailable','receipt_unavailable','select_exactly_one_file','ssrf_url_blocked']);
    return allowed.has(value) ? value : 'capture_failed';
  }

  button.addEventListener('click', async () => {
    button.disabled = true; receipt.style.display = 'none';
    try {
      const openai = window.openai;
      if (!openai || typeof openai.selectFiles !== 'function' || typeof openai.getFileDownloadUrl !== 'function') throw new Error('chatgpt_file_picker_unavailable');
      status.textContent = 'Waiting for file selection…';
      const files = await openai.selectFiles();
      if (!Array.isArray(files) || files.length !== 1 || !files[0] || typeof files[0].fileId !== 'string') throw new Error('select_exactly_one_file');
      status.textContent = 'Authorizing a temporary download…';
      const selected = files[0];
      const temporary = await openai.getFileDownloadUrl({ fileId: selected.fileId });
      if (!temporary || typeof temporary.downloadUrl !== 'string') throw new Error('raw_bytes_unavailable');
      const args = preparedInput();
      args.file = { download_url: temporary.downloadUrl, file_id: selected.fileId };
      if (typeof selected.mimeType === 'string' && selected.mimeType.trim() !== '') args.file.mime_type = selected.mimeType;
      status.textContent = 'Sealing and finalizing…';
      const result = await request('tools/call', { name: 'capture_artifact_file', arguments: args });
      const value = parseReceipt(result); showReceipt(value); status.textContent = 'Capture finalized.';
      if (openai.setWidgetState) openai.setWidgetState({
        modelContent: JSON.stringify({
          status: value.status, captureId: value.captureId, documentId: value.documentId,
          artifacts: Array.isArray(value.artifacts) ? value.artifacts.map(artifact => ({ uploadId: artifact.uploadId, role: artifact.role, primary: artifact.primary })) : [],
        }),
        privateContent: { status: 'complete' }, imageIds: [],
      });
    } catch (error) {
      status.textContent = 'Capture not completed: ' + safeErrorCode(error);
    } finally { button.disabled = false; }
  });
})();
</script></body></html>`
