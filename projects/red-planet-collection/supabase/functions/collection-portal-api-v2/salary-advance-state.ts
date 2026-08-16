export function salaryAdvanceMarker(operationUuid: string) {
  return `[COLLECT-SALARY-ADVANCE|${operationUuid}]`;
}

export function pendingSalaryAdvanceActions(
  hasAttachment: boolean,
  paymentState: string | null | undefined,
) {
  const actions: string[] = [];
  if (!hasAttachment) actions.push("create_salary_attachment");
  if (!paymentState) actions.push("create_payment");
  if (paymentState === "draft") actions.push("action_post");
  return actions;
}
