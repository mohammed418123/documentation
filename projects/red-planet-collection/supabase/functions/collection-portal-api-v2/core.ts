import { createClient } from "npm:@supabase/supabase-js@2.95.0";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export type PortalUser = {
  id: string;
  employee_id: number | null;
  employee_name: string;
  role: "manager" | "collector";
  active: boolean;
  company_id: number | null;
  journal_id: number | null;
  method_id: number | null;
  expense_method_id?: number | null;
  currency_id: number | null;
  permissions?: Record<string, boolean> | null;
  failed_login_count?: number;
  locked_until?: string | null;
};

export const PERMISSION_KEYS = [
  "receipts_enter",
  "receipts_post",
  "receipts_sync",
  "receipts_edit_all",
  "pending_view",
  "pending_view_all",
  "pending_create",
  "pending_opening_create",
  "pending_opening_view",
  "pending_collect",
  "pending_settle",
  "deposits_create",
  "deposits_approve",
  "expenses_enter",
  "expenses_view_all",
  "expenses_approve",
  "expenses_cancel",
  "reports_all",
  "closures_create",
  "users_manage",
  "audit_view",
  "settings_manage",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const collectorDefaults: Record<PermissionKey, boolean> = {
  receipts_enter: true,
  receipts_post: true,
  receipts_sync: true,
  receipts_edit_all: false,
  pending_view: true,
  pending_view_all: false,
  pending_create: true,
  pending_opening_create: false,
  pending_opening_view: true,
  pending_collect: true,
  pending_settle: true,
  deposits_create: true,
  deposits_approve: false,
  expenses_enter: true,
  expenses_view_all: false,
  expenses_approve: false,
  expenses_cancel: false,
  reports_all: false,
  closures_create: true,
  users_manage: false,
  audit_view: false,
  settings_manage: false,
};

export function normalizedPermissions(user: PortalUser) {
  return Object.fromEntries(
    PERMISSION_KEYS.map((key) => [
      key,
      user.role === "manager" ? true : user.permissions?.[key] ?? collectorDefaults[key],
    ]),
  ) as Record<PermissionKey, boolean>;
}

export function requirePermission(user: PortalUser, permission: PermissionKey) {
  if (!normalizedPermissions(user)[permission]) {
    throw new AppError(
      "FORBIDDEN",
      "ليس لديك صلاحية تنفيذ هذه العملية",
      403,
      "permission",
      { permission },
    );
  }
}

export class AppError extends Error {
  code: string;
  status: number;
  category: string;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    category = "validation",
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.category = category;
    this.details = details;
  }
}

const allowedOrigins = [
  /^https:\/\/red-planet-collection(?:-[a-z0-9-]+)?(?:-[a-z0-9-]+)?\.vercel\.app$/i,
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i,
];

export function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = allowedOrigins.some((rx) => rx.test(origin))
    ? origin
    : "https://red-planet-collection.vercel.app";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

export function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(req),
  });
}

export function asNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asDate(value: unknown) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new AppError("INVALID_DATE", "التاريخ غير صحيح");
  }
  return text;
}

export function cleanText(value: unknown, max = 500) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

export function managerOnly(user: PortalUser) {
  requirePermission(user, "users_manage");
}

export async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function audit(
  user: PortalUser | null,
  action: string,
  detail = "",
  requestId?: string,
  metadata: Record<string, unknown> = {},
  severity = "info",
) {
  const { error } = await db.from("collection_portal_audit").insert({
    user_id: user?.id || null,
    employee_id: user?.employee_id || null,
    employee_name: user?.employee_name || "النظام",
    action,
    detail: detail.slice(0, 1000),
    request_id: requestId || null,
    metadata,
    severity,
  });
  if (error) console.error("audit_failed", error.message);
}

export function normalizedError(error: unknown, requestId: string) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          category: error.category,
          request_id: requestId,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: "BACKEND_ERROR",
        message: "حدث خطأ في الخادم. استخدم رقم التتبع عند المراجعة.",
        category: "backend",
        request_id: requestId,
        details: { internal_message: message.slice(0, 500) },
      },
    },
  };
}
