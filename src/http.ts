import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { bearerAuth } from "./auth.js";
import { oauthProvider, mintAuthCode } from "./oauth.js";
import { completeGithubLogin } from "./github-oauth.js";
import { takePendingState } from "./db.js";
import { buildMcpProxy } from "./proxy.js";

const PORT = parseInt(process.env.PORT ?? "3061", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

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

  // MCP endpoints — bearer-authenticated then proxied upstream with the
  // user's GitHub token swapped in.
  const proxy = buildMcpProxy();
  app.use("/mcp", bearerAuth, proxy);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

function splashPage(): string {
  const issuer = BASE_URL;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GitHub MCP — Multi-tenant OAuth Gateway</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; color: #1f2937; line-height: 1.55; }
    h1 { margin: 0 0 .25rem; }
    .sub { color: #6b7280; margin-bottom: 2rem; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: .9rem; }
    pre { padding: .9rem 1rem; overflow-x: auto; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>GitHub MCP</h1>
  <p class="sub">Multi-tenant OAuth gateway for the official <code>github-mcp-server</code>. Each user authorizes with their own GitHub account and acts as themselves on the GitHub API.</p>

  <div class="card">
    <h3>Connect from claude.ai</h3>
    <p>Add this connector URL in <strong>claude.ai → Settings → Connectors → Add custom connector</strong>:</p>
    <pre>${issuer}/mcp</pre>
    <p>You'll be redirected to GitHub to authorize. Subsequent sessions reuse your stored token; revoke at any time from <a href="https://github.com/settings/connections/applications" target="_blank" rel="noopener">github.com/settings/connections/applications</a>.</p>
  </div>

  <div class="card">
    <h3>Endpoints</h3>
    <ul>
      <li><a href="/.well-known/oauth-protected-resource">/.well-known/oauth-protected-resource</a></li>
      <li><a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a></li>
      <li><a href="/health">/health</a></li>
    </ul>
  </div>
</body>
</html>`;
}

export function listen(): void {
  const app = buildApp();
  app.listen(PORT, HOST, () => {
    console.log(`github-mcp-auth listening on ${HOST}:${PORT} (BASE_URL=${BASE_URL})`);
  });
}
