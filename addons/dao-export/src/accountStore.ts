/**
 * Multi-account store — 万法归一.
 *
 * Holds many Devin accounts (email+password OR raw token), persists them, and
 * exposes one "active" account whose AuthState drives session listing/export.
 * Universal-format text (any paste) is normalised via parseAccountText, so the
 * single-account login of the old plugin becomes batch multi-account management
 * without changing the download/export core.
 *
 * Storage-agnostic (a tiny get/update interface) so it works from both the
 * extension host and the Agent Bridge, on any OS / editor. Zero runtime deps.
 */
import * as crypto from 'crypto';
import * as api from './api';
import { parseAccountText } from './accounts';

export type AccountKind = 'password' | 'token';
export type AccountStatus = 'unverified' | 'ok' | 'fail';

export interface Account {
  id: string;
  kind: AccountKind;
  email: string;        // real email for password accounts; label for token accounts
  password?: string;
  token?: string;       // raw bearer token for token accounts
  auth?: api.AuthState; // cached verified auth
  status: AccountStatus;
  lastError?: string;
  verifiedAt?: number;
  addedAt: number;
}

export interface Storage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void> | Thenable<void>;
}

interface PersistShape { accounts: Account[]; activeId?: string; }

const KEY = 'daoDevinAccounts';
const LEGACY_AUTH_KEY = 'daoDevinAuth';

function idForPassword(email: string): string {
  return 'p:' + email.trim().toLowerCase();
}
function idForToken(token: string): string {
  return 't:' + crypto.createHash('sha1').update(token.trim()).digest('hex').slice(0, 16);
}

/** A redacted view safe to send to webviews / over the bridge (no secrets). */
export interface AccountView {
  id: string;
  kind: AccountKind;
  email: string;
  orgName?: string;
  status: AccountStatus;
  lastError?: string;
  verifiedAt?: number;
  active: boolean;
}

export class AccountStore {
  private accounts: Account[] = [];
  private activeId?: string;

  constructor(private storage: Storage) {}

  /** Load persisted accounts, migrating a legacy single-account login if present. */
  load(): void {
    const data = this.storage.get<PersistShape>(KEY);
    if (data && Array.isArray(data.accounts)) {
      this.accounts = data.accounts;
      this.activeId = data.activeId;
    }
    // One-time migration: an old single-account auth becomes the first account.
    const legacy = this.storage.get<api.AuthState>(LEGACY_AUTH_KEY);
    if (legacy && legacy.token && !this.accounts.some((a) => a.email.toLowerCase() === (legacy.email || '').toLowerCase())) {
      const acc: Account = {
        id: idForPassword(legacy.email || legacy.token),
        kind: 'password',
        email: legacy.email || '(legacy)',
        auth: legacy,
        status: 'ok',
        verifiedAt: Date.now(),
        addedAt: Date.now(),
      };
      this.accounts.unshift(acc);
      if (!this.activeId) { this.activeId = acc.id; }
    }
    if (!this.activeId && this.accounts.length) { this.activeId = this.accounts[0].id; }
  }

  private async persist(): Promise<void> {
    await this.storage.update(KEY, { accounts: this.accounts, activeId: this.activeId } as PersistShape);
  }

  list(): Account[] { return this.accounts; }

  views(): AccountView[] {
    return this.accounts.map((a) => ({
      id: a.id,
      kind: a.kind,
      email: a.email,
      orgName: a.auth?.orgName,
      status: a.status,
      lastError: a.lastError,
      verifiedAt: a.verifiedAt,
      active: a.id === this.activeId,
    }));
  }

  get(id: string): Account | undefined { return this.accounts.find((a) => a.id === id); }

  getActive(): Account | undefined { return this.activeId ? this.get(this.activeId) : undefined; }

  activeAuth(): api.AuthState | undefined { return this.getActive()?.auth; }

  isEmpty(): boolean { return this.accounts.length === 0; }

  /**
   * Add accounts/tokens from arbitrary text (万法识号). De-duplicates against
   * existing entries. Returns counts so the UI can report what happened.
   */
  async addFromText(text: string): Promise<{ added: number; dupes: number; emails: number; tokens: number }> {
    const { accounts, tokens } = parseAccountText(text || '');
    let added = 0; let dupes = 0;
    for (const { email, password } of accounts) {
      const id = idForPassword(email);
      const existing = this.get(id);
      if (existing) {
        dupes++;
        if (password && existing.password !== password) {
          existing.password = password;
          existing.status = 'unverified';
          existing.auth = undefined;
          existing.lastError = undefined;
        }
        continue;
      }
      this.accounts.push({ id, kind: 'password', email, password, status: 'unverified', addedAt: Date.now() });
      added++;
    }
    for (const token of tokens) {
      const id = idForToken(token);
      if (this.get(id)) { dupes++; continue; }
      this.accounts.push({ id, kind: 'token', email: '(token)', token, status: 'unverified', addedAt: Date.now() });
      added++;
    }
    if (!this.activeId && this.accounts.length) { this.activeId = this.accounts[0].id; }
    await this.persist();
    return { added, dupes, emails: accounts.length, tokens: tokens.length };
  }

  async remove(id: string): Promise<void> {
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.activeId === id) { this.activeId = this.accounts[0]?.id; }
    await this.persist();
  }

  async clear(): Promise<void> {
    this.accounts = [];
    this.activeId = undefined;
    await this.persist();
  }

  /** Verify (log in) one account, caching its AuthState. Returns the auth on success. */
  async verify(id: string): Promise<api.AuthState> {
    const acc = this.get(id);
    if (!acc) { throw new Error('account not found'); }
    try {
      let auth: api.AuthState;
      if (acc.kind === 'token') {
        auth = await api.loginWithToken(acc.token || '', acc.email);
        if (auth.email && auth.email !== '(token)') { acc.email = auth.email; }
      } else {
        if (!acc.password) { throw new Error('该账号缺少密码（仅邮箱）— 请补充密码或改用 token'); }
        auth = await api.login(acc.email, acc.password);
      }
      acc.auth = auth;
      acc.status = 'ok';
      acc.lastError = undefined;
      acc.verifiedAt = Date.now();
      await this.persist();
      return auth;
    } catch (e) {
      acc.status = 'fail';
      acc.lastError = String(e);
      acc.auth = undefined;
      await this.persist();
      throw e;
    }
  }

  /** Ensure an account has a usable auth, verifying lazily if needed. */
  async ensureAuth(id: string): Promise<api.AuthState> {
    const acc = this.get(id);
    if (!acc) { throw new Error('account not found'); }
    if (acc.auth && acc.auth.token) { return acc.auth; }
    return this.verify(id);
  }

  /** Verify every account with bounded concurrency. */
  async verifyAll(concurrency = 4): Promise<{ ok: number; fail: number }> {
    let ok = 0; let fail = 0;
    const ids = this.accounts.map((a) => a.id);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try { await this.verify(id); ok++; } catch { fail++; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
    return { ok, fail };
  }

  /** Switch the active account, verifying lazily so its sessions are ready. */
  async setActive(id: string): Promise<api.AuthState> {
    if (!this.get(id)) { throw new Error('account not found'); }
    this.activeId = id;
    await this.persist();
    return this.ensureAuth(id);
  }

  /** Update the active account's cached auth (e.g. after bridge re-login). */
  async setActiveAuth(auth: api.AuthState | undefined): Promise<void> {
    const acc = this.getActive();
    if (acc) {
      acc.auth = auth;
      acc.status = auth ? 'ok' : acc.status;
      if (auth) { acc.verifiedAt = Date.now(); }
      await this.persist();
    }
  }
}
