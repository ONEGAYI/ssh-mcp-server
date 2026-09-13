import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { posix } from "node:path";

export interface HelperTransport {
  executeInputCommand(command: string, input: Buffer, name?: string, options?: { timeout?: number }):
    Promise<{ stdout: string; stderr: string; exitCode: number; signal?: string }>;
  /** Optional binary twin whose stdout stays a Buffer (issue #14): download
   * fetches return raw block bytes that a UTF-8 decode would corrupt. */
  executeBinaryInputCommand?(command: string, input: Buffer, name?: string, options?: { timeout?: number }):
    Promise<{ stdout: Buffer; stderr: string; exitCode: number; signal?: string }>;
}

export interface RemoteAgentOptions {
  remoteStateDir: string;
  pythonPath?: string;
  connectionName?: string;
  helperSourcePath?: string;
}

export class RemoteAgentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RemoteAgentError";
  }
}

export function quoteShell(value: string): string {
  if (value.includes("\0")) throw new RemoteAgentError("INVALID_PATH", "Shell values must not contain NUL");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

const INSTALL_HELPER = [
  "import base64,hashlib,json,os,re,sys,tempfile",
  "data=sys.stdin.buffer.read()",
  "target,digest=sys.argv[1:3]",
  "assert hashlib.sha256(data).hexdigest()==digest, 'Helper checksum mismatch'",
  "os.umask(0o077)",
  "parent=os.path.dirname(target)",
  "os.makedirs(parent,mode=0o700,exist_ok=True)",
  "image=json.loads(data.decode('utf8'))",
  "for name,payload in image['files'].items():",
  " assert re.fullmatch(r'[a-zA-Z0-9_-]+[.]py',name), 'Invalid helper module name'",
  " content=base64.b64decode(payload,validate=True)",
  " fd,tmp=tempfile.mkstemp(prefix='.install-',dir=parent)",
  " try:",
  "  with os.fdopen(fd,'wb') as stream:",
  "   stream.write(content);stream.flush();os.fsync(stream.fileno())",
  "  os.chmod(tmp,0o500)",
  "  os.replace(tmp,os.path.join(parent,name))",
  " finally:",
  "  if os.path.exists(tmp):os.unlink(tmp)",
  "print('installed')",
].join("\n");

/** Shared by MCP tools and the native background-Shell command entry point. */
export class RemoteAgentClient {
  private installation?: Promise<string>;
  private readonly python: string;

  constructor(private readonly transport: HelperTransport, private readonly options: RemoteAgentOptions) {
    this.python = options.pythonPath ?? "/usr/bin/python3";
    if (!posix.isAbsolute(options.remoteStateDir) || options.remoteStateDir === "/" || !posix.isAbsolute(this.python)) {
      throw new RemoteAgentError("INVALID_CONFIG", "Remote helper and state paths must be explicit absolute paths");
    }
    quoteShell(this.python);
    quoteShell(options.remoteStateDir);
  }

  private ensureInstalled(): Promise<string> {
    if (!this.installation) {
      this.installation = this.install().catch(error => { this.installation = undefined; throw error; });
    }
    return this.installation;
  }

  private async install(): Promise<string> {
    const files: Record<string, string> = {};
    if (this.options.helperSourcePath) {
      files["agent.py"] = (await readFile(this.options.helperSourcePath)).toString("base64");
    } else {
      const directory = new URL("../remote/", import.meta.url);
      for (const name of (await readdir(directory)).filter(name => /^[a-zA-Z0-9_-]+\.py$/.test(name)).sort()) {
        files[name] = (await readFile(new URL(name, directory))).toString("base64");
      }
    }
    if (!files["agent.py"]) throw new RemoteAgentError("HELPER_INSTALL_FAILED", "Helper image is missing its entry point");
    const data = Buffer.from(JSON.stringify({ files }), "utf8");
    const digest = createHash("sha256").update(data).digest("hex");
    const target = posix.join(this.options.remoteStateDir, "helpers", digest, "agent.py");
    const command = `${quoteShell(this.python)} -c ${quoteShell(INSTALL_HELPER)} ${quoteShell(target)} ${quoteShell(digest)}`;
    const result = await this.transport.executeInputCommand(command, data, this.options.connectionName);
    if (result.exitCode !== 0 || result.stdout.trim() !== "installed") {
      throw new RemoteAgentError("HELPER_INSTALL_FAILED", "Could not install the verified remote helper");
    }
    return target;
  }

  /** One helper protocol exchange with a raw stdin payload (issue #13).
   *
   * Same envelope contract as call(), but the caller frames the input bytes:
   * transfer blocks are a JSON control line plus raw binary, and the options
   * can extend the per-exchange timeout beyond the 30 s command default. */
  async exchange<T = Record<string, unknown>>(action: string, input: Buffer,
    options: { timeoutMs?: number } = {}): Promise<T> {
    if (!/^[a-z][a-z0-9_-]*$/.test(action)) throw new RemoteAgentError("INVALID_ACTION", "Invalid helper action");
    const target = await this.ensureInstalled();
    const command = `${quoteShell(this.python)} ${quoteShell(target)} --root ${quoteShell(this.options.remoteStateDir)} ${quoteShell(action)}`;
    const response = await this.transport.executeInputCommand(command, input, this.options.connectionName,
      options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs });
    if (response.exitCode !== 0) throw new RemoteAgentError("HELPER_EXECUTION_FAILED", "Remote helper did not complete its exchange");
    const lines = response.stdout.split(/\r?\n/).filter(line => line.startsWith("SSH_MCP_V1 "));
    if (lines.length !== 1 || !/^SSH_MCP_V1 [A-Za-z0-9+/]+={0,2}$/.test(lines[0])) {
      throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Missing or ambiguous remote helper response");
    }
    let envelope: { ok?: boolean; result?: T; error?: { code?: string; message?: string } };
    try { envelope = JSON.parse(Buffer.from(lines[0].slice(11), "base64").toString("utf8")); }
    catch { throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Malformed remote helper response"); }
    if (!envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
      throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Invalid remote helper envelope");
    }
    if (!envelope.ok) throw new RemoteAgentError(envelope.error?.code ?? "HELPER_ERROR", envelope.error?.message ?? "Remote helper failed");
    return envelope.result as T;
  }

  /** A framed binary exchange: the helper answers a fetch with raw bytes (issue #14).
   *
   * Success framing on stdout: one bounded JSON control line, exactly `size`
   * raw payload bytes, a newline, then the regular SSH_MCP_V1 envelope. The
   * parse is structural -- the payload is located by the declared size, not
   * by scanning for the envelope prefix, so arbitrary binary content cannot
   * confuse it. Error paths keep the envelope-only shape. */
  async exchangeBinary(action: string, input: Buffer,
    options: { timeoutMs?: number } = {}): Promise<{ control: Record<string, unknown>; payload: Buffer; result: Record<string, unknown> }> {
    if (!/^[a-z][a-z0-9_-]*$/.test(action)) throw new RemoteAgentError("INVALID_ACTION", "Invalid helper action");
    const binary = this.transport.executeBinaryInputCommand;
    if (!binary) throw new RemoteAgentError("INVALID_TRANSPORT", "This transport cannot carry binary helper responses");
    const target = await this.ensureInstalled();
    const command = `${quoteShell(this.python)} ${quoteShell(target)} --root ${quoteShell(this.options.remoteStateDir)} ${quoteShell(action)}`;
    const response = await binary.call(this.transport, command, input, this.options.connectionName,
      options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs });
    if (response.exitCode !== 0) throw new RemoteAgentError("HELPER_EXECUTION_FAILED", "Remote helper did not complete its exchange");
    const stdout = response.stdout;
    const newline = stdout.indexOf(0x0a);
    if (newline === -1) throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Missing or ambiguous remote helper response");
    const firstLine = stdout.subarray(0, newline);
    if (firstLine.length >= 10 && firstLine.subarray(0, 10).toString("latin1") === "SSH_MCP_V1 ") {
      // No frame: an error or an observation answered in envelope-only form.
      const envelope = this.parseEnvelope(stdout.toString("utf8").trimEnd());
      if (envelope.ok) throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Expected a framed block, not a plain envelope");
      throw new RemoteAgentError(envelope.error?.code ?? "HELPER_ERROR", envelope.error?.message ?? "Remote helper failed");
    }
    let control: { size?: unknown };
    try { control = JSON.parse(firstLine.toString("utf8")); }
    catch { throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Malformed block control line"); }
    const size = (control as Record<string, unknown>).size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 8 * 1024 * 1024) {
      throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Block control line carries no usable size");
    }
    const payloadEnd = newline + 1 + size;
    if (stdout.length < payloadEnd + 1 || stdout[payloadEnd] !== 0x0a) {
      throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Framed payload ended before the declared size");
    }
    const payload = stdout.subarray(newline + 1, payloadEnd);
    const envelope = this.parseEnvelope(stdout.subarray(payloadEnd + 1).toString("utf8").trimEnd());
    if (!envelope.ok) throw new RemoteAgentError(envelope.error?.code ?? "HELPER_ERROR", envelope.error?.message ?? "Remote helper failed");
    return { control: control as Record<string, unknown>, payload, result: envelope.result ?? {} };
  }

  private parseEnvelope(line: string): { ok: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string } } {
    if (!/^SSH_MCP_V1 [A-Za-z0-9+/]+={0,2}$/.test(line) || line.includes("\n")) {
      throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Missing or ambiguous remote helper response");
    }
    try {
      const envelope = JSON.parse(Buffer.from(line.slice(11), "base64").toString("utf8"));
      if (!envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
        throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Invalid remote helper envelope");
      }
      return envelope;
    } catch (error) {
      if (error instanceof RemoteAgentError) throw error;
      throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Malformed remote helper response");
    }
  }

  async call<T = Record<string, unknown>>(action: string, request: Record<string, unknown>,
    options: { timeoutMs?: number } = {}): Promise<T> {
    return this.exchange(action, Buffer.from(JSON.stringify(request), "utf8"), options);
  }
}
