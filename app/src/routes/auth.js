'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const gh = require('../github');

const router = express.Router();

router.get('/github', (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const redirectUri = process.env.GITHUB_CALLBACK_URL;

  if (!clientId || !redirectUri) {
    return res
      .status(500)
      .send('Falta configurar GITHUB_CLIENT_ID / GITHUB_CALLBACK_URL en el .env');
  }

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

  const url = gh.buildAuthorizeUrl({ clientId, redirectUri, state });
  res.redirect(url);
});

router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies.oauth_state;

  if (!code || !state || state !== savedState) {
    return res.status(400).send('OAuth state invalido o ausente. Volve a intentar conectar desde el dashboard.');
  }

  try {
    const tokenData = await gh.exchangeCodeForToken({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirectUri: process.env.GITHUB_CALLBACK_URL,
    });

    const user = await gh.getAuthenticatedUser(tokenData.access_token);

    await db.setConnection({
      access_token: tokenData.access_token,
      github_username: user.login,
      github_user_id: user.id,
      scopes: tokenData.scope,
    });

    res.clearCookie('oauth_state');
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Error conectando con GitHub: ${err.message}`);
  }
});

router.post('/disconnect', async (req, res) => {
  await db.clearConnection();
  res.json({ ok: true });
});

module.exports = router;
