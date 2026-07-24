'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS github_connection (
      id SERIAL PRIMARY KEY,
      access_token TEXT NOT NULL,
      github_username TEXT,
      github_user_id BIGINT,
      scopes TEXT,
      connected_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      org_name TEXT,
      poll_interval_minutes INT NOT NULL DEFAULT 10,
      enabled BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT settings_single_row CHECK (id = 1)
    );
  `);

  await pool.query(`
    INSERT INTO settings (id, org_name, poll_interval_minutes, enabled)
    VALUES (1, NULL, 10, false)
    ON CONFLICT (id) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS approved_prs (
      id SERIAL PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      pr_number INT NOT NULL,
      pr_url TEXT NOT NULL,
      title TEXT,
      author TEXT,
      matched_reason TEXT,
      additions INT DEFAULT 0,
      deletions INT DEFAULT 0,
      changed_files INT DEFAULT 0,
      files_json JSONB,
      approved_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (repo_full_name, pr_number)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS failed_prs (
      id SERIAL PRIMARY KEY,
      repo_full_name TEXT,
      pr_number INT,
      pr_url TEXT,
      title TEXT,
      error TEXT,
      failed_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_logs (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,
      prs_found INT DEFAULT 0,
      prs_approved INT DEFAULT 0,
      prs_failed INT DEFAULT 0,
      error TEXT
    );
  `);

  // Migracion para bases ya existentes creadas antes de sumar "bloqueados".
  await pool.query(`ALTER TABLE run_logs ADD COLUMN IF NOT EXISTS prs_blocked INT DEFAULT 0;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_prs (
      id SERIAL PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      pr_number INT NOT NULL,
      pr_url TEXT NOT NULL,
      title TEXT,
      author TEXT,
      reason TEXT NOT NULL,
      detail TEXT,
      action_taken TEXT,
      blocked_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (repo_full_name, pr_number)
    );
  `);
}

// ---- Settings ----
async function getSettings() {
  const { rows } = await pool.query('SELECT * FROM settings WHERE id = 1');
  return rows[0];
}

async function updateSettings({ org_name, poll_interval_minutes, enabled }) {
  const { rows } = await pool.query(
    `UPDATE settings SET
       org_name = COALESCE($1, org_name),
       poll_interval_minutes = COALESCE($2, poll_interval_minutes),
       enabled = COALESCE($3, enabled),
       updated_at = now()
     WHERE id = 1
     RETURNING *`,
    [org_name, poll_interval_minutes, enabled]
  );
  return rows[0];
}

// ---- GitHub connection (single usuario) ----
async function getConnection() {
  const { rows } = await pool.query(
    'SELECT * FROM github_connection ORDER BY id DESC LIMIT 1'
  );
  return rows[0] || null;
}

async function setConnection({ access_token, github_username, github_user_id, scopes }) {
  await pool.query('DELETE FROM github_connection');
  const { rows } = await pool.query(
    `INSERT INTO github_connection (access_token, github_username, github_user_id, scopes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [access_token, github_username, github_user_id, scopes]
  );
  return rows[0];
}

async function clearConnection() {
  await pool.query('DELETE FROM github_connection');
}

// ---- Approved PRs ----
async function hasBeenApproved(repoFullName, prNumber) {
  const { rows } = await pool.query(
    'SELECT id FROM approved_prs WHERE repo_full_name = $1 AND pr_number = $2',
    [repoFullName, prNumber]
  );
  return rows.length > 0;
}

async function insertApprovedPr(pr) {
  const { rows } = await pool.query(
    `INSERT INTO approved_prs
       (repo_full_name, pr_number, pr_url, title, author, matched_reason, additions, deletions, changed_files, files_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (repo_full_name, pr_number) DO NOTHING
     RETURNING *`,
    [
      pr.repo_full_name,
      pr.pr_number,
      pr.pr_url,
      pr.title,
      pr.author,
      pr.matched_reason,
      pr.additions,
      pr.deletions,
      pr.changed_files,
      JSON.stringify(pr.files || []),
    ]
  );
  return rows[0] || null;
}

async function listApprovedPrs({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM approved_prs ORDER BY approved_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function countApprovedPrs() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM approved_prs');
  return rows[0].count;
}

async function countApprovedToday() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM approved_prs WHERE approved_at >= date_trunc('day', now())`
  );
  return rows[0].count;
}

async function dailyStats(days = 14) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('day', approved_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
     FROM approved_prs
     WHERE approved_at >= now() - (INTERVAL '1 day' * $1::int)
     GROUP BY 1
     ORDER BY 1`,
    [days]
  );
  return rows;
}

// ---- Failed PRs ----
async function insertFailedPr(pr) {
  await pool.query(
    `INSERT INTO failed_prs (repo_full_name, pr_number, pr_url, title, error)
     VALUES ($1,$2,$3,$4,$5)`,
    [pr.repo_full_name, pr.pr_number, pr.pr_url, pr.title, pr.error]
  );
}

async function listFailedPrs({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    'SELECT * FROM failed_prs ORDER BY failed_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

// ---- Blocked PRs (conflictos, checks fallando, etc.) ----
async function hasBeenBlocked(repoFullName, prNumber) {
  const { rows } = await pool.query(
    'SELECT id FROM blocked_prs WHERE repo_full_name = $1 AND pr_number = $2',
    [repoFullName, prNumber]
  );
  return rows.length > 0;
}

async function upsertBlockedPr(pr) {
  await pool.query(
    `INSERT INTO blocked_prs (repo_full_name, pr_number, pr_url, title, author, reason, detail, action_taken)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (repo_full_name, pr_number) DO UPDATE SET
       title = EXCLUDED.title,
       reason = EXCLUDED.reason,
       detail = EXCLUDED.detail,
       action_taken = EXCLUDED.action_taken,
       blocked_at = now()`,
    [pr.repo_full_name, pr.pr_number, pr.pr_url, pr.title, pr.author, pr.reason, pr.detail, pr.action_taken]
  );
}

async function clearBlockedPr(repoFullName, prNumber) {
  await pool.query('DELETE FROM blocked_prs WHERE repo_full_name = $1 AND pr_number = $2', [
    repoFullName,
    prNumber,
  ]);
}

async function listBlockedPrs({ limit = 50 } = {}) {
  const { rows } = await pool.query('SELECT * FROM blocked_prs ORDER BY blocked_at DESC LIMIT $1', [limit]);
  return rows;
}

async function countBlockedPrs() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM blocked_prs');
  return rows[0].count;
}

// ---- Run logs ----
async function startRunLog() {
  const { rows } = await pool.query(`INSERT INTO run_logs (started_at) VALUES (now()) RETURNING *`);
  return rows[0];
}

async function finishRunLog(id, { prs_found, prs_approved, prs_failed, prs_blocked, error }) {
  await pool.query(
    `UPDATE run_logs SET finished_at = now(), prs_found = $2, prs_approved = $3, prs_failed = $4, prs_blocked = $5, error = $6
     WHERE id = $1`,
    [id, prs_found, prs_approved, prs_failed, prs_blocked || 0, error || null]
  );
}

async function listRunLogs({ limit = 20 } = {}) {
  const { rows } = await pool.query('SELECT * FROM run_logs ORDER BY started_at DESC LIMIT $1', [limit]);
  return rows;
}

module.exports = {
  pool,
  initDb,
  getSettings,
  updateSettings,
  getConnection,
  setConnection,
  clearConnection,
  hasBeenApproved,
  insertApprovedPr,
  listApprovedPrs,
  countApprovedPrs,
  countApprovedToday,
  dailyStats,
  insertFailedPr,
  listFailedPrs,
  hasBeenBlocked,
  upsertBlockedPr,
  clearBlockedPr,
  listBlockedPrs,
  countBlockedPrs,
  startRunLog,
  finishRunLog,
  listRunLogs,
};
