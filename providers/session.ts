import {getMemberSession} from "../auth/session";
import {isAdminEmail, opsAuthorized} from "./env";

type EnvRecord = Record<string, string | undefined>;

export type AdminAuthorization =
  | {ok: true; email: string; open: boolean}
  | {ok: false; status: 401 | 403; error: string; open: boolean};

export async function authorizeAdmin(request: Request, overrides: EnvRecord = {}): Promise<AdminAuthorization> {
  const session = await getMemberSession(request);
  if (!session) {
    return {ok: false, status: 401, error: "Sign in to review the Miami pipeline.", open: false};
  }
  if (!isAdminEmail(session.member.email, overrides)) {
    return {ok: false, status: 403, error: "You are not authorized to review applications.", open: false};
  }
  const ops = opsAuthorized(request, overrides);
  if (!ops.ok) {
    return {ok: false, status: 401, error: "Enter the Salu ops key to review applications.", open: false};
  }
  return {ok: true, email: session.member.email, open: ops.open};
}
