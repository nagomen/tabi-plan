import { all } from "./db.js";
import {
  canEditPlanPolicy,
  canEditWorkspaceRole,
  canManagePlanRole,
  canViewPlanPolicy,
  type PlanRole,
} from "./policy.js";

interface PlanAccessRow {
  visibility: "public" | "invite";
  status: "draft" | "published";
  open_editing: 0 | 1;
  role: Exclude<PlanRole, null> | null;
}

export interface PlanAccess {
  exists: boolean;
  role: PlanRole;
  canManage: boolean;
  canEditWorkspace: boolean;
  canEdit: boolean;
  canView: boolean;
}

/** 計画情報と参加者ロールを一度だけ読み、同一リクエスト内の認可判定へ再利用する。 */
export async function getPlanAccess(planId: string, userId: string): Promise<PlanAccess> {
  const rows = await all<PlanAccessRow>(
    `SELECT p.visibility, p.status, p.open_editing, pm.role
       FROM plans p
       LEFT JOIN plan_members pm
         ON pm.plan_id = p.id AND pm.user_id = ? AND pm.status = 'active'
      WHERE p.id = ? AND p.deleted_at IS NULL
      LIMIT 1`,
    [userId || "", planId],
  );
  const plan = rows[0];
  if (!plan) {
    return {
      exists: false,
      role: null,
      canManage: false,
      canEditWorkspace: false,
      canEdit: false,
      canView: false,
    };
  }

  const role = plan.role || null;
  const context = {
    role,
    loggedIn: Boolean(userId),
    visibility: plan.visibility,
    status: plan.status,
    openEditing: Boolean(plan.open_editing),
  };
  return {
    exists: true,
    role,
    canManage: canManagePlanRole(role),
    canEditWorkspace: canEditWorkspaceRole(role),
    canEdit: canEditPlanPolicy(context),
    canView: canViewPlanPolicy(context),
  };
}

export async function planRole(planId: string, userId: string): Promise<PlanRole> {
  return (await getPlanAccess(planId, userId)).role;
}

export async function canManagePlan(planId: string, userId: string): Promise<boolean> {
  return (await getPlanAccess(planId, userId)).canManage;
}

export async function canEditPlanWorkspace(planId: string, userId: string): Promise<boolean> {
  return (await getPlanAccess(planId, userId)).canEditWorkspace;
}

export async function canEditPlan(planId: string, userId: string): Promise<boolean> {
  return (await getPlanAccess(planId, userId)).canEdit;
}

export async function canViewPlan(planId: string, userId: string): Promise<boolean> {
  return (await getPlanAccess(planId, userId)).canView;
}
