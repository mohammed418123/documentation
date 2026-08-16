export type LocalExpenseStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "posted"
  | "paid"
  | "rejected";

export function expenseMarker(operationUuid: string) {
  return `[COLLECT-EXPENSE|${operationUuid}]`;
}

export function expenseStatusFromOdoo(state: unknown): LocalExpenseStatus {
  const value = String(state || "").trim().toLowerCase();
  if (["paid", "done"].includes(value)) return "paid";
  if (value === "posted") return "posted";
  if (value === "approved") return "approved";
  if (["refused", "rejected", "cancel"].includes(value)) return "rejected";
  if (["submitted", "reported"].includes(value)) return "submitted";
  return "draft";
}

export function pendingApprovalActions(state: unknown) {
  const mapped = expenseStatusFromOdoo(state);
  if (mapped === "draft") return ["action_submit", "action_approve", "action_post"];
  if (mapped === "submitted") return ["action_approve", "action_post"];
  if (mapped === "approved") return ["action_post"];
  return [];
}
