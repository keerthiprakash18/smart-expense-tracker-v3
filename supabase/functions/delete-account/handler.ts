// Pure request handler: the same code runs in Deno and in the offline Node tests.
// SDK creation is injected so tests exercise the actual authorization boundary.
type Result<T> = { data: T | null; error: unknown };
type User = { id: string; email?: string; factors?: Array<{ status?: string }> };
type StorageEntry = { id?: string | null; name: string; metadata?: unknown };
type Client = {
  auth: {
    getUser: (jwt: string) => Promise<Result<{ user: User | null }>>;
    signInWithPassword: (credentials: { email: string; password: string }) => Promise<Result<{ user: User | null; session?: unknown }>>;
    signOut: (options: { scope: 'local' }) => Promise<{ error: unknown }>;
    admin: { deleteUser: (id: string, softDelete: boolean) => Promise<Result<{ user: User | null }>> };
  };
  storage: {
    getBucket: (id: string) => Promise<Result<{ id: string; public: boolean; versioning_status?: string }>>;
    from: (id: string) => {
      list: (prefix: string, options: { limit: number; offset: number; sortBy: { column: string; order: string } }) => Promise<Result<StorageEntry[]>>;
      remove: (paths: string[]) => Promise<Result<unknown>>;
    };
  };
};
type Configuration = { url: string; publicKey: string; serviceRoleKey: string; allowedOrigins: string[] };
type Dependencies = {
  config: Configuration;
  createClient: (url: string, key: string, options: { auth: { persistSession: false; autoRefreshToken: false; detectSessionInUrl: false } }) => Client;
  now?: () => number;
};

const BUCKET = 'tracker-receipts';
const LIMITS = { bodyBytes: 8192, files: 1000, entries: 2000, directories: 32, depth: 4, listCalls: 40, batch: 100, durationMs: 20000 };
const isolatedOptions = () => ({ auth: { persistSession: false as const, autoRefreshToken: false as const, detectSessionInUrl: false as const } });

class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

function reject(status: number, code: string, message: string): never { throw new RequestError(status, code, message); }

function isPublicKey(key: string) {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  try {
    const parts = key.split('.');
    return parts.length === 3 && JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon';
  } catch { return false; }
}

async function readBody(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') reject(415, 'json_required', 'Send an application/json request.');
  if (Number(request.headers.get('content-length') || 0) > LIMITS.bodyBytes) reject(413, 'request_too_large', 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) reject(400, 'invalid_request', 'A JSON request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.bodyBytes) { await reader.cancel(); reject(413, 'request_too_large', 'Request body is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { reject(400, 'invalid_json', 'Request body must be valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['password', 'confirmation'].includes(key))) {
    reject(400, 'invalid_request', 'Only password and confirmation may be supplied.');
  }
  if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 1024 || body.confirmation !== 'DELETE') {
    reject(400, 'confirmation_required', 'Enter your current password and type DELETE to confirm.');
  }
  return body as { password: string; confirmation: 'DELETE' };
}

function validatedClaims(jwt: string, user: User, now: number) {
  // Decoding is NOT authentication. This is called only AFTER getUser(jwt) has
  // validated this exact token against the Auth server; sub must still match.
  let claims;
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error();
    claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { reject(401, 'invalid_session', 'Sign in again before deleting your account.'); }
  if (claims.sub !== user.id || claims.role !== 'authenticated' || typeof claims.exp !== 'number' || claims.exp <= now / 1000 || !['aal1', 'aal2'].includes(claims.aal)) {
    reject(401, 'invalid_session', 'Sign in again before deleting your account.');
  }
  if (user.factors?.some((factor) => factor.status === 'verified') && claims.aal !== 'aal2') {
    reject(403, 'mfa_required', 'Verify your authenticator before deleting your account.');
  }
}

function safeSegment(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false;
  try {
    const decoded = decodeURIComponent(value);
    return decoded !== '.' && decoded !== '..' && !/[%\\/\u0000-\u001f]/.test(decoded);
  } catch { return false; }
}

export function createDeleteAccountHandler({ config, createClient, now = Date.now }: Dependencies) {
  return async function deleteAccount(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    const cors: Record<string, string> = { Vary: 'Origin', 'Cache-Control': 'no-store' };
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (origin && !config.allowedOrigins.includes(origin)) return respond({ error: 'This frontend origin is not allowed.', code: 'origin_not_allowed' }, 403);
    if (origin) cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Headers'] = 'authorization, apikey, x-client-info, content-type';
    cors['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return respond({ error: 'Use POST to delete your account.', code: 'method_not_allowed' }, 405);
    let receiptsMayHaveBeenRemoved = false;
    try {
      const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') || '')?.[1];
      if (!token) reject(401, 'authentication_required', 'Sign in before deleting your account.');
      if (!config.url || !isPublicKey(config.publicKey) || !config.serviceRoleKey || config.publicKey === config.serviceRoleKey) {
        reject(503, 'function_not_configured', 'Account deletion is not configured. Contact the project administrator.');
      }
      const deadline = now() + LIMITS.durationMs;
      const checkTime = () => { if (now() >= deadline) reject(503, 'cleanup_timeout', 'Deletion did not complete within the safe cleanup time limit. Check your account status before retrying.'); };
      const body = await readBody(request);
      const callerClient = createClient(config.url, config.publicKey, isolatedOptions());
      const callerResult = await callerClient.auth.getUser(token);
      const caller = callerResult.data?.user;
      if (callerResult.error || !caller || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caller.id)) {
        reject(401, 'invalid_session', 'Sign in again before deleting your account.');
      }
      validatedClaims(token, caller, now());
      if (!caller.email) reject(409, 'email_password_required', 'This deletion flow requires an email and password account. Contact the project administrator.');
      checkTime();
      // A fresh public-key client: no caller Authorization header, no shared
      // session, no storage, and no service role during password verification.
      const verifier = createClient(config.url, config.publicKey, isolatedOptions());
      const verification = await verifier.auth.signInWithPassword({ email: caller.email, password: body.password });
      body.password = '';
      if (verification.error) reject(403, 'password_verification_failed', 'Current password could not be verified.');
      const verifiedUserId = verification.data?.user?.id;
      const signedOut = await verifier.auth.signOut({ scope: 'local' });
      if (signedOut.error) reject(503, 'verification_cleanup_failed', 'Password verification could not complete safely. Account deletion has not started.');
      if (verifiedUserId !== caller.id) reject(403, 'identity_mismatch', 'Password verification did not match the signed-in account.');
      // Recheck enrollment/session state immediately before privileged work.
      const fresh = await callerClient.auth.getUser(token);
      if (fresh.error || fresh.data?.user?.id !== caller.id) reject(401, 'invalid_session', 'Your session changed. Sign in again before deleting your account.');
      validatedClaims(token, fresh.data.user, now());
      checkTime();
      const admin = createClient(config.url, config.serviceRoleKey, isolatedOptions());
      const bucket = await admin.storage.getBucket(BUCKET);
      if (bucket.error || bucket.data?.id !== BUCKET || bucket.data.public !== false) reject(503, 'receipt_bucket_unavailable', 'The private receipt bucket could not be verified. Account deletion has not started.');
      if (bucket.data.versioning_status && bucket.data.versioning_status !== 'DISABLED') reject(409, 'versioned_receipts_unsupported', 'Versioned receipt storage requires administrator-assisted deletion. Account deletion has not started.');
      const storage = admin.storage.from(BUCKET);
      const folders = [{ path: caller.id, depth: 0 }];
      const seen = new Set<string>();
      const paths: string[] = [];
      let entries = 0;
      let listCalls = 0;
      const list = async (path: string, offset = 0, limit = LIMITS.batch) => {
        checkTime();
        if (++listCalls > LIMITS.listCalls) reject(409, 'receipt_cleanup_limit', 'Receipt cleanup exceeds this request’s safe limit. Contact the project administrator.');
        const result = await storage.list(path, { limit, offset, sortBy: { column: 'name', order: 'asc' } });
        if (result.error || !Array.isArray(result.data) || result.data.length > limit) reject(503, 'receipt_listing_failed', 'Private receipts could not be listed safely. Account deletion has not completed.');
        return result.data;
      };
      // Complete a bounded, read-only inventory before removing any object.
      // Never list bucket root or accept a user-supplied bucket/prefix/target ID.
      for (let directory = 0; directory < folders.length; directory++) {
        const folder = folders[directory];
        for (let offset = 0; ; offset += LIMITS.batch) {
          const page = await list(folder.path, offset);
          for (const entry of page) {
            if (++entries > LIMITS.entries || !safeSegment(entry.name)) reject(409, 'unsafe_receipt_inventory', 'Receipt inventory cannot be cleaned safely by this request. Contact the project administrator.');
            const path = `${folder.path}/${entry.name}`;
            if (!path.startsWith(`${caller.id}/`) || path.length > 1024 || seen.has(path)) reject(409, 'unsafe_receipt_inventory', 'Receipt inventory changed or contains unsupported paths. Account deletion has not completed.');
            seen.add(path);
            if (entry.id === null && entry.metadata === null) {
              if (folder.depth >= LIMITS.depth || folders.length >= LIMITS.directories) reject(409, 'receipt_cleanup_limit', 'Receipt folders exceed this request’s safe limit. Contact the project administrator.');
              folders.push({ path, depth: folder.depth + 1 });
            } else if (typeof entry.id === 'string' && entry.id.length > 0) {
              paths.push(path);
              if (paths.length > LIMITS.files) reject(409, 'receipt_cleanup_limit', 'More than 1,000 private receipts require administrator-assisted deletion. No receipts have been removed.');
            } else reject(409, 'unsafe_receipt_inventory', 'Receipt inventory contains an unsupported entry. Account deletion has not completed.');
          }
          if (page.length < LIMITS.batch) break;
        }
      }
      for (let offset = 0; offset < paths.length; offset += LIMITS.batch) {
        checkTime();
        receiptsMayHaveBeenRemoved = true;
        const result = await storage.remove(paths.slice(offset, offset + LIMITS.batch));
        if (result.error) reject(503, 'receipt_cleanup_failed', 'Receipt cleanup did not complete. Some receipts may already be removed; the account has not been deleted.');
      }
      if ((await list(caller.id, 0, 1)).length > 0) reject(409, 'receipts_changed', 'Receipts changed during cleanup. Some receipts may already be removed; account deletion has not completed.');
      checkTime();
      // The only deletion target comes from the Auth-validated caller, never
      // metadata, decoded claims alone, request JSON, or a query parameter.
      const deleted = await admin.auth.admin.deleteUser(caller.id, false);
      if (deleted.error || deleted.data?.user?.id !== caller.id) reject(503, 'account_deletion_failed', 'Account deletion was not confirmed. Receipt cleanup may already have occurred; check your account status before retrying.');
      return respond({ deleted: true, message: 'Account and app records deleted.', receipts_removed: paths.length });
    } catch (error) {
      // SDK/network messages can contain sensitive implementation details.
      // Return only fixed errors; never log passwords, keys, tokens or bodies.
      const failure = error instanceof RequestError ? error : new RequestError(503, 'deletion_unavailable', 'Account deletion could not complete. Check your account status before retrying.');
      return respond({ error: failure.message, code: failure.code, receipts_may_have_been_removed: receiptsMayHaveBeenRemoved }, failure.status);
    }
  };
}
