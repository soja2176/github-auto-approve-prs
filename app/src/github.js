'use strict';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'github-auto-approve-prs-app';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'repo read:org');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCodeForToken({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`${data.error}: ${data.error_description || ''}`);
  }
  return data; // { access_token, scope, token_type }
}

async function getAuthenticatedUser(token) {
  const res = await fetch(`${GITHUB_API}/user`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`GET /user fallo: ${res.status}`);
  return res.json();
}

async function listUserOrgs(token) {
  const res = await fetch(`${GITHUB_API}/user/orgs?per_page=100`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`GET /user/orgs fallo: ${res.status}`);
  return res.json();
}

function parseOwnerRepo(repositoryUrl) {
  // https://api.github.com/repos/{owner}/{repo}
  const parts = repositoryUrl.split('/');
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

// GitHub suele devolver un "message" generico (ej. "Unprocessable Entity" o
// "Validation Failed") y dejar el motivo real adentro de un array "errors".
// Esto arma un mensaje legible juntando ambas partes.
function extractGithubErrorMessage(rawBody) {
  if (!rawBody) return 'sin detalle en la respuesta';
  try {
    const parsed = JSON.parse(rawBody);
    const parts = [];
    if (parsed.message) parts.push(parsed.message);
    if (Array.isArray(parsed.errors)) {
      for (const e of parsed.errors) {
        if (typeof e === 'string') parts.push(e);
        else if (e && e.message) parts.push(e.message);
        else if (e) parts.push(JSON.stringify(e));
      }
    }
    return parts.length ? parts.join(' | ') : rawBody;
  } catch (_) {
    return rawBody;
  }
}

async function searchOpenPrs(token, query) {
  const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=100`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Busqueda fallo (${res.status}): ${extractGithubErrorMessage(body)}`);
  }
  const data = await res.json();
  return data.items || [];
}

async function searchAssignedOpenPrs(token, org, username) {
  return searchOpenPrs(token, `org:${org} is:pr is:open assignee:${username}`);
}

async function searchReviewRequestedOpenPrs(token, org, username) {
  return searchOpenPrs(token, `org:${org} is:pr is:open review-requested:${username}`);
}

async function getPr(token, owner, repo, number) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET pull ${owner}/${repo}#${number} fallo (${res.status}): ${extractGithubErrorMessage(body)}`);
  }
  return res.json();
}

async function getPrFiles(token, owner, repo, number) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET pull files ${owner}/${repo}#${number} fallo (${res.status}): ${extractGithubErrorMessage(body)}`);
  }
  return res.json();
}

async function getCheckRuns(token, owner, repo, sha) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET check-runs ${owner}/${repo}@${sha} fallo (${res.status}): ${extractGithubErrorMessage(body)}`);
  }
  const data = await res.json();
  return data.check_runs || [];
}

async function getCombinedStatus(token, owner, repo, sha) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}/status?per_page=100`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET status ${owner}/${repo}@${sha} fallo (${res.status}): ${extractGithubErrorMessage(body)}`);
  }
  return res.json();
}

async function getPrReviews(token, owner, repo, number) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET reviews ${owner}/${repo}#${number} fallo (${res.status}): ${extractGithubErrorMessage(body)}`);
  }
  return res.json();
}

async function submitReview(token, owner, repo, number, event, body) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, body }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`(${res.status}) ${extractGithubErrorMessage(errBody)}`);
  }
  return res.json();
}

async function approvePr(token, owner, repo, number, body) {
  return submitReview(token, owner, repo, number, 'APPROVE', body || 'Auto-aprobado automáticamente.');
}

async function requestChangesOnPr(token, owner, repo, number, body) {
  return submitReview(token, owner, repo, number, 'REQUEST_CHANGES', body);
}

async function commentOnPr(token, owner, repo, number, body) {
  return submitReview(token, owner, repo, number, 'COMMENT', body);
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getAuthenticatedUser,
  listUserOrgs,
  parseOwnerRepo,
  searchAssignedOpenPrs,
  searchReviewRequestedOpenPrs,
  getPr,
  getPrFiles,
  getCheckRuns,
  getCombinedStatus,
  getPrReviews,
  approvePr,
  requestChangesOnPr,
  commentOnPr,
};
