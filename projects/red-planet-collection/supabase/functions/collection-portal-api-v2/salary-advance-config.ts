type InputType = {
  id?: unknown;
  name?: unknown;
  code?: unknown;
  available_in_attachments?: unknown;
};

type SalaryRule = {
  active?: unknown;
  amount_other_input_id?: unknown;
  condition_other_input_id?: unknown;
};

function relationId(value: unknown) {
  if (Array.isArray(value)) return Number(value[0] || 0);
  return Number(value || 0);
}

/**
 * Employee advances must use the customer's explicit payroll deduction input.
 * Generic salary attachments can be allowances or assignments and must never
 * be selected as a fallback for an advance.
 */
export function selectSalaryDeductionInputType(inputTypes: InputType[]) {
  return inputTypes.find(
    (row) =>
      row.available_in_attachments === true &&
      String(row.code || "").trim().toUpperCase() === "PAY_DED",
  ) || null;
}

export function payrollRuleForInput(
  inputType: InputType | null,
  salaryRules: SalaryRule[],
) {
  const inputTypeId = relationId(inputType?.id);
  if (!inputTypeId) return null;
  return salaryRules.find(
    (rule) =>
      rule.active !== false &&
      (relationId(rule.amount_other_input_id) === inputTypeId ||
        relationId(rule.condition_other_input_id) === inputTypeId),
  ) || null;
}

export function selectOutboundSalaryAdvanceMethod(
  methods: Array<{ id?: unknown }>,
  requested: unknown,
  fallback: unknown,
) {
  const requestedId = Number(requested || fallback || 0);
  return methods.find((row) => Number(row.id || 0) === requestedId) || methods[0] || null;
}
