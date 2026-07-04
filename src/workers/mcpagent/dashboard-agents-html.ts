// src/workers/mcpagent/dashboard-agents-html.ts
// Minimal live-agent panel for Phase 6 (demo clause 6: sub-agent visibility +
// cancel from dashboard). Served CF-Access-protected from the Worker; the full
// 8-panel dashboard lands in Phase 11. Everything rendered here comes from the
// content-free run ledger (profile, tools, status, progress phase, heartbeat).

export const AGENT_DASHBOARD_HTML = `<!doctype html><html><head>
<meta charset="utf-8"><title>HAETSAL — Live Agents</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui;max-width:56rem;margin:2rem auto;padding:0 1rem;line-height:1.5;background:#0b0f14;color:#e6edf3}
  h1{font-size:1.3rem} table{width:100%;border-collapse:collapse;font-size:.9rem}
  th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #22303c;vertical-align:top}
  .status{font-weight:600} .status.running,.status.starting{color:#e3b341}
  .status.completed{color:#3fb950} .status.aborted{color:#8b949e} .status.error,.status.interrupted{color:#f85149}
  button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:.25rem .7rem;cursor:pointer}
  button:hover{background:#30363d} .muted{color:#8b949e;font-size:.8rem}
  .bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden;min-width:90px}
  .bar>div{height:100%;background:#e3b341}
</style></head><body>
<h1>Live agents <span id="tick" class="muted"></span></h1>
<p class="muted">Execution agents spawned by the interaction agent, with their scoped tools.
Cancel stops a running agent; retry re-dispatches a finished one with the same task.</p>
<table><thead><tr><th>Agent</th><th>Tools</th><th>Status</th><th>Progress</th><th>Heartbeat</th><th></th></tr></thead>
<tbody id="runs"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table>
<script>
async function act(path){await fetch(path,{method:'POST'});await load()}
function fmtAge(ms){if(ms==null)return '—';const s=Math.round(ms/1000);return s<60?s+'s ago':Math.round(s/60)+'m ago'}
async function load(){
  const res=await fetch('/api/agents/runs');if(!res.ok)return;
  const runs=await res.json();
  const rows=runs.map(r=>{
    const live=r.status==='running'||r.status==='starting';
    const frac=r.progress?Math.round(r.progress.fraction*100):null;
    const phase=r.progress?r.progress.phase:'';
    return '<tr><td><code>'+r.runId.slice(0,8)+'</code><br><span class="muted">'+(r.profile||r.agentType)+(r.retryOf?' · retry':'')+'</span></td>'+
      '<td class="muted">'+(r.tools||[]).join('<br>')+'</td>'+
      '<td class="status '+r.status+'">'+r.status+(r.error?'<br><span class="muted">'+r.error.slice(0,60)+'</span>':'')+'</td>'+
      '<td>'+(frac!=null?'<div class="bar"><div style="width:'+frac+'%"></div></div><span class="muted">'+phase+'</span>':'<span class="muted">—</span>')+'</td>'+
      '<td class="muted">'+fmtAge(r.heartbeatAgeMs)+'</td>'+
      '<td>'+(live?'<button onclick="act(\\'/api/agents/runs/'+r.runId+'/cancel\\')">Cancel</button>'
                 :'<button onclick="act(\\'/api/agents/runs/'+r.runId+'/retry\\')">Retry</button>')+'</td></tr>'
  });
  document.getElementById('runs').innerHTML=rows.length?rows.join(''):'<tr><td colspan="6" class="muted">No agent runs yet. Text the brain something like "research the best e-ink tablets" to spawn one.</td></tr>';
  document.getElementById('tick').textContent='· refreshed '+new Date().toLocaleTimeString();
}
load();setInterval(load,2000);
</script></body></html>`
