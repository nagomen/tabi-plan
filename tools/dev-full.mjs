#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { persistentDevSessionSecret } from "./dev-session-secret.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: npm run dev:full

Starts the MySQL SSH tunnel, local API, TypeScript watcher, and Vite frontend.

Environment:
  ENV_FILE                 API environment file (default: .env)
  LOCAL_DB_SSH_TARGET      SSH target, e.g. ubuntu@YOUR_VPS_HOST (set in .env)
  LOCAL_DB_SSH_PORT        SSH port (default: 22)
  LOCAL_DB_REMOTE_HOST     MySQL host seen from the VPS (default: 127.0.0.1)
  LOCAL_DB_REMOTE_PORT     MySQL port seen from the VPS (default: 3306)
  LOCAL_DB_TUNNEL          Set to 0 when DB_HOST/DB_PORT is already reachable
  LOCAL_DB_AUTO_MIGRATE    Set to 0 to skip the idempotent schema migration
  LOCAL_FRONTEND_PORT      Vite port (default: 5173)
  LOCAL_SESSION_SECRET_FILE  Persistent dev secret file (default: .env.local-session-secret)
`);
  process.exit(0);
}

function parseEnvFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function command(name, commandPath, commandArgs, options = {}) {
  console.log(`[dev:full] ${name}`);
  const child = spawn(commandPath, commandArgs, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(`[dev:full] ${name} を起動できません: ${error.message}`);
  });
  return child;
}

function waitForExit(child, name) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ name, code, signal }));
  });
}

function runOnce(name, commandPath, commandArgs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = command(name, commandPath, commandArgs, options);
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${name} が終了しました (code=${code ?? "-"}, signal=${signal ?? "-"})`));
    });
  });
}

function canConnect(host, port, timeoutMs = 700) {
  return new Promise((resolveConnection) => {
    const socket = net.createConnection({ host, port });
    const finish = (connected) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(host, port, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${label} (${host}:${port}) に接続できません`);
}

async function availableFrontendPort(preferredPort) {
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    if (!(await canConnect("localhost", port))) return port;
  }
  throw new Error(`フロントエンド用ポート ${preferredPort}〜${preferredPort + 19} がすべて使用中です`);
}

async function waitForHealth(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw new Error(`API health check に失敗しました: ${lastError}`);
}

const envFile = resolve(rootDir, process.env.ENV_FILE || ".env");
if (!existsSync(envFile)) {
  console.error(`[dev:full] ${envFile} がありません。.env.sample をコピーして接続情報を設定してください。`);
  process.exit(1);
}

const fileEnv = parseEnvFile(envFile);
// 明示的に渡した環境変数で .env の値を一時上書きできるようにする。
const apiEnv = { ...fileEnv, ...process.env };
for (const name of ["DB_USER", "DB_PASSWORD", "DB_NAME", "API_TOKEN"]) {
  if (!apiEnv[name]) {
    console.error(`[dev:full] ${name} が ${envFile} に設定されていません。`);
    process.exit(1);
  }
}

if (!apiEnv.SESSION_SECRET) {
  const secretFile = resolve(rootDir, apiEnv.LOCAL_SESSION_SECRET_FILE || ".env.local-session-secret");
  apiEnv.SESSION_SECRET = persistentDevSessionSecret(secretFile);
  console.warn(`[dev:full] SESSION_SECRET が未設定のため、端末内の開発用秘密値を使います: ${secretFile}`);
}

const apiHost = apiEnv.HOST || "127.0.0.1";
const apiPort = Number(apiEnv.PORT || 8001);
const dbHost = apiEnv.DB_HOST || "127.0.0.1";
const dbPort = Number(apiEnv.DB_PORT || 3310);
const preferredFrontendPort = Number(apiEnv.LOCAL_FRONTEND_PORT || 5173);
const frontendPort = await availableFrontendPort(preferredFrontendPort);
const tunnelEnabled = apiEnv.LOCAL_DB_TUNNEL !== "0";
const children = [];
let shuttingDown = false;

function stopAll(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.toReversed()) {
    if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 250).unref();
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

try {
  if (frontendPort !== preferredFrontendPort) {
    console.log(`[dev:full] localhost:${preferredFrontendPort} は使用中のため ${frontendPort} を使います。`);
  }
  if (await canConnect(apiHost, apiPort)) {
    throw new Error(`APIポート ${apiHost}:${apiPort} は既に使用中です。既存のAPIを終了してから再実行してください`);
  }

  if (tunnelEnabled) {
    if (await canConnect(dbHost, dbPort)) {
      console.log(`[dev:full] 既存のDB接続を再利用します: ${dbHost}:${dbPort}`);
    } else {
      const sshTarget = apiEnv.LOCAL_DB_SSH_TARGET;
      if (!sshTarget) {
        throw new Error("LOCAL_DB_SSH_TARGET が未設定です。.env に ubuntu@<VPSホスト> を設定するか、LOCAL_DB_TUNNEL=0 で直接接続してください");
      }
      const sshPort = apiEnv.LOCAL_DB_SSH_PORT || "22";
      const remoteHost = apiEnv.LOCAL_DB_REMOTE_HOST || "127.0.0.1";
      const remotePort = apiEnv.LOCAL_DB_REMOTE_PORT || "3306";
      const tunnel = command("MySQL SSHトンネルを起動", "ssh", [
        "-N", "-T",
        "-p", String(sshPort),
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-L", `${dbPort}:${remoteHost}:${remotePort}`,
        sshTarget,
      ]);
      children.push(tunnel);
      await Promise.race([
        waitForPort(dbHost, dbPort, "MySQL SSHトンネル"),
        waitForExit(tunnel, "SSHトンネル").then(({ code, signal }) => {
          throw new Error(`SSHトンネルが終了しました (code=${code ?? "-"}, signal=${signal ?? "-"})`);
        }),
      ]);
    }
  } else {
    await waitForPort(dbHost, dbPort, "MySQL");
  }

  if (apiEnv.LOCAL_DB_AUTO_MIGRATE !== "0") {
    await runOnce("DBスキーマを更新", process.execPath, [
      resolve(rootDir, "api/scripts/migrate.mjs"),
    ], { env: apiEnv });
  } else {
    console.warn("[dev:full] DBマイグレーションをスキップします。");
  }

  const tscPath = resolve(rootDir, "node_modules/.bin/tsc");
  const vitePath = resolve(rootDir, "node_modules/.bin/vite");
  // watcherの初回コンパイルで起動直後のAPIが再起動し、Vite proxyが一瞬
  // ECONNREFUSEDになるのを避ける。buildとwatchで同じincremental情報を共有する。
  const incrementalArgs = ["--incremental", "--tsBuildInfoFile", "api/dist/.tsbuildinfo"];
  await runOnce("APIをビルド", tscPath, ["-p", "api/tsconfig.json", ...incrementalArgs], { env: apiEnv });

  const typeWatcher = command("APIの型変更を監視", tscPath, [
    "-p", "api/tsconfig.json", "--watch", "--preserveWatchOutput", ...incrementalArgs,
  ], { env: apiEnv });
  children.push(typeWatcher);

  const apiServer = command("ローカルAPIを起動", process.execPath, [
    "--watch", resolve(rootDir, "api/dist/server.js"),
  ], { env: apiEnv });
  children.push(apiServer);
  await Promise.race([
    waitForHealth(`http://${apiHost}:${apiPort}/api/health`),
    waitForExit(apiServer, "ローカルAPI").then(({ code, signal }) => {
      throw new Error(`ローカルAPIが終了しました (code=${code ?? "-"}, signal=${signal ?? "-"})`);
    }),
  ]);

  const frontendEnv = {
    ...process.env,
    LOCAL_API_PROXY_TARGET: `http://${apiHost}:${apiPort}`,
  };
  const frontend = command("フロントエンドを起動", vitePath, [
    "--host", "localhost", "--port", String(frontendPort), "--strictPort",
  ], { cwd: resolve(rootDir, "frontend"), env: frontendEnv });
  children.push(frontend);

  console.log(`[dev:full] 起動完了: http://localhost:${frontendPort}/plans.html`);
  const ended = await Promise.race([
    waitForExit(typeWatcher, "TypeScript watcher"),
    waitForExit(apiServer, "ローカルAPI"),
    waitForExit(frontend, "フロントエンド"),
  ]);
  if (!shuttingDown) {
    console.error(`[dev:full] ${ended.name} が終了しました (code=${ended.code ?? "-"}, signal=${ended.signal ?? "-"})`);
    stopAll(ended.code || 1);
  }
} catch (error) {
  console.error(`[dev:full] ${error instanceof Error ? error.message : String(error)}`);
  stopAll(1);
}
