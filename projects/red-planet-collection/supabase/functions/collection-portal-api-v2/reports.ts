import {
  AppError,
  asDate,
  asNumber,
  cleanText,
  db,
  normalizedPermissions,
  PortalUser,
  requirePermission,
} from "./core.ts";
import { getConfig, odooCall, scopedJournal } from "./odoo.ts";
import {
  aggregateDailyOutflows,
  outflowTotals,
} from "./daily-outflow.ts";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBefore(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

const DRAFT_STATES = new Set(["draft", "local_draft"]);
const CANCELLED_STATES = new Set(["canceled", "cancelled", "missing"]);

function isPostedState(state: string) {
  return Boolean(state) && !DRAFT_STATES.has(state) && !CANCELLED_STATES.has(state);
}

function settledAmount(line: any) {
  const settlementIds = Array.isArray(line.settlement_ids)
    ? line.settlement_ids.filter(Boolean)
    : [];
  const plan = Array.isArray(line.allocation_plan) ? line.allocation_plan : [];
  if (!settlementIds.length || !plan.length) return 0;
  return plan
    .slice(0, settlementIds.length)
    .reduce((sum: number, item: any) => sum + asNumber(item.amount), 0);
}

function relationId(value: unknown) {
  return Array.isArray(value) ? asNumber(value[0]) : asNumber(value);
}

function odooPaymentIsActual(state: unknown) {
  const value = cleanText(state, 30).toLowerCase();
  return Boolean(value) && !DRAFT_STATES.has(value) && !CANCELLED_STATES.has(value) && value !== "rejected";
}

type DailyCurrencyTotal = {
  currency_id: number | null;
  currency_name: string;
  receipt_count: number;
  receipt_total: number;
  receipt_draft_count: number;
  receipt_draft_total: number;
  new_pending_total: number;
  pending_collection_count: number;
  pending_collection_total: number;
  collected_total: number;
  deposit_count: number;
  deposit_total: number;
  expense_count: number;
  expense_total: number;
  expense_cash_total: number;
  expense_personal_total: number;
  advance_count: number;
  advance_total: number;
  outflow_total: number;
  net_before_deposits: number;
  net_cash: number;
};

function dailyCurrencyRow(
  grouped: Map<number, DailyCurrencyTotal>,
  currencyId: number,
  currencyName = "",
) {
  const key = currencyId || 0;
  const current = grouped.get(key);
  if (current) {
    if (!current.currency_name && currencyName) current.currency_name = currencyName;
    return current;
  }
  const row: DailyCurrencyTotal = {
    currency_id: currencyId || null,
    currency_name: currencyName,
    receipt_count: 0,
    receipt_total: 0,
    receipt_draft_count: 0,
    receipt_draft_total: 0,
    new_pending_total: 0,
    pending_collection_count: 0,
    pending_collection_total: 0,
    collected_total: 0,
    deposit_count: 0,
    deposit_total: 0,
    expense_count: 0,
    expense_total: 0,
    expense_cash_total: 0,
    expense_personal_total: 0,
    advance_count: 0,
    advance_total: 0,
    outflow_total: 0,
    net_before_deposits: 0,
    net_cash: 0,
  };
  grouped.set(key, row);
  return row;
}

async function visibleCollectionUsers(user: PortalUser) {
  const permissions = normalizedPermissions(user);
  if (!permissions.reports_all) return [user];
  let query = db.from("collection_portal_users").select("*").eq("active", true);
  if (user.company_id) query = query.eq("company_id", user.company_id);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as PortalUser[];
}

async function realDailyTotals(
  user: PortalUser,
  date: string,
  requestId: string,
) {
  const visibleUsers = await visibleCollectionUsers(user);
  const visibleUserIds = visibleUsers.map((item) => item.id);
  const journalIds = [...new Set(visibleUsers
    .map((item) => asNumber(item.journal_id))
    .filter((id) => id > 0))];
  const grouped = new Map<number, DailyCurrencyTotal>();
  if (!journalIds.length) return { by_currency: [], source: "odoo", accounting_date: date };

  const payments = await odooCall(
    "account.payment",
    "search_read",
    {
      domain: [
        ["date", "=", date],
        ["payment_type", "=", "inbound"],
        ["journal_id", "in", journalIds],
      ],
      fields: [
        "id", "name", "date", "state", "amount", "currency_id", "partner_id",
        "journal_id", "payment_reference", "x_has_pending_amount",
        "x_pending_amount", "x_pending_record_id",
      ],
      limit: 5000,
      order: "id desc",
    },
    user,
    requestId,
    { action: "dashboard_real_daily_payments" },
  );
  for (const payment of payments || []) {
    const currencyId = relationId(payment.currency_id);
    const currencyName = Array.isArray(payment.currency_id)
      ? cleanText(payment.currency_id[1], 80)
      : "";
    const row = dailyCurrencyRow(grouped, currencyId, currencyName);
    const amount = asNumber(payment.amount);
    if (odooPaymentIsActual(payment.state)) {
      row.receipt_count += 1;
      row.receipt_total += amount;
      if (payment.x_has_pending_amount === true)
        row.new_pending_total += asNumber(payment.x_pending_amount);
    } else if (DRAFT_STATES.has(cleanText(payment.state, 30).toLowerCase())) {
      row.receipt_draft_count += 1;
      row.receipt_draft_total += amount;
    }
  }

  const settlements = await odooCall(
    "x_payment_pending_settlement",
    "search_read",
    {
      domain: [["x_date", "=", date]],
      fields: ["id", "x_pending_id", "x_date", "x_amount", "x_reference", "x_notes"],
      limit: 5000,
      order: "id desc",
    },
    user,
    requestId,
    { action: "dashboard_real_daily_pending_collections" },
  );
  const settlementPendingIds = [...new Set((settlements || [])
    .map((item: any) => relationId(item.x_pending_id))
    .filter((id: number) => id > 0))];
  const pendingRows = settlementPendingIds.length
    ? await odooCall(
        "x_payment_pending",
        "read",
        { ids: settlementPendingIds, fields: ["id", "x_journal_id", "x_currency_id"] },
        user,
        requestId,
        { action: "dashboard_daily_settlement_scope" },
      )
    : [];
  const pendingById = new Map<number, any>(
    (pendingRows || []).map((item: any) => [asNumber(item.id), item]),
  );
  const { data: receiptSettlementLines, error: settlementLineError } = await db
    .from("collection_portal_receipt_lines")
    .select("settlement_ids")
    .not("settlement_ids", "is", null)
    .limit(10000);
  if (settlementLineError) throw settlementLineError;
  const receiptSettlementIds = new Set<number>(
    (receiptSettlementLines || []).flatMap((line: any) =>
      Array.isArray(line.settlement_ids)
        ? line.settlement_ids.map(asNumber).filter((id: number) => id > 0)
        : [],
    ),
  );
  for (const settlement of settlements || []) {
    if (receiptSettlementIds.has(asNumber(settlement.id))) continue;
    const pending = pendingById.get(relationId(settlement.x_pending_id));
    if (!pending || !journalIds.includes(relationId(pending.x_journal_id))) continue;
    const currencyId = relationId(pending.x_currency_id);
    const currencyName = Array.isArray(pending.x_currency_id)
      ? cleanText(pending.x_currency_id[1], 80)
      : "";
    const row = dailyCurrencyRow(grouped, currencyId, currencyName);
    row.pending_collection_count += 1;
    row.pending_collection_total += asNumber(settlement.x_amount);
  }

  const postedDepositMoves = await odooCall(
    "account.move",
    "search_read",
    {
      domain: [
        ["date", "=", date],
        ["state", "=", "posted"],
        ["journal_id", "in", journalIds],
        ["ref", "ilike", "[COLLECT-DEPOSIT|"],
      ],
      fields: ["id", "date", "state", "ref", "journal_id"],
      limit: 5000,
    },
    user,
    requestId,
    { action: "dashboard_real_daily_deposits" },
  );
  const postedDepositMoveIds = (postedDepositMoves || [])
    .map((move: any) => asNumber(move.id))
    .filter((id: number) => id > 0);
  let deposits: any[] = [];
  if (postedDepositMoveIds.length) {
    let depositQuery = db
      .from("collection_portal_deposits")
      .select("id,user_id,company_id,currency_id,amount,odoo_move_id")
      .in("odoo_move_id", postedDepositMoveIds)
      .limit(5000);
    if (!normalizedPermissions(user).reports_all)
      depositQuery = depositQuery.eq("user_id", user.id);
    else if (visibleUserIds.length)
      depositQuery = depositQuery.in("user_id", visibleUserIds);
    const depositResult = await depositQuery;
    if (depositResult.error) throw depositResult.error;
    deposits = depositResult.data || [];
  }
  for (const deposit of deposits) {
    const row = dailyCurrencyRow(grouped, asNumber(deposit.currency_id));
    row.deposit_count += 1;
    row.deposit_total += asNumber(deposit.amount);
  }

  const permissions = normalizedPermissions(user);
  if (permissions.expenses_enter || permissions.expenses_approve) {
    const employeeIds = [...new Set(visibleUsers
      .map((item) => asNumber(item.employee_id))
      .filter((id) => id > 0))];
    const odooExpenses = employeeIds.length
      ? await odooCall(
          "hr.expense",
          "search_read",
          {
            domain: [
              ["date", "=", date],
              ["employee_id", "in", employeeIds],
            ],
            fields: [
              "id", "state", "date", "employee_id", "currency_id",
              "total_amount_currency", "payment_mode",
            ],
            limit: 5000,
          },
          user,
          requestId,
          { action: "dashboard_real_daily_expenses" },
        )
      : [];
    for (const expense of odooExpenses || []) {
      const state = cleanText(expense.state, 30).toLowerCase();
      if (!["approved", "posted", "paid", "done"].includes(state)) continue;
      const currencyId = relationId(expense.currency_id);
      const currencyName = Array.isArray(expense.currency_id)
        ? cleanText(expense.currency_id[1], 80)
        : "";
      const row = dailyCurrencyRow(grouped, currencyId, currencyName);
      const amount = asNumber(expense.total_amount_currency);
      row.expense_count += 1;
      row.expense_total += amount;
      if (expense.payment_mode === "own_account") row.expense_personal_total += amount;
      else row.expense_cash_total += amount;
    }

    const advancePayments = await odooCall(
      "account.payment",
      "search_read",
      {
        domain: [
          ["date", "=", date],
          ["payment_type", "=", "outbound"],
          ["journal_id", "in", journalIds],
          ["payment_reference", "ilike", "[COLLECT-SALARY-ADVANCE|"],
        ],
        fields: ["id", "state", "date", "amount", "currency_id", "journal_id"],
        limit: 5000,
      },
      user,
      requestId,
      { action: "dashboard_real_daily_advances" },
    );
    for (const payment of advancePayments || []) {
      if (!odooPaymentIsActual(payment.state)) continue;
      const currencyId = relationId(payment.currency_id);
      const currencyName = Array.isArray(payment.currency_id)
        ? cleanText(payment.currency_id[1], 80)
        : "";
      const row = dailyCurrencyRow(grouped, currencyId, currencyName);
      row.advance_count += 1;
      row.advance_total += asNumber(payment.amount);
    }
  }

  const byCurrency = [...grouped.values()].map((row) => ({
    ...row,
    collected_total: row.receipt_total + row.pending_collection_total,
    outflow_total: row.expense_cash_total + row.advance_total,
    net_before_deposits:
      row.receipt_total + row.pending_collection_total - row.expense_cash_total - row.advance_total,
    net_cash:
      row.receipt_total + row.pending_collection_total - row.expense_cash_total - row.advance_total - row.deposit_total,
  })).sort((a, b) => String(a.currency_name).localeCompare(String(b.currency_name)));
  return {
    by_currency: byCurrency,
    recent_receipts: (payments || [])
      .filter((payment: any) => !CANCELLED_STATES.has(cleanText(payment.state, 30).toLowerCase()))
      .slice(0, 20)
      .map((payment: any) => ({
        id: asNumber(payment.id),
        name: payment.name,
        date: payment.date,
        partner_id: payment.partner_id,
        amount: asNumber(payment.amount),
        currency_id: payment.currency_id,
        payment_reference: payment.payment_reference,
        state: payment.state,
        new_pending_amount:
          payment.x_has_pending_amount === true
            ? asNumber(payment.x_pending_amount)
            : 0,
        allocated_amount: 0,
      })),
    source: "odoo",
    accounting_date: date,
    journal_ids: journalIds,
  };
}

export async function paymentsReport(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  const from = asDate(body.from || today());
  const to = asDate(body.to || today());
  if (from > to)
    throw new AppError("INVALID_PERIOD", "تاريخ البداية أكبر من تاريخ النهاية");
  const partnerId = asNumber(body.partner_id);
  const journalId = asNumber(body.journal_id);
  const state = cleanText(body.state, 30);
  const reference = cleanText(body.reference, 120);
  const minAmount = asNumber(body.min_amount);
  const maxAmount = asNumber(body.max_amount);
  const permissions = normalizedPermissions(user);
  let batchQuery = db
    .from("collection_portal_receipt_batches")
    .select(
      "id,user_id,employee_id,employee_name,status,batch_date,journal_id,currency_id,updated_at,approved_at",
    )
    .gte("batch_date", from)
    .lte("batch_date", to)
    .neq("status", "cancelled")
    .order("batch_date", { ascending: false })
    .order("updated_at", { ascending: false });
  const selectedUserId =
    permissions.reports_all && body.user_id
      ? cleanText(body.user_id, 64)
      : permissions.reports_all
        ? ""
        : user.id;
  if (selectedUserId) batchQuery = batchQuery.eq("user_id", selectedUserId);
  if (journalId) batchQuery = batchQuery.eq("journal_id", journalId);
  const { data: batches, error: batchError } = await batchQuery.limit(1000);
  if (batchError) throw batchError;
  const batchIds = (batches || []).map((batch: any) => String(batch.id));
  if (!batchIds.length) {
    return {
      records: [],
      totals: {
        count: 0,
        amount: 0,
        allocated: 0,
        planned_allocated: 0,
        unallocated: 0,
        new_pending: 0,
        draft_new_pending: 0,
        posted_new_pending: 0,
        customers: 0,
        draft_count: 0,
        draft_amount: 0,
        local_draft_count: 0,
        odoo_draft_count: 0,
        posted_count: 0,
        posted_amount: 0,
      },
      period: { from, to },
    };
  }
  const { data: localLines, error: lineError } = await db
    .from("collection_portal_receipt_lines")
    .select("*")
    .in("batch_id", batchIds)
    .order("sort_order", { ascending: true })
    .limit(3000);
  if (lineError) throw lineError;
  const batchById = new Map((batches || []).map((batch: any) => [String(batch.id), batch]));
  const paymentIds = (localLines || [])
    .map((line: any) => asNumber(line.odoo_payment_id))
    .filter((id: number) => id > 0);
  const pendingIds = (localLines || [])
    .map((line: any) => asNumber(line.created_pending_id))
    .filter((id: number) => id > 0);
  const [payments, createdPending] = await Promise.all([
    paymentIds.length
      ? odooCall(
        "account.payment",
        "read",
        {
          ids: [...new Set(paymentIds)],
          fields: [
            "id",
            "name",
            "date",
            "partner_id",
            "amount",
            "currency_id",
            "journal_id",
            "payment_reference",
            "memo",
            "state",
            "payment_type",
          ],
        },
        user,
        requestId,
        { action: "payments_report_linked_read" },
      )
      : Promise.resolve([]),
    pendingIds.length
      ? odooCall(
          "x_payment_pending",
          "read",
          {
            ids: [...new Set(pendingIds)],
            fields: ["id", "x_pending_amount", "x_remaining_amount", "x_settled_amount", "x_state"],
          },
          user,
          requestId,
          { action: "payments_report_created_pending_read" },
        )
      : Promise.resolve([]),
  ]);
  const paymentById = new Map(
    (payments || []).map((payment: any) => [asNumber(payment.id), payment]),
  );
  const pendingById = new Map(
    (createdPending || []).map((pending: any) => [asNumber(pending.id), pending]),
  );
  const allRows = (localLines || []).map((line: any) => {
    const batch: any = batchById.get(String(line.batch_id));
    const paymentId = asNumber(line.odoo_payment_id);
    const payment: any = paymentById.get(paymentId);
    const paymentState = payment
      ? String(payment.state || "draft")
      : paymentId
        ? "missing"
        : "local_draft";
    const actualSettled = settledAmount(line);
    const plannedAllocation = asNumber(line.allocation_amount);
    const posted = isPostedState(paymentState);
    const pending: any = pendingById.get(asNumber(line.created_pending_id));
    const pendingCreated =
      Boolean(pending) && String(pending.x_state || "") !== "cancelled";
    return {
      id: paymentId || String(line.id),
      name: payment?.name || (paymentId ? `Odoo #${paymentId}` : "غير مرفوع إلى Odoo"),
      date: payment?.date || batch?.batch_date,
      partner_id: payment?.partner_id || [asNumber(line.partner_id), line.partner_name],
      amount: payment ? asNumber(payment.amount) : asNumber(line.receipt_amount),
      currency_id: payment?.currency_id || [asNumber(batch?.currency_id), ""],
      journal_id: payment?.journal_id || [asNumber(batch?.journal_id), ""],
      payment_reference: payment?.payment_reference || line.reference,
      memo: payment?.memo || line.reference,
      state: paymentState,
      collector: {
        user_id: batch?.user_id,
        employee_id: batch?.employee_id,
        employee_name: batch?.employee_name,
      },
      allocated_amount: actualSettled,
      planned_allocation_amount: plannedAllocation,
      unallocated_amount: Math.max(
        0,
        asNumber(line.receipt_amount) - (posted ? actualSettled : plannedAllocation),
      ),
      new_pending_amount: pendingCreated
        ? asNumber(pending.x_pending_amount, asNumber(line.new_pending_amount))
        : asNumber(line.new_pending_amount),
      pending_created: pendingCreated,
      portal_status: line.status,
      batch_status: batch?.status,
      batch_id: line.batch_id,
      line_uuid: line.line_uuid,
      odoo_payment_id: paymentId || null,
      can_delete:
        DRAFT_STATES.has(paymentState) &&
        batch?.status !== "approved" &&
        line.status !== "completed" &&
        (!Array.isArray(line.settlement_ids) || !line.settlement_ids.length),
      can_edit:
        DRAFT_STATES.has(paymentState) &&
        batch?.status === "draft" &&
        (batch?.user_id === user.id || permissions.receipts_edit_all === true) &&
        permissions.receipts_enter === true &&
        line.status !== "completed" &&
        (!Array.isArray(line.settlement_ids) || !line.settlement_ids.length),
    };
  });
  const normalizedReference = reference.toLocaleLowerCase();
  const filteredRows = allRows.filter((row: any) => {
    if (partnerId && asNumber(row.partner_id?.[0]) !== partnerId) return false;
    if (state) {
      if (state === "draft") {
        if (!DRAFT_STATES.has(row.state)) return false;
      } else if (row.state !== state) return false;
    }
    if (
      normalizedReference &&
      !`${row.payment_reference || ""} ${row.name || ""}`
        .toLocaleLowerCase()
        .includes(normalizedReference)
    )
      return false;
    if (minAmount && row.amount < minAmount) return false;
    if (maxAmount && row.amount > maxAmount) return false;
    return true;
  });
  const limit = Math.min(3000, Math.max(1, asNumber(body.limit, 1000)));
  const rows = filteredRows
    .sort(
      (a: any, b: any) =>
        String(b.date || "").localeCompare(String(a.date || "")) ||
        String(b.id).localeCompare(String(a.id)),
    )
    .slice(0, limit);
  const draftRows = rows.filter((row: any) => DRAFT_STATES.has(row.state));
  const postedRows = rows.filter((row: any) => isPostedState(row.state));
  return {
    records: rows,
    totals: {
      count: rows.length,
      amount: rows.reduce(
        (sum: number, row: any) => sum + asNumber(row.amount),
        0,
      ),
      allocated: rows.reduce(
        (sum: number, row: any) => sum + asNumber(row.allocated_amount),
        0,
      ),
      planned_allocated: draftRows.reduce(
        (sum: number, row: any) => sum + asNumber(row.planned_allocation_amount),
        0,
      ),
      unallocated: rows.reduce(
        (sum: number, row: any) => sum + asNumber(row.unallocated_amount),
        0,
      ),
      new_pending: rows.reduce(
        (sum: number, row: any) =>
          sum + (row.pending_created ? asNumber(row.new_pending_amount) : 0),
        0,
      ),
      draft_new_pending: draftRows.reduce(
        (sum: number, row: any) => sum + asNumber(row.new_pending_amount),
        0,
      ),
      posted_new_pending: postedRows.reduce(
        (sum: number, row: any) => sum + asNumber(row.new_pending_amount),
        0,
      ),
      customers: new Set(
        rows.map((row: any) => asNumber(row.partner_id?.[0])).filter(Boolean),
      ).size,
      draft_count: draftRows.length,
      draft_amount: draftRows.reduce(
        (sum: number, row: any) => sum + asNumber(row.amount),
        0,
      ),
      local_draft_count: draftRows.filter((row: any) => row.state === "local_draft").length,
      odoo_draft_count: draftRows.filter((row: any) => row.state === "draft").length,
      posted_count: postedRows.length,
      posted_amount: postedRows.reduce(
        (sum: number, row: any) => sum + asNumber(row.amount),
        0,
      ),
    },
    period: { from, to },
  };
}

export async function dashboard(
  user: PortalUser,
  requestId: string,
  body: Record<string, unknown> = {},
) {
  const date = asDate(body.date || today());
  const daily = await realDailyTotals(user, date, requestId);
  const emptyTotals = outflowTotals([]);
  return {
    date,
    daily,
    payments: {
      posted_amount: 0,
      posted_count: 0,
      draft_amount: 0,
      draft_count: 0,
      odoo_draft_count: 0,
      local_draft_count: 0,
      allocated: 0,
      planned_allocated: 0,
      new_pending: 0,
      posted_new_pending: 0,
      draft_new_pending: 0,
    },
    pending: {
      count: 0,
      remaining: 0,
      over_30: 0,
      over_60: 0,
    },
    deposits: {
      count: 0,
      amount: 0,
    },
    outflows: {
      period: { from: date, to: date },
      rows: [],
      today_rows: [],
      today: emptyTotals,
      totals: emptyTotals,
    },
    recent: daily.recent_receipts,
  };
}

export async function dailyOutflowReport(
  user: PortalUser,
  body: Record<string, unknown>,
) {
  const permissions = normalizedPermissions(user);
  if (!permissions.expenses_enter && !permissions.expenses_approve)
    throw new AppError(
      "FORBIDDEN",
      "لا تملك صلاحية عرض المصروفات والسلف",
      403,
      "permission",
    );
  const to = asDate(body.to || today());
  const from = asDate(body.from || daysBefore(to, 30));
  if (from > to)
    throw new AppError("INVALID_PERIOD", "تاريخ البداية أكبر من تاريخ النهاية");

  let expensesQuery = db
    .from("collection_portal_expenses")
    .select("expense_date,amount,currency_id,status,user_id,company_id")
    .gte("expense_date", from)
    .lte("expense_date", to)
    .limit(5000);
  let advancesQuery = db
    .from("collection_portal_salary_advances")
    .select("advance_date,amount,currency_id,status,user_id,company_id")
    .gte("advance_date", from)
    .lte("advance_date", to)
    .limit(5000);
  if (!permissions.expenses_view_all) {
    expensesQuery = expensesQuery.eq("user_id", user.id);
    advancesQuery = advancesQuery.eq("user_id", user.id);
  } else if (user.company_id) {
    expensesQuery = expensesQuery.eq("company_id", user.company_id);
    advancesQuery = advancesQuery.eq("company_id", user.company_id);
  }
  const [expenseResult, advanceResult] = await Promise.all([
    expensesQuery,
    advancesQuery,
  ]);
  if (expenseResult.error) throw expenseResult.error;
  if (advanceResult.error) throw advanceResult.error;

  const rows = aggregateDailyOutflows([
    ...(expenseResult.data || []).map((row: any) => ({
      source: "expense" as const,
      date: String(row.expense_date || ""),
      amount: asNumber(row.amount),
      currency_id: asNumber(row.currency_id) || null,
      status: String(row.status || ""),
    })),
    ...(advanceResult.data || []).map((row: any) => ({
      source: "advance" as const,
      date: String(row.advance_date || ""),
      amount: asNumber(row.amount),
      currency_id: asNumber(row.currency_id) || null,
      status: String(row.status || ""),
    })),
  ]);
  const todayRows = rows.filter((row) => row.date === to);
  return {
    period: { from, to },
    rows,
    today_rows: todayRows,
    today: outflowTotals(todayRows),
    totals: outflowTotals(rows),
  };
}

export async function collectorReport(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  const selectedUserId =
    normalizedPermissions(user).reports_all && body.user_id
      ? cleanText(body.user_id, 64)
      : user.id;
  const payments = await paymentsReport(
    user,
    {
      from: body.from || today(),
      to: body.to || today(),
      user_id: selectedUserId,
      limit: 2000,
    },
    requestId,
  );
  return {
    user_id: selectedUserId,
    totals: payments.totals,
    recent: payments.records.slice(0, 20),
  };
}

export async function connectionHealth(user: PortalUser, requestId: string) {
  const { settings } = await getConfig();
  const journalId = scopedJournal(user, user.journal_id, settings.journal_id);
  const [journal, paymentFields, pendingFields] = await Promise.all([
    odooCall(
      "account.journal",
      "search_read",
      {
        domain: [["id", "=", journalId]],
        fields: ["id", "name", "type"],
        limit: 1,
      },
      user,
      requestId,
      { action: "health_journal" },
    ),
    odooCall(
      "account.payment",
      "fields_get",
      { attributes: ["type", "required"] },
      user,
      requestId,
      { action: "health_payment_model" },
    ),
    odooCall(
      "x_payment_pending",
      "fields_get",
      { attributes: ["type", "required"] },
      user,
      requestId,
      { action: "health_pending_model" },
    ),
  ]);
  return {
    connected: true,
    journal: journal?.[0] || null,
    checks: {
      account_payment: Boolean(
        paymentFields?.payment_reference && paymentFields?.memo,
      ),
      pending: Boolean(
        pendingFields?.x_remaining_amount && pendingFields?.x_journal_id,
      ),
      payment_reference_field: Boolean(paymentFields?.payment_reference),
      memo_field: Boolean(paymentFields?.memo),
    },
  };
}

export async function depositList(user: PortalUser) {
  let query = db
    .from("collection_portal_deposits")
    .select("*")
    .order("deposit_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (user.role !== "manager") query = query.eq("user_id", user.id);
  const { data, error } = await query;
  if (error) throw error;
  return { deposits: data || [] };
}

export async function saveDeposit(
  user: PortalUser,
  body: Record<string, unknown>,
) {
  const deposit = (body.deposit || {}) as Record<string, unknown>;
  const amount = asNumber(deposit.amount);
  if (amount <= 0) throw new AppError("INVALID_AMOUNT", "المبلغ غير صحيح");
  const { settings } = await getConfig();
  const sourceJournal = scopedJournal(
    user,
    deposit.source_journal_id,
    settings.journal_id,
  );
  const row = {
    user_id: user.id,
    employee_id: user.employee_id,
    employee_name: user.employee_name,
    company_id: asNumber(user.company_id || settings.company_id) || null,
    source_journal_id: sourceJournal,
    destination_journal_id: asNumber(deposit.destination_journal_id) || null,
    amount,
    currency_id:
      asNumber(
        deposit.currency_id || user.currency_id || settings.currency_id,
      ) || null,
    deposit_date: asDate(deposit.deposit_date),
    reference: cleanText(deposit.reference, 120) || null,
    note: cleanText(deposit.note, 1000) || null,
    status: "recorded",
  };
  if (!row.destination_journal_id)
    throw new AppError("DESTINATION_REQUIRED", "اختر البنك أو دفتر الوجهة");
  const { data, error } = await db
    .from("collection_portal_deposits")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return { deposit: data };
}

export async function closureList(user: PortalUser) {
  let query = db
    .from("collection_portal_closures")
    .select("*")
    .order("closure_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (user.role !== "manager") query = query.eq("user_id", user.id);
  const { data, error } = await query;
  if (error) throw error;
  return { closures: data || [] };
}

export async function saveClosure(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  requirePermission(user, "closures_create");
  const closure = (body.closure || {}) as Record<string, unknown>;
  const date = asDate(closure.closure_date);
  const summary = await dashboard(user, requestId);
  const row = {
    user_id: user.id,
    employee_id: user.employee_id,
    employee_name: user.employee_name,
    closure_date: date,
    note: cleanText(closure.note, 1000) || null,
    summary,
  };
  const { data, error } = await db
    .from("collection_portal_closures")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return { closure: data };
}
