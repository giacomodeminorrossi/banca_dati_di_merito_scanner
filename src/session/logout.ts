import { rm } from "node:fs/promises";
import { browserProfileDir } from "../config.ts";
import { BdpError } from "../errors.ts";
import { loginInProgress } from "./login.ts";
import { clearSession } from "./store.ts";

/**
 * Deletes the session file and the dedicated browser profile. The profile holds
 * BDP and identity-provider cookies too: keeping it would let the next login
 * skip authentication.
 */
export const logout = async (): Promise<void> => {
  if (loginInProgress()) {
    throw new BdpError(
      "parametri",
      "È in corso un accesso: completalo o chiudi la finestra del browser, poi riprova a uscire.",
    );
  }
  await clearSession();
  await rm(browserProfileDir(), { recursive: true, force: true });
};
