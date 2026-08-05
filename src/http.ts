import { randomUUID } from "node:crypto";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { bearerAuth } from "./auth.js";
import { oauthProvider, mintAuthCode } from "./oauth.js";
import {
  buildGithubAuthorizeUrl,
  completeGithubLogin,
  getApprovedEmailDomains,
  identifyGithubUser,
  revokeGithubGrant,
} from "./github-oauth.js";
import { offboardGithubUser, storePendingState, takePendingState } from "./db.js";
import type { OffboardResult } from "./db.js";
import { buildMcpProxy } from "./proxy.js";

const PORT = parseInt(process.env.PORT ?? "3061", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const DISCONNECT_STATE_TTL_MS = 10 * 60 * 1000; // 10m, same as an authorize dance

export function buildApp(): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "github-mcp-auth" });
  });

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(splashPage());
  });

  // OAuth 2.1 endpoints (.well-known, /register, /authorize, /token, /revoke).
  // mcpAuthRouter delegates to oauthProvider for the actual logic.
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(BASE_URL),
      resourceName: "GitHub MCP",
    })
  );

  // Callback target registered with the GitHub OAuth App.
  // GitHub redirects the user here with ?code=...&state=...
  app.get("/oauth/github/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) {
      res.status(400).type("text/plain").send("Missing code or state");
      return;
    }
    const pending = await takePendingState(state);
    if (!pending) {
      res.status(400).type("text/plain").send("Unknown or expired state — please retry authorization.");
      return;
    }

    // The same callback serves both directions: connecting, and turning it off.
    if (pending.purpose === "disconnect") {
      await finishBrowserDisconnect(code, res);
      return;
    }

    if (!pending.clientId || !pending.redirectUri || !pending.codeChallenge) {
      res.status(400).type("text/plain").send("Malformed authorization state — please retry authorization.");
      return;
    }

    let user: { githubUserId: number; githubLogin: string };
    try {
      user = await completeGithubLogin(code);
    } catch (err) {
      console.error("GitHub login failed:", err);
      res
        .status(401)
        .type("text/plain")
        .send(`GitHub login failed: ${err instanceof Error ? err.message : "unknown error"}`);
      return;
    }

    const ourCode = await mintAuthCode(
      pending.clientId,
      pending.redirectUri,
      pending.codeChallenge,
      user.githubUserId
    );
    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", ourCode);
    if (pending.claudeState) target.searchParams.set("state", pending.claudeState);
    res.redirect(target.toString());
  });

  // ─── Self-service offboarding ─────────────────────────────────────────────
  //
  // Two ways in, both proving the same thing — that you control the GitHub
  // account whose credentials are about to be deleted:
  //
  //   • browser: GET /disconnect → POST /disconnect/start → GitHub → callback
  //   • API:     POST /disconnect with the connector's own bearer token
  //
  // Neither re-checks the approved-domain allowlist. That gate decides who may
  // *connect*; making it also guard disconnection would mean dropping a domain
  // from the allowlist strands its users with a connector they can't turn off.

  app.get("/disconnect", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(disconnectPage());
  });

  app.post("/disconnect/start", async (_req, res) => {
    const stateToken = randomUUID();
    await storePendingState(
      stateToken,
      null,
      null,
      null,
      undefined,
      Date.now() + DISCONNECT_STATE_TTL_MS,
      "disconnect"
    );
    res.redirect(buildGithubAuthorizeUrl(stateToken));
  });

  app.post("/disconnect", bearerAuth, async (req, res) => {
    const tenant = req.tenant;
    if (!tenant) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const result = await offboardGithubUser(tenant.githubUserId);
    const grantRevoked = await tryRevokeGrant(tenant.githubAccessToken);
    console.log(`Offboarded GitHub user ${tenant.githubLogin} via bearer token`);
    res.json({
      status: "disconnected",
      github_login: tenant.githubLogin,
      github_grant_revoked: grantRevoked,
      ...result,
    });
  });

  // MCP endpoints — bearer-authenticated then proxied upstream with the
  // user's GitHub token swapped in.
  const proxy = buildMcpProxy();
  app.use("/mcp", bearerAuth, proxy);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

/** Revoking is best-effort: local state is gone either way. */
async function tryRevokeGrant(accessToken: string): Promise<boolean> {
  try {
    return await revokeGithubGrant(accessToken);
  } catch (err) {
    console.error("GitHub grant revocation failed:", err);
    return false;
  }
}

async function finishBrowserDisconnect(code: string, res: express.Response): Promise<void> {
  let identity: Awaited<ReturnType<typeof identifyGithubUser>>;
  try {
    identity = await identifyGithubUser(code);
  } catch (err) {
    console.error("Disconnect identification failed:", err);
    res
      .status(401)
      .type("text/html")
      .send(
        page(
          "Disconnect failed",
          `<div class="card">
    <h3>We couldn't confirm who you are</h3>
    <p>${escapeHtml(err instanceof Error ? err.message : "unknown error")}</p>
    <p><a href="/disconnect">Try again</a></p>
  </div>`
        )
      );
    return;
  }

  const result = await offboardGithubUser(identity.githubUserId);
  const grantRevoked = await tryRevokeGrant(identity.accessToken);
  console.log(
    `Offboarded GitHub user ${identity.githubLogin} via browser (grant revoked: ${grantRevoked})`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(disconnectedPage(identity.githubLogin, identity.email, result, grantRevoked));
}

// ─── Pages ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; color: #1f2937; line-height: 1.55; }
    h1 { margin: 0 0 .25rem; }
    .sub { color: #6b7280; margin-bottom: 2rem; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: .9rem; }
    pre { padding: .9rem 1rem; overflow-x: auto; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
    a { color: #2563eb; }
    button { font: inherit; background: #b91c1c; color: #fff; border: 0; border-radius: 6px; padding: .6rem 1.1rem; cursor: pointer; }
    button:hover { background: #991b1b; }
    ul { padding-left: 1.25rem; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function splashPage(): string {
  const issuer = BASE_URL;
  const domains = getApprovedEmailDomains();
  const who =
    domains.length > 0
      ? `<p>Open to GitHub accounts with a verified email on ${domains
          .map((d) => `<code>${escapeHtml(d)}</code>`)
          .join(", ")} (subdomains included).</p>`
      : "";
  return page(
    "GitHub MCP — Multi-tenant OAuth Gateway",
    `  <h1>GitHub MCP</h1>
  <p class="sub">Multi-tenant OAuth gateway for the official <code>github-mcp-server</code>. Each user authorizes with their own GitHub account and acts as themselves on the GitHub API.</p>

  <div class="card">
    <h3>Connect from claude.ai</h3>
    <p>Add this connector URL in <strong>claude.ai → Settings → Connectors → Add custom connector</strong>:</p>
    <pre>${escapeHtml(issuer)}/mcp</pre>
    <p>You'll be redirected to GitHub to authorize. Subsequent sessions reuse your stored token.</p>
${who}  </div>

  <div class="card">
    <h3>Turn your connector off</h3>
    <p><a href="/disconnect">Disconnect this connector</a> — deletes your stored GitHub credentials here and revokes the app's access to your GitHub account, whichever approved domain you signed in from.</p>
  </div>

  <div class="card">
    <h3>Endpoints</h3>
    <ul>
      <li><a href="/.well-known/oauth-protected-resource">/.well-known/oauth-protected-resource</a></li>
      <li><a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a></li>
      <li><a href="/health">/health</a></li>
    </ul>
  </div>`
  );
}

function disconnectPage(): string {
  return page(
    "Disconnect GitHub MCP",
    `  <h1>Disconnect this connector</h1>
  <p class="sub">Sign in with GitHub to confirm it's your connector, then we turn it off.</p>

  <div class="card">
    <h3>What this deletes</h3>
    <ul>
      <li>Every access and refresh token this gateway issued to your MCP clients</li>
      <li>Your encrypted GitHub access and refresh tokens stored here</li>
      <li>Your tenant record</li>
    </ul>
    <p>It also revokes this app's authorization on your GitHub account, so nothing here can act as you again until you reconnect.</p>
    <p>Any GitHub account that signed in here can turn its own connector off — it isn't limited to one email domain. Activity records in the audit log are kept; they identify you only by a salted hash.</p>
    <form method="POST" action="/disconnect/start">
      <button type="submit">Continue to GitHub and disconnect</button>
    </form>
  </div>

  <div class="card">
    <h3>Prefer the API?</h3>
    <p>With a bearer token your client already holds:</p>
    <pre>curl -X POST ${escapeHtml(BASE_URL)}/disconnect \\
     -H 'Authorization: Bearer &lt;access_token&gt;'</pre>
  </div>`
  );
}

function disconnectedPage(
  login: string,
  email: string | null,
  result: OffboardResult,
  grantRevoked: boolean
): string {
  const who = email
    ? `<code>${escapeHtml(login)}</code> (${escapeHtml(email)})`
    : `<code>${escapeHtml(login)}</code>`;
  const headline = result.hadStoredConnection
    ? `Disconnected ${who}.`
    : `Nothing was stored here for ${who} — there was no connector left to turn off.`;
  const grantNote = grantRevoked
    ? "<li>This app's authorization on your GitHub account was revoked.</li>"
    : `<li>We couldn't revoke this app's GitHub authorization automatically — remove it at <a href="https://github.com/settings/connections/applications" target="_blank" rel="noopener">github.com/settings/connections/applications</a>.</li>`;
  return page(
    "Connector disconnected",
    `  <h1>Connector off</h1>
  <p class="sub">${headline}</p>

  <div class="card">
    <h3>What happened</h3>
    <ul>
      <li>Access tokens deleted: ${result.accessTokensDeleted}</li>
      <li>Refresh tokens deleted: ${result.refreshTokensDeleted}</li>
      <li>Pending authorization codes deleted: ${result.authCodesDeleted}</li>
      <li>Stored GitHub credentials: ${result.hadStoredConnection ? "deleted" : "none found"}</li>
      ${grantNote}
    </ul>
    <p>Remove the connector in <strong>claude.ai → Settings → Connectors</strong> too, so it stops trying to reach a connection that no longer exists. You can <a href="/">reconnect</a> any time.</p>
  </div>`
  );
}

export function listen(): void {
  const app = buildApp();
  app.listen(PORT, HOST, () => {
    console.log(`github-mcp-auth listening on ${HOST}:${PORT} (BASE_URL=${BASE_URL})`);
  });
}
