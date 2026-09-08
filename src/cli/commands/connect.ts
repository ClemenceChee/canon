import type { Command } from '../main.js';
import type { CanonApp } from '../../app.js';
import type { ConnectOptions } from '../../app.js';

function argString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function argStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as string[])
    : undefined;
}

/** canon connect — implemented end-to-end in slice 1 (writes config + connect audit). */
const connect: Command = async (ctx) => {
  const app: CanonApp = ctx.app;
  const a = ctx.args;
  const env = process.env;
  const opts: ConnectOptions = {
    // validated (nonEmpty/usage) inside app.connect
    host: argString(a.host) ?? '',
    projectId: argString(a.project) ?? '',
    publicKey: argString(a.publicKey) ?? env.CANON_LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: argString(a.secretKey) ?? env.CANON_LANGFUSE_SECRET_KEY ?? '',
    environment: argStringArray(a.env),
    redactIngest:
      a.redact === true ? true : a.noRedact === true ? false : undefined,
    force: a.force === true,
    wipe: a.wipe === true,
    insecureHttp: a.insecureHttp === true,
  };
  const cfg = await app.connect(opts);
  console.log(`connected to project ${cfg.connection.projectId} at ${cfg.connection.baseUrl}`);
  return 0;
};

export default connect;
