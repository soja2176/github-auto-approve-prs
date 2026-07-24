'use strict';

const express = require('express');
const db = require('../db');
const gh = require('../github');
const scheduler = require('../scheduler');

const router = express.Router();

router.get('/status', async (req, res) => {
  const connection = await db.getConnection();
  const settings = await db.getSettings();
  const totalApproved = await db.countApprovedPrs();
  const approvedToday = await db.countApprovedToday();
  const totalBlocked = await db.countBlockedPrs();
  const [lastRun] = await db.listRunLogs({ limit: 1 });

  res.json({
    connected: !!connection,
    github_username: connection ? connection.github_username : null,
    settings,
    stats: { total_approved: totalApproved, approved_today: approvedToday, total_blocked: totalBlocked },
    last_run: lastRun || null,
  });
});

router.get('/orgs', async (req, res) => {
  const connection = await db.getConnection();
  if (!connection) return res.status(401).json({ error: 'not-connected' });
  try {
    const orgs = await gh.listUserOrgs(connection.access_token);
    res.json(orgs.map((o) => ({ login: o.login, avatar_url: o.avatar_url })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/settings', async (req, res) => {
  res.json(await db.getSettings());
});

router.post('/settings', async (req, res) => {
  const body = req.body || {};
  const updated = await db.updateSettings({
    org_name: body.org_name ?? null,
    poll_interval_minutes: body.poll_interval_minutes ?? null,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : null,
  });
  await scheduler.reschedule();
  res.json(updated);
});

router.post('/run-now', async (req, res) => {
  const result = await scheduler.runOnce();
  res.json(result);
});

router.get('/approved-prs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const rows = await db.listApprovedPrs({ limit, offset });
  res.json(rows);
});

router.get('/failed-prs', async (req, res) => {
  const rows = await db.listFailedPrs({ limit: 50 });
  res.json(rows);
});

router.get('/blocked-prs', async (req, res) => {
  const rows = await db.listBlockedPrs({ limit: 50 });
  res.json(rows);
});

router.get('/run-logs', async (req, res) => {
  const rows = await db.listRunLogs({ limit: 20 });
  res.json(rows);
});

router.get('/stats/daily', async (req, res) => {
  const rows = await db.dailyStats(14);
  res.json(rows);
});

module.exports = router;
