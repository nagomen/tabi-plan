// フロントエンド起動時に必要な、認可済みデータ一式を1往復で組み立てる。
import { all, inClause } from "./db.js";
import type { Bootstrap, ExpenseRow, ExpenseShareRow, PlanMemberRow, PlanRow, SettlementRow } from "./types.js";

export async function bootstrapForUser(userId = ""): Promise<Bootstrap> {
  const actorJoin = userId
    ? "LEFT JOIN plan_members pm ON pm.plan_id = p.id AND pm.user_id = ? AND pm.status = 'active'"
    : "";
  const actorParams = userId ? [userId] : [];
  const publicPredicate = "(p.visibility = 'public' AND p.status = 'published')";
  // open_editing は公開済み計画の本文をログイン利用者が編集するための権限。
  // メンバー・費用・精算を含むワークスペース情報は正式な参加者だけに返す。
  const memberPredicate = userId ? "pm.user_id IS NOT NULL" : "FALSE";
  const collaborativePredicate = userId
    ? "(p.open_editing = 1 AND p.visibility = 'public' AND p.status = 'published')"
    : "FALSE";
  const visibleWhere = `p.deleted_at IS NULL AND (${publicPredicate} OR ${memberPredicate} OR ${collaborativePredicate})`;
  const workspaceWhere = `p.deleted_at IS NULL AND ${memberPredicate}`;

  const [plans, workspaceRows, credentials, friendships, pendingInvites] = await Promise.all([
    all<PlanRow>(`SELECT p.id, p.slug, p.title, p.note, p.start_date, p.end_date, p.dates_label, p.cover_url,
           p.base_currency, p.source, p.visibility, p.status, p.version, p.open_editing, p.owner_user_id,
           p.external_spreadsheet_id, p.external_apps_script_url, p.external_schema,
           p.created_at, p.updated_at
         FROM plans p ${actorJoin}
         WHERE ${visibleWhere}
         ORDER BY p.created_at`, actorParams),
    all<{ id: string }>(`SELECT p.id FROM plans p ${actorJoin} WHERE ${workspaceWhere}`, actorParams),
    userId ? all("SELECT user_id, email FROM user_credentials WHERE user_id = ?", [userId]) : [],
    userId
      ? all(`SELECT id, user_low_id, user_high_id, requested_by_id, status, created_at, responded_at
         FROM friendships WHERE user_low_id = ? OR user_high_id = ?`, [userId, userId])
      : [],
    userId
      ? all<Bootstrap["pendingInvites"][number]>(`SELECT i.id, i.plan_id, p.slug AS plan_slug, p.title AS plan_title,
             i.role, i.invited_name, i.created_at, i.expires_at
           FROM plan_invites i
           JOIN plans p ON p.id = i.plan_id AND p.deleted_at IS NULL
          WHERE i.invited_user_id = ? AND i.status = 'pending'
            AND (i.expires_at IS NULL OR i.expires_at > CURRENT_TIMESTAMP)
          ORDER BY i.created_at DESC`, [userId])
      : [],
  ]);

  const visiblePlanIds = plans.map((plan) => plan.id);
  const workspacePlanIdSet = new Set(workspaceRows.map((row) => row.id));
  const workspacePlanIds = visiblePlanIds.filter((id) => workspacePlanIdSet.has(id));
  const publicOnlyPlanIds = visiblePlanIds.filter((id) => !workspacePlanIdSet.has(id));

  const visibleIn = inClause(visiblePlanIds);
  const [itinerary, cities, views] = visiblePlanIds.length
    ? await Promise.all([
      all<Bootstrap["itinerary"][number]>(`SELECT id, plan_id, item_date, day_index, sort_order, kind, start_time, title, place,
           area, note, map_query, lat, lng, from_place, to_place, transport, duration_minutes
         FROM itinerary_items
         WHERE plan_id IN (${visibleIn.sql})
         ORDER BY plan_id, item_date, sort_order`, visibleIn.params),
      all<Bootstrap["cities"][number]>(`SELECT id, plan_id, name, sort_order FROM plan_cities
         WHERE plan_id IN (${visibleIn.sql})
         ORDER BY plan_id, sort_order`, visibleIn.params),
      all<Bootstrap["views"][number]>(`SELECT plan_id, CAST(SUM(view_count) AS SIGNED) AS view_count FROM plan_view_daily
         WHERE plan_id IN (${visibleIn.sql})
         GROUP BY plan_id`, visibleIn.params),
    ])
    : [[], [], []];

  const workspaceIn = inClause(workspacePlanIds);
  const [members, checklist, candidates, expenses, expenseShares, settlements] = workspacePlanIds.length
    ? await Promise.all([
      all<PlanMemberRow>(`SELECT plan_id, user_id, role, status FROM plan_members
         WHERE status = 'active' AND plan_id IN (${workspaceIn.sql})`, workspaceIn.params),
      all<Bootstrap["checklist"][number]>(`SELECT id, plan_id, label, status, sort_order FROM plan_checklist_items
         WHERE plan_id IN (${workspaceIn.sql})
         ORDER BY plan_id, sort_order`, workspaceIn.params),
      all<Bootstrap["candidates"][number]>(`SELECT id, plan_id, title, place, proposed_by_id, adopted_at FROM plan_candidates
         WHERE plan_id IN (${workspaceIn.sql})
         ORDER BY plan_id, created_at`, workspaceIn.params),
      all<ExpenseRow>(`SELECT id, plan_id, paid_on, payer_user_id, category, title, amount_minor, currency,
           fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url,
           created_at, deleted_at
         FROM expenses
         WHERE plan_id IN (${workspaceIn.sql})
         ORDER BY plan_id, created_at`, workspaceIn.params),
      all<ExpenseShareRow>(`SELECT s.expense_id, s.user_id, s.amount_base_minor FROM expense_shares s
         JOIN expenses e ON e.id = s.expense_id
         WHERE e.plan_id IN (${workspaceIn.sql})`, workspaceIn.params),
      all<SettlementRow>(`SELECT id, plan_id, from_user_id, to_user_id, amount_base_minor, note, settled_at, deleted_at
         FROM settlements
         WHERE deleted_at IS NULL AND plan_id IN (${workspaceIn.sql})
         ORDER BY plan_id, settled_at`, workspaceIn.params),
    ])
    : [[], [], [], [], [], []];

  const candidateIn = inClause(candidates.map((candidate) => String(candidate.id)));
  const candidateVotes = candidates.length
    ? await all(`SELECT candidate_id, user_id FROM plan_candidate_votes WHERE candidate_id IN (${candidateIn.sql})`, candidateIn.params)
    : [];

  const publicOnlyIn = inClause(publicOnlyPlanIds);
  const linkClauses: string[] = [];
  const linkParams: string[] = [];
  if (workspacePlanIds.length) {
    linkClauses.push(`plan_id IN (${workspaceIn.sql})`);
    linkParams.push(...workspaceIn.params);
  }
  if (publicOnlyPlanIds.length) {
    linkClauses.push(`(plan_id IN (${publicOnlyIn.sql}) AND link_key IN ('itinerary', 'maps', 'photos'))`);
    linkParams.push(...publicOnlyIn.params);
  }
  const links = linkClauses.length
    ? await all(`SELECT id, plan_id, link_key, label, url, caption, sort_order FROM plan_links
         WHERE ${linkClauses.join(" OR ")}
         ORDER BY plan_id, sort_order`, linkParams)
    : [];

  const workspaceUserIds = new Set<string>();
  for (const member of members as PlanMemberRow[]) workspaceUserIds.add(member.user_id);
  for (const expense of expenses as ExpenseRow[]) workspaceUserIds.add(expense.payer_user_id);
  for (const share of expenseShares as ExpenseShareRow[]) workspaceUserIds.add(share.user_id);
  for (const settlement of settlements as SettlementRow[]) {
    workspaceUserIds.add(settlement.from_user_id);
    workspaceUserIds.add(settlement.to_user_id);
  }
  if (userId) workspaceUserIds.add(userId);

  const visibleUserIds = new Set(workspaceUserIds);
  for (const plan of plans) {
    if (plan.owner_user_id) visibleUserIds.add(plan.owner_user_id);
  }
  for (const friendship of friendships as Bootstrap["friendships"]) {
    visibleUserIds.add(friendship.user_low_id);
    visibleUserIds.add(friendship.user_high_id);
  }

  const visibleUserIn = inClause([...visibleUserIds]);
  const users = visibleUserIds.size
    ? await all(`SELECT id, display_name FROM users WHERE id IN (${visibleUserIn.sql}) ORDER BY created_at`, visibleUserIn.params)
    : [];

  const paymentUserIn = inClause([...workspaceUserIds]);
  const paymentLinks = workspaceUserIds.size
    ? await all(`SELECT user_id, provider, handle FROM user_payment_links WHERE user_id IN (${paymentUserIn.sql})`, paymentUserIn.params)
    : [];

  const userSettings = visibleUserIds.size
    ? await all<Bootstrap["userSettings"][number]>(
      `SELECT user_id, history_public FROM user_settings WHERE user_id IN (${visibleUserIn.sql})`,
      visibleUserIn.params,
    )
    : [];

  return {
    users, credentials, plans, members, itinerary, cities, links, checklist,
    candidates, candidateVotes, expenses, expenseShares, settlements, views,
    paymentLinks, userSettings, friendships, pendingInvites,
  } as Bootstrap;
}
