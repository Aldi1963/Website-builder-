# LMS starter: owner setup and verification

## Administrator bootstrap (trusted operator only)

Public registration always creates `siswa`, including the first account. There is no public setup token, first-signup promotion, or role picker.

1. Start the app with its project-specific `VB_APP_DATABASE_URL` supplied by your deployment's secret environment. Register the intended owner's account through `/login`.
2. Verify that this exact account belongs to the owner (have the owner sign in successfully). Email addresses are not verified by this starter; **never promote an address merely because it looks like the owner's address**. If someone else registered it, resolve account ownership first.
3. In a trusted operator shell inside this generated application's directory, with the correct database secret already injected, run:

   ```sh
   node scripts/bootstrap-admin.mjs --email owner@example.com
   ```

4. The command verifies the stored administrator role. Existing sessions for the newly promoted account are revoked; sign in again. Subsequent runs for the same administrator are idempotent. Promotion of another account is refused once any administrator exists. Concurrent bootstrap calls are serialized on a single PostgreSQL transaction/client.

The script does not create passwords, expose a network endpoint, or print database credentials. Do not put the database URL in source control, browser code, or shell history. Database credentials are trusted administrative capabilities. Additional administrator provisioning and account recovery require a separate deliberate operator procedure; this bootstrap is not a general role-management API.

## Course permissions

Publication exposes the catalog summary only. Protected lessons, assignments, grades and discussions require an administrator, the owning `guru`, or an enrolled `siswa`. Unrelated teachers and unenrolled visitors cannot read content or post discussions. Enrolled students retain access if a course is later unpublished; guests and outsiders cannot view its detail. Management links and discussion forms follow the same server-computed permissions.

## Verification

From `starters/lms` after installing dependencies:

```sh
npx tsc --noEmit
npm run build
```

Behavior tests run real route-handler bodies and PostgreSQL queries; only TanStack transport and route registration are replaced by a test adapter. UI tests run the built SSR server and Chromium using real browser signup, enrollment, progress, and discussion requests.

Create a **disposable** PostgreSQL database whose name starts with `lms_test_`, and set `LMS_TEST_DATABASE_URL` privately. Tests **drop and recreate its public schema**. Never use a production/project database. Include `options=-c%20statement_timeout%3D2000` in the connection URL for bounded lock regression failures. Run these suites sequentially, not concurrently on the same database:

```sh
node --test tests/behavior.test.mjs
# playwright-core and Chromium must be available in the test environment.
# Set LMS_TEST_CHROMIUM to the local Chromium executable if needed.
node --test tests/ui.test.mjs
```

The UI suite owns a temporary loopback server on port 15440 and stops it afterwards. The caller owns the disposable PostgreSQL instance/database and its cleanup. Behavioral tests cover allowed and denied content/discussion access on published and unpublished courses, public role injection, session persistence, and explicit owner bootstrap. Browser coverage is a student journey, not a claim that every LMS/admin workflow has been E2E tested.
