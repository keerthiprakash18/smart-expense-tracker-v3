# Supabase authentication and account deletion

This is an opt-in, fresh-data backend. Django remains the default. The existing
Django/Railway service, accounts, data and deployment are not migrated or deleted
by these changes. Configuration/deployment steps below are operator instructions;
they have not been applied to a remote project.

## Frontend configuration

Build the Vite frontend with public configuration only:

```dotenv
VITE_BACKEND_PROVIDER=supabase
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
```

Omit `VITE_BACKEND_PROVIDER` or set it to `django` to keep the original behavior.
Vite substitutes these variables at build time: changing a deployment setting
requires a new build. `supabaseClient.js` creates no client in Django mode, and
reports a configuration error rather than falling back to Django when Supabase
configuration is missing. It rejects `sb_secret_*` and JWT `service_role` keys.
A legacy JWT `anon` key is accepted only after checking its role.

Never put service-role/secret keys in a frontend variable, the browser bundle,
an example file, a request body or a repository. The server deletion function is
the only component here that needs an administrative credential.

## Email settings and exact redirect URLs

In **Supabase Authentication**, enable the Email provider and **Confirm email**.
Configure a suitable SMTP sender and test delivery before enabling real signup.
This frontend does not bypass confirmation or manufacture a session when signup
returns no session. A confirmation-required signup leaves its instructions visible.

In **Authentication → URL Configuration**:

1. Set **Site URL** to the deployed frontend origin, for example
   `https://expenses.example.com`.
2. Add these **full URLs** to the redirect allowlist, using the exact deployed
   origin and any actual application base path:

   ```text
   https://expenses.example.com/#/login
   https://expenses.example.com/?auth=recovery#/reset-password
   ```

3. For Vite development on its default port, separately allow:

   ```text
   http://localhost:5173/#/login
   http://localhost:5173/?auth=recovery#/reset-password
   ```

   If you open the application at `127.0.0.1`, another port, a Vercel preview
   hostname or a subpath, add the corresponding exact URLs. `localhost` and
   `127.0.0.1` are distinct origins with distinct browser storage. Avoid broad
   production wildcard redirects.

4. Preserve the default Supabase confirmation/recovery email link destination
   `{{ .ConfirmationURL }}`. This SPA has no server `/auth/confirm` route. Do not
   substitute an SSR `token_hash` template or link directly to `#/login` without
   first verifying the token with Supabase. Customized templates must still use
   Supabase's verification URL and preserve the requested `RedirectTo`.

The client explicitly uses **PKCE** with `detectSessionInUrl: true`. Supabase
returns a one-use `code` in the real URL query; the SDK exchanges it using the
locally stored verifier. The application uses **HashRouter**. A recovery redirect
contains both the real query marker `?auth=recovery` and the route fragment
`#/reset-password`; neither is optional in the configured recovery destination.
The marker survives the code exchange and ensures that the welcome screen cannot
hide the recovery page.

Open signup/recovery links on the **same browser and device that initiated the
request**. A different browser, cleared site storage, an expired/used code, or a
new overlapping PKCE request can invalidate the exchange. Request a fresh link
and open the newest email in the initiating browser. Link-scanning email products
can also consume one-use links; test the actual delivery setup.

Recovery sessions can update the password for 30 minutes in this UI, are kept
out of finance routes, and still require AAL2 when MFA is enrolled. Updating the
password signs out globally. It does not remove the enrolled authenticator.

## Registration metadata

Only email/password are authentication credentials. Name and phone are user
metadata, not phone authentication. The signup adapter supplies:

```js
{
  name,
  phone,
  accepted_terms: true,
  accepted_privacy: true,
  terms_accepted_at: true,
  privacy_accepted_at: true,
}
```

The last two compatibility values ask the bootstrap trigger to record server
time. They are not client-generated timestamps. The schema also supports the
accepted flags. These metadata declarations are not proof of verified identity.

## Session and MFA integration

`handleSupabaseAuth(method, path, data)` returns `{ data, status }` for handled
auth requests and `null` for unhandled methods/paths. Errors have the existing
Axios-compatible `response.status` and `response.data.error/detail/code` shape.
In Supabase mode, unhandled requests must go to the finance adapter or return an
explicit unsupported error, never fall through to the Railway/Django backend.

The Supabase SDK owns session persistence and refresh. A synchronous compatibility
cache may support `getAccessToken`, but is not proof of authentication.
`clearTokens` clears compatibility values; actual logout uses SDK `signOut`.
The password-change adapter calls `updateUser` with `current_password` and then
`signOut({ scope: 'global' })` before returning success, so the existing profile
password form's clear/reload behavior cannot resurrect the SDK session.

`AuthContext` validates current server factor state before exposing route access,
reacts immediately to `SIGNED_OUT`, and handles the API's
`smart-expense-auth-expired` event. Auth methods are deferred outside synchronous
`onAuthStateChange` callbacks. A session at AAL1 with any verified MFA factor is
not considered authenticated for finance routes. Server authorization/RLS must
enforce the corresponding rule independently.

Login can choose among enrolled TOTP authenticators. Profile supports setup,
confirmation and disabling a **single TOTP factor** after checking the current
password and an authenticator code. Multiple/non-TOTP management is explicitly
unavailable in this profile UI. No legacy Django recovery codes are accepted and
no fabricated backup codes are displayed. Losing an authenticator requires an
administrator-supported recovery process; email reset is not an MFA bypass.

## Server-side account deletion

Frontend endpoint: `POST /api/delete-account/` with exactly
`{ password, confirmation: 'DELETE' }`. The auth adapter forwards only those fields
to the **delete-account** Edge Function with the current user's bearer JWT. It
requires `{ deleted: true }` before treating the operation as complete and then
signs out the SDK session. Function errors retain their status and safe message.

Files:

- `supabase/functions/delete-account/index.ts`: pinned SDK import, server-only
  environment access, isolated clients and five-second per-fetch timeout.
- `supabase/functions/delete-account/handler.ts`: tested HTTP handler and cleanup.

Before making this function available, configure the **Edge Function's server
environment** (not Vercel/Vite public variables):

- `SUPABASE_URL`.
- `SUPABASE_ANON_KEY`, or `SUPABASE_PUBLISHABLE_KEY` for the public client.
- `SUPABASE_SERVICE_ROLE_KEY`, or `SUPABASE_SECRET_KEY` for admin-only operations.
  Supabase normally provisions its standard project credentials to Edge Functions.
- `AUTH_ALLOWED_ORIGINS`: comma-separated exact frontend origins, for example
  `https://expenses.example.com,http://localhost:5173`. Use origins only here,
  with no path, query, fragment or trailing slash. Redirect allowlists and this
  CORS allowlist serve different purposes; configure both.

Deploy the function only as a separate, explicitly authorized operator action.
Keep the platform's user JWT verification enabled. The handler independently
validates the exact bearer JWT with Auth `getUser`; neither CORS nor a publishable
API key substitutes for user authentication. No remote deployment is part of
this implementation.

Deletion checks, in order:

1. Exact allowed browser origin, POST/JSON, bounded body, password and `DELETE`.
2. Auth-server validation of the caller JWT, matching subject, authenticated role,
   unexpired claims, and AAL2 whenever a verified MFA factor exists.
3. Password verification by a fresh public-key client without shared session or
   inherited caller authorization. The returned user ID must equal the caller.
   The temporary verification session is signed out before privileged work.
4. A second Auth check of the caller's current user record and MFA enrollment
   after password verification.
5. An administrative client is created only now. The bucket must be the private,
   unversioned `tracker-receipts` bucket. Only the `${caller.id}/` tree is listed.
6. A complete bounded inventory is collected before removal. Unsupported paths,
   traversal names, duplicate/changing inventory and excessive trees fail closed.
7. Receipts are removed in batches; the caller folder is checked again for new
   uploads. Only then is `auth.admin.deleteUser(caller.id, false)` called.
   Database foreign-key cascades remove that user's app rows.

Cleanup bounds are 1,000 files, 2,000 inventory entries, 32 directories, four
levels below the user folder, 40 list calls, 100 objects per delete batch, and a
20-second checked operation deadline with five-second per-fetch timeouts. Large
accounts, versioned buckets, and objects owned in other buckets require an
administrator-assisted process; the function does not expand its scope.

Storage and Auth deletion are not one transaction. A failure after receipt
removal can leave the account present with some receipts already removed. Errors
include `receipts_may_have_been_removed`; UI messages say to check account status
before retrying. No automatic retry is performed. A lost final HTTP response can
also leave the operation's outcome uncertain.

Hard-deleting the Auth user removes refreshable sessions, but previously issued
stateless access JWTs can remain valid until expiry. Sensitive APIs should validate
current user/session existence, and storage policies should also reject deleted
users if immediate revocation is required. Folder-only storage RLS is not, by
itself, an immediate-revocation check. The function never deletes an unrelated
folder/bucket or accepts a user ID from the request.

## Local checks

Run from the repository root:

```sh
node --test supabase/tests/delete-account.test.mjs
npx --yes deno check supabase/functions/delete-account/index.ts
```

The handler tests require Node 24 (or a Node release supporting native TypeScript
type stripping). They execute the actual request handler with mocked external
Auth/Storage clients, including ownership, password/MFA, CORS, bounds, concurrent
uploads and sanitized failures. Deno checks the deployable entrypoint and pinned
SDK types; it does not serve or deploy the function.

From `frontend/`:

```sh
npm run test:auth
npx playwright test --config tests/supabase-auth.playwright.config.js
npm run lint
npm run build
```

Browser tests use fake public configuration and intercepted network responses.
They are not live email delivery, Supabase Storage, or Edge deployment tests.
Before enabling a real project, verify confirmation/resend/recovery email delivery,
MFA enrollment/login, password change, and deletion in a disposable test account.

## Official references

- [Password-based authentication](https://supabase.com/docs/guides/auth/passwords)
- [Redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls)
- [PKCE flow and same-browser limitations](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [TOTP MFA](https://supabase.com/docs/guides/auth/auth-mfa/totp)
- [Deleting and managing users](https://supabase.com/docs/guides/auth/managing-user-data)
- [Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)
