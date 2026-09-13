export type PlanRole = "owner" | "editor" | "viewer" | null;

export interface PlanAccessContext {
  role: PlanRole;
  loggedIn: boolean;
  visibility: "public" | "invite";
  status: "draft" | "published";
  openEditing: boolean;
}

export function canManagePlanRole(role: PlanRole): boolean {
  return role === "owner";
}

export function canEditWorkspaceRole(role: PlanRole): boolean {
  return role === "owner" || role === "editor";
}

export function canViewPlanPolicy(context: PlanAccessContext): boolean {
  if (context.role) return true;
  return context.visibility === "public" && context.status === "published";
}

export function canEditPlanPolicy(context: PlanAccessContext): boolean {
  // 招待を受諾して付与された owner/editor だけが変更できる。
  // openEditing は旧データ互換で入力型には残すが、認可には使わない。
  return canEditWorkspaceRole(context.role);
}
