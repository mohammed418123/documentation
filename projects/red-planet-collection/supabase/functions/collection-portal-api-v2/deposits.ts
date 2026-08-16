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

const EPSILON = 0.000001;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function relationId(value: unknown) {
  return Array.isArray(value) ? asNumber(value[0]) : asNumber(value);
}

function marker(operationUuid: string) {
  return `[COLLECT-DEPOSIT|${operationUuid}]`;
}

async function journalPair(
  user: PortalUser,
  sourceId: number,
  destinationId: number,
  requestId: string,
) {
  const rows = await odooCall(
    "account.journal",
    "search_read",
    {
      domain: [
        ["id", "in", [sourceId, destinationId]],
        ["type", "in", ["cash", "bank"]],
      ],
      fields: [
        "id",
        "name",
        "type",
        "company_id",
        "currency_id",
        "default_account_id",
      ],
      limit: 2,
    },
    user,
    requestId,
    { action: "deposit_validate_journals" },
  );
  const source = (rows || []).find((row: any) => asNumber(row.id) === sourceId);
  const destination = (rows || []).find(
    (row: any) => asNumber(row.id) === destinationId,
  );
  if (!source || !destination)
    throw new AppError(
      "DEPOSIT_JOURNAL_INVALID",
      "تعذر قراءة صندوق المصدر أو دفتر الوجهة من Odoo",
      400,
      "validation",
    );
  const sourceCompany = relationId(source.company_id);
  const destinationCompany = relationId(destination.company_id);
  if (!sourceCompany || sourceCompany !== destinationCompany)
    throw new AppError(
      "DEPOSIT_COMPANY_MISMATCH",
      "لا يمكن التوريد بين يوميتين لشركتين مختلفتين",
      400,
      "validation",
    );
  if (
    user.role !== "manager" &&
    asNumber(user.company_id) &&
    sourceCompany !== asNumber(user.company_id)
  )
    throw new AppError(
      "DEPOSIT_COMPANY_FORBIDDEN",
      "دفتر التوريد لا يتبع شركتك",
      403,
      "permission",
    );
  if (!relationId(source.default_account_id) || !relationId(destination.default_account_id))
    throw new AppError(
      "DEPOSIT_ACCOUNT_MISSING",
      "أحد الدفترين لا يحتوي حسابًا افتراضيًا في Odoo",
      400,
      "configuration",
    );
  return { source, destination, companyId: sourceCompany };
}

async function companyAmount(
  user: PortalUser,
  companyId: number,
  currencyId: number,
  date: string,
  amount: number,
  requestId: string,
) {
  const companies = await odooCall(
    "res.company",
    "read",
    { ids: [companyId], fields: ["currency_id"] },
    user,
    requestId,
    { action: "deposit_company_currency" },
  );
  const companyCurrencyId = relationId(companies?.[0]?.currency_id);
  if (!companyCurrencyId)
    throw new AppError("COMPANY_CURRENCY_MISSING", "عملة الشركة غير محددة في Odoo");
  if (currencyId === companyCurrencyId)
    return { companyAmount: amount, companyCurrencyId, foreign: false };

  const currencies = await odooCall(
    "res.currency",
    "read",
    {
      ids: [currencyId],
      fields: ["rate", "decimal_places", "active"],
      context: { date, company_id: companyId },
    },
    user,
    requestId,
    { action: "deposit_currency_rate" },
  );
  const rate = asNumber(currencies?.[0]?.rate);
  if (!(rate > 0))
    throw new AppError(
      "CURRENCY_RATE_MISSING",
      "لا يوجد سعر صرف صالح للعملة في تاريخ التوريد",
      400,
      "configuration",
    );
  return {
    companyAmount: Math.round((amount / rate + Number.EPSILON) * 100) / 100,
    companyCurrencyId,
    foreign: true,
  };
}

export async function depositList(user: PortalUser) {
  let query = db
    .from("collection_portal_deposits")
    .select("*")
    .order("deposit_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  const permissions = normalizedPermissions(user);
  if (!permissions.deposits_approve && !permissions.reports_all)
    query = query.eq("user_id", user.id);
  else if (user.company_id) query = query.eq("company_id", user.company_id);
  const { data, error } = await query;
  if (error) throw error;
  return { deposits: data || [] };
}

export async function saveDeposit(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  requirePermission(user, "deposits_create");
  const input = (body.deposit || {}) as Record<string, unknown>;
  const operationUuid = cleanText(input.operation_uuid, 64) || crypto.randomUUID();
  if (!uuidPattern.test(operationUuid))
    throw new AppError("DEPOSIT_OPERATION_INVALID", "معرّف التوريد غير صحيح");
  const amount = asNumber(input.amount);
  if (!(amount > 0) || amount > 1_000_000_000_000)
    throw new AppError("INVALID_AMOUNT", "أدخل مبلغ توريد صحيحًا أكبر من صفر");
  const reference = cleanText(input.reference, 120);
  if (!reference)
    throw new AppError("DEPOSIT_REFERENCE_REQUIRED", "رقم التوريد أو مرجع الإيداع مطلوب");
  const { settings } = await getConfig();
  const sourceJournalId = scopedJournal(
    user,
    input.source_journal_id,
    settings.journal_id,
  );
  const destinationJournalId = asNumber(input.destination_journal_id);
  if (!destinationJournalId)
    throw new AppError("DESTINATION_REQUIRED", "اختر البنك أو دفتر الوجهة");
  if (destinationJournalId === sourceJournalId)
    throw new AppError("SAME_JOURNAL", "دفتر المصدر والوجهة لا يمكن أن يكونا متطابقين");
  const currencyId =
    asNumber(input.currency_id || user.currency_id || settings.currency_id) || 0;
  if (!currencyId) throw new AppError("CURRENCY_REQUIRED", "عملة التوريد مطلوبة");
  const depositDate = asDate(input.deposit_date);
  const pair = await journalPair(
    user,
    sourceJournalId,
    destinationJournalId,
    requestId,
  );
  for (const journal of [pair.source, pair.destination]) {
    const journalCurrency = relationId(journal.currency_id);
    if (journalCurrency && journalCurrency !== currencyId)
      throw new AppError(
        "DEPOSIT_CURRENCY_MISMATCH",
        `عملة ${journal.name} لا تطابق عملة التوريد`,
        400,
        "validation",
      );
  }

  const row = {
    operation_uuid: operationUuid,
    user_id: user.id,
    employee_id: user.employee_id,
    employee_name: user.employee_name,
    company_id: pair.companyId,
    source_journal_id: sourceJournalId,
    destination_journal_id: destinationJournalId,
    amount,
    currency_id: currencyId,
    deposit_date: depositDate,
    reference,
    note: cleanText(input.note, 1000) || null,
    status: "submitted",
    submitted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data: previous, error: previousError } = await db
    .from("collection_portal_deposits")
    .select("*")
    .eq("operation_uuid", operationUuid)
    .maybeSingle();
  if (previousError) throw previousError;
  if (previous) {
    const same =
      previous.user_id === row.user_id &&
      asNumber(previous.source_journal_id) === row.source_journal_id &&
      asNumber(previous.destination_journal_id) === row.destination_journal_id &&
      Math.abs(asNumber(previous.amount) - row.amount) < EPSILON &&
      previous.deposit_date === row.deposit_date &&
      previous.reference === row.reference;
    if (!same)
      throw new AppError(
        "DEPOSIT_OPERATION_CONFLICT",
        "معرّف التوريد مستخدم لبيانات مختلفة",
        409,
        "conflict",
      );
    return { deposit: previous, idempotent: true };
  }
  const { data, error } = await db
    .from("collection_portal_deposits")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  await audit(
    user,
    "إرسال توريد للاعتماد",
    `${amount} | ${reference}`,
    requestId,
    { deposit_id: data.id, operation_uuid: operationUuid },
  );
  return { deposit: data };
}

export async function postDeposit(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  requirePermission(user, "deposits_approve");
  const depositId = cleanText(body.deposit_id, 64);
  if (!uuidPattern.test(depositId))
    throw new AppError("DEPOSIT_REQUIRED", "حدد التوريد المطلوب اعتماده");
  const { data: deposit, error } = await db
    .from("collection_portal_deposits")
    .select("*")
    .eq("id", depositId)
    .maybeSingle();
  if (error || !deposit)
    throw new AppError("DEPOSIT_NOT_FOUND", "التوريد غير موجود", 404);
  if (user.company_id && asNumber(deposit.company_id) !== asNumber(user.company_id))
    throw new AppError("DEPOSIT_COMPANY_FORBIDDEN", "التوريد يتبع شركة أخرى", 403, "permission");
  if (deposit.status === "posted")
    return { deposit, idempotent: true };
  if (!["submitted", "processing", "needs_repair"].includes(deposit.status))
    throw new AppError("DEPOSIT_STATE_INVALID", "حالة التوريد لا تسمح بالاعتماد", 409, "conflict");

  const operationUuid = String(deposit.operation_uuid);
  const moveMarker = marker(operationUuid);
  let stage = "validation";
  await db
    .from("collection_portal_deposits")
    .update({
      status: "processing",
      attempt_count: asNumber(deposit.attempt_count) + 1,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", depositId);
  try {
    const pair = await journalPair(
      user,
      asNumber(deposit.source_journal_id),
      asNumber(deposit.destination_journal_id),
      requestId,
    );
    const converted = await companyAmount(
      user,
      pair.companyId,
      asNumber(deposit.currency_id),
      deposit.deposit_date,
      asNumber(deposit.amount),
      requestId,
    );
    stage = "move_lookup";
    let matches = await odooCall(
      "account.move",
      "search_read",
      {
        domain: [["ref", "ilike", moveMarker]],
        fields: ["id", "name", "state", "ref"],
        limit: 3,
      },
      user,
      requestId,
      { action: "deposit_move_idempotency" },
    );
    if ((matches || []).length > 1)
      throw new AppError(
        "DEPOSIT_DUPLICATE_MOVES",
        "وُجد أكثر من قيد لنفس التوريد؛ يلزم فحص المدير",
        409,
        "financial_repair",
      );
    let move = matches?.[0];
    if (!move) {
      stage = "move_create";
      const amount = asNumber(deposit.amount);
      const balance = converted.companyAmount;
      const currencyId = asNumber(deposit.currency_id);
      const description = `توريد من ${pair.source.name} إلى ${pair.destination.name} | ${deposit.reference}`;
      const sourceLine: Record<string, unknown> = {
        name: description,
        account_id: relationId(pair.source.default_account_id),
        debit: 0,
        credit: balance,
      };
      const destinationLine: Record<string, unknown> = {
        name: description,
        account_id: relationId(pair.destination.default_account_id),
        debit: balance,
        credit: 0,
      };
      if (converted.foreign) {
        Object.assign(sourceLine, { currency_id: currencyId, amount_currency: -amount });
        Object.assign(destinationLine, { currency_id: currencyId, amount_currency: amount });
      }
      const created = await odooCall(
        "account.move",
        "create",
        {
          vals_list: [
            {
              move_type: "entry",
              journal_id: asNumber(deposit.source_journal_id),
              date: deposit.deposit_date,
              ref: `${moveMarker} ${deposit.reference}`,
              line_ids: [
                [0, 0, destinationLine],
                [0, 0, sourceLine],
              ],
            },
          ],
        },
        user,
        requestId,
        { action: "deposit_move_create" },
      );
      const moveId = Array.isArray(created) ? asNumber(created[0]) : asNumber(created);
      if (!moveId)
        throw new AppError("DEPOSIT_MOVE_CREATE_FAILED", "لم يرجع Odoo رقم قيد التوريد", 502, "odoo");
      await db
        .from("collection_portal_deposits")
        .update({ odoo_move_id: moveId, updated_at: new Date().toISOString() })
        .eq("id", depositId);
      move = { id: moveId, state: "draft", name: "/" };
    }
    if (move.state === "draft") {
      stage = "move_post";
      await odooCall(
        "account.move",
        "action_post",
        { ids: [asNumber(move.id)] },
        user,
        requestId,
        { action: "deposit_move_post" },
      );
    }
    stage = "move_verify";
    const verified = await odooCall(
      "account.move",
      "read",
      { ids: [asNumber(move.id)], fields: ["id", "name", "state", "ref"] },
      user,
      requestId,
      { action: "deposit_move_verify" },
    );
    const posted = verified?.[0];
    if (!posted || posted.state !== "posted")
      throw new AppError("DEPOSIT_NOT_POSTED", "قيد التوريد لم يُرحّل في Odoo", 502, "odoo");
    const { data: saved, error: saveError } = await db
      .from("collection_portal_deposits")
      .update({
        status: "posted",
        odoo_move_id: asNumber(posted.id),
        odoo_move_name: posted.name,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", depositId)
      .select()
      .single();
    if (saveError) throw saveError;
    await audit(
      user,
      "اعتماد وترحيل توريد",
      `${deposit.amount} | ${posted.name}`,
      requestId,
      { deposit_id: depositId, odoo_move_id: posted.id, operation_uuid: operationUuid },
    );
    return { deposit: saved, odoo_move_id: posted.id, odoo_move_name: posted.name };
  } catch (caught) {
    await db
      .from("collection_portal_deposits")
      .update({
        status: stage === "validation" ? "submitted" : "needs_repair",
        last_error: {
          stage,
          request_id: requestId,
          message: caught instanceof Error ? caught.message.slice(0, 1000) : String(caught).slice(0, 1000),
          at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", depositId);
    await audit(
      user,
      "فشل اعتماد توريد",
      `deposit=${depositId} | stage=${stage}`,
      requestId,
      { message: caught instanceof Error ? caught.message : String(caught) },
      "error",
    );
    if (caught instanceof AppError) {
      caught.details = { ...(caught.details || {}), deposit_id: depositId, stage };
      throw caught;
    }
    throw new AppError(
      "DEPOSIT_NEEDS_REVIEW",
      stage === "validation"
        ? "تعذر التحقق من التوريد قبل إنشاء القيد"
        : "توقف التوريد بعد بدء القيد. لم يُحذف أي أثر مالي؛ أعد المحاولة لإكماله بأمان.",
      500,
      stage === "validation" ? "backend" : "financial_repair",
      { deposit_id: depositId, stage },
    );
  }
}

export async function rejectDeposit(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  requirePermission(user, "deposits_approve");
  const depositId = cleanText(body.deposit_id, 64);
  const reason = cleanText(body.reason, 500);
  if (!uuidPattern.test(depositId)) throw new AppError("DEPOSIT_REQUIRED", "حدد التوريد");
  if (!reason) throw new AppError("REJECTION_REASON_REQUIRED", "اكتب سبب الرفض");
  const { data, error } = await db
    .from("collection_portal_deposits")
    .update({
      status: "rejected",
      rejection_reason: reason,
      rejected_by: user.id,
      rejected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", depositId)
    .in("status", ["submitted", "draft"])
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError("DEPOSIT_STATE_INVALID", "لا يمكن رفض التوريد في حالته الحالية", 409);
  await audit(user, "رفض توريد", reason, requestId, { deposit_id: depositId }, "warning");
  return { deposit: data };
}
