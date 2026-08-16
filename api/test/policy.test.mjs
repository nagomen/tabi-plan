import test from "node:test";
import assert from "node:assert/strict";
import {
  canEditPlanPolicy,
  canEditWorkspaceRole,
  canManagePlanRole,
  canViewPlanPolicy,
} from "../dist/policy.js";

const plan = (overrides = {}) => ({
  role: null,
  loggedIn: false,
  visibility: "public",
  status: "published",
  openEditing: false,
  ...overrides,
});

test("public published plan is viewable without login", () => {
  assert.equal(canViewPlanPolicy(plan()), true);
});

test("invite and draft plans require active membership", () => {
  assert.equal(canViewPlanPolicy(plan({ visibility: "invite" })), false);
  assert.equal(canViewPlanPolicy(plan({ status: "draft" })), false);
  assert.equal(canViewPlanPolicy(plan({ visibility: "invite", role: "viewer" })), true);
  assert.equal(canViewPlanPolicy(plan({ status: "draft", role: "editor" })), true);
});

test("viewer cannot edit and editor cannot manage", () => {
  assert.equal(canEditWorkspaceRole("viewer"), false);
  assert.equal(canEditWorkspaceRole("editor"), true);
  assert.equal(canManagePlanRole("editor"), false);
  assert.equal(canManagePlanRole("owner"), true);
});

test("open editing requires login and a public published plan", () => {
  assert.equal(canEditPlanPolicy(plan({ openEditing: true })), false);
  assert.equal(canEditPlanPolicy(plan({ openEditing: true, loggedIn: true })), true);
  assert.equal(canEditPlanPolicy(plan({ openEditing: true, loggedIn: true, visibility: "invite" })), false);
  assert.equal(canEditPlanPolicy(plan({ openEditing: true, loggedIn: true, status: "draft" })), false);
});

test("owner and editor can edit regardless of publication state", () => {
  assert.equal(canEditPlanPolicy(plan({ role: "owner", visibility: "invite", status: "draft" })), true);
  assert.equal(canEditPlanPolicy(plan({ role: "editor", visibility: "invite", status: "draft" })), true);
});
