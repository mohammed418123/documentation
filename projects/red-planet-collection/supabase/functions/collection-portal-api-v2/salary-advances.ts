import {
  AppError,
  asDate,
  asNumber,
  audit,
  cleanText,
  db,
  normalizedPermissions,
  PortalUser,
  requirePermission,
} from "./core.ts";
import { getConfig, odooCall, scopedJournal } from "./odoo.ts";
import { salaryAdvanceMarker as marker } from "./salary-advance-state.ts";
import {
  payrollRuleForInput,
  selectOutboundSalaryAdvanceMethod,
  selectSalaryDeductionInputType,
} from "./salary-advance-config.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function relationId(value: unknown) {
  return Array.isArray(value) ? asNumber(value[0]) : asNumber(value);
}

function relationName(value: unknown) {
  return Array.isArray(value) ? cleanText(value[1], 300) : "";
}

function normalizedWords(value: unknown) {
  const ignored = new Set([
    "سلف", "سلفة", "الموظف", "الموظفين", "موظفين", "عهد", "عهود",
    "الدكتور", "دكتور", "المندوب", "المندوبة", "المبيعات", "المحاسب",
  ]);
  return cleanText(value, 500)
    .normalize("NFKD")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !ignored.has(word));
}

function matchingAccount(employeeName: string, accounts: any[]) {
  const employeeWords = new Set(normalizedWords(employeeName));
  const ranked = accounts
    .filter((account) => normalizedWords(account.name).length > 0)
    .map((account) => ({
      account,
      score: normalizedWords(account.name).filter((word) => employeeWords.has(word)).length,
    }))
    .sort((a, b) => b.score - a.score || asNumber(a.account.id) - asNumber(b.account.id));
  const strongest = ranked[0];
  const runnerUp = ranked[1];
  const specific =
    ranked.find((row) => row.score >= 2) ||
    (strongest?.score === 1 && !runnerUp?.score ? strongest : null);
  const general = accounts.find((account) => {
    const words = normalizedWords(account.name);
    return words.length === 0 || cleanText(account.code, 30) === "125029";
  });
  return specific?.account || general || null;
}

const EMPLOYEE_ACCOUNT_ALIASES: Record<number, string> = {
  1: "محمد أحمد المحاسب",
};

const optionsCache = new Map<string, { at: number; value: any }>();
const OPTIONS_CACHE_MS = 120_000;

async function advanceOptions(user: PortalUser, requestId: string) {
  const { settings } = await getConfig();
  const companyId = asNumber(user.company_id || settings.company_id);
  const journalId = scopedJournal(user, user.journal_id, settings.journal_id);
  const currencyId = asNumber(user.currency_id || settings.currency_id);
  const cacheKey = [
    companyId,
    journalId,
    currencyId,
    asNumber(user.expense_method_id),
  ].join(":");
  const cached = optionsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < OPTIONS_CACHE_MS) return cached.value;
  const [employees, accounts, methods, inputTypes] = await Promise.all([
    odooCall(
      "hr.employee",
      "search_read",
      {
        domain: [["active", "=", true], ["company_id", "=", companyId]],
        fields: ["id", "name", "company_id", "work_contact_id"],
        limit: 1000,
        order: "name asc",
      },
      user,
      requestId,
      { action: "salary_advance_employees" },
    ),
    odooCall(
      "account.account",
      "search_read",
      {
        domain: [["account_type", "=", "asset_prepayments"], ["name", "ilike", "سلف"]],
        fields: ["id", "code", "name", "account_type", "company_ids"],
        limit: 500,
        order: "code asc",
      },
      user,
      requestId,
      { action: "salary_advance_accounts" },
    ),
    odooCall(
      "account.payment.method.line",
      "search_read",
      {
        domain: [["journal_id", "=", journalId], ["payment_type", "=", "outbound"]],
        fields: ["id", "name", "journal_id", "payment_type"],
        limit: 50,
        order: "id asc",
      },
      user,
      requestId,
      { action: "salary_advance_methods" },
    ),
    odooCall(
      "hr.payslip.input.type",
      "search_read",
      {
        domain: [["available_in_attachments", "=", true]],
        fields: ["id", "name", "code", "available_in_attachments"],
        limit: 100,
        order: "id asc",
      },
      user,
      requestId,
      { action: "salary_advance_input_types" },
    ),
  ]);
  const companyAccounts = (accounts || []).filter((account: any) => {
    const companyIds = Array.isArray(account.company_ids) ? account.company_ids.map(asNumber) : [];
    return !companyIds.length || companyIds.includes(companyId);
  });
  const employeeOptions = (employees || []).map((employee: any) => {
    const employeeId = asNumber(employee.id);
    const account = matchingAccount(
      `${cleanText(employee.name, 300)} ${EMPLOYEE_ACCOUNT_ALIASES[employeeId] || ""}`,
      companyAccounts,
    );
    return {
      id: employeeId,
      name: cleanText(employee.name, 300),
      partner_id: relationId(employee.work_contact_id) || null,
      account_id: asNumber(account?.id) || null,
      account_name: account
        ? `${cleanText(account.code, 30)} ${cleanText(account.name, 300)}`.trim()
        : null,
      configured: Boolean(account && relationId(employee.work_contact_id)),
    };
  });
  const inputType = selectSalaryDeductionInputType(inputTypes || []);
  const salaryRules = inputType
    ? await odooCall(
        "hr.salary.rule",
        "search_read",
        {
          domain: [
            "&",
            ["active", "=", true],
            "|",
            ["amount_other_input_id", "=", asNumber(inputType.id)],
            ["condition_other_input_id", "=", asNumber(inputType.id)],
          ],
          fields: ["id", "name", "code", "struct_id", "amount_other_input_id", "condition_other_input_id"],
          limit: 100,
          order: "name asc",
        },
        user,
        requestId,
        { action: "salary_advance_salary_rules" },
      )
    : [];
  const payrollRule = payrollRuleForInput(inputType, salaryRules || []);
  const value = {
    available: Boolean(methods?.length && inputType && payrollRule),
    payroll_configured: Boolean(payrollRule),
    salary_rules: salaryRules || [],
    employees: employeeOptions,
    methods: methods || [],
    default_method_id: asNumber(user.expense_method_id) || asNumber(methods?.[0]?.id) || null,
    input_type_id: asNumber(inputType?.id) || null,
    input_type_name: cleanText(inputType?.name, 300) || null,
    journal_id: journalId,
    currency_id: currencyId,
  };
  optionsCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function salaryAdvanceBootstrap(user: PortalUser, requestId: string) {
  if (!normalizedPermissions(user).expenses_enter && !normalizedPermissions(user).expenses_approve)
    throw new AppError("FORBIDDEN", "لا تملك صلاحية سلف الموظفين", 403, "permission");
  return await advanceOptions(user, requestId);
}

export async function salaryAdvanceList(user: PortalUser) {
  if (!normalizedPermissions(user).expenses_enter && !normalizedPermissions(user).expenses_approve)
    throw new AppError("FORBIDDEN", "لا تملك صلاحية عرض سلف الموظفين", 403, "permission");
  let query = db
    .from("collection_portal_salary_advances")
    .select("*")
    .order("advance_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (!normalizedPermissions(user).expenses_view_all) query = query.eq("user_id", user.id);
  else if (user.company_id) query = query.eq("company_id", user.company_id);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];
  const summary = rows.reduce((acc: any, row: any) => {
    acc.total += asNumber(row.amount);
    acc.count += 1;
    if (["submitted", "needs_repair"].includes(row.status)) {
      acc.pending_amount += asNumber(row.amount);
      acc.pending_count += 1;
    }
    if (row.status === "posted") acc.posted_amount += asNumber(row.amount);
    if (row.status === "rejected") acc.rejected_count += 1;
    return acc;
  }, { total: 0, count: 0, pending_amount: 0, pending_count: 0, posted_amount: 0, rejected_count: 0 });
  return { advances: rows, summary };
}

async function localAdvance(id: string) {
  const { data, error } = await db
    .from("collection_portal_salary_advances")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw new AppError("SALARY_ADVANCE_NOT_FOUND", "السلفة غير موجودة", 404);
  return data;
}

async function editableAdvance(user: PortalUser, id: string) {
  const data = await localAdvance(id);
  if (data.user_id !== user.id)
    throw new AppError("SALARY_ADVANCE_OWNER_REQUIRED", "لا يمكنك تعديل سلفة سجلها متحصل آخر", 403, "permission");
  if (!["draft", "correction_requested"].includes(data.status))
    throw new AppError("SALARY_ADVANCE_NOT_EDITABLE", "لا يمكن تعديل السلفة في حالتها الحالية", 409);
  return data;
}

export async function saveSalaryAdvance(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  requirePermission(user, "expenses_enter");
  if (!user.employee_id)
    throw new AppError("SALARY_ADVANCE_COLLECTOR_REQUIRED", "المستخدم غير مربوط بموظف في Odoo", 422, "configuration");
  const input = (body.advance || {}) as Record<string, unknown>;
  const localId = cleanText(input.id, 64);
  const operationUuid = cleanText(input.operation_uuid, 64) || crypto.randomUUID();
  if (!UUID_PATTERN.test(operationUuid))
    throw new AppError("SALARY_ADVANCE_OPERATION_INVALID", "معرّف السلفة غير صحيح");
  const amount = asNumber(input.amount);
  const installmentAmount = asNumber(input.installment_amount || amount);
  if (!(amount > 0) || amount > 1_000_000_000_000)
    throw new AppError("SALARY_ADVANCE_AMOUNT_INVALID", "أدخل مبلغ سلفة صحيحًا أكبر من صفر");
  if (!(installmentAmount > 0) || installmentAmount > amount)
    throw new AppError("SALARY_ADVANCE_INSTALLMENT_INVALID", "قسط الخصم يجب أن يكون أكبر من صفر ولا يتجاوز مبلغ السلفة");
  const description = cleanText(input.description, 180);
  if (!description) throw new AppError("SALARY_ADVANCE_DESCRIPTION_REQUIRED", "اكتب بيان السلفة");
  const options = await advanceOptions(user, requestId);
  const employee = options.employees.find((row: any) => asNumber(row.id) === asNumber(input.employee_id));
  if (!employee) throw new AppError("SALARY_ADVANCE_EMPLOYEE_INVALID", "الموظف غير موجود في شركة المتحصل", 422);
  if (!employee.configured)
    throw new AppError("SALARY_ADVANCE_EMPLOYEE_UNCONFIGURED", `الموظف «${employee.name}» لا يملك جهة اتصال أو حساب سلف صالحًا`, 422, "configuration");
  const method = selectOutboundSalaryAdvanceMethod(
    options.methods,
    input.payment_method_line_id,
    options.default_method_id,
  );
  if (!method)
    throw new AppError(
      "SALARY_ADVANCE_METHOD_MISSING",
      "لا توجد طريقة صرف صادرة على صندوق المتحصل",
      422,
      "configuration",
    );
  let existing = localId ? await editableAdvance(user, localId) : null;
  if (!existing) {
    const { data } = await db
      .from("collection_portal_salary_advances")
      .select("*")
      .eq("operation_uuid", operationUuid)
      .maybeSingle();
    if (data) {
      if (data.user_id !== user.id)
        throw new AppError("SALARY_ADVANCE_OPERATION_CONFLICT", "معرّف السلفة مستخدم في عملية أخرى", 409);
      if (!["draft", "correction_requested"].includes(data.status)) return { advance: data, idempotent: true };
      existing = data;
    }
  }
  const row = {
    operation_uuid: operationUuid,
    user_id: user.id,
    collector_employee_id: asNumber(user.employee_id),
    collector_name: user.employee_name,
    employee_id: employee.id,
    employee_name: employee.name,
    employee_partner_id: employee.partner_id,
    company_id: asNumber(user.company_id),
    journal_id: options.journal_id,
    payment_method_line_id: asNumber(method.id),
    advance_account_id: employee.account_id,
    advance_account_name: employee.account_name,
    currency_id: options.currency_id,
    advance_date: asDate(input.advance_date),
    deduction_start_date: asDate(input.deduction_start_date),
    amount,
    installment_amount: installmentAmount,
    description,
    details: cleanText(input.details, 2000) || null,
    status: "draft",
    correction_reason: null,
    rejection_reason: null,
    version: asNumber(existing?.version, 0) + 1,
    updated_at: new Date().toISOString(),
  };
  const query = existing
    ? db.from("collection_portal_salary_advances").update(row).eq("id", existing.id)
    : db.from("collection_portal_salary_advances").insert(row);
  const { data, error } = await query.select().single();
  if (error) throw error;
  await audit(user, existing ? "تعديل مسودة سلفة راتب" : "حفظ مسودة سلفة راتب", `${amount} | ${employee.name}`, requestId, { salary_advance_id: data.id });
  return { advance: data };
}

export async function submitSalaryAdvance(user: PortalUser, body: Record<string, unknown>, requestId: string) {
  requirePermission(user, "expenses_enter");
  const id = cleanText(body.advance_id, 64);
  const advance = await editableAdvance(user, id);
  const { data, error } = await db.from("collection_portal_salary_advances").update({
    status: "submitted",
    submitted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", advance.id).select().single();
  if (error) throw error;
  await audit(user, "إرسال سلفة راتب للمراجعة", `${advance.amount} | ${advance.employee_name}`, requestId, { salary_advance_id: advance.id });
  return { advance: data };
}

async function reviewableAdvance(user: PortalUser, id: string) {
  requirePermission(user, "expenses_approve");
  const data = await localAdvance(id);
  if (user.company_id && asNumber(data.company_id) !== asNumber(user.company_id))
    throw new AppError("SALARY_ADVANCE_COMPANY_FORBIDDEN", "السلفة تتبع شركة أخرى", 403, "permission");
  return data;
}

async function findSingle(
  model: string,
  domain: unknown[],
  fields: string[],
  user: PortalUser,
  requestId: string,
  action: string,
) {
  const rows = await odooCall(model, "search_read", { domain, fields, limit: 3 }, user, requestId, { action });
  if ((rows || []).length > 1)
    throw new AppError("SALARY_ADVANCE_DUPLICATE_ODOO", "وُجد أكثر من سجل Odoo لنفس السلفة؛ يلزم فحص المدير", 409, "financial_repair", { model });
  return rows?.[0] || null;
}

export async function approveSalaryAdvance(user: PortalUser, body: Record<string, unknown>, requestId: string) {
  const id = cleanText(body.advance_id, 64);
  const advance = await reviewableAdvance(user, id);
  if (advance.status === "posted") return { advance, idempotent: true };
  if (!["submitted", "processing", "needs_repair"].includes(advance.status))
    throw new AppError("SALARY_ADVANCE_STATE_INVALID", "حالة السلفة لا تسمح بالاعتماد", 409);
  const operationMarker = marker(advance.operation_uuid);
  const options = await advanceOptions({ ...user, company_id: advance.company_id, journal_id: advance.journal_id, currency_id: advance.currency_id }, requestId);
  const employee = options.employees.find((row: any) => asNumber(row.id) === asNumber(advance.employee_id));
  if (!employee?.configured)
    throw new AppError("SALARY_ADVANCE_EMPLOYEE_UNCONFIGURED", "تعذر تحديد جهة اتصال الموظف أو حساب سلفته", 422, "configuration");
  if (!options.available || !options.payroll_configured || !options.input_type_id)
    throw new AppError(
      "SALARY_ADVANCE_PAYROLL_NOT_READY",
      "نوع «استقطاع راتب» PAY_DED أو قاعدة الراتب المرتبطة به غير جاهزة في Odoo",
      422,
      "configuration",
    );
  const method = selectOutboundSalaryAdvanceMethod(
    options.methods,
    advance.payment_method_line_id,
    options.default_method_id,
  );
  if (!method)
    throw new AppError(
      "SALARY_ADVANCE_METHOD_MISSING",
      "لا توجد طريقة صرف صادرة على صندوق المتحصل",
      422,
      "configuration",
    );
  let stage = "payment_lookup";
  await db.from("collection_portal_salary_advances").update({
    status: "processing",
    attempt_count: asNumber(advance.attempt_count) + 1,
    manager_note: cleanText(body.note, 1000) || advance.manager_note,
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", advance.id);
  try {
    let payment = await findSingle(
      "account.payment",
      [["payment_reference", "ilike", operationMarker]],
      ["id", "name", "state", "amount", "journal_id", "destination_account_id"],
      user,
      requestId,
      "salary_advance_payment_lookup",
    );
    if (!payment) {
      stage = "payment_create";
      const created = await odooCall("account.payment", "create", {
        vals_list: [{
          payment_type: "outbound",
          partner_type: "customer",
          partner_id: employee.partner_id,
          amount: asNumber(advance.amount),
          date: advance.advance_date,
          journal_id: asNumber(advance.journal_id),
          currency_id: asNumber(advance.currency_id),
          payment_method_line_id: asNumber(method.id),
          destination_account_id: employee.account_id,
          payment_reference: `${advance.description} ${operationMarker}`,
        }],
      }, user, requestId, { action: "salary_advance_payment_create" });
      const paymentId = Array.isArray(created) ? asNumber(created[0]) : asNumber(created);
      payment = { id: paymentId, state: "draft", name: false };
    }
    const paymentId = asNumber(payment.id);
    if (!paymentId) throw new AppError("SALARY_ADVANCE_PAYMENT_FAILED", "تعذر إنشاء سند صرف السلفة في Odoo", 502, "odoo");
    if (["canceled", "rejected"].includes(cleanText(payment.state, 30)))
      throw new AppError("SALARY_ADVANCE_PAYMENT_CANCELLED", "سند صرف السلفة في Odoo ملغي أو مرفوض", 409, "financial_repair");
    if (cleanText(payment.state, 30) === "draft") {
      stage = "payment_post";
      await odooCall("account.payment", "action_post", { ids: [paymentId] }, user, requestId, { action: "salary_advance_payment_post" });
    }
    stage = "payment_read";
    const paymentRows = await odooCall("account.payment", "read", {
      ids: [paymentId],
      fields: ["id", "name", "state", "amount", "journal_id", "destination_account_id"],
    }, user, requestId, { action: "salary_advance_payment_read" });
    payment = paymentRows?.[0];
    if (!payment || !["paid", "reconciled"].includes(cleanText(payment.state, 30)))
      throw new AppError("SALARY_ADVANCE_PAYMENT_NOT_POSTED", "لم يكتمل ترحيل سند صرف السلفة", 502, "odoo", { state: payment?.state });

    stage = "salary_attachment_lookup";
    let salaryAttachment = await findSingle(
      "hr.salary.attachment",
      [["description", "ilike", operationMarker]],
      [
        "id",
        "state",
        "employee_id",
        "other_input_type_id",
        "total_amount",
        "monthly_amount",
        "description",
        "is_refund",
      ],
      user,
      requestId,
      "salary_advance_attachment_lookup",
    );
    if (!salaryAttachment) {
      stage = "salary_attachment_create";
      const created = await odooCall("hr.salary.attachment", "create", {
        vals_list: [{
          employee_id: asNumber(advance.employee_id),
          company_id: asNumber(advance.company_id),
          other_input_type_id: options.input_type_id,
          date_start: advance.deduction_start_date,
          duration_type: asNumber(advance.installment_amount) >= asNumber(advance.amount) ? "one" : "limited",
          total_amount: asNumber(advance.amount),
          monthly_amount: asNumber(advance.installment_amount),
          description: `${advance.description} ${operationMarker}`,
          is_refund: true,
          state: "open",
        }],
      }, user, requestId, { action: "salary_advance_attachment_create" });
      const attachmentId = Array.isArray(created) ? asNumber(created[0]) : asNumber(created);
      salaryAttachment = {
        id: attachmentId,
        state: "open",
        employee_id: [asNumber(advance.employee_id), advance.employee_name],
        other_input_type_id: [asNumber(options.input_type_id), options.input_type_name],
        total_amount: asNumber(advance.amount),
        monthly_amount: asNumber(advance.installment_amount),
        is_refund: true,
      };
    }
    const salaryAttachmentId = asNumber(salaryAttachment.id);
    if (!salaryAttachmentId)
      throw new AppError("SALARY_ADVANCE_ATTACHMENT_FAILED", "تعذر إنشاء استقطاع السلفة في الرواتب", 502, "odoo");
    if (
      relationId(salaryAttachment.employee_id) !== asNumber(advance.employee_id) ||
      relationId(salaryAttachment.other_input_type_id) !== asNumber(options.input_type_id) ||
      salaryAttachment.is_refund !== true
    )
      throw new AppError(
        "SALARY_ADVANCE_ATTACHMENT_MISMATCH",
        "سجل استقطاع السلفة في Odoo لا يطابق الموظف أو نوع PAY_DED أو علامة الخصم",
        409,
        "financial_repair",
        { salary_attachment_id: salaryAttachmentId },
      );
    const { data, error } = await db.from("collection_portal_salary_advances").update({
      status: "posted",
      employee_partner_id: employee.partner_id,
      advance_account_id: employee.account_id,
      advance_account_name: employee.account_name,
      odoo_payment_id: paymentId,
      odoo_payment_name: cleanText(payment.name, 100) || null,
      odoo_payment_state: cleanText(payment.state, 30),
      odoo_salary_attachment_id: salaryAttachmentId,
      approved_by: user.id,
      posted_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", advance.id).select().single();
    if (error) throw error;
    await audit(user, "اعتماد وترحيل سلفة راتب", `${advance.amount} | ${advance.employee_name}`, requestId, {
      salary_advance_id: advance.id,
      odoo_payment_id: paymentId,
      odoo_salary_attachment_id: salaryAttachmentId,
      advance_account_id: employee.account_id,
    });
    return { advance: data };
  } catch (caught) {
    await db.from("collection_portal_salary_advances").update({
      status: "needs_repair",
      last_error: {
        stage,
        request_id: requestId,
        message: caught instanceof Error ? caught.message.slice(0, 1000) : String(caught).slice(0, 1000),
        at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }).eq("id", advance.id);
    await audit(user, "فشل اعتماد سلفة راتب", `advance=${advance.id} | stage=${stage}`, requestId, { message: caught instanceof Error ? caught.message : String(caught) }, "error");
    if (caught instanceof AppError) {
      caught.details = { ...(caught.details || {}), salary_advance_id: advance.id, stage };
      throw caught;
    }
    throw new AppError("SALARY_ADVANCE_NEEDS_REPAIR", "توقف ترحيل السلفة بعد بدء دورة Odoo. أعد المحاولة لإكمالها بأمان دون تكرار.", 500, "financial_repair", { salary_advance_id: advance.id, stage });
  }
}

export async function rejectSalaryAdvance(user: PortalUser, body: Record<string, unknown>, requestId: string) {
  const id = cleanText(body.advance_id, 64);
  const reason = cleanText(body.reason, 500);
  if (!reason) throw new AppError("SALARY_ADVANCE_REJECTION_REASON", "اكتب سبب رفض السلفة");
  const advance = await reviewableAdvance(user, id);
  if (advance.status === "rejected") return { advance, idempotent: true };
  if (advance.status !== "submitted") throw new AppError("SALARY_ADVANCE_STATE_INVALID", "لا يمكن رفض السلفة في حالتها الحالية", 409);
  const { data, error } = await db.from("collection_portal_salary_advances").update({
    status: "rejected",
    rejection_reason: reason,
    rejected_by: user.id,
    rejected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", advance.id).select().single();
  if (error) throw error;
  await audit(user, "رفض سلفة راتب", reason, requestId, { salary_advance_id: advance.id }, "warning");
  return { advance: data };
}

export async function requestSalaryAdvanceCorrection(user: PortalUser, body: Record<string, unknown>, requestId: string) {
  const id = cleanText(body.advance_id, 64);
  const reason = cleanText(body.reason, 500);
  if (!reason) throw new AppError("SALARY_ADVANCE_CORRECTION_REASON", "اكتب التعديل المطلوب");
  const advance = await reviewableAdvance(user, id);
  if (advance.status !== "submitted") throw new AppError("SALARY_ADVANCE_STATE_INVALID", "لا يمكن طلب تعديل السلفة في حالتها الحالية", 409);
  const { data, error } = await db.from("collection_portal_salary_advances").update({
    status: "correction_requested",
    correction_reason: reason,
    manager_note: reason,
    updated_at: new Date().toISOString(),
  }).eq("id", advance.id).select().single();
  if (error) throw error;
  await audit(user, "طلب تعديل سلفة راتب", reason, requestId, { salary_advance_id: advance.id }, "warning");
  return { advance: data };
}

export async function deleteSalaryAdvanceDraft(user: PortalUser, body: Record<string, unknown>, requestId: string) {
  requirePermission(user, "expenses_enter");
  const id = cleanText(body.advance_id, 64);
  const advance = await editableAdvance(user, id);
  if (advance.status !== "draft") throw new AppError("SALARY_ADVANCE_DELETE_DRAFT_ONLY", "يمكن حذف مسودة السلفة فقط", 409);
  const { error } = await db.from("collection_portal_salary_advances").delete().eq("id", advance.id);
  if (error) throw error;
  await audit(user, "حذف مسودة سلفة راتب", `${advance.amount} | ${advance.employee_name}`, requestId, { salary_advance_id: advance.id }, "warning");
  return { deleted: true, advance_id: advance.id };
}
