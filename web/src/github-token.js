// The GitHub token the user lets this browser remember for the Patch Tester: every new playground with the Patch
// Tester gets it (main.js), so it need not be entered again for each pull request.
//
// It is kept in localStorage: on this computer, in this browser, for every page of this site (the playground's whole
// origin, which includes the pull requests tested in it). The playground asks for a token without permissions, so it
// gives nothing beyond GitHub's higher rate limit.

const KEY = 'joomla-playground-github-token';

/** The remembered token, or null (none, or no storage in this browser). */
export function rememberedToken() {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Remembers a token; throws when it does not look like one or this browser does not keep it.
 */
export function rememberToken(token) {
  const value = String(token ?? '').trim();

  if (!isToken(value)) {
    throw new Error('That does not look like a GitHub token (one word, such as github_pat_… or ghp_…)');
  }

  try {
    localStorage.setItem(KEY, value);
  } catch {
    throw new Error('This browser does not keep data for this site (a private window?), so it cannot remember the token');
  }

  return value;
}

export function forgetToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}

/** One word of letters, digits and underscores: GitHub's fine-grained (github_pat_…) and classic (ghp_…) tokens. */
export function isToken(value) {
  return /^[A-Za-z0-9_]{20,255}$/.test(value);
}

/** Headers for GitHub's API: with the remembered token, a higher rate limit than 60 requests an hour. */
export function gitHubHeaders() {
  const token = rememberedToken();

  return { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
