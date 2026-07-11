/**
 * Botocore model reader — the keystone deep module.
 *
 * Locates the installed aws CLI's botocore service models and parses them into
 * a small, typed interface consumed by later slices (engine, wait, paginate).
 *
 * Discovery order for the botocore data directory:
 *   1. Explicit `dataDir` parameter (highest priority — used in tests)
 *   2. `AWS_DATA_PATH` environment variable
 *   3. `which aws` → resolve symlinks → derive sibling path
 *   4. Known fallback install paths for official aws CLI v2 bundles
 *
 * All returned objects are immutable. Parsed models are cached in-process so
 * repeated calls within a process never re-read disk.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

// ── Public types ──────────────────────────────────────────────────────────────

/** Simplified shape type drawn from botocore's type vocabulary. */
export type ShapeType =
  | "string"
  | "integer"
  | "boolean"
  | "list"
  | "map"
  | "structure"
  | "blob"
  | "timestamp"
  | "float"
  | "double"
  | "long";

/** A single input parameter in a distilled operation signature. */
export interface ParamDef {
  readonly name: string;
  readonly type: ShapeType;
  readonly required: boolean;
}

/**
 * A compact, model-derived operation signature — an agent-friendly alternative
 * to the full aws … help output that can run to thousands of lines.
 */
export interface OperationSignature {
  readonly name: string;
  /** All top-level input parameters with their primitive type and required flag. */
  readonly inputParams: readonly ParamDef[];
  /** Top-level output field names (not deep-traversed). */
  readonly outputFields: readonly string[];
}

/** Resolved metadata for a single operation. */
export interface OperationInfo {
  readonly name: string;
  /** Names of input parameters that the service marks as required. */
  readonly required: readonly string[];
  /** Botocore error codes this operation may return. */
  readonly errors: readonly string[];
  /** Distilled signature for agent-ergonomic help. */
  readonly signature: OperationSignature;
}

/** Pagination configuration for a single operation. */
export interface PaginatorConfig {
  /** Input token field name(s). */
  readonly inputToken: string | readonly string[];
  /** Output token field name(s). */
  readonly outputToken: string | readonly string[];
  /** Result key(s) — the output field(s) that carry "the list". */
  readonly resultKeys: readonly string[];
  /** Optional limit-key field name. */
  readonly limitKey: string | undefined;
}

/** A single acceptor in a waiter definition. */
export interface WaiterAcceptor {
  readonly state: "success" | "failure" | "retry";
  readonly matcher: string;
  readonly expected: unknown;
  readonly argument?: string;
}

/** A waiter definition parsed from waiters-2.json. */
export interface WaiterDef {
  readonly name: string;
  readonly operation: string;
  readonly delay: number;
  readonly maxAttempts: number;
  readonly acceptors: readonly WaiterAcceptor[];
}

/** Parsed representation of a botocore service model. */
export interface ServiceModel {
  readonly service: string;
  readonly apiVersion: string;
  readonly operations: ReadonlyMap<string, OperationInfo>;
  readonly paginators: ReadonlyMap<string, PaginatorConfig>;
  readonly waiters: ReadonlyMap<string, WaiterDef>;
}

/** Options for `loadService`. */
export interface LoadServiceOptions {
  /**
   * Override the botocore data directory (the directory that contains
   * per-service subdirectories). Defaults to discovery via the installed
   * `aws` CLI.
   */
  readonly dataDir?: string;
}

// ── Raw botocore JSON types (internal) ───────────────────────────────────────

interface RawShape {
  readonly type: string;
  readonly members?: Readonly<Record<string, { readonly shape: string }>>;
  readonly required?: readonly string[];
  readonly error?: { readonly code?: string };
}

interface RawOperation {
  readonly name: string;
  readonly input?: { readonly shape: string };
  readonly output?: { readonly shape: string };
  readonly errors?: ReadonlyArray<{ readonly shape: string }>;
}

interface RawServiceModel {
  readonly operations: Readonly<Record<string, RawOperation>>;
  readonly shapes: Readonly<Record<string, RawShape>>;
}

interface RawPaginatorEntry {
  readonly input_token: string | readonly string[];
  readonly output_token: string | readonly string[];
  readonly result_key: string | readonly string[];
  readonly limit_key?: string;
}

interface RawPaginatorsFile {
  readonly pagination: Readonly<Record<string, RawPaginatorEntry>>;
}

interface RawAcceptor {
  readonly state: string;
  readonly matcher: string;
  readonly expected: unknown;
  readonly argument?: string;
}

interface RawWaiterEntry {
  readonly delay: number;
  readonly operation: string;
  readonly maxAttempts: number;
  readonly acceptors: ReadonlyArray<RawAcceptor>;
}

interface RawWaitersFile {
  readonly waiters: Readonly<Record<string, RawWaiterEntry>>;
}

// ── In-process model cache ────────────────────────────────────────────────────

// Keyed by `${dataDir}:${service}` to prevent fixture / production data cross-contamination.
const MODEL_CACHE = new Map<string, ServiceModel>();

// ── Known fallback install paths for the official aws CLI v2 bundle ──────────

const KNOWN_DATA_PATHS: readonly string[] = [
  // Official installer on macOS/Linux drops here
  "/usr/local/aws-cli/awscli/botocore/data",
  // Homebrew (Intel)
  "/usr/local/opt/awscli/libexec/lib/python3/dist-packages/botocore/data",
  // Homebrew (Apple Silicon)
  "/opt/homebrew/opt/awscli/libexec/lib/python3/dist-packages/botocore/data",
];

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Locate the botocore data directory — the directory that contains
 * per-service subdirectories (e.g. `sts/`, `ec2/`, …).
 *
 * @param options.override  Explicit path override (highest priority).
 */
export function findBotocoreDataDir(options?: { override?: string }): string {
  // 1. Explicit override parameter
  if (options?.override !== undefined && options.override !== "") {
    if (!existsSync(options.override)) {
      throw new Error(
        `Botocore data directory override '${options.override}' does not exist.\n` +
          "Ensure the AWS CLI v2 is installed: https://aws.amazon.com/cli/",
      );
    }
    return options.override;
  }

  // 2. AWS_DATA_PATH environment variable
  const envPath = process.env["AWS_DATA_PATH"];
  if (envPath !== undefined && envPath !== "") {
    if (!existsSync(envPath)) {
      throw new Error(
        `AWS_DATA_PATH '${envPath}' does not exist.\n` +
          "Ensure the AWS CLI v2 is installed: https://aws.amazon.com/cli/",
      );
    }
    return envPath;
  }

  // 3. Derive from `which aws` → resolve symlinks → sibling botocore/data dir
  const fromWhich = tryDeriveFromWhich();
  if (fromWhich !== undefined) {
    return fromWhich;
  }

  // 4. Known fallback install paths
  for (const candidate of KNOWN_DATA_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not locate the botocore model data directory.\n" +
      "Ensure the AWS CLI v2 is installed: https://aws.amazon.com/cli/\n" +
      "Or set the AWS_DATA_PATH environment variable to the botocore data directory\n" +
      "(e.g. /usr/local/aws-cli/awscli/botocore/data).",
  );
}

function tryDeriveFromWhich(): string | undefined {
  try {
    const awsBin = execSync("which aws 2>/dev/null", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!awsBin) return undefined;

    const realPath = realpathSync(awsBin);
    const candidate = join(dirname(realPath), "awscli", "botocore", "data");
    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // which not found, or real-path failed — fall through
  }
  return undefined;
}

// ── Model loading ─────────────────────────────────────────────────────────────

/**
 * Load (and cache) a botocore service model by service name.
 *
 * @param name     Service name as it appears in the botocore data directory
 *                 (e.g. `"sts"`, `"ec2"`, `"sqs"`).
 * @param options  Optional override for the data directory.
 */
export function loadService(
  name: string,
  options?: LoadServiceOptions,
): ServiceModel {
  const dataDir = options?.dataDir ?? findBotocoreDataDir();
  const cacheKey = `${dataDir}:${name}`;

  const cached = MODEL_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const model = parseService(name, dataDir);
  MODEL_CACHE.set(cacheKey, model);
  return model;
}

// ── Public accessors ──────────────────────────────────────────────────────────

/**
 * Return the OperationInfo for a named operation.
 * Throws if the operation does not exist in the model.
 */
export function getOperation(
  service: ServiceModel,
  opName: string,
): OperationInfo {
  const op = service.operations.get(opName);
  if (op === undefined) {
    throw new Error(
      `Operation '${opName}' not found in service '${service.service}'.\n` +
        `Available operations: ${[...service.operations.keys()].join(", ")}`,
    );
  }
  return op;
}

/**
 * Return the PaginatorConfig for a named operation, or `undefined` if the
 * operation has no paginator.
 */
export function getPaginator(
  service: ServiceModel,
  opName: string,
): PaginatorConfig | undefined {
  return service.paginators.get(opName);
}

/**
 * Return the WaiterDef for a named waiter, or `undefined` if it does not
 * exist in this service.
 */
export function getWaiter(
  service: ServiceModel,
  waiterName: string,
): WaiterDef | undefined {
  return service.waiters.get(waiterName);
}

/**
 * Return the names of all waiters defined for this service.
 */
export function listWaiters(service: ServiceModel): readonly string[] {
  return [...service.waiters.keys()];
}

// ── Name conversion utilities — exported for reuse by engine and wait ─────────

/**
 * Convert a botocore PascalCase name to its CLI kebab-case equivalent.
 *
 * Implements botocore's two-pass `xform_name` algorithm — acronym-safe:
 *   "DescribeDBInstances"        → "describe-db-instances"
 *   "GetIPSet"                   → "get-ip-set"
 *   "ListSMSSandboxPhoneNumbers" → "list-sms-sandbox-phone-numbers"
 *
 * Exported here so the engine and the wait command share one implementation.
 * The private copy that existed in `src/commands/wait.ts` imports this instead.
 */
export function pascalToKebab(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Resolve a user's kebab-case operation name to the exact PascalCase key
 * stored in the botocore model.
 *
 * Performs a reverse-map lookup over the model's actual PascalCase keys via
 * `pascalToKebab`. This is the only correct approach for acronym-bearing names:
 *   "get-ip-set"   → "GetIPSet"   (naive title-casing gives "GetIpSet" — wrong)
 *   "describe-db-instances" → "DescribeDBInstances"
 *
 * @returns The PascalCase key if found, or `undefined` if no op matches.
 */
export function resolveOperationName(
  service: ServiceModel,
  kebabOp: string,
): string | undefined {
  for (const pascalKey of service.operations.keys()) {
    if (pascalToKebab(pascalKey) === kebabOp) {
      return pascalKey;
    }
  }
  return undefined;
}

// ── Parsing internals ─────────────────────────────────────────────────────────

function parseService(name: string, dataDir: string): ServiceModel {
  const serviceDir = join(dataDir, name);
  if (!existsSync(serviceDir)) {
    throw new Error(
      `Service '${name}' not found in botocore data directory '${dataDir}'.\n` +
        "Check the service name matches the botocore directory (e.g. 'sts', 'ec2', 'sqs').",
    );
  }

  const apiVersion = resolveLatestApiVersion(serviceDir, name);
  const versionDir = join(serviceDir, apiVersion);

  const rawService = readJsonFile<RawServiceModel>(
    join(versionDir, "service-2.json"),
    name,
    "service-2.json",
  );

  const operations = buildOperationsMap(rawService);
  const paginators = buildPaginatorsMap(versionDir);
  const waiters = buildWaitersMap(versionDir);

  return Object.freeze({
    service: name,
    apiVersion,
    operations,
    paginators,
    waiters,
  });
}

/**
 * Find the latest api-version directory under a service dir.
 * Version dirs are ISO-date strings (e.g. `2011-06-15`) — lexicographic
 * sort descending gives the latest.
 */
function resolveLatestApiVersion(serviceDir: string, service: string): string {
  const entries = readdirSync(serviceDir, { withFileTypes: true });
  const versionDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  if (versionDirs.length === 0) {
    throw new Error(
      `No api-version directories found under '${serviceDir}' for service '${service}'.`,
    );
  }

  // Take the lexicographically largest (= latest ISO-date string)
  return versionDirs[0] as string;
}

function buildOperationsMap(
  raw: RawServiceModel,
): ReadonlyMap<string, OperationInfo> {
  const map = new Map<string, OperationInfo>();
  for (const [opName, rawOp] of Object.entries(raw.operations)) {
    map.set(opName, buildOperationInfo(opName, rawOp, raw.shapes));
  }
  return map;
}

function buildOperationInfo(
  opName: string,
  rawOp: RawOperation,
  shapes: Readonly<Record<string, RawShape>>,
): OperationInfo {
  const inputShapeName = rawOp.input?.shape;
  const inputShape =
    inputShapeName !== undefined ? shapes[inputShapeName] : undefined;

  const required: string[] = inputShape?.required
    ? [...inputShape.required]
    : [];

  const errors: string[] = (rawOp.errors ?? []).map((e) =>
    resolveErrorCode(e.shape, shapes),
  );

  const signature = buildSignature(opName, rawOp, shapes);

  return Object.freeze({ name: opName, required, errors, signature });
}

/**
 * Resolve the botocore error code for a given error shape name.
 * If the shape has an `error.code` block, that is the wire code (e.g.
 * `MalformedPolicyDocument`). Otherwise fall back to the shape name itself
 * (e.g. `InvalidMessageContents`).
 */
function resolveErrorCode(
  shapeName: string,
  shapes: Readonly<Record<string, RawShape>>,
): string {
  const shape = shapes[shapeName];
  return shape?.error?.code ?? shapeName;
}

function buildSignature(
  opName: string,
  rawOp: RawOperation,
  shapes: Readonly<Record<string, RawShape>>,
): OperationSignature {
  const inputShapeName = rawOp.input?.shape;
  const inputShape =
    inputShapeName !== undefined ? shapes[inputShapeName] : undefined;
  const requiredSet = new Set(inputShape?.required ?? []);

  const inputParams: ParamDef[] = Object.entries(
    inputShape?.members ?? {},
  ).map(([memberName, memberRef]) => {
    const memberShape = shapes[memberRef.shape];
    return Object.freeze({
      name: memberName,
      type: normalizeShapeType(memberShape?.type),
      required: requiredSet.has(memberName),
    });
  });

  const outputShapeName = rawOp.output?.shape;
  const outputShape =
    outputShapeName !== undefined ? shapes[outputShapeName] : undefined;
  const outputFields = Object.keys(outputShape?.members ?? []);

  return Object.freeze({ name: opName, inputParams, outputFields });
}

function normalizeShapeType(raw: string | undefined): ShapeType {
  const valid: readonly string[] = [
    "string",
    "integer",
    "boolean",
    "list",
    "map",
    "structure",
    "blob",
    "timestamp",
    "float",
    "double",
    "long",
  ];
  if (raw !== undefined && valid.includes(raw)) {
    return raw as ShapeType;
  }
  // Unknown/missing type → default to string (safe for display purposes)
  return "string";
}

function buildPaginatorsMap(
  versionDir: string,
): ReadonlyMap<string, PaginatorConfig> {
  const filePath = join(versionDir, "paginators-1.json");
  if (!existsSync(filePath)) {
    return new Map();
  }

  const raw = readJsonFile<RawPaginatorsFile>(
    filePath,
    versionDir,
    "paginators-1.json",
  );

  const map = new Map<string, PaginatorConfig>();
  for (const [opName, entry] of Object.entries(raw.pagination)) {
    map.set(opName, buildPaginatorConfig(entry));
  }
  return map;
}

function buildPaginatorConfig(entry: RawPaginatorEntry): PaginatorConfig {
  const resultKeys = Array.isArray(entry.result_key)
    ? (entry.result_key as readonly string[])
    : [entry.result_key as string];

  return Object.freeze({
    inputToken: entry.input_token,
    outputToken: entry.output_token,
    resultKeys,
    limitKey: entry.limit_key,
  });
}

function buildWaitersMap(versionDir: string): ReadonlyMap<string, WaiterDef> {
  const filePath = join(versionDir, "waiters-2.json");
  if (!existsSync(filePath)) {
    return new Map();
  }

  const raw = readJsonFile<RawWaitersFile>(
    filePath,
    versionDir,
    "waiters-2.json",
  );

  const map = new Map<string, WaiterDef>();
  for (const [waiterName, entry] of Object.entries(raw.waiters)) {
    map.set(waiterName, buildWaiterDef(waiterName, entry));
  }
  return map;
}

function buildWaiterDef(name: string, entry: RawWaiterEntry): WaiterDef {
  const acceptors: WaiterAcceptor[] = entry.acceptors.map((a) =>
    Object.freeze({
      state: a.state as WaiterAcceptor["state"],
      matcher: a.matcher,
      expected: a.expected,
      argument: a.argument,
    }),
  );

  return Object.freeze({
    name,
    operation: entry.operation,
    delay: entry.delay,
    maxAttempts: entry.maxAttempts,
    acceptors,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonFile<T>(
  filePath: string,
  context: string,
  fileName: string,
): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read botocore model file '${fileName}' in '${context}': ${String(err)}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse botocore model file '${fileName}' in '${context}': ${String(err)}`,
    );
  }
}
