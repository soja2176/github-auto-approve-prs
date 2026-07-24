'use strict';

const db = require('./db');
const gh = require('./github');
const { evaluatePrSafety } = require('./safety');

let timer = null;
let running = false;

async function runOnce() {
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;

  try {
    const settings = await db.getSettings();
    const connection = await db.getConnection();

    if (!connection) return { skipped: true, reason: 'not-connected' };
    if (!settings.enabled) return { skipped: true, reason: 'disabled' };
    if (!settings.org_name) return { skipped: true, reason: 'no-org' };

    const log = await db.startRunLog();
    let found = 0;
    let approved = 0;
    let failed = 0;
    let blocked = 0;
    let runError = null;

    try {
      const token = connection.access_token;
      const username = connection.github_username;

      const [assigned, requested] = await Promise.all([
        gh.searchAssignedOpenPrs(token, settings.org_name, username),
        gh.searchReviewRequestedOpenPrs(token, settings.org_name, username),
      ]);

      const seen = new Map();
      for (const item of assigned) seen.set(item.id, { item, reason: 'assignee' });
      for (const item of requested) {
        if (!seen.has(item.id)) seen.set(item.id, { item, reason: 'review_requested' });
      }

      found = seen.size;

      for (const { item, reason } of seen.values()) {
        const { owner, repo } = gh.parseOwnerRepo(item.repository_url);
        const repoFullName = `${owner}/${repo}`;

        const already = await db.hasBeenApproved(repoFullName, item.number);
        if (already) continue;

        try {
          const prDetail = await gh.getPr(token, owner, repo, item.number);

          // Protecciones: conflictos de merge, checks fallando/pendientes,
          // reviews humanas con cambios solicitados, drafts, y bloqueos
          // genericos que ya reporta GitHub.
          let checkRuns = [];
          let combinedStatus = null;
          let reviews = [];
          if (prDetail.mergeable !== false && prDetail.mergeable_state !== 'dirty' && !prDetail.draft) {
            const sha = prDetail.head && prDetail.head.sha;
            [checkRuns, combinedStatus, reviews] = await Promise.all([
              sha ? gh.getCheckRuns(token, owner, repo, sha) : [],
              sha ? gh.getCombinedStatus(token, owner, repo, sha) : null,
              gh.getPrReviews(token, owner, repo, item.number),
            ]);
          }

          const evaluation = evaluatePrSafety({ prDetail, checkRuns, combinedStatus, reviews, botUsername: username });

          if (evaluation.retry) {
            // Todavia no esta listo para evaluar (mergeability o checks en
            // progreso) - se reintenta solo en el proximo ciclo.
            continue;
          }

          if (evaluation.blocked) {
            blocked += 1;
            const alreadyBlocked = await db.hasBeenBlocked(repoFullName, item.number);
            if (!alreadyBlocked && evaluation.action === 'request_changes') {
              await gh.requestChangesOnPr(token, owner, repo, item.number, evaluation.message);
            } else if (!alreadyBlocked && evaluation.action === 'comment') {
              await gh.commentOnPr(token, owner, repo, item.number, evaluation.message);
            }
            await db.upsertBlockedPr({
              repo_full_name: repoFullName,
              pr_number: item.number,
              pr_url: prDetail.html_url,
              title: prDetail.title,
              author: prDetail.user && prDetail.user.login,
              reason: evaluation.reason,
              detail: evaluation.message || null,
              action_taken: evaluation.action || 'none',
            });
            continue;
          }

          await gh.approvePr(token, owner, repo, item.number);
          const files = await gh.getPrFiles(token, owner, repo, item.number);

          await db.insertApprovedPr({
            repo_full_name: repoFullName,
            pr_number: item.number,
            pr_url: prDetail.html_url,
            title: prDetail.title,
            author: prDetail.user && prDetail.user.login,
            matched_reason: reason,
            additions: prDetail.additions,
            deletions: prDetail.deletions,
            changed_files: prDetail.changed_files,
            files: files.map((f) => ({
              filename: f.filename,
              additions: f.additions,
              deletions: f.deletions,
              status: f.status,
            })),
          });
          await db.clearBlockedPr(repoFullName, item.number);
          approved += 1;
        } catch (err) {
          failed += 1;
          await db.insertFailedPr({
            repo_full_name: repoFullName,
            pr_number: item.number,
            pr_url: item.html_url,
            title: item.title,
            error: err.message,
          });
        }
      }
    } catch (err) {
      runError = err.message;
    }

    await db.finishRunLog(log.id, {
      prs_found: found,
      prs_approved: approved,
      prs_failed: failed,
      prs_blocked: blocked,
      error: runError,
    });

    return { skipped: false, found, approved, failed, blocked, error: runError };
  } finally {
    running = false;
  }
}

async function reschedule() {
  if (timer) clearInterval(timer);
  const settings = await db.getSettings();
  const intervalMs = Math.max(1, settings.poll_interval_minutes || 10) * 60 * 1000;
  timer = setInterval(() => {
    runOnce().catch((err) => console.error('Scheduler run fallo:', err));
  }, intervalMs);
}

async function start() {
  await reschedule();
  // primera corrida a los 10s de levantar, para no bloquear el arranque del server
  setTimeout(() => {
    runOnce().catch((err) => console.error('Scheduler initial run fallo:', err));
  }, 10_000);
}

module.exports = { start, runOnce, reschedule };
