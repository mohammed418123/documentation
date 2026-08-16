import {
  AppError,
  audit,
  cleanText,
  db,
  normalizedPermissions,
  PortalUser,
  randomToken,
  sha256,
} from "./core.ts";

const PBKDF2_ITERATIONS = 240_000;

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  if (!/^[a-f0-9]+$/i.test(hex) || hex.length % 2) return new Uint8Array();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function pbkdf2(pin: string, salt: Uint8Array, iterations: number) {
  const saltBuffer = salt.buffer.slice(
    salt.byteOffset,
    salt.byteOffset + salt.byteLength,
  ) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function hashPin(pin: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const digest = await pbkdf2(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${digest}`;
}

async function verifyPin(pin: string, stored: string) {
  if (stored.startsWith("pbkdf2$")) {
    const [, iterationsText, saltHex, expected] = stored.split("$");
    const iterations = Number(iterationsText);
    if (!iterations || !saltHex || !expected)
      return { valid: false, legacy: false };
    const actual = await pbkdf2(pin, hexToBytes(saltHex), iterations);
    return { valid: actual === expected, legacy: false };
  }
  return { valid: (await sha256(pin)) === stored, legacy: true };
}

export function publicUser(user: PortalUser) {
  return {
    id: user.id,
    employee_id: user.employee_id,
    name: user.employee_name,
    role: user.role,
    company_id: user.company_id,
    journal_id: user.journal_id,
    method_id: user.method_id,
    expense_method_id: user.expense_method_id || null,
    currency_id: user.currency_id,
    permissions: normalizedPermissions(user),
  };
}

export async function listPublicUsers() {
  const { data, error } = await db
    .from("collection_portal_users")
    .select("id,employee_name")
    .eq("active", true)
    .order("employee_name");
  if (error) throw error;
  return (data || []).map((x) => ({ id: x.id, name: x.employee_name }));
}

export async function login(
  body: Record<string, unknown>,
  req: Request,
  requestId: string,
) {
  const userId = cleanText(body.user_id, 64);
  const pin = cleanText(body.pin, 32);
  if (!userId || !pin) {
    throw new AppError("LOGIN_REQUIRED", "اختر الموظف وأدخل PIN", 400, "auth");
  }

  const { data: user, error } = await db
    .from("collection_portal_users")
    .select("*")
    .eq("id", userId)
    .eq("active", true)
    .maybeSingle();
  if (error || !user) {
    throw new AppError(
      "INVALID_LOGIN",
      "المستخدم أو رمز PIN غير صحيح",
      401,
      "auth",
    );
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw new AppError(
      "LOGIN_LOCKED",
      "تم إيقاف المحاولات مؤقتًا. حاول بعد 15 دقيقة.",
      429,
      "auth",
    );
  }

  const verified = await verifyPin(pin, user.pin_hash);
  if (!verified.valid) {
    const failures = Number(user.failed_login_count || 0) + 1;
    const lockedUntil =
      failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await db
      .from("collection_portal_users")
      .update({
        failed_login_count: failures >= 5 ? 0 : failures,
        locked_until: lockedUntil,
      })
      .eq("id", user.id);
    await audit(
      user,
      "محاولة دخول فاشلة",
      "PIN غير صحيح",
      requestId,
      {},
      "warning",
    );
    throw new AppError(
      "INVALID_LOGIN",
      failures >= 5
        ? "تم إيقاف المحاولات مؤقتًا. حاول بعد 15 دقيقة."
        : "المستخدم أو رمز PIN غير صحيح",
      failures >= 5 ? 429 : 401,
      "auth",
    );
  }

  const newPinHash = verified.legacy ? await hashPin(pin) : undefined;
  await db
    .from("collection_portal_users")
    .update({
      failed_login_count: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      ...(newPinHash
        ? { pin_hash: newPinHash, pin_changed_at: new Date().toISOString() }
        : {}),
    })
    .eq("id", user.id);

  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  const forwarded =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) || null;
  const { error: sessionError } = await db
    .from("collection_portal_sessions")
    .insert({
      token_hash: tokenHash,
      user_id: user.id,
      expires_at: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(),
      device_name: cleanText(body.device_name, 120) || "متصفح",
      user_agent: userAgent,
      ip_address: forwarded,
    });
  if (sessionError) throw sessionError;
  await audit(user, "تسجيل دخول", cleanText(body.device_name, 120), requestId);
  return { token: rawToken, user: publicUser(user) };
}

export async function getSession(rawToken: unknown) {
  const token = cleanText(rawToken, 256);
  if (!token) {
    throw new AppError("SESSION_REQUIRED", "الجلسة مطلوبة", 401, "auth");
  }
  const tokenHash = await sha256(token);
  const { data: session, error } = await db
    .from("collection_portal_sessions")
    .select("user_id,expires_at,revoked_at")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !session) {
    throw new AppError(
      "SESSION_EXPIRED",
      "انتهت الجلسة أو غير صالحة",
      401,
      "auth",
    );
  }
  const { data: user, error: userError } = await db
    .from("collection_portal_users")
    .select("*")
    .eq("id", session.user_id)
    .eq("active", true)
    .maybeSingle();
  if (userError || !user) {
    throw new AppError("USER_DISABLED", "المستخدم غير نشط", 403, "permission");
  }
  void db
    .from("collection_portal_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("token_hash", tokenHash);
  return { user: user as PortalUser, tokenHash };
}

export async function logout(
  tokenHash: string,
  user: PortalUser,
  requestId: string,
) {
  await db
    .from("collection_portal_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", tokenHash);
  await audit(user, "تسجيل خروج", "", requestId);
}
