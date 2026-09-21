import crypto from "node:crypto";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidRequestError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";
import type http from "node:http";
import { config } from "./config.js";
import { firstRow, pool, withTransaction } from "./db.js";
import { hmac } from "./signing.js";
import { newId } from "./ids.js";
import { TARGET_TRIP_SLUG } from "./mcp-constants.js";
import { BadRequest, Forbidden } from "./errors.js";

export const MCP_READ_SCOPE = "trip:expenses:read";
export const MCP_WRITE_SCOPE = "trip:expenses:write";
export const MCP_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE] as const;

type DbClientRow = { metadata_json: string | Record<string, unknown> };
type GrantRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  state_value: string | null;
  scopes_value: string;
  code_challenge: string;
  resource_value: string;
  user_id: string | null;
};
type TokenRow = {
  client_id: string;
  user_id: string;
  scopes_value: string;
  resource_value: string;
  expires_at_epoch: number;
};

function secret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function tokenHash(kind: "request" | "code" | "access" | "refresh", value: string): Buffer {
  return hmac(`mcp-oauth:${kind}:${value}`);
}

function scopesText(scopes: string[]): string {
  return [...new Set(scopes)].sort().join(" ");
}

function parsedScopes(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

export function isAllowedMcpRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && ["chatgpt.com", "chat.openai.com", "platform.openai.com"].includes(url.hostname)) {
      return true;
    }
    return ["http:", "https:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function validateScopes(requested: string[] | undefined): string[] {
  const scopes = requested?.length ? [...new Set(requested)] : [...MCP_SCOPES];
  if (scopes.some((scope) => !MCP_SCOPES.includes(scope as typeof MCP_SCOPES[number]))) {
    throw new InvalidRequestError("Unsupported scope");
  }
  return scopes;
}

function validateResource(resource: URL | undefined): string {
  const value = resource?.href || config.mcp.resourceUrl;
  if (value !== config.mcp.resourceUrl) throw new InvalidRequestError("Invalid resource");
  return value;
}

class MysqlClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await firstRow<DbClientRow>(pool,
      "SELECT metadata_json FROM mcp_oauth_clients WHERE client_id = ? LIMIT 1",
      [clientId],
    );
    if (!row) return undefined;
    const value = typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json;
    return value as OAuthClientInformationFull;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const full = client as OAuthClientInformationFull;
    if (!full.client_id) throw new InvalidRequestError("client_id is required");
    if ((full.token_endpoint_auth_method || "none") !== "none" || full.client_secret) {
      throw new InvalidRequestError("Only public PKCE clients are supported");
    }
    if (!full.redirect_uris.length || full.redirect_uris.some((uri) => !isAllowedMcpRedirectUri(uri))) {
      throw new InvalidRequestError("redirect_uri is not allowed");
    }
    const normalized: OAuthClientInformationFull = {
      ...full,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    await pool.query(
      `INSERT INTO mcp_oauth_clients (client_id, metadata_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE metadata_json = VALUES(metadata_json)`,
      [normalized.client_id, JSON.stringify(normalized)],
    );
    return normalized;
  }
}

export class TabiPlanOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new MysqlClientsStore();

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = validateScopes(params.scopes);
    const resource = validateResource(params.resource);
    if (!isAllowedMcpRedirectUri(params.redirectUri) || !client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }
    const request = secret();
    await pool.query(
      `INSERT INTO mcp_oauth_grants
         (id, request_hash, client_id, redirect_uri, state_value, scopes_value,
          code_challenge, resource_value, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL 10 MINUTE))`,
      [
        newId("mog"), tokenHash("request", request), client.client_id, params.redirectUri,
        params.state?.slice(0, 1024) || null, scopesText(scopes), params.codeChallenge,
        resource,
      ],
    );
    const target = new URL(config.mcp.approvalUrl);
    target.hash = new URLSearchParams({ request }).toString();
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = await firstRow<{ code_challenge: string }>(pool,
      `SELECT code_challenge FROM mcp_oauth_grants
        WHERE code_hash = ? AND client_id = ? AND approved_at IS NOT NULL
          AND consumed_at IS NULL AND expires_at > NOW(3) LIMIT 1`,
      [tokenHash("code", authorizationCode), client.client_id],
    );
    if (!row) throw new InvalidGrantError("Invalid or expired authorization code");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return withTransaction(async (conn) => {
      const grant = await firstRow<GrantRow>(conn,
        `SELECT id, client_id, redirect_uri, state_value, scopes_value, code_challenge,
                resource_value, user_id
           FROM mcp_oauth_grants
          WHERE code_hash = ? AND client_id = ? AND approved_at IS NOT NULL
            AND consumed_at IS NULL AND expires_at > NOW(3) LIMIT 1 FOR UPDATE`,
        [tokenHash("code", authorizationCode), client.client_id],
      );
      if (!grant?.user_id) throw new InvalidGrantError("Invalid or expired authorization code");
      if (redirectUri && redirectUri !== grant.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
      if ((resource?.href || grant.resource_value) !== grant.resource_value) throw new InvalidGrantError("resource mismatch");
      await conn.query("UPDATE mcp_oauth_grants SET consumed_at = NOW(3) WHERE id = ?", [grant.id]);
      return issueTokenPair(conn, grant.client_id, grant.user_id, grant.scopes_value, grant.resource_value);
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return withTransaction(async (conn) => {
      const row = await firstRow<TokenRow & { id: string }>(conn,
        `SELECT id, client_id, user_id, scopes_value, resource_value,
                UNIX_TIMESTAMP(expires_at) AS expires_at_epoch
           FROM mcp_oauth_tokens
          WHERE token_hash = ? AND token_type = 'refresh' AND client_id = ?
            AND revoked_at IS NULL AND expires_at > NOW(3) LIMIT 1 FOR UPDATE`,
        [tokenHash("refresh", refreshToken), client.client_id],
      );
      if (!row) throw new InvalidGrantError("Invalid or expired refresh token");
      if (!(await authorizedTripUser(row.user_id))) throw new InvalidGrantError("Trip access has been revoked");
      const original = parsedScopes(row.scopes_value);
      const requested = scopes?.length ? validateScopes(scopes) : original;
      if (requested.some((scope) => !original.includes(scope))) throw new InvalidGrantError("Scope escalation is not allowed");
      if ((resource?.href || row.resource_value) !== row.resource_value) throw new InvalidGrantError("resource mismatch");
      await conn.query("UPDATE mcp_oauth_tokens SET revoked_at = NOW(3) WHERE id = ?", [row.id]);
      return issueTokenPair(conn, row.client_id, row.user_id, scopesText(requested), row.resource_value);
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await firstRow<TokenRow>(pool,
      `SELECT client_id, user_id, scopes_value, resource_value,
              UNIX_TIMESTAMP(expires_at) AS expires_at_epoch
         FROM mcp_oauth_tokens
        WHERE token_hash = ? AND token_type = 'access' AND revoked_at IS NULL
          AND expires_at > NOW(3) LIMIT 1`,
      [tokenHash("access", token)],
    );
    if (!row || row.resource_value !== config.mcp.resourceUrl || !(await authorizedTripUser(row.user_id))) {
      throw new InvalidGrantError("Invalid or expired access token");
    }
    return {
      token,
      clientId: row.client_id,
      scopes: parsedScopes(row.scopes_value),
      expiresAt: Number(row.expires_at_epoch),
      resource: new URL(row.resource_value),
      extra: { userId: row.user_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const raw = request.token;
    await pool.query(
      `UPDATE mcp_oauth_tokens SET revoked_at = NOW(3)
        WHERE client_id = ? AND revoked_at IS NULL AND token_hash IN (?, ?)`,
      [client.client_id, tokenHash("access", raw), tokenHash("refresh", raw)],
    );
  }
}

async function issueTokenPair(
  conn: import("mysql2/promise").PoolConnection,
  clientId: string,
  userId: string,
  scopes: string,
  resource: string,
): Promise<OAuthTokens> {
  const access = secret();
  const refresh = secret();
  await conn.query(
    `INSERT INTO mcp_oauth_tokens
       (id, token_hash, token_type, client_id, user_id, scopes_value, resource_value, expires_at)
     VALUES (?, ?, 'access', ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND)),
            (?, ?, 'refresh', ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? DAY))`,
    [
      newId("mot"), tokenHash("access", access), clientId, userId, scopes, resource,
      config.mcp.accessTokenTtlSeconds,
      newId("mot"), tokenHash("refresh", refresh), clientId, userId, scopes, resource,
      config.mcp.refreshTokenTtlDays,
    ],
  );
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: config.mcp.accessTokenTtlSeconds,
    scope: scopes,
  };
}

export const mcpOAuthProvider = new TabiPlanOAuthProvider();

const oauthApp = express();
oauthApp.set("trust proxy", 1);
oauthApp.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    resource: config.mcp.resourceUrl,
    authorization_servers: [config.mcp.issuerUrl + "/"],
    scopes_supported: [...MCP_SCOPES],
    resource_name: "香港・マカオ・金門旅行の費用",
    resource_documentation: "https://nagomen.github.io/tabi-plan/",
  });
});
oauthApp.use(mcpAuthRouter({
  provider: mcpOAuthProvider,
  issuerUrl: new URL(config.mcp.issuerUrl),
  resourceServerUrl: new URL(config.mcp.resourceUrl),
  scopesSupported: [...MCP_SCOPES],
  resourceName: "香港・マカオ・金門旅行の費用",
  serviceDocumentationUrl: new URL("https://nagomen.github.io/tabi-plan/"),
}));

export function isMcpOAuthPath(path: string): boolean {
  return [
    "/authorize", "/token", "/register", "/revoke",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ].includes(path);
}

export async function handleMcpOAuthHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    res.once("finish", resolve);
    oauthApp(
      req as unknown as Request,
      res as unknown as Response,
      (error?: unknown) => error ? reject(error) : resolve(),
    );
  });
}

async function authorizedTripUser(userId: string): Promise<boolean> {
  const row = await firstRow<{ ok: number }>(pool,
    `SELECT 1 AS ok FROM plans p
       JOIN plan_access_grants pag ON pag.plan_id = p.id AND pag.user_id = ?
      WHERE p.slug = ? AND p.deleted_at IS NULL AND p.source <> 'sample'
        AND pag.status = 'active' AND pag.role IN ('owner','editor') LIMIT 1`,
    [userId, TARGET_TRIP_SLUG],
  );
  return Boolean(row);
}

export async function inspectMcpApproval(request: string, userId: string): Promise<Record<string, unknown>> {
  if (!userId || !(await authorizedTripUser(userId))) throw new Forbidden("この旅行の費用を編集する権限がありません");
  const row = await firstRow<GrantRow & { client_name: string | null }>(pool,
    `SELECT g.id, g.client_id, g.redirect_uri, g.state_value, g.scopes_value,
            g.code_challenge, g.resource_value, g.user_id,
            JSON_UNQUOTE(JSON_EXTRACT(c.metadata_json, '$.client_name')) AS client_name
       FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.client_id = g.client_id
      WHERE g.request_hash = ? AND g.approved_at IS NULL AND g.consumed_at IS NULL
        AND g.expires_at > NOW(3) LIMIT 1`,
    [tokenHash("request", request)],
  );
  if (!row) throw new BadRequest("接続リクエストの期限が切れています。ChatGPTからやり直してください");
  return {
    clientName: row.client_name || "ChatGPT",
    tripName: "香港・マカオ・金門旅行",
    scopes: parsedScopes(row.scopes_value),
  };
}

export async function decideMcpApproval(
  request: string,
  userId: string,
  approved: boolean,
): Promise<{ redirect: string }> {
  if (!userId || !(await authorizedTripUser(userId))) throw new Forbidden("この旅行の費用を編集する権限がありません");
  return withTransaction(async (conn) => {
    const row = await firstRow<GrantRow>(conn,
      `SELECT id, client_id, redirect_uri, state_value, scopes_value, code_challenge,
              resource_value, user_id
         FROM mcp_oauth_grants
        WHERE request_hash = ? AND approved_at IS NULL AND consumed_at IS NULL
          AND expires_at > NOW(3) LIMIT 1 FOR UPDATE`,
      [tokenHash("request", request)],
    );
    if (!row) throw new BadRequest("接続リクエストの期限が切れています。ChatGPTからやり直してください");
    const target = new URL(row.redirect_uri);
    if (!approved) {
      await conn.query("UPDATE mcp_oauth_grants SET consumed_at = NOW(3) WHERE id = ?", [row.id]);
      target.searchParams.set("error", "access_denied");
    } else {
      const code = secret();
      await conn.query(
        "UPDATE mcp_oauth_grants SET user_id = ?, code_hash = ?, approved_at = NOW(3) WHERE id = ?",
        [userId, tokenHash("code", code), row.id],
      );
      target.searchParams.set("code", code);
    }
    if (row.state_value) target.searchParams.set("state", row.state_value);
    return { redirect: target.href };
  });
}

export async function authenticateMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<AuthInfo | null> {
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const metadata = `${config.mcp.issuerUrl}/.well-known/oauth-protected-resource/mcp`;
  if (!match) {
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer resource_metadata="${metadata}"`,
    });
    res.end(JSON.stringify({ error: "invalid_token", error_description: "Authorization is required" }));
    return null;
  }
  try {
    const auth = await mcpOAuthProvider.verifyAccessToken(match[1]);
    if (!auth.scopes.includes(MCP_READ_SCOPE)) throw new Error("scope");
    return auth;
  } catch {
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}"`,
    });
    res.end(JSON.stringify({ error: "invalid_token", error_description: "Token is invalid or expired" }));
    return null;
  }
}
