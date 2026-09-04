#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const API_WORKFLOW = "deploy-api.yml";
const FRONTEND_WORKFLOW = "deploy-pages.yml";
const FRONTEND_URL = (process.env.PRODUCTION_FRONTEND_URL || "https://nagomen.github.io/tabi-plan").replace(/\/+$/, "");
const API_URL = (process.env.PRODUCTION_API_URL || "https://travel-api.vote-jt.com").replace(/\/+$/, "");
const POLL_INTERVAL_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 90_000;
const DEPLOY_TIMEOUT_MS = 30 * 60_000;

function usage() {
  console.log(`本番のAPIとフロントエンドをまとめてデプロイします。

使い方:
  npm run deploy:production

前提:
  - GitHub CLI (gh) でログイン済み
  - main ブランチにいる
  - 作業ツリーがクリーン
  - ローカルHEADがorigin/mainと一致している`);
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function ghJson(args) {
  const output = capture("gh", args);
  return JSON.parse(output || "null");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertReady() {
  run("gh", ["auth", "status"]);

  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error(`main ブランチで実行してください（現在: ${branch || "detached HEAD"}）。`);
  }

  const changes = capture("git", ["status", "--porcelain"]);
  if (changes) {
    throw new Error("未コミットの変更があります。コミットまたは退避してから実行してください。");
  }

  const headSha = capture("git", ["rev-parse", "HEAD"]);
  const repository = capture("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const remoteSha = capture("gh", ["api", `repos/${repository}/git/ref/heads/main`, "--jq", ".object.sha"]);
  if (headSha !== remoteSha) {
    throw new Error("ローカルHEADがorigin/mainと一致しません。pushまたはpullしてから実行してください。");
  }

  return headSha;
}

function listWorkflowRuns(workflow) {
  return ghJson([
    "run", "list",
    "--workflow", workflow,
    "--event", "workflow_dispatch",
    "--branch", "main",
    "--limit", "20",
    "--json", "databaseId,headSha,status,conclusion,url",
  ]);
}

async function discoverRun(workflow, headSha, previousIds) {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const runInfo = listWorkflowRuns(workflow).find(
        (candidate) => candidate.headSha === headSha && !previousIds.has(candidate.databaseId),
      );
      if (runInfo) return runInfo;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`${workflow} の実行IDを取得できませんでした。${lastError ? ` 最後のエラー: ${lastError.message}` : ""}`);
}

async function waitForDeployments(runs) {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    try {
      const states = runs.map((runInfo) => ghJson([
        "run", "view", String(runInfo.databaseId), "--json", "status,conclusion,url",
      ]));
      consecutiveErrors = 0;

      for (let index = 0; index < states.length; index += 1) {
        const state = states[index];
        if (state.status === "completed" && state.conclusion !== "success") {
          throw new Error(`${runs[index].name} が ${state.conclusion || "失敗"} で終了しました: ${state.url}`);
        }
      }

      if (states.every((state) => state.status === "completed" && state.conclusion === "success")) {
        return states;
      }

      console.log(states.map((state, index) => `${runs[index].name}: ${state.status}`).join(" / "));
    } catch (error) {
      if (error.message.includes("で終了しました")) throw error;
      consecutiveErrors += 1;
      console.warn(`GitHub Actionsの状態取得に失敗しました（${consecutiveErrors}/12）。再試行します。`);
      if (consecutiveErrors >= 12) throw error;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("デプロイが30分以内に完了しませんでした。GitHub Actionsを確認してください。");
}

async function verifyProduction(headSha) {
  const deploymentResponse = await fetch(`${FRONTEND_URL}/deployment.json?verify=${Date.now()}`, {
    headers: { "Cache-Control": "no-cache" },
  });
  if (!deploymentResponse.ok) {
    throw new Error(`公開フロントの確認に失敗しました（HTTP ${deploymentResponse.status}）。`);
  }
  const deployment = await deploymentResponse.json();
  if (deployment.commit !== headSha) {
    throw new Error(`公開フロントのコミットが不一致です（期待: ${headSha}, 実際: ${deployment.commit || "不明"}）。`);
  }

  for (const path of ["/api/ai/itinerary", "/api/ai/itinerary-options"]) {
    const response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.status !== 401) {
      throw new Error(`${path} の疎通確認が想定外です（HTTP ${response.status}、期待: 401）。`);
    }
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }

  console.log("本番デプロイの前提条件を確認しています…");
  const headSha = assertReady();
  const workflows = [
    { name: "API", file: API_WORKFLOW, dispatchArgs: ["-f", "ref=main"] },
    { name: "Frontend", file: FRONTEND_WORKFLOW, dispatchArgs: [] },
  ];
  const previousRunIds = new Map(
    workflows.map(({ file }) => [file, new Set(listWorkflowRuns(file).map(({ databaseId }) => databaseId))]),
  );

  console.log(`コミット ${headSha.slice(0, 7)} のAPI・フロントデプロイを開始します…`);
  for (const workflow of workflows) {
    run("gh", ["workflow", "run", workflow.file, ...workflow.dispatchArgs]);
  }

  const discovered = await Promise.all(workflows.map(async (workflow) => ({
    ...await discoverRun(workflow.file, headSha, previousRunIds.get(workflow.file)),
    name: workflow.name,
  })));
  for (const runInfo of discovered) console.log(`${runInfo.name}: ${runInfo.url}`);

  await waitForDeployments(discovered);
  console.log("GitHub Actionsは両方成功しました。本番を検証しています…");
  await verifyProduction(headSha);
  console.log(`本番デプロイ完了: ${headSha}`);
}

main().catch((error) => {
  console.error(`本番デプロイ失敗: ${error.message}`);
  process.exitCode = 1;
});
