import { AppError, audit, corsHeaders, json, normalizedError } from "./core.ts";
import {
  getSession,
  listPublicUsers,
  login,
  logout,
  publicUser,
} from "./auth.ts";
import {
  auditList,
  employees,
  saveSettings,
  saveOdooKey,
  saveUser,
  settingsSummary,
  usersList,
} from "./admin.ts";
import {
  approveBatch,
  bootstrap,
  createPartner,
  createPendingBalances,
  deleteReceiptDraft,
  listDrafts,
  loadDraft,
  partnerPending,
  partnerSearch,
  pendingList,
  saveDraft,
  settlePending,
  syncReceiptStates,
} from "./receipts.ts";
import {
  closureList,
  collectorReport,
  connectionHealth,
  dailyOutflowReport,
  dashboard,
  paymentsReport,
  saveClosure,
} from "./reports.ts";
import {
  depositList,
  postDeposit,
  rejectDeposit,
  saveDeposit,
} from "./deposits.ts";
import {
  approveExpense,
  deleteExpenseDraft,
  expenseBootstrap,
  expenseList,
  rejectExpense,
  requestExpenseCorrection,
  saveExpense,
  submitExpense,
} from "./expenses.ts";
import {
  approveSalaryAdvance,
  deleteSalaryAdvanceDraft,
  rejectSalaryAdvance,
  requestSalaryAdvanceCorrection,
  salaryAdvanceBootstrap,
  salaryAdvanceList,
  saveSalaryAdvance,
  submitSalaryAdvance,
} from "./salary-advances.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST")
    return json(
      req,
      { ok: false, error: { code: "POST_ONLY", message: "POST only" } },
      405,
    );

  const requestId = crypto.randomUUID();
  let currentUser: any = null;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "public_users") {
      return json(req, {
        ok: true,
        request_id: requestId,
        users: await listPublicUsers(),
      });
    }
    if (action === "login") {
      const result = await login(body, req, requestId);
      return json(req, { ok: true, request_id: requestId, ...result });
    }

    const { user, tokenHash } = await getSession(body.token);
    currentUser = user;
    let result: Record<string, unknown>;
    switch (action) {
      case "me": result = { user: publicUser(user) }; break;
      case "logout": await logout(tokenHash, user, requestId); result = {}; break;
      case "bootstrap": result = await bootstrap(user, requestId); break;
      case "health": result = await connectionHealth(user, requestId); break;
      case "partner_search": result = await partnerSearch(user, body, requestId); break;
      case "partner_create": result = await createPartner(user, body, requestId); break;
      case "partner_pending": result = await partnerPending(user, body, requestId); break;
      case "pending_list": result = await pendingList(user, body, requestId); break;
      case "pending_create": result = await createPendingBalances(user, body, requestId); break;
      case "pending_settle": result = await settlePending(user, body, requestId); break;
      case "draft_save":
        result = await saveDraft(user, body, requestId);
        await audit(user, "حفظ مسودة سندات قبض", String(result.batch_id || ""), requestId);
        break;
      case "receipt_delete": result = await deleteReceiptDraft(user, body, requestId); break;
      case "draft_load": result = await loadDraft(user, body, requestId); break;
      case "draft_list": result = await listDrafts(user, requestId); break;
      case "receipt_sync": result = await syncReceiptStates(user, body, requestId); break;
      case "batch_approve": result = await approveBatch(user, body, requestId); break;
      case "dashboard": result = await dashboard(user, requestId, body); break;
      case "daily_outflow_report": result = await dailyOutflowReport(user, body); break;
      case "payments_report": result = await paymentsReport(user, body, requestId); break;
      case "collector_report": result = await collectorReport(user, body, requestId); break;
      case "deposit_list": result = await depositList(user); break;
      case "deposit_save":
        result = await saveDeposit(user, body, requestId);
        await audit(user, "تسجيل توريد", String((result.deposit as any)?.amount || ""), requestId, result);
        break;
      case "deposit_post": result = await postDeposit(user, body, requestId); break;
      case "deposit_reject": result = await rejectDeposit(user, body, requestId); break;
      case "expense_bootstrap": result = await expenseBootstrap(user, requestId); break;
      case "expense_list": result = await expenseList(user); break;
      case "expense_save": result = await saveExpense(user, body, requestId); break;
      case "expense_submit": result = await submitExpense(user, body, requestId); break;
      case "expense_approve": result = await approveExpense(user, body, requestId); break;
      case "expense_reject": result = await rejectExpense(user, body, requestId); break;
      case "expense_request_correction": result = await requestExpenseCorrection(user, body, requestId); break;
      case "expense_delete": result = await deleteExpenseDraft(user, body, requestId); break;
      case "salary_advance_bootstrap": result = await salaryAdvanceBootstrap(user, requestId); break;
      case "salary_advance_list": result = await salaryAdvanceList(user); break;
      case "salary_advance_save": result = await saveSalaryAdvance(user, body, requestId); break;
      case "salary_advance_submit": result = await submitSalaryAdvance(user, body, requestId); break;
      case "salary_advance_approve": result = await approveSalaryAdvance(user, body, requestId); break;
      case "salary_advance_reject": result = await rejectSalaryAdvance(user, body, requestId); break;
      case "salary_advance_request_correction": result = await requestSalaryAdvanceCorrection(user, body, requestId); break;
      case "salary_advance_delete": result = await deleteSalaryAdvanceDraft(user, body, requestId); break;
      case "closure_list": result = await closureList(user); break;
      case "closure_save":
        result = await saveClosure(user, body, requestId);
        await audit(user, "إغلاق يومية", String((result.closure as any)?.closure_date || ""), requestId);
        break;
      case "users_list": result = await usersList(user); break;
      case "user_save": result = await saveUser(user, body, requestId); break;
      case "employees": result = await employees(user, requestId); break;
      case "settings_get": result = await settingsSummary(user); break;
      case "settings_save": result = await saveSettings(user, body, requestId); break;
      case "odoo_key_save": result = await saveOdooKey(user, body, requestId); break;
      case "audit_list": result = await auditList(user, body); break;
      default:
        throw new AppError("UNKNOWN_ACTION", "إجراء غير معروف", 400, "validation");
    }
    return json(req, { ok: true, request_id: requestId, ...result });
  } catch (error) {
    const normalized = normalizedError(error, requestId);
    if (currentUser) {
      await audit(
        currentUser,
        "خطأ Backend",
        (normalized.body as any)?.error?.message || "خطأ",
        requestId,
        (normalized.body as any)?.error || {},
        "error",
      );
    }
    return json(req, normalized.body, normalized.status);
  }
});
