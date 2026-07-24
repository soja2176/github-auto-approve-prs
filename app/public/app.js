'use strict';

const state = { settings: null };

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('es-AR');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

const REASON_LABELS = {
  merge_conflict: 'Conflicto de merge',
  failing_checks: 'Checks fallando',
  draft: 'Borrador (draft)',
  changes_requested: 'Cambios ya solicitados (humano)',
  blocked_by_github: 'Bloqueado por GitHub',
};

const ACTION_LABELS = {
  request_changes: 'Se pidieron cambios (REQUEST_CHANGES)',
  comment: 'Se dejó un comentario',
  none: 'Solo registrado (sin acción en GitHub)',
};

async function loadStatus() {
  const status = await fetchJSON('/api/status');
  const badge = document.getElementById('connection-badge');
  const connectSection = document.getElementById('connect-section');
  const dashboardSection = document.getElementById('dashboard-section');

  if (!status.connected) {
    badge.textContent = 'No conectado';
    connectSection.hidden = false;
    dashboardSection.hidden = true;
    return null;
  }

  badge.textContent = `Conectado como @${status.github_username}`;
  connectSection.hidden = true;
  dashboardSection.hidden = false;

  document.getElementById('stat-total').textContent = status.stats.total_approved;
  document.getElementById('stat-today').textContent = status.stats.approved_today;
  document.getElementById('stat-blocked').textContent = status.stats.total_blocked;
  document.getElementById('stat-last-run').textContent = status.last_run
    ? fmtDate(status.last_run.started_at)
    : 'Nunca';

  document.getElementById('interval-input').value = status.settings.poll_interval_minutes;
  document.getElementById('enabled-input').checked = status.settings.enabled;

  state.settings = status.settings;
  return status;
}

async function loadOrgs() {
  const select = document.getElementById('org-select');
  try {
    const orgs = await fetchJSON('/api/orgs');
    select.innerHTML =
      '<option value="">-- elegir organización --</option>' +
      orgs.map((o) => `<option value="${escapeHtml(o.login)}">${escapeHtml(o.login)}</option>`).join('');
    if (state.settings && state.settings.org_name) {
      select.value = state.settings.org_name;
    }
  } catch (err) {
    select.innerHTML = '<option value="">(no se pudieron cargar las organizaciones)</option>';
  }
}

async function loadApproved() {
  const rows = await fetchJSON('/api/approved-prs?limit=50');
  const body = document.getElementById('approved-table-body');
  body.innerHTML =
    rows
      .map((r) => {
        const files = (r.files_json || [])
          .map((f) => `${escapeHtml(f.filename)} (+${f.additions}/-${f.deletions})`)
          .join('<br/>');
        return `
      <tr>
        <td><a href="${r.pr_url}" target="_blank" rel="noopener">${escapeHtml(r.repo_full_name)}</a></td>
        <td>#${r.pr_number} ${escapeHtml(r.title || '')}</td>
        <td>${escapeHtml(r.author || '-')}</td>
        <td>${r.matched_reason === 'assignee' ? 'Assignee' : 'Review solicitado'}</td>
        <td>+${r.additions || 0}/-${r.deletions || 0} (${r.changed_files || 0} archivos)
          <details><summary>Ver archivos</summary><small>${files || 'sin detalle'}</small></details>
        </td>
        <td>${fmtDate(r.approved_at)}</td>
      </tr>`;
      })
      .join('') || '<tr><td colspan="6"><em>Todavía no se aprobó ningún PR.</em></td></tr>';
}

async function loadFailed() {
  const rows = await fetchJSON('/api/failed-prs');
  const body = document.getElementById('failed-table-body');
  body.innerHTML =
    rows
      .map(
        (r) => `
      <tr>
        <td><a href="${r.pr_url}" target="_blank" rel="noopener">${escapeHtml(r.repo_full_name || '')}</a></td>
        <td>#${r.pr_number}</td>
        <td>${escapeHtml(r.error || '')}</td>
        <td>${fmtDate(r.failed_at)}</td>
      </tr>`
      )
      .join('') || '<tr><td colspan="4"><em>Sin errores registrados.</em></td></tr>';
}

async function loadBlocked() {
  const rows = await fetchJSON('/api/blocked-prs');
  const body = document.getElementById('blocked-table-body');
  body.innerHTML =
    rows
      .map(
        (r) => `
      <tr>
        <td><a href="${r.pr_url}" target="_blank" rel="noopener">${escapeHtml(r.repo_full_name || '')}</a></td>
        <td>#${r.pr_number} ${escapeHtml(r.title || '')}</td>
        <td>${escapeHtml(r.author || '-')}</td>
        <td>${escapeHtml(REASON_LABELS[r.reason] || r.reason)}</td>
        <td>${escapeHtml(r.detail || '-')}</td>
        <td>${escapeHtml(ACTION_LABELS[r.action_taken] || r.action_taken || '-')}</td>
        <td>${fmtDate(r.blocked_at)}</td>
      </tr>`
      )
      .join('') || '<tr><td colspan="7"><em>Nada bloqueado por ahora.</em></td></tr>';
}

async function loadRuns() {
  const rows = await fetchJSON('/api/run-logs');
  const body = document.getElementById('runs-table-body');
  body.innerHTML =
    rows
      .map(
        (r) => `
      <tr>
        <td>${fmtDate(r.started_at)}</td>
        <td>${r.prs_found}</td>
        <td>${r.prs_approved}</td>
        <td>${r.prs_blocked || 0}</td>
        <td>${r.prs_failed}</td>
        <td>${escapeHtml(r.error || '-')}</td>
      </tr>`
      )
      .join('') || '<tr><td colspan="6"><em>Todavía no corrió.</em></td></tr>';
}

let chart;
async function loadChart() {
  const rows = await fetchJSON('/api/stats/daily');
  const ctx = document.getElementById('chart-daily');
  const labels = rows.map((r) => r.day);
  const data = rows.map((r) => r.count);
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'PRs aprobados', data, backgroundColor: '#1a5fb4' }] },
    options: { scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
  });
}

async function refreshAll() {
  const status = await loadStatus();
  if (!status) return;
  await Promise.all([loadOrgs(), loadApproved(), loadBlocked(), loadFailed(), loadRuns(), loadChart()]);
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const org_name = document.getElementById('org-select').value || null;
  const poll_interval_minutes = parseInt(document.getElementById('interval-input').value, 10) || 10;
  const enabled = document.getElementById('enabled-input').checked;
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_name, poll_interval_minutes, enabled }),
  });
  await refreshAll();
});

document.getElementById('run-now').addEventListener('click', async () => {
  const el = document.getElementById('run-now-result');
  el.textContent = 'Ejecutando...';
  const result = await fetchJSON('/api/run-now', { method: 'POST' });
  if (result.skipped) {
    el.textContent = `No se ejecutó (${result.reason}).`;
  } else {
    el.textContent = `Listo: ${result.found} encontrados, ${result.approved} aprobados, ${result.blocked || 0} bloqueados, ${result.failed} fallidos.`;
  }
  await refreshAll();
});

document.getElementById('disconnect').addEventListener('click', async () => {
  if (!confirm('¿Desconectar tu cuenta de GitHub?')) return;
  await fetch('/auth/disconnect', { method: 'POST' });
  await refreshAll();
});

refreshAll();
setInterval(refreshAll, 30000);
