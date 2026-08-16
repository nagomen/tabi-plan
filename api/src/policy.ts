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
  if (canEditWorkspaceRole(context.role)) return true;
  return Boolean(
    context.loggedIn &&
    context.openEditing &&
    context.visibility === "public" &&
    context.status === "published"
  );
}
