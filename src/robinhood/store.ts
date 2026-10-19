// The Robinhood sign-in, kept in one file in the person's own folder (~/.trading-agents/robinhood.json), readable only
// by them. It holds what Robinhood's sign-in gives back - the client registration and the tokens - and nothing is ever
// printed from it. Agents are refused this folder (.claude/settings.json, .claude/hooks/guard.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { writePrivate } from '../private.js';

interface Saved { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; state?: string; savedAt?: string }

export function readSaved(file: string): Saved {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Saved; } catch { return {}; }
}

/** Written whole, and locked to the person's own account on every system (private.ts). */
export function writeSaved(file: string, saved: Saved): void {
  writePrivate(file, JSON.stringify({ ...saved, savedAt: new Date().toISOString() }, null, 2));
}

/** The sign-in as the MCP library asks for it: where Robinhood sends the person back, who we are, and the saved pieces. */
export class FileAuth implements OAuthClientProvider {
  constructor(private readonly file: string, readonly redirectUrl: string, private readonly openBrowser: (url: URL) => void) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Trading Agents',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  private update(change: Partial<Saved>): void { writeSaved(this.file, { ...readSaved(this.file), ...change }); }

  state(): string { const state = crypto.randomBytes(16).toString('hex'); this.update({ state }); return state; }
  expectedState(): string | undefined { return readSaved(this.file).state; }
  clientInformation(): OAuthClientInformationMixed | undefined { return readSaved(this.file).client; }
  saveClientInformation(client: OAuthClientInformationMixed): void { this.update({ client }); }
  tokens(): OAuthTokens | undefined { return readSaved(this.file).tokens; }
  saveTokens(tokens: OAuthTokens): void { this.update({ tokens }); }
  saveCodeVerifier(verifier: string): void { this.update({ verifier }); }
  codeVerifier(): string {
    const v = readSaved(this.file).verifier;
    if (!v) throw new Error('the sign-in lost its place; run the connection again');
    return v;
  }
  redirectToAuthorization(url: URL): void { this.openBrowser(url); }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const s = readSaved(this.file);
    if (scope === 'all') { writeSaved(this.file, {}); return; }
    if (scope === 'client') delete s.client;
    if (scope === 'tokens') delete s.tokens;
    if (scope === 'verifier') delete s.verifier;
    writeSaved(this.file, s);
  }
}
