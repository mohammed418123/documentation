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
import { fieldMap, getConfig, odooCall, scopedJournal } from "./odoo.ts";
import { expenseMarker as marker, expenseStatusFromOdoo as statusFromOdoo } from "./expense-state.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

type AttachmentInput = {
  name: string;
  mimetype: string;
  data: string;
};

let expenseFieldsCache:
  | { at: number; fields: Record<string, Record<string, unknown>> }
  | undefined;

function relationId(value: unknown) {
  return Array.isArray(value) ? asNumber(value[0]) : asNumber(value);
}

function relationName(value: unknown) {
  return Array.isArray(value) ? cleanText(value[1], 300) : "";
}

async function expenseFields(user: PortalUser, requestId: string) {
  if (expenseFieldsCache && Date.now() - expenseFieldsCache.at < 300_000)
    return expenseFieldsCache.fields;
  const fields = await fieldMap("hr.expense", user, requestId);
  expenseFieldsCache = { at: Date.now(), fields: fields || {} };
  return fields || {};
}

function onlyKnownFields(
  fields: Record<string, Record<string, unknown>>,
  values: Record<string, unknown>,
) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) =>
        fields[key] && fields[key].readonly !== true && value !== undefined,
    ),
  );
}

async function productFields(user: PortalUser, requestId: string) {
  return await fieldMap("product.product", user, requestId);
}

async function expenseCategory(
  user: PortalUser,
  productId: number,
  requestId: string,
) {
  const fields = await productFields(user, requestId);
  const names = ["id", "name", "can_be_expensed", "property_account_expense_id"]
    .filter((name) => fields?.[name]);
  const domain: unknown[] = [["id", "=", productId]];
  if (fields?.can_be_expensed) domain.push(["can_be_expensed", "=", true]);
  const rows = await odooCall(
    "product.product",
    "search_read",
    { domain, fields: names, limit: 1 },
    user,
    requestId,
    { action: "expense_validate_category" },
  );
  const category = rows?.[0];
  if (!category)
    throw new AppError(
      "EXPENSE_CATEGORY_INVALID",
      "تصنيف المصروف غير موجود أو غير مفعّل للمصروفات",
      422,
      "validation",
    );
  const accountId = relationId(category.property_account_expense_id);
  if (!accountId)
    throw new AppError(
      "EXPENSE_ACCOUNT_MISSING",
      `تصنيف «${category.name}» لا يحتوي حساب مصروف. اضبطه في Odoo أولًا.`,
      422,
      "configuration",
      { product_id: productId },
    );
  return {
    id: asNumber(category.id),
    name: cleanText(category.name, 300),
    account_id: accountId,
    account_name: relationName(category.property_account_expense_id),
  };
}

async function outboundMethod(
  user: PortalUser,
  journalId: number,
  requested: unknown,
  requestId: string,
) {
  const preferred = asNumber(requested || user.expense_method_id);
  const domain: unknown[] = [
    ["journal_id", "=", journalId],
    ["payment_type", "=", "outbound"],
  ];
  if (preferred) domain.push(["id", "=", preferred]);
  let rows = await odooCall(
    "account.payment.method.line",
    "search_read",
    {
      domain,
      fields: ["id", "name", "journal_id", "payment_type"],
      limit: preferred ? 1 : 20,
      order: "id asc",
    },
    user,
    requestId,
    { action: "expense_outbound_method" },
  );
  if (preferred && !rows?.length)
    throw new AppError(
      "EXPENSE_METHOD_INVALID",
      "طريقة صرف المصروف لا تتبع صندوق المتحصل أو ليست صادرة",
      422,
      "configuration",
    );
  if (!rows?.length)
    throw new AppError(
      "EXPENSE_METHOD_MISSING",
      "لا توجد طريقة دفع صادرة على صندوق المتحصل. راجع إعداد المستخدم.",
      422,
      "configuration",
    );
  return rows[0];
}

async function readExpense(
  user: PortalUser,
  expenseId: number,
  requestId: string,
) {
  const fields = await expenseFields(user, requestId);
  const names = [
    "id",
    "name",
    "state",
    "employee_id",
    "product_id",
    "account_id",
    "total_amount_currency",
    "currency_id",
    "payment_mode",
    "payment_method_line_id",
    "journal_id",
    "account_move_id",
  ].filter((name) => fields[name]);
  const rows = await odooCall(
    "hr.expense",
    "read",
    { ids: [expenseId], fields: names },
    user,
    requestId,
    { action: "expense_read" },
  );
  if (!rows?.[0])
    throw new AppError("EXPENSE_ODOO_MISSING", "المصروف غير موجود في Odoo", 404, "odoo");
  return rows[0];
}

async function findExpenseByMarker(
  user: PortalUser,
  operationUuid: string,
  requestId: string,
) {
  const fields = await expenseFields(user, requestId);
  const searchable = fields.description ? "description" : "name";
  const rows = await odooCall(
    "hr.expense",
    "search_read",
    {
      domain: [[searchable, "ilike", marker(operationUuid)]],
      fields: ["id", "state", "name"].filter((name) => fields[name]),
      limit: 3,
    },
    user,
    requestId,
    { action: "expense_idempotency_lookup" },
  );
  if ((rows || []).length > 1)
    throw new AppError(
      "EXPENSE_DUPLICATE_ODOO",
      "وُجد أكثر من مصروف لنفس العملية في Odoo؛ يلزم فحص المدير",
      409,
      "financial_repair",
      { operation_uuid: operationUuid },
    );
  return rows?.[0] || null;
}

function parsedAttachments(value: unknown): AttachmentInput[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 3)
    throw new AppError("EXPENSE_ATTACHMENTS_LIMIT", "يمكن رفع ثلاثة مرفقات كحد أقصى");
  let totalBytes = 0;
  return value.map((raw) => {
    const row = (raw || {}) as Record<string, unknown>;
    const name = cleanText(row.name, 180).replace(/[\\/]/g, "-") || "receipt";
    const mimetype = cleanText(row.mimetype, 80).toLowerCase();
    const data = String(row.data || "").replace(/^data:[^;]+;base64,/, "");
    const estimatedBytes = Math.floor((data.length * 3) / 4);
    if (!ALLOWED_ATTACHMENT_TYPES.has(mimetype))
      throw new AppError(
        "EXPENSE_ATTACHMENT_TYPE",
        "المرفق يجب أن يكون صورة JPG أو PNG أو WEBP أو ملف PDF",
      );
    if (!data || estimatedBytes > MAX_ATTACHMENT_BYTES)
      throw new AppError(
        "EXPENSE_ATTACHMENT_SIZE",
        "حجم المرفق الواحد يجب ألا يتجاوز 4 ميجابايت",
      );
    if (!/^[a-z0-9+/=\r\n]+$/i.test(data))
      throw new AppError("EXPENSE_ATTACHMENT_INVALID", "بيانات المرفق غير صحيحة");
    totalBytes += estimatedBytes;
    if (totalBytes > 8 * 1024 * 1024)
      throw new AppError("EXPENSE_ATTACHMENTS_TOTAL", "إجمالي المرفقات يجب ألا يتجاوز 8 ميجابايت");
    return { name, mimetype, data };
  });
}

async function attachFiles(
  user: PortalUser,
  expenseId: number,
  operationUuid: string,
  attachments: AttachmentInput[],
  requestId: string,
) {
  const saved: Array<{ id: number; name: string; mimetype: string }> = [];
  for (const file of attachments) {
    const existing = await odooCall(
      "ir.attachment",
      "search_read",
      {
        domain: [
          ["res_model", "=", "hr.expense"],
          ["res_id", "=", expenseId],
          ["name", "=", file.name],
          ["description", "=", marker(operationUuid)],
        ],
        fields: ["id", "name", "mimetype"],
        limit: 2,
      },
      user,
      requestId,
      { action: "expense_attachment_idempotency" },
    );
    if (existing?.[0]) {
      saved.push({
        id: asNumber(existing[0].id),
        name: cleanText(existing[0].name, 180),
        mimetype: cleanText(existing[0].mimetype, 80),
      });
      continue;
    }
    const created = await odooCall(
      "ir.attachment",
      "create",
      {
        vals_list: [{
          name: file.name,
          datas: file.data,
          mimetype: file.mimetype,
          res_model: "hr.expense",
          res_id: expenseId,
          type: "binary",
          description: marker(operationUuid),
        }],
      },
      user,
      requestId,
      { action: "expense_attachment_create" },
    );
    const attachmentId = Array.isArray(created) ? asNumber(created[0]) : asNumber(created);
    if (!attachmentId)
      throw new AppError("EXPENSE_ATTACHMENT_FAILED", "تعذر حفظ مرفق المصروف في Odoo", 502, "odoo");
    saved.push({ id: attachmentId, name: file.name, mimetype: file.mimetype });
  }
  return saved;
}

async function messageExpense(
  user: PortalUser,
  expenseId: number,
  body: string,
  requestId: string,
) {
  try {
    await odooCall(
      "hr.expense",
      "message_post",
      { ids: [expenseId], body },
      user,
      requestId,
      { action: "expense_message_post" },
    );
  } catch (error) {
    console.warn("expense_message_failed", error instanceof Error ? error.message : String(error));
  }
}

export async function expenseBootstrap(user: PortalUser, requestId: string) {
  if (!normalizedPermissions(user).expenses_enter && !normalizedPermissions(user).expenses_approve)
    throw new AppError("FORBIDDEN", "لا تملك صلاحية المصروفات", 403, "permission");
  const [expenseFieldMap, productFieldMap] = await Promise.all([
    expenseFields(user, requestId),
    productFields(user, requestId),
  ]);
  const productNames = ["id", "name", "can_be_expensed", "property_account_expense_id"]
    .filter((name) => productFieldMap?.[name]);
  const productDomain: unknown[] = [];
  if (productFieldMap?.can_be_expensed)
    productDomain.push(["can_be_expensed", "=", true]);
  const [products, methods] = await Promise.all([
    odooCall(
      "product.product",
      "search_read",
      { domain: productDomain, fields: productNames, limit: 500, order: "name asc" },
      user,
      requestId,
      { action: "expense_categories" },
    ),
    odooCall(
      "account.payment.method.line",
      "search_read",
      {
        domain: [
          ["journal_id", "=", scopedJournal(user, user.journal_id)],
          ["payment_type", "=", "outbound"],
        ],
        fields: ["id", "name", "journal_id", "payment_type"],
        limit: 50,
        order: "name asc",
      },
      user,
      requestId,
      { action: "expense_methods" },
    ),
  ]);
  const categories = (products || []).map((row: any) => ({
    id: asNumber(row.id),
    name: cleanText(row.name, 300),
    account_id: relationId(row.property_account_expense_id) || null,
    account_name: relationName(row.property_account_expense_id) || null,
    configured: Boolean(relationId(row.property_account_expense_id)),
  }));
  return {
    available: true,
    categories,
    methods: methods || [],
    default_method_id:
      asNumber(user.expense_method_id) || asNumber(methods?.[0]?.id) || null,
    capabilities: {
      vendor: Boolean(expenseFieldMap.vendor_id),
      description: Boolean(expenseFieldMap.description),
      payment_method_line: Boolean(expenseFieldMap.payment_method_line_id),
      journal: Boolean(expenseFieldMap.journal_id),
      account_move: Boolean(expenseFieldMap.account_move_id),
    },
  };
}

export async function expenseList(user: PortalUser) {
  if (!normalizedPermissions(user).expenses_enter && !normalizedPermissions(user).expenses_approve)
    throw new AppError("FORBIDDEN", "لا تملك صلاحية عرض المصروفات", 403, "permission");
  let query = db
    .from("collection_portal_expenses")
    .select("*")
    .order("expense_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (!normalizedPermissions(user).expenses_view_all)
    query = query.eq("user_id", user.id);
  else if (user.company_id) query = query.eq("company_id", user.company_id);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];
  const summary = rows.reduce(
    (acc, row: any) => {
      acc.total += asNumber(row.amount);
      acc.count += 1;
      if (["submitted", "needs_repair"].includes(row.status)) {
        acc.pending_amount += asNumber(row.amount);
        acc.pending_count += 1;
      }
      if (["approved", "posted", "paid"].includes(row.status))
        acc.approved_amount += asNumber(row.amount);
      if (row.status === "rejected") acc.rejected_count += 1;
      return acc;
    },
    { total: 0, count: 0, pending_amount: 0, pending_count: 0, approved_amount: 0, rejected_count: 0 },
  );
  return { expenses: rows, summary };
}

async function editableExpense(user: PortalUser, id: string) {
  const { data, error } = await db
    .from("collection_portal_expenses")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw new AppError("EXPENSE_NOT_FOUND", "المصروف غير موجود", 404);
  if (data.user_id !== user.id)
    throw new AppError("EXPENSE_OWNER_REQUIRED", "لا يمكنك تعديل مصروف متحصل آخر", 403, "permission");
  if (!["draft", "correction_requested"].includes(data.status))
    throw new AppError("EXPENSE_NOT_EDITABLE", "لا يمكن تعديل المصروف في حالته الحالية", 409, "conflict");
  return data;
}

async function ownedExpense(user: PortalUser, id: string) {
  const { data, error } = await db
    .from("collection_portal_expenses")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw new AppError("EXPENSE_NOT_FOUND", "المصروف غير موجود", 404);
  if (data.user_id !== user.id)
    throw new AppError("EXPENSE_OWNER_REQUIRED", "لا يمكنك تعديل مصروف متحصل آخر", 403, "permission");
  return data;
}

export async function saveExpense(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  requirePermission(user, "expenses_enter");
  if (!user.employee_id)
    throw new AppError("EXPENSE_EMPLOYEE_REQUIRED", "المستخدم غير مربوط بموظف في Odoo", 422, "configuration");
  const input = (body.expense || {}) as Record<string, unknown>;
  const localId = cleanText(input.id, 64);
  const operationUuid = cleanText(input.operation_uuid, 64) || crypto.randomUUID();
  if (!UUID_PATTERN.test(operationUuid))
    throw new AppError("EXPENSE_OPERATION_INVALID", "معرّف المصروف غير صحيح");
  const amount = asNumber(input.amount);
  if (!(amount > 0) || amount > 1_000_000_000_000)
    throw new AppError("EXPENSE_AMOUNT_INVALID", "أدخل مبلغ مصروف صحيحًا أكبر من صفر");
  const description = cleanText(input.description, 180);
  if (!description)
    throw new AppError("EXPENSE_DESCRIPTION_REQUIRED", "اكتب بيان المصروف");
  const productId = asNumber(input.product_id);
  if (!productId) throw new AppError("EXPENSE_CATEGORY_REQUIRED", "اختر نوع المصروف");
  const paymentMode = input.payment_mode === "personal" ? "personal" : "collector_cash";
  const { settings } = await getConfig();
  const journalId = paymentMode === "collector_cash"
    ? scopedJournal(user, input.journal_id, settings.journal_id)
    : null;
  const currencyId = asNumber(input.currency_id || user.currency_id || settings.currency_id);
  if (!currencyId) throw new AppError("EXPENSE_CURRENCY_REQUIRED", "عملة المصروف مطلوبة");
  const category = await expenseCategory(user, productId, requestId);
  const method = journalId
    ? await outboundMethod(user, journalId, input.payment_method_line_id, requestId)
    : null;
  const attachments = parsedAttachments(input.attachments);
  let existing = localId ? await editableExpense(user, localId) : null;
  if (!existing) {
    const { data: operationExisting, error: operationError } = await db
      .from("collection_portal_expenses")
      .select("*")
      .eq("operation_uuid", operationUuid)
      .maybeSingle();
    if (operationError) throw operationError;
    if (operationExisting) {
      if (operationExisting.user_id !== user.id)
        throw new AppError("EXPENSE_OPERATION_FORBIDDEN", "معرّف المصروف يتبع مستخدمًا آخر", 403, "permission");
      const samePayload =
        asNumber(operationExisting.product_id) === productId &&
        Math.abs(asNumber(operationExisting.amount) - amount) < 0.000001 &&
        operationExisting.expense_date === asDate(input.expense_date) &&
        operationExisting.description === description &&
        operationExisting.payment_mode === paymentMode;
      if (!samePayload)
        throw new AppError("EXPENSE_OPERATION_CONFLICT", "معرّف المصروف مستخدم لبيانات مختلفة", 409, "conflict");
      if (!["draft", "correction_requested"].includes(operationExisting.status))
        return { expense: operationExisting, idempotent: true };
      existing = operationExisting;
    }
  }
  if (existing && String(existing.operation_uuid) !== operationUuid)
    throw new AppError("EXPENSE_OPERATION_CONFLICT", "معرّف المسودة لا يطابق المصروف", 409, "conflict");

  let odooExpenseId = asNumber(existing?.odoo_expense_id);
  let odooRecord = odooExpenseId
    ? await readExpense(user, odooExpenseId, requestId)
    : await findExpenseByMarker(user, operationUuid, requestId);
  if (odooRecord) odooExpenseId = asNumber(odooRecord.id);
  if (existing?.status === "correction_requested" && odooRecord && statusFromOdoo(odooRecord.state) !== "draft") {
    await odooCall(
      "hr.expense",
      "action_reset",
      { ids: [odooExpenseId] },
      user,
      requestId,
      { action: "expense_reset_for_correction" },
    );
    odooRecord = await readExpense(user, odooExpenseId, requestId);
  }
  if (odooRecord && statusFromOdoo(odooRecord.state) !== "draft")
    throw new AppError("EXPENSE_ODOO_NOT_EDITABLE", "المصروف لم يعد مسودة في Odoo", 409, "conflict");

  const fields = await expenseFields(user, requestId);
  const detailText = [
    cleanText(input.details, 1500),
    cleanText(input.beneficiary, 300) ? `المستفيد: ${cleanText(input.beneficiary, 300)}` : "",
    marker(operationUuid),
  ].filter(Boolean).join("\n");
  const values = onlyKnownFields(fields, {
    name: description,
    date: asDate(input.expense_date),
    employee_id: asNumber(user.employee_id),
    product_id: category.id,
    account_id: category.account_id,
    total_amount_currency: amount,
    currency_id: currencyId,
    payment_mode: paymentMode === "personal" ? "own_account" : "company_account",
    payment_method_line_id: method ? asNumber(method.id) : false,
    journal_id: journalId || false,
    vendor_id: asNumber(input.vendor_id) || false,
    description: detailText,
  });
  if (!odooExpenseId) {
    const created = await odooCall(
      "hr.expense",
      "create",
      { vals_list: [values] },
      user,
      requestId,
      { action: "expense_create_draft" },
    );
    odooExpenseId = Array.isArray(created) ? asNumber(created[0]) : asNumber(created);
    if (!odooExpenseId)
      throw new AppError("EXPENSE_CREATE_FAILED", "لم يرجع Odoo رقم المصروف", 502, "odoo");
  } else {
    await odooCall(
      "hr.expense",
      "write",
      { ids: [odooExpenseId], vals: values },
      user,
      requestId,
      { action: "expense_update_draft" },
    );
  }
  const newAttachments = await attachFiles(
    user,
    odooExpenseId,
    operationUuid,
    attachments,
    requestId,
  );
  const verified = await readExpense(user, odooExpenseId, requestId);
  const savedAttachments = [
    ...(Array.isArray(existing?.attachment_ids) ? existing.attachment_ids : []),
    ...newAttachments,
  ];
  const row = {
    operation_uuid: operationUuid,
    user_id: user.id,
    employee_id: asNumber(user.employee_id),
    employee_name: user.employee_name,
    company_id: asNumber(user.company_id || settings.company_id),
    journal_id: journalId,
    payment_method_line_id: method ? asNumber(method.id) : null,
    payment_mode: paymentMode,
    expense_date: asDate(input.expense_date),
    product_id: category.id,
    product_name: category.name,
    account_id: relationId(verified.account_id) || category.account_id,
    account_name: relationName(verified.account_id) || category.account_name || null,
    vendor_id: asNumber(input.vendor_id) || null,
    beneficiary: cleanText(input.beneficiary, 300) || null,
    amount,
    currency_id: currencyId,
    description,
    details: cleanText(input.details, 1500) || null,
    attachment_ids: savedAttachments,
    odoo_expense_id: odooExpenseId,
    odoo_state: cleanText(verified.state, 40) || "draft",
    status: "draft",
    correction_reason: null,
    rejection_reason: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  let saved;
  if (existing) {
    const { data, error } = await db
      .from("collection_portal_expenses")
      .update({ ...row, version: asNumber(existing.version, 1) + 1 })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw error;
    saved = data;
  } else {
    const { data, error } = await db
      .from("collection_portal_expenses")
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    saved = data;
  }
  await audit(user, existing ? "تعديل مسودة مصروف" : "حفظ مسودة مصروف", `${amount} | ${description}`, requestId, {
    expense_id: saved.id,
    odoo_expense_id: odooExpenseId,
    operation_uuid: operationUuid,
  });
  return { expense: saved };
}

export async function submitExpense(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  requirePermission(user, "expenses_enter");
  const expenseId = cleanText(body.expense_id, 64);
  const expense = await ownedExpense(user, expenseId);
  if (["submitted", "approved", "posted", "paid"].includes(expense.status))
    return { expense, idempotent: true };
  if (!["draft", "correction_requested"].includes(expense.status))
    throw new AppError("EXPENSE_NOT_SUBMITTABLE", "لا يمكن إرسال المصروف في حالته الحالية", 409, "conflict");
  const odooExpenseId = asNumber(expense.odoo_expense_id);
  let record = await readExpense(user, odooExpenseId, requestId);
  if (statusFromOdoo(record.state) === "draft") {
    await odooCall("hr.expense", "action_submit", { ids: [odooExpenseId] }, user, requestId, { action: "expense_submit" });
    record = await readExpense(user, odooExpenseId, requestId);
  }
  const mapped = statusFromOdoo(record.state);
  if (!["submitted", "approved", "posted", "paid"].includes(mapped))
    throw new AppError("EXPENSE_SUBMIT_FAILED", "لم ينتقل المصروف إلى المراجعة في Odoo", 502, "odoo", { state: record.state });
  const { data, error } = await db
    .from("collection_portal_expenses")
    .update({ status: mapped === "submitted" ? "submitted" : mapped, odoo_state: record.state, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", expense.id)
    .select()
    .single();
  if (error) throw error;
  await audit(user, "إرسال مصروف للمراجعة", `${expense.amount} | ${expense.description}`, requestId, { expense_id: expense.id, odoo_expense_id: odooExpenseId });
  return { expense: data };
}

async function reviewableExpense(user: PortalUser, id: string) {
  requirePermission(user, "expenses_approve");
  const { data, error } = await db
    .from("collection_portal_expenses")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw new AppError("EXPENSE_NOT_FOUND", "المصروف غير موجود", 404);
  if (user.company_id && asNumber(data.company_id) !== asNumber(user.company_id))
    throw new AppError("EXPENSE_COMPANY_FORBIDDEN", "المصروف يتبع شركة أخرى", 403, "permission");
  return data;
}

export async function approveExpense(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  const expenseId = cleanText(body.expense_id, 64);
  const expense = await reviewableExpense(user, expenseId);
  if (["posted", "paid"].includes(expense.status)) return { expense, idempotent: true };
  if (!["submitted", "processing", "needs_repair", "approved"].includes(expense.status))
    throw new AppError("EXPENSE_STATE_INVALID", "حالة المصروف لا تسمح بالاعتماد", 409, "conflict");
  const odooExpenseId = asNumber(expense.odoo_expense_id);
  let stage = "read";
  await db.from("collection_portal_expenses").update({
    status: "processing",
    attempt_count: asNumber(expense.attempt_count) + 1,
    manager_note: cleanText(body.note, 1000) || expense.manager_note,
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", expense.id);
  try {
    let record = await readExpense(user, odooExpenseId, requestId);
    let mapped = statusFromOdoo(record.state);
    if (mapped === "draft") {
      stage = "submit";
      await odooCall("hr.expense", "action_submit", { ids: [odooExpenseId] }, user, requestId, { action: "expense_submit_before_approve" });
      record = await readExpense(user, odooExpenseId, requestId);
      mapped = statusFromOdoo(record.state);
    }
    if (mapped === "submitted") {
      stage = "approve";
      await odooCall("hr.expense", "action_approve", { ids: [odooExpenseId] }, user, requestId, { action: "expense_approve" });
      record = await readExpense(user, odooExpenseId, requestId);
      mapped = statusFromOdoo(record.state);
    }
    if (mapped === "approved") {
      stage = "post";
      await odooCall("hr.expense", "action_post", { ids: [odooExpenseId] }, user, requestId, { action: "expense_post" });
      record = await readExpense(user, odooExpenseId, requestId);
      mapped = statusFromOdoo(record.state);
    }
    if (!["posted", "paid"].includes(mapped))
      throw new AppError("EXPENSE_POST_FAILED", "لم يكتمل ترحيل المصروف في Odoo", 502, "odoo", { state: record.state });
    const moveId = relationId(record.account_move_id);
    const { data, error } = await db
      .from("collection_portal_expenses")
      .update({
        status: mapped,
        odoo_state: record.state,
        odoo_move_id: moveId || null,
        odoo_move_name: relationName(record.account_move_id) || null,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", expense.id)
      .select()
      .single();
    if (error) throw error;
    await messageExpense(user, odooExpenseId, `تم اعتماد وترحيل المصروف من بوابة التحصيل بواسطة ${user.employee_name}.`, requestId);
    await audit(user, "اعتماد وترحيل مصروف", `${expense.amount} | ${expense.description}`, requestId, { expense_id: expense.id, odoo_expense_id: odooExpenseId, odoo_move_id: moveId });
    return { expense: data };
  } catch (caught) {
    await db.from("collection_portal_expenses").update({
      status: stage === "read" ? "submitted" : "needs_repair",
      last_error: {
        stage,
        request_id: requestId,
        message: caught instanceof Error ? caught.message.slice(0, 1000) : String(caught).slice(0, 1000),
        at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }).eq("id", expense.id);
    await audit(user, "فشل اعتماد مصروف", `expense=${expense.id} | stage=${stage}`, requestId, { message: caught instanceof Error ? caught.message : String(caught) }, "error");
    if (caught instanceof AppError) {
      caught.details = { ...(caught.details || {}), expense_id: expense.id, stage };
      throw caught;
    }
    throw new AppError(
      "EXPENSE_NEEDS_REPAIR",
      "توقف اعتماد المصروف بعد بدء دورة Odoo. أعد المحاولة لإكماله بأمان دون تكرار.",
      500,
      "financial_repair",
      { expense_id: expense.id, stage },
    );
  }
}

export async function rejectExpense(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  const expenseId = cleanText(body.expense_id, 64);
  const reason = cleanText(body.reason, 500);
  if (!reason) throw new AppError("EXPENSE_REJECTION_REASON", "اكتب سبب رفض المصروف");
  const expense = await reviewableExpense(user, expenseId);
  if (expense.status === "rejected") return { expense, idempotent: true };
  if (expense.status !== "submitted")
    throw new AppError("EXPENSE_STATE_INVALID", "لا يمكن رفض المصروف في حالته الحالية", 409);
  const odooExpenseId = asNumber(expense.odoo_expense_id);
  let record = await readExpense(user, odooExpenseId, requestId);
  if (statusFromOdoo(record.state) === "submitted") {
    await odooCall("hr.expense", "action_refuse", { ids: [odooExpenseId] }, user, requestId, { action: "expense_refuse" });
    record = await readExpense(user, odooExpenseId, requestId);
  }
  if (statusFromOdoo(record.state) !== "rejected")
    throw new AppError("EXPENSE_REFUSE_FAILED", "لم ينتقل المصروف إلى مرفوض في Odoo", 502, "odoo", { state: record.state });
  await messageExpense(user, odooExpenseId, `سبب الرفض من بوابة التحصيل: ${reason}`, requestId);
  const { data, error } = await db.from("collection_portal_expenses").update({
    status: "rejected",
    odoo_state: record.state,
    rejection_reason: reason,
    rejected_by: user.id,
    rejected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", expense.id).select().single();
  if (error) throw error;
  await audit(user, "رفض مصروف", reason, requestId, { expense_id: expense.id, odoo_expense_id: odooExpenseId }, "warning");
  return { expense: data };
}

export async function requestExpenseCorrection(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  const expenseId = cleanText(body.expense_id, 64);
  const reason = cleanText(body.reason, 500);
  if (!reason) throw new AppError("EXPENSE_CORRECTION_REASON", "اكتب التعديل المطلوب");
  const expense = await reviewableExpense(user, expenseId);
  if (expense.status !== "submitted")
    throw new AppError("EXPENSE_STATE_INVALID", "لا يمكن طلب تعديل المصروف في حالته الحالية", 409);
  await messageExpense(user, asNumber(expense.odoo_expense_id), `مطلوب تعديل المصروف: ${reason}`, requestId);
  const { data, error } = await db.from("collection_portal_expenses").update({
    status: "correction_requested",
    correction_reason: reason,
    manager_note: reason,
    updated_at: new Date().toISOString(),
  }).eq("id", expense.id).select().single();
  if (error) throw error;
  await audit(user, "طلب تعديل مصروف", reason, requestId, { expense_id: expense.id }, "warning");
  return { expense: data };
}

export async function deleteExpenseDraft(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  requirePermission(user, "expenses_enter");
  const expenseId = cleanText(body.expense_id, 64);
  const expense = await editableExpense(user, expenseId);
  if (expense.status !== "draft")
    throw new AppError("EXPENSE_DELETE_DRAFT_ONLY", "يمكن حذف مسودة المصروف فقط", 409);
  const odooExpenseId = asNumber(expense.odoo_expense_id);
  const record = await readExpense(user, odooExpenseId, requestId);
  if (statusFromOdoo(record.state) !== "draft")
    throw new AppError("EXPENSE_ODOO_NOT_DRAFT", "المصروف لم يعد مسودة في Odoo ولا يمكن حذفه", 409);
  await odooCall("hr.expense", "unlink", { ids: [odooExpenseId] }, user, requestId, { action: "expense_unlink_draft" });
  const { error } = await db.from("collection_portal_expenses").delete().eq("id", expense.id);
  if (error) throw error;
  await audit(user, "حذف مسودة مصروف", `${expense.amount} | ${expense.description}`, requestId, { expense_id: expense.id, odoo_expense_id: odooExpenseId }, "warning");
  return { deleted: true, expense_id: expense.id };
}
