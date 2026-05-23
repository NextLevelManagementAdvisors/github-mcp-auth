// Per-user reverse proxy from /mcp → UPSTREAM_MCP_URL (the official
// github-mcp-server container, running on 127.0.0.1:3060 with no auth).
//
// At request time the bearerAuth middleware has already resolved req.tenant.
// We rewrite the Authorization header to the *user's* GitHub access token so
// github-mcp-server makes API calls as that user — not as the shared PAT.

import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import type { TenantContext } from "./auth.js";

export function buildMcpProxy(): RequestHandler {
  const target = process.env.UPSTREAM_MCP_URL ?? "http://127.0.0.1:3060";
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    // The upstream container is mounted at /mcp too (default), so no path rewrite needed.
    // Streaming transport requirements:
    ws: false,
    selfHandleResponse: false,
    proxyTimeout: 0,
    timeout: 0,
    on: {
      proxyReq: (proxyReq, req, _res) => {
        const tenant = (req as unknown as { tenant?: TenantContext }).tenant;
        if (!tenant) {
          // bearerAuth middleware should always run first; if not, bail loud.
          proxyReq.destroy(new Error("tenant context missing in proxy layer"));
          return;
        }
        proxyReq.setHeader("Authorization", `Bearer ${tenant.githubAccessToken}`);
        proxyReq.setHeader("X-GitHub-Mcp-User", tenant.githubLogin);
        // The MCP session header passes through verbatim — github-mcp-server
        // is the source of truth for session affinity.
        fixRequestBody(proxyReq, req);
      },
      error: (err, _req, res) => {
        console.error("github-mcp-auth proxy error:", err);
        if ("status" in res && typeof (res as { status?: unknown }).status === "function") {
          const eres = res as unknown as {
            status: (code: number) => { json: (body: unknown) => void };
          };
          eres.status(502).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "upstream github-mcp-server unavailable" },
            id: null,
          });
        }
      },
    },
  });
}
