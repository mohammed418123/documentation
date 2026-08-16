import { AppError, asNumber, db, PortalUser } from "./core.ts";

type OdooSettings = {
  odoo_url: string;
  odoo_database: string;
  company_id: number | null;
  journal_id: number | null;
  method_id: number | null;
  currency_id: number | null;
};

type OdooKey = {
  slot: "primary" | "backup";
  value: string;
  updated_at?: string | null;
};

let cached:
  | { at: number; settings: OdooSettings; keys: OdooKey[] }
  | undefined;

export function clearConfigCache() {
  cached = undefined;
}

export async function getStoredSettings() {
  const { data: settings, error } = await db
    .from("collection_portal_settings")
    .select("*")
    .eq("id", 1)
    .single();
  if (error || !settings) {
    throw new AppError(
      "SETTINGS_MISSING",
      "إعدادات Odoo غير مكتملة",
      500,
      "backend",
    );
  }
  return settings as OdooSettings;
}

export async function getConfig() {
  if (cached && Date.now() - cached.at < 60_000) return cached;
  const [settings, { data: secrets, error: secretError }] =
    await Promise.all([
      getStoredSettings(),
      db
        .from("collection_portal_secrets")
        .select("secret_name,secret_value,updated_at")
        .in("secret_name", [
          "odoo_api_key_primary",
          "odoo_api_key_backup",
          "odoo_api_key",
        ]),
    ]);
  const secretByName = new Map(
    (secrets || []).map((row: any) => [String(row.secret_name), row]),
  );
  const primary =
    secretByName.get("odoo_api_key_primary") ||
    secretByName.get("odoo_api_key");
  const backup = secretByName.get("odoo_api_key_backup");
  const keys: OdooKey[] = [
    ...(primary?.secret_value
      ? [
          {
            slot: "primary" as const,
            value: String(primary.secret_value),
            updated_at: primary.updated_at || null,
          },
        ]
      : []),
    ...(backup?.secret_value && backup.secret_value !== primary?.secret_value
      ? [
          {
            slot: "backup" as const,
            value: String(backup.secret_value),
            updated_at: backup.updated_at || null,
          },
        ]
      : []),
  ];
  if (secretError || !keys.length) {
    throw new AppError(
      "ODOO_KEY_MISSING",
      "لا يوجد مفتاح Odoo صالح. حدّث المفتاح من صفحة الإعدادات.",
      500,
      "configuration",
    );
  }
  cached = {
    at: Date.now(),
    settings,
    keys,
  };
  return cached;
}

async function callWithKey(
  endpoint: string,
  database: string,
  key: string,
  args: Record<string, unknown>,
  requestId: string,
) {
  return await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `bearer ${key}`,
      "X-Odoo-Database": database,
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30_000),
  });
}

const READ_ONLY_ODOO_METHODS = new Set([
  "read",
  "search",
  "search_count",
  "search_read",
  "fields_get",
  "name_search",
]);

function retryDelay(response: Response, attempt: number) {
  const retryAfterSeconds = Number(response.headers.get("retry-after") || 0);
  const fromHeader =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 0;
  return Math.min(2_500, Math.max(fromHeader, 400 * 2 ** attempt));
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function testOdooKey(
  candidate: string,
  user: PortalUser,
  requestId: string,
) {
  const settings = await getStoredSettings();
  const endpoint = `${String(settings.odoo_url).replace(/\/$/, "")}/json/2/res.company/search_read`;
  let response: Response;
  try {
    response = await callWithKey(
      endpoint,
      settings.odoo_database,
      candidate,
      {
        domain: [],
        fields: ["id", "name"],
        limit: 1,
        context: {
          lang: "ar_001",
          ...(user.company_id
            ? {
                allowed_company_ids: [asNumber(user.company_id)],
                company_id: asNumber(user.company_id),
              }
            : {}),
        },
      },
      requestId,
    );
  } catch (error) {
    throw new AppError(
      "ODOO_KEY_TEST_NETWORK",
      "تعذر فحص المفتاح بسبب مشكلة اتصال مع Odoo",
      503,
      "odoo",
      {
        request_id: requestId,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (!response.ok) {
    throw new AppError(
      response.status === 401 ? "ODOO_KEY_INVALID" : "ODOO_KEY_TEST_FAILED",
      response.status === 401
        ? "رفض Odoo المفتاح. تأكد من نسخه كاملًا وأنه غير منتهي أو ملغي."
        : "لم ينجح فحص المفتاح في Odoo. تحقق من صلاحيات مستخدم المفتاح.",
      response.status === 401 ? 422 : 502,
      "configuration",
      { http_status: response.status, request_id: requestId },
    );
  }
  return true;
}

export async function odooCall(
  model: string,
  method: string,
  args: Record<string, unknown>,
  user: PortalUser,
  requestId: string,
  options: { noCompany?: boolean; action?: string } = {},
) {
  const config = await getConfig();
  const { settings } = config;
  const companyId = asNumber(user.company_id || settings.company_id);
  const context = {
    lang: "ar_001",
    ...((args.context as Record<string, unknown>) || {}),
    ...(!options.noCompany && companyId
      ? { allowed_company_ids: [companyId], company_id: companyId }
      : {}),
  };
  const endpoint = `${String(settings.odoo_url).replace(/\/$/, "")}/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`;
  let response: Response;
  let usedSlot = config.keys[0].slot;
  try {
    response = await callWithKey(
      endpoint,
      settings.odoo_database,
      config.keys[0].value,
      { ...args, context },
      requestId,
    );
    if (response.status === 401 && config.keys[1]) {
      usedSlot = config.keys[1].slot;
      response = await callWithKey(
        endpoint,
        settings.odoo_database,
        config.keys[1].value,
        { ...args, context },
        requestId,
      );
    }
    if (response.status === 429 && READ_ONLY_ODOO_METHODS.has(method)) {
      for (
        let attempt = 0;
        attempt < 2 && response.status === 429;
        attempt += 1
      ) {
        await wait(retryDelay(response, attempt));
        response = await callWithKey(
          endpoint,
          settings.odoo_database,
          config.keys.find((key) => key.slot === usedSlot)?.value ||
            config.keys[0].value,
          { ...args, context },
          requestId,
        );
      }
    }
  } catch (error) {
    throw new AppError(
      "ODOO_NETWORK",
      "تعذر الاتصال بـ Odoo. تحقق من الإنترنت ثم أعد المحاولة.",
      503,
      "odoo",
      {
        action: options.action || "odoo_call",
        model,
        method,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const raw = await response.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw: raw.slice(0, 1000) };
  }
  if (!response.ok) {
    const value = data as Record<string, any>;
    const message =
      value?.message ||
      value?.data?.message ||
      value?.error ||
      `Odoo HTTP ${response.status}`;
    const invalidKey = response.status === 401;
    const rateLimited = response.status === 429;
    const permission =
      response.status === 403 ||
      /access|permission|صلاح/i.test(String(message));
    throw new AppError(
      invalidKey
        ? "ODOO_KEY_EXPIRED"
        : rateLimited
          ? "ODOO_RATE_LIMIT"
        : permission
          ? "ODOO_PERMISSION"
          : "ODOO_ERROR",
      invalidKey
        ? "رفض Odoo مفتاحي الربط. حدّث المفتاح من صفحة الإعدادات ثم أعد المحاولة."
        : rateLimited
          ? "Odoo مشغول مؤقتًا بسبب كثرة الطلبات. انتظر قليلًا ثم أعد المحاولة؛ لن يكرر التطبيق السلفة أو السند."
        : permission
        ? "لا توجد صلاحية كافية لتنفيذ العملية في Odoo"
        : String(message),
      invalidKey ? 401 : rateLimited ? 503 : permission ? 403 : 502,
      invalidKey ? "configuration" : permission ? "permission" : "odoo",
      {
        action: options.action || "odoo_call",
        model,
        method,
        http_status: response.status,
        key_slot: usedSlot,
        odoo_message: String(message).slice(0, 1000),
      },
    );
  }
  return data as any;
}

export async function fieldMap(
  model: string,
  user: PortalUser,
  requestId: string,
) {
  return await odooCall(
    model,
    "fields_get",
    {
      attributes: [
        "type",
        "string",
        "relation",
        "selection",
        "required",
        "readonly",
      ],
    },
    user,
    requestId,
    { action: "fields_get" },
  );
}

export function scopedJournal(
  user: PortalUser,
  requested: unknown,
  fallback?: unknown,
) {
  const journalId = asNumber(requested || user.journal_id || fallback);
  if (!journalId) {
    throw new AppError(
      "JOURNAL_NOT_ASSIGNED",
      "لم يتم تعيين دفتر التحصيل لهذا الموظف. راجع المدير.",
      422,
      "configuration",
    );
  }
  if (user.role !== "manager" && journalId !== asNumber(user.journal_id)) {
    throw new AppError(
      "JOURNAL_FORBIDDEN",
      "لا يمكنك استخدام دفتر تحصيل آخر",
      403,
      "permission",
    );
  }
  return journalId;
}
