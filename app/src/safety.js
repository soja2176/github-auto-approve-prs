'use strict';

// Conclusiones de check-runs que consideramos "fallando". Dejamos afuera
// 'neutral' y 'skipped' porque GitHub no las trata como bloqueantes.
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'stale']);

// Combina check-runs (GitHub Actions / Checks API) y combined status (CI
// clasico via Status API) en un solo resultado: failing | pending | passing.
function evaluateChecksData(checkRuns, combinedStatus) {
  let anyFailing = false;
  let anyPending = false;
  const names = [];

  for (const run of checkRuns || []) {
    if (run.status !== 'completed') {
      anyPending = true;
    } else if (FAILING_CONCLUSIONS.has(run.conclusion)) {
      anyFailing = true;
      names.push(run.name);
    }
  }

  if (combinedStatus) {
    if (combinedStatus.state === 'failure' || combinedStatus.state === 'error') {
      anyFailing = true;
      for (const s of combinedStatus.statuses || []) {
        if (s.state === 'failure' || s.state === 'error') names.push(s.context);
      }
    } else if (combinedStatus.state === 'pending') {
      anyPending = true;
    }
  }

  if (anyFailing) return { status: 'failing', names: [...new Set(names)] };
  if (anyPending) return { status: 'pending', names: [] };
  return { status: 'passing', names: [] };
}

// Mira si el revisor humano mas reciente (excluyendo al propio bot) dejo la
// PR en estado "cambios solicitados".
function hasHumanChangesRequested(reviews, botUsername) {
  const latestByUser = new Map();
  for (const r of reviews || []) {
    if (!r.user || !r.user.login) continue;
    if (botUsername && r.user.login.toLowerCase() === String(botUsername).toLowerCase()) continue;
    latestByUser.set(r.user.login, r.state);
  }
  for (const state of latestByUser.values()) {
    if (state === 'CHANGES_REQUESTED') return true;
  }
  return false;
}

/**
 * Decide si un PR es seguro para auto-aprobar.
 *
 * Devuelve una de estas formas:
 *  - { blocked: false, retry: true,  reason }                     -> todavia no se puede evaluar, reintentar el proximo ciclo
 *  - { blocked: true,  retry: false, reason, action, message }     -> no aprobar; action: 'request_changes' | 'comment' | 'none'
 *  - { blocked: false, retry: false, reason: null, action: null }  -> aprobar normalmente
 *
 * Parametros (todos ya obtenidos previamente via la API de GitHub):
 *  - prDetail: GET /repos/{owner}/{repo}/pulls/{number}
 *  - checkRuns: array de check_runs de GET .../commits/{sha}/check-runs
 *  - combinedStatus: GET .../commits/{sha}/status
 *  - reviews: GET .../pulls/{number}/reviews
 *  - botUsername: usuario de GitHub conectado (para no contar sus propias reviews)
 */
function evaluatePrSafety({ prDetail, checkRuns, combinedStatus, reviews, botUsername }) {
  if (prDetail.draft) {
    return { blocked: true, retry: false, reason: 'draft', action: 'none', message: 'Es un borrador (draft).' };
  }

  // Conflictos de merge
  if (prDetail.mergeable === false || prDetail.mergeable_state === 'dirty') {
    return {
      blocked: true,
      retry: false,
      reason: 'merge_conflict',
      action: 'request_changes',
      message:
        'Este PR tiene conflictos de merge con la rama base y no se pudo aprobar automáticamente. Resolvé los conflictos para continuar.',
    };
  }

  // GitHub todavia no termino de calcular si es mergeable -> reintentar despues
  if (prDetail.mergeable === null || prDetail.mergeable_state === 'unknown') {
    return { blocked: false, retry: true, reason: 'mergeability_unknown' };
  }

  // Checks (Actions/Checks API + Status API clasico), independiente de si el
  // repo tiene o no branch protection configurada.
  const checks = evaluateChecksData(checkRuns, combinedStatus);
  if (checks.status === 'failing') {
    return {
      blocked: true,
      retry: false,
      reason: 'failing_checks',
      action: 'request_changes',
      message: `Hay checks fallando en el último commit${checks.names.length ? ': ' + checks.names.join(', ') : ''}. No se aprueba hasta que pasen.`,
    };
  }
  if (checks.status === 'pending') {
    return { blocked: false, retry: true, reason: 'checks_pending' };
  }

  // Ya hay un humano pidiendo cambios -> no sumar aprobacion automatica encima
  if (hasHumanChangesRequested(reviews, botUsername)) {
    return {
      blocked: true,
      retry: false,
      reason: 'changes_requested',
      action: 'none',
      message: 'Ya hay un revisor humano que pidió cambios; no se aprueba automáticamente encima.',
    };
  }

  // GitHub marca bloqueado por alguna otra razon (tipicamente reviews
  // requeridas faltantes) que no pudimos identificar puntualmente arriba.
  if (prDetail.mergeable_state === 'blocked') {
    return {
      blocked: true,
      retry: false,
      reason: 'blocked_by_github',
      action: 'comment',
      message: 'GitHub marca este PR como bloqueado (checks o revisiones requeridas pendientes). Queda para revisión manual.',
    };
  }

  return { blocked: false, retry: false, reason: null, action: null };
}

module.exports = {
  evaluatePrSafety,
  evaluateChecksData,
  hasHumanChangesRequested,
  FAILING_CONCLUSIONS,
};
