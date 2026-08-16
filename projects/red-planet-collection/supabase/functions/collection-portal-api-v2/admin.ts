import {
  AppError,
  asNumber,
  audit,
  cleanText,
  db,
  managerOnly,
  normalizedPermissions,
  PERMISSION_KEYS,
  PortalUser,
} from "./core.ts";
import { hashPin } from "./auth.ts";
import {
  clearConfigCache,
  fieldMap,
  getStoredSettings,
  odooCall,
  testOdooKey,
} from "./odoo.ts";

export async function usersList(user: PortalUser) {
  managerOnly(user);
  const [{ data: users, error }, { data: sessions }] = await Promise.all([
    db
      .from("collection_portal_users")
      .select(
        "id,employee_id,employee_name,role,active,company_id,journal_id,method_id,expense_method_id,currency_id,permissions,created_at,updated_at,last_login_at,locked_until",
      )
      .order("employee_name"),
    db
      .from("collection_portal_sessions")
      .select("user_id,last_seen_at,expires_at,revoked_at")
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("last_seen_at", { ascending: false }),
  ]);
  if (error) throw error;
  const lastSeen = new Map<string, string>();
  const activeSessions = new Map<string, number>();
  for (const session of sessions || []) {
    if (!lastSeen.has(session.user_id))
      lastSeen.set(session.user_id, session.last_seen_at);
    activeSessions.set(
      session.user_id,
      (activeSessions.get(session.user_id) || 0) + 1,
    );
  }
  return {
    users: (users || []).map((row) => ({
      ...row,
      last_seen_at: lastSeen.get(row.id) || null,
      active_sessions: activeSessions.get(row.id) || 0,
    })),
  };
}

export async function saveUser(
  actor: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  managerOnly(actor);
  const input = (body.user || {}) as Record<string, unknown>;
  const id = cleanText(input.id, 64);
  const name = cleanText(input.employee_name, 300);
  const role = input.role === "manager" ? "manager" : "collector";
  const pin = cleanText(input.pin, 32);
  const active = input.active !== false;
  const requestedPermissions =
    input.permissions && typeof input.permissions === "object"
      ? (input.permissions as Record<string, unknown>)
      : {};
  const permissions =
    role === "manager"
      ? normalizedPermissions({ ...actor, role: "manager" })
      : Object.fromEntries(
          PERMISSION_KEYS.map((key) => [key, requestedPermissions[key] === true]),
        );
  if (
    permissions.pending_view_all ||
    permissions.pending_create ||
    permissions.pending_opening_create ||
    permissions.pending_opening_view ||
    permissions.pending_collect ||
    permissions.pending_settle
  ) {
    permissions.pending_view = true;
  }
  if (!name) throw new AppError("USER_NAME_REQUIRED", "اسم الموظف مطلوب");
  if (!id && !/^\d{4,12}$/.test(pin)) {
    throw new AppError(
      "PIN_INVALID",
      "PIN الجديد يجب أن يكون من 4 إلى 12 رقمًا",
    );
  }
  if (pin && !/^\d{4,12}$/.test(pin)) {
    throw new AppError(
      "PIN_INVALID",
      "PIN الجديد يجب أن يكون من 4 إلى 12 رقمًا",
    );
  }
  const row: Record<string, unknown> = {
    employee_id: asNumber(input.employee_id) || null,
    employee_name: name,
    role,
    active,
    company_id: asNumber(input.company_id) || null,
    journal_id: asNumber(input.journal_id) || null,
    method_id: asNumber(input.method_id) || null,
    expense_method_id: asNumber(input.expense_method_id) || null,
    currency_id: asNumber(input.currency_id) || null,
    permissions,
    updated_at: new Date().toISOString(),
  };
  if (pin) {
    row.pin_hash = await hashPin(pin);
    row.pin_changed_at = new Date().toISOString();
    row.failed_login_count = 0;
    row.locked_until = null;
  }
  if (role === "collector") {
    for (const key of [
      "company_id",
      "journal_id",
      "method_id",
      "currency_id",
    ]) {
      if (!row[key]) {
        throw new AppError(
          "COLLECTOR_CONFIG_REQUIRED",
          "أكمل الشركة ودفتر التحصيل والعملة وطريقة الدفع للمتحصل",
        );
      }
    }
  }
  let savedId = id;
  if (id) {
    const { error } = await db
      .from("collection_portal_users")
      .update(row)
      .eq("id", id);
    if (error) throw error;
  } else {
    const { data, error } = await db
      .from("collection_portal_users")
      .insert(row)
      .select("id")
      .single();
    if (error) throw error;
    savedId = data.id;
  }
  if ((pin || !active) && savedId) {
    await db
      .from("collection_portal_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", savedId)
      .is("revoked_at", null);
  }
  await audit(
    actor,
    id ? "تعديل مستخدم" : "إضافة مستخدم",
    `${name} (${role})`,
    requestId,
    { user_id: savedId },
  );
  return { user_id: savedId };
}

export async function employees(user: PortalUser, requestId: string) {
  managerOnly(user);
  for (const model of ["hr.employee", "hr.employee.public"]) {
    try {
      const available = await fieldMap(model, user, requestId);
      const fields = [
        "id",
        "name",
        "company_id",
        "department_id",
        "job_id",
        "work_phone",
        "work_email",
        "active",
      ].filter((field) => Boolean(available?.[field]));
      const rows = await odooCall(
        model,
        "search_read",
        {
          domain: [["active", "=", true]],
          fields,
          limit: 1000,
          order: "name asc",
        },
        user,
        requestId,
        { action: "employees_list" },
      );
      return { model, employees: rows || [] };
    } catch {
      // Try the public employee model when the API user cannot read hr.employee.
    }
  }
  throw new AppError(
    "EMPLOYEES_UNAVAILABLE",
    "تعذر قراءة الموظفين من Odoo",
    502,
    "odoo",
  );
}

export async function saveSettings(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  if (!normalizedPermissions(user).settings_manage)
    throw new AppError("FORBIDDEN", "لا تملك صلاحية تعديل الإعدادات", 403, "permission");
  const input = (body.settings || {}) as Record<string, unknown>;
  const row = {
    company_id: asNumber(input.company_id) || null,
    journal_id: asNumber(input.journal_id) || null,
    method_id: asNumber(input.method_id) || null,
    currency_id: asNumber(input.currency_id) || null,
    updated_at: new Date().toISOString(),
  };
  if (
    !row.company_id ||
    !row.journal_id ||
    !row.method_id ||
    !row.currency_id
  ) {
    throw new AppError(
      "SETTINGS_REQUIRED",
      "أكمل الشركة والدفتر والعملة وطريقة الدفع",
    );
  }
  const { error } = await db
    .from("collection_portal_settings")
    .update(row)
    .eq("id", 1);
  if (error) throw error;
  await audit(user, "تعديل الإعدادات", "", requestId, row);
  return { settings: row };
}

export async function auditList(
  user: PortalUser,
  body: Record<string, unknown>,
) {
  if (!normalizedPermissions(user).audit_view)
    throw new AppError("FORBIDDEN", "لا تملك صلاحية عرض سجل النشاط", 403, "permission");
  let query = db
    .from("collection_portal_audit")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(1000, Math.max(1, asNumber(body.limit, 500))));
  const severity = cleanText(body.severity, 20);
  if (severity) query = query.eq("severity", severity);
  const { data, error } = await query;
  if (error) throw error;
  return { audit: data || [] };
}

export async function settingsSummary(user: PortalUser) {
  if (!normalizedPermissions(user).settings_manage)
    throw new AppError("FORBIDDEN", "لا تملك صلاحية عرض الإعدادات", 403, "permission");
  const settings = await getStoredSettings();
  const { data: secrets, error } = await db
    .from("collection_portal_secrets")
    .select("secret_name,updated_at")
    .in("secret_name", [
      "odoo_api_key_primary",
      "odoo_api_key_backup",
      "odoo_api_key",
    ]);
  if (error) throw error;
  const byName = new Map(
    (secrets || []).map((row: any) => [String(row.secret_name), row]),
  );
  const primary =
    byName.get("odoo_api_key_primary") || byName.get("odoo_api_key");
  const backup = byName.get("odoo_api_key_backup");
  return {
    settings: {
      company_id: settings.company_id,
      journal_id: settings.journal_id,
      method_id: settings.method_id,
      currency_id: settings.currency_id,
    },
    odoo_keys: {
      primary: {
        configured: Boolean(primary),
        updated_at: primary?.updated_at || null,
      },
      backup: {
        configured: Boolean(backup),
        updated_at: backup?.updated_at || null,
      },
    },
  };
}

export async function saveOdooKey(
  user: PortalUser,
  body: Record<string, unknown>,
  requestId: string,
) {
  if (!normalizedPermissions(user).settings_manage)
    throw new AppError(
      "FORBIDDEN",
      "لا تملك صلاحية تعديل مفاتيح Odoo",
      403,
      "permission",
    );
  const slot = body.slot === "backup" ? "backup" : "primary";
  const key = cleanText(body.key, 500);
  if (key.length < 20)
    throw new AppError(
      "ODOO_KEY_TOO_SHORT",
      "المفتاح غير مكتمل. انسخه كاملًا من Odoo.",
      422,
      "validation",
    );

  await testOdooKey(key, user, requestId);
  const secretName =
    slot === "backup" ? "odoo_api_key_backup" : "odoo_api_key_primary";
  const updatedAt = new Date().toISOString();
  const { error } = await db.from("collection_portal_secrets").upsert(
    {
      secret_name: secretName,
      secret_value: key,
      updated_at: updatedAt,
    },
    { onConflict: "secret_name" },
  );
  if (error) throw error;
  clearConfigCache();
  await audit(
    user,
    slot === "backup" ? "تحديث مفتاح Odoo الاحتياطي" : "تحديث مفتاح Odoo الأساسي",
    "تم فحص المفتاح وحفظه دون إظهار قيمته",
    requestId,
    { slot, updated_at: updatedAt },
  );
  return {
    slot,
    configured: true,
    updated_at: updatedAt,
    tested: true,
  };
}
