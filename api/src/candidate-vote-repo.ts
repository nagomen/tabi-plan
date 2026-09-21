import type mysql from "mysql2/promise";
import { firstRow, type Row, withTransaction } from "./db.js";
import { BadRequest, Forbidden } from "./errors.js";
import { newId } from "./ids.js";

interface SlotCandidate {
  id: string;
  title: string;
  place: string | null;
  slot_id: string;
  item_date: string | null;
  start_time: string | null;
  kind: string | null;
  duration_minutes: number | null;
  lat: number | null;
  lng: number | null;
  note: string | null;
  member_ids: string | null;
  adopted_at: string | null;
}

interface SlotContext {
  ownerUserId: string | null;
  candidates: SlotCandidate[];
  eligibleIds: string[];
}

export interface CandidateVoteResult {
  resolved: boolean;
  readyToFinalize: boolean;
  tied: boolean;
  winnerCandidateId: string | null;
  votedCount: number;
  eligibleCount: number;
}

function parsedMemberIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
  } catch { return []; }
}

async function loadSlotContext(
  conn: mysql.PoolConnection,
  planId: string,
  slotId: string,
): Promise<SlotContext> {
  const plan = await firstRow<{ owner_user_id: string | null }>(
    conn,
    "SELECT owner_user_id FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
    [planId],
  );
  if (!plan) throw new BadRequest("旅行計画が見つかりません");

  const [rows] = await conn.query<Row[]>(
    `SELECT id, title, place, slot_id, item_date, start_time, kind, duration_minutes, lat, lng, note, member_ids, adopted_at
       FROM plan_candidates
      WHERE plan_id = ? AND slot_id = ? FOR UPDATE`,
    [planId, slotId],
  );
  const candidates = rows as unknown as SlotCandidate[];
  if (candidates.length < 2) throw new BadRequest("この投票枠には選べる候補がありません");

  const scopeIds = parsedMemberIds(candidates[0].member_ids);
  const scopeSql = scopeIds.length ? `AND pm.user_id IN (${scopeIds.map(() => "?").join(",")})` : "";
  const [memberRows] = await conn.query<Row[]>(
    `SELECT pm.user_id
       FROM plan_members pm
       JOIN plans p ON p.id = pm.plan_id
       LEFT JOIN plan_access_grants pag
         ON pag.plan_id = pm.plan_id AND pag.user_id = pm.user_id AND pag.status = 'active'
      WHERE pm.plan_id = ? AND pm.status = 'active'
        AND (pm.user_id = p.owner_user_id OR pag.user_id IS NOT NULL)
        AND (? IS NULL OR pm.from_date IS NULL OR pm.from_date <= ?)
        AND (? IS NULL OR pm.to_date IS NULL OR pm.to_date >= ?)
        ${scopeSql}
      FOR UPDATE`,
    [planId, candidates[0].item_date, candidates[0].item_date, candidates[0].item_date, candidates[0].item_date, ...scopeIds],
  );
  return {
    ownerUserId: plan.owner_user_id,
    candidates,
    eligibleIds: [...new Set((memberRows as unknown as { user_id: string }[]).map((row) => row.user_id))],
  };
}

async function voteState(
  conn: mysql.PoolConnection,
  planId: string,
  slotId: string,
  candidates: SlotCandidate[],
  eligibleIds: string[],
): Promise<CandidateVoteResult> {
  if (!eligibleIds.length) {
    return {
      resolved: false, readyToFinalize: false, tied: false, winnerCandidateId: null,
      votedCount: 0, eligibleCount: 0,
    };
  }
  const eligibleIn = eligibleIds.map(() => "?").join(",");
  const [voteRows] = await conn.query<Row[]>(
    `SELECT v.candidate_id, v.user_id
       FROM plan_candidate_votes v
       JOIN plan_candidates c ON c.id = v.candidate_id
      WHERE c.plan_id = ? AND c.slot_id = ? AND v.user_id IN (${eligibleIn})
      FOR UPDATE`,
    [planId, slotId, ...eligibleIds],
  );
  const votes = voteRows as unknown as { candidate_id: string; user_id: string }[];
  const voters = new Set(votes.map((vote) => vote.user_id));
  const counts = new Map<string, number>();
  votes.forEach((vote) => counts.set(vote.candidate_id, (counts.get(vote.candidate_id) || 0) + 1));
  const maxVotes = Math.max(0, ...candidates.map((candidate) => counts.get(candidate.id) || 0));
  const leaders = candidates.filter((candidate) => (counts.get(candidate.id) || 0) === maxVotes);
  const allVoted = voters.size === eligibleIds.length;
  const uniqueLeader = allVoted && leaders.length === 1 ? leaders[0] : null;
  return {
    resolved: false,
    readyToFinalize: Boolean(uniqueLeader),
    tied: allVoted && !uniqueLeader,
    winnerCandidateId: uniqueLeader?.id || null,
    votedCount: voters.size,
    eligibleCount: eligibleIds.length,
  };
}

/** 一つの時間枠につき一人一票。全員投票後も、マスターが終了するまでは選択を変更できる。 */
export async function voteForCandidateSlot(
  planId: string,
  slotId: string,
  candidateId: string,
  actorUserId: string,
): Promise<CandidateVoteResult> {
  if (!actorUserId) throw new BadRequest("投票するにはログインしてください");
  if (!slotId || !candidateId) throw new BadRequest("投票する候補を選んでください");

  return withTransaction(async (conn) => {
    const context = await loadSlotContext(conn, planId, slotId);
    const selected = context.candidates.find((candidate) => candidate.id === candidateId);
    if (!selected) throw new BadRequest("選択した候補が最新ではありません");
    if (!context.eligibleIds.includes(actorUserId)) throw new BadRequest("この候補枠の投票対象メンバーではありません");
    if (context.candidates.some((candidate) => candidate.adopted_at)) {
      throw new BadRequest("この投票はすでに終了しています");
    }

    await conn.query(
      `DELETE v FROM plan_candidate_votes v
        JOIN plan_candidates c ON c.id = v.candidate_id
       WHERE c.plan_id = ? AND c.slot_id = ? AND v.user_id = ?`,
      [planId, slotId, actorUserId],
    );
    await conn.query(
      "INSERT INTO plan_candidate_votes (candidate_id, user_id) VALUES (?, ?)",
      [candidateId, actorUserId],
    );
    await conn.query("UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
    return voteState(conn, planId, slotId, context.candidates, context.eligibleIds);
  });
}

/** 全員の投票後、旅行マスターだけが単独最多の候補を通常予定へ確定できる。 */
export async function finalizeCandidateSlot(
  planId: string,
  slotId: string,
  actorUserId: string,
): Promise<CandidateVoteResult> {
  if (!actorUserId) throw new Forbidden("投票を終了できるのは旅行マスターだけです");

  return withTransaction(async (conn) => {
    const context = await loadSlotContext(conn, planId, slotId);
    if (context.ownerUserId !== actorUserId) {
      throw new Forbidden("投票を終了できるのは旅行マスターだけです");
    }
    const adopted = context.candidates.find((candidate) => candidate.adopted_at);
    if (adopted) {
      return {
        resolved: true, readyToFinalize: false, tied: false, winnerCandidateId: adopted.id,
        votedCount: context.eligibleIds.length, eligibleCount: context.eligibleIds.length,
      };
    }

    const state = await voteState(conn, planId, slotId, context.candidates, context.eligibleIds);
    if (state.votedCount < state.eligibleCount) {
      throw new BadRequest("全員の投票が終わるまで終了できません");
    }
    if (state.tied || !state.winnerCandidateId) {
      throw new BadRequest("同票です。誰かが投票を変更して単独最多になってから終了してください");
    }
    const winner = context.candidates.find((candidate) => candidate.id === state.winnerCandidateId);
    if (!winner) throw new BadRequest("最多票の候補が見つかりません");

    const confirmedNote = winner.note
      ? `${winner.note}\nみんなの投票で確定`
      : "みんなの投票で確定";
    const sort = await firstRow<{ next_order: number }>(
      conn,
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM itinerary_items WHERE plan_id = ? AND item_date <=> ?",
      [planId, winner.item_date],
    );
    await conn.query(
      `INSERT INTO itinerary_items (id, plan_id, item_date, day_index, sort_order, kind, start_time,
         title, place, note, map_query, lat, lng, duration_minutes, member_ids)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("itm"), planId, winner.item_date, Number(sort?.next_order || 0), winner.kind || "todo",
        winner.start_time, winner.title, winner.place, confirmedNote, winner.place || winner.title, winner.lat, winner.lng,
        winner.duration_minutes, winner.member_ids,
      ],
    );
    await conn.query(
      "UPDATE plan_candidates SET adopted_at = CASE WHEN id = ? THEN CURRENT_TIMESTAMP ELSE NULL END WHERE plan_id = ? AND slot_id = ?",
      [winner.id, planId, slotId],
    );
    await conn.query("UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
    return {
      ...state,
      resolved: true,
      readyToFinalize: false,
    };
  });
}
