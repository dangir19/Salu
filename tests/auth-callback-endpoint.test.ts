import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

// Regression guard: Auth.js v5 handles the credentials provider in the
// *callback* action, not the signin action. Posting credentials to
// /api/auth/signin/credentials silently bounces back to the signin page
// without ever calling authorize(). The client must post to
// /api/auth/callback/credentials.
test("credentials sign-in posts to the Auth.js callback endpoint", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(join(root, "components", "SignIn.tsx"), "utf8");
  assert.match(source, /\/api\/auth\/callback\/credentials/);
  assert.doesNotMatch(source, /\/api\/auth\/signin\/credentials/);
});
