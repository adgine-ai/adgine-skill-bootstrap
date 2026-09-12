#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { formatUserInline, getVersionState } from "./check_version.mjs";

const LOCK_SCHEMA_VERSION = 1;
const PROFILE_SCHEMA_VERSION = 1;
const RUNTIME_SCHEMA_VERSION = 1;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1000;
const MANIFEST_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const AGENT_HOST = "universal";

function configuration() {
  // The generated package carries one immutable test or production profile.
  // Isolated tests may override paths and endpoints, but normal users only
  // configure ADGINE_API_KEY.
  const testMode = process.env.NODE_ENV === "test";
  const testProfileFile = testMode ? process.env.ADGINE_SKILLCTL_TEST_PROFILE_FILE : "";
  const testBaseUrl = testMode ? process.env.ADGINE_SKILLCTL_TEST_BASE_URL : "";
  const testSkillsDir = testMode ? process.env.ADGINE_SKILLCTL_TEST_SKILLS_DIR : "";
  const testCredentialsFile = testMode ? process.env.ADGINE_SKILLCTL_TEST_CREDENTIALS_FILE : "";
  const profile = loadBootstrapProfile(testProfileFile ? path.resolve(expandHome(testProfileFile)) : undefined);
  const skillsDir = testSkillsDir ? path.resolve(expandHome(testSkillsDir)) : detectAgentSkillsDir();
  return {
    channel: profile.channel,
    environment: profile.environment,
    baseUrl: (testBaseUrl || profile.access_center_url).replace(/\/+$/, ""),
    credentialsFile: expandHome(testCredentialsFile || "~/.adgine/credentials.json"),
    runtimeFile: path.join(skillsDir, ".adgine-runtime.json"),
    skillsDir,
    skillsDirSource: testSkillsDir ? "test-override" : "bootstrap-parent",
    host: AGENT_HOST,
  };
}

function bootstrapRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function loadBootstrapProfile(profilePath = path.join(bootstrapRoot(), "bootstrap-profile.json")) {
  if (!fs.statSync(profilePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Bootstrap profile is missing: ${profilePath}`);
  }
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  } catch {
    throw new Error(`Bootstrap profile is invalid: ${profilePath}`);
  }
  return validateBootstrapProfile(profile);
}

function validateBootstrapProfile(profile) {
  if (
    !profile ||
    profile.schema_version !== PROFILE_SCHEMA_VERSION ||
    !new Set(["test", "production"]).has(profile.channel) ||
    profile.environment !== profile.channel ||
    typeof profile.access_center_url !== "string" ||
    typeof profile.version_url !== "string" ||
    typeof profile.release_url !== "string"
  ) {
    throw new Error("Bootstrap profile has an invalid environment contract");
  }
  validateBaseURL(profile.access_center_url);
  validateHTTPSURL(profile.version_url, "Bootstrap version URL");
  validateHTTPSURL(profile.release_url, "Bootstrap release URL");
  return profile;
}

function detectAgentSkillsDir() {
  const scriptPath = fileURLToPath(import.meta.url);
  const bootstrapDir = path.dirname(path.dirname(scriptPath));
  if (!fs.statSync(path.join(bootstrapDir, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("cannot locate the Bootstrap Skill directory from skillctl; reinstall the Bootstrap package");
  }
  return path.resolve(path.dirname(bootstrapDir));
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";
  const cfg = configuration();
  switch (command) {
    case "doctor":
      output(await doctor(cfg));
      return;
    case "login":
      output(await login(cfg));
      return;
    case "manifest":
      output(await fetchManifest(cfg, loadAPIKey(cfg)));
      return;
    case "sync":
      output(await withSyncLock(cfg.skillsDir, () => synchronize(cfg, loadAPIKey(cfg))));
      return;
    case "preflight":
      output(await preflight(cfg));
      return;
    case "check-update":
      output((await getVersionState()) || { update_available: false, check_unavailable: true });
      return;
    case "permission-denied":
      output(await handlePermissionDenied(cfg, argv[1]));
      return;
    case "list":
      output(readLock(cfg.skillsDir));
      return;
    case "disable":
      if (!argv[1]) throw new Error("disable requires a Skill id");
      output(disableManagedSkill(cfg.skillsDir, argv[1]));
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write("Usage: skillctl.mjs {doctor|login|manifest|sync|preflight|check-update|permission-denied <error-code>|list|disable <skill-id>}\n");
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function handlePermissionDenied(cfg, errorCode) {
  if (!new Set(["skill_forbidden", "capability_forbidden", "operation_forbidden"]).has(errorCode)) {
    throw new Error("permission-denied requires skill_forbidden, capability_forbidden, or operation_forbidden");
  }
  const result = await withSyncLock(cfg.skillsDir, () => synchronize(cfg, loadAPIKey(cfg), { mode: "permission-denied" }));
  result.permission_error_code = errorCode;
  result.user_message = "API Key 的 Adgine Skill 权限已发生变化；已强制同步最新授权，本次被拒绝的操作不会自动重试。";
  return result;
}

async function preflight(cfg) {
  const lock = readLock(cfg.skillsDir);
  if (isManifestCheckFresh(lock) && runtimeMatchesConfiguration(cfg, lock)) {
    const result = {
      mode: "preflight",
      manifest_checked: false,
      reason: "checked-within-10-minutes",
      revision: lock.manifest_revision,
      permission_revision: lock.permission_revision ?? lock.manifest_revision,
      catalog_revision: lock.catalog_revision ?? 0,
      manifest_etag: lock.manifest_etag ?? "",
      channel: cfg.channel,
      environment: cfg.environment,
      access_center_url: cfg.baseUrl,
      service_endpoints: readRuntimeConfig(cfg.runtimeFile)?.services || {},
      installed: [],
      upgraded: [],
      unchanged: [],
      removed: [],
    };
    addBootstrapUpdate(result, await getVersionState());
    return result;
  }
  return withSyncLock(cfg.skillsDir, () => synchronize(cfg, loadAPIKey(cfg), { mode: "preflight" }));
}

async function doctor(cfg) {
  const existingParent = nearestExistingParent(cfg.skillsDir);
  let writable = false;
  try {
    fs.accessSync(existingParent, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  const report = {
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    fetch_available: typeof fetch === "function",
    channel: cfg.channel,
    environment: cfg.environment,
    access_center_url: cfg.baseUrl,
    host: cfg.host,
    skills_dir: cfg.skillsDir,
    skills_dir_source: cfg.skillsDirSource,
    nearest_existing_parent: existingParent,
    writable,
    api_key_configured: Boolean(findAPIKey(cfg)),
    credentials_file: cfg.credentialsFile,
    runtime_file: cfg.runtimeFile,
  };
  try {
    const runtime = readRuntimeConfig(cfg.runtimeFile);
    report.runtime_configured = Boolean(runtime);
    report.runtime_environment = runtime?.environment || "";
    report.service_endpoints = runtime?.services || {};
  } catch (error) {
    report.runtime_configured = false;
    report.runtime_error = error.message;
  }
  if (!report.fetch_available) {
    report.warning = "Node.js 18 or newer is required because fetch is unavailable.";
  }
  return report;
}

async function login(cfg) {
  const apiKey = (await readSecret("Adgine API Key: ")).trim();
  validateAPIKeyShape(apiKey);
  atomicWriteJSON(cfg.credentialsFile, { schema_version: 1, api_key: apiKey }, 0o600);
  if (fs.existsSync(cfg.runtimeFile)) fs.unlinkSync(cfg.runtimeFile);
  return {
    saved: true,
    channel: cfg.channel,
    environment: cfg.environment,
    access_center_url: cfg.baseUrl,
    credentials_file: cfg.credentialsFile,
  };
}

async function synchronize(cfg, apiKey, { mode = "sync" } = {}) {
  if (typeof fetch !== "function") throw new Error("Node.js 18 or newer is required");
  fs.mkdirSync(cfg.skillsDir, { recursive: true, mode: 0o700 });
  const [manifest, bootstrapVersion] = await Promise.all([
    fetchManifest(cfg, apiKey),
    getVersionState(),
  ]);
  const lock = readLock(cfg.skillsDir);
  const desired = new Map(manifest.skills.map((skill) => [skill.id, skill]));
  const result = {
    mode,
    manifest_checked: true,
    channel: cfg.channel,
    environment: manifest.runtime.environment,
    access_center_url: cfg.baseUrl,
    service_endpoints: manifest.runtime.services,
    revision: manifest.permission_revision,
    permission_revision: manifest.permission_revision,
    catalog_revision: manifest.catalog_revision,
    manifest_etag: manifest.manifest_etag,
    installed: [],
    upgraded: [],
    unchanged: [],
    removed: [],
  };

  for (const skill of manifest.skills) {
    const current = lock.installed[skill.id];
    const target = managedSkillPath(cfg.skillsDir, skill.id);
    if (current?.status === "active" && current.version === skill.version && current.sha256 === skill.sha256 && fs.existsSync(path.join(target, "SKILL.md"))) {
      result.unchanged.push(skill.id);
      continue;
    }
    if (!current && fs.existsSync(target)) {
      throw new Error(`refusing to overwrite unmanaged Skill directory: ${target}`);
    }
    const archive = await downloadSkill(cfg, apiKey, skill);
    installArchive(cfg.skillsDir, skill.id, archive, Boolean(current));
    lock.installed[skill.id] = { version: skill.version, sha256: skill.sha256, status: "active" };
    if (current) result.upgraded.push(skill.id);
    else result.installed.push(skill.id);
  }

  for (const skillID of Object.keys(lock.installed)) {
    if (desired.has(skillID)) continue;
    removeManagedSkillFiles(cfg.skillsDir, skillID);
    delete lock.installed[skillID];
    result.removed.push(skillID);
  }

  const checkedAt = new Date().toISOString();
  writeRuntimeConfig(cfg, manifest, checkedAt, apiKey);
  lock.manifest_revision = manifest.permission_revision;
  lock.permission_revision = manifest.permission_revision;
  lock.catalog_revision = manifest.catalog_revision;
  lock.manifest_etag = manifest.manifest_etag;
  lock.manifest_checked_at = checkedAt;
  lock.environment = cfg.environment;
  lock.access_center_url = cfg.baseUrl;
  lock.updated_at = checkedAt;
  writeLock(cfg.skillsDir, lock);
  addBootstrapUpdate(result, bootstrapVersion);
  return result;
}

function isManifestCheckFresh(lock, now = Date.now()) {
  const timestamp = Date.parse(lock.manifest_checked_at || lock.updated_at || "");
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= 0 && age < MANIFEST_CHECK_INTERVAL_MS;
}

function addBootstrapUpdate(result, state) {
  if (!state?.update_available) return;
  result.bootstrap_update = {
    current: state.current,
    latest: state.latest,
    install_type: state.install_type,
    release_url: state.release_url,
    update_command: state.update_command,
    message: formatUserInline(state),
  };
}

async function fetchManifest(cfg, apiKey) {
  validateBaseURL(cfg.baseUrl);
  if (!IDENTIFIER_PATTERN.test(cfg.host)) throw new Error("the built-in host selector is invalid");
  const manifestURL = new URL("/api/v1/skills/manifest", cfg.baseUrl);
  manifestURL.searchParams.set("host", cfg.host);
  const response = await fetchWithTimeout(manifestURL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "adgine-skillctl/0.3.0" },
  });
  if (!response.ok) throw await responseError(response, "manifest request failed");
  return validateManifest(await response.json(), { expectedEnvironment: cfg.environment });
}

async function downloadSkill(cfg, apiKey, skill) {
  const targetURL = new URL(skill.download_url, cfg.baseUrl);
  const allowedOrigin = new URL(cfg.baseUrl).origin;
  if (targetURL.origin !== allowedOrigin) throw new Error(`refusing cross-origin artifact URL for ${skill.id}`);
  const response = await fetchWithTimeout(targetURL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/zip", "User-Agent": "adgine-skillctl/0.3.0" },
  });
  if (!response.ok) throw await responseError(response, `download failed for ${skill.id}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error(`archive is too large for ${skill.id}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES || archive.length !== skill.size) {
    throw new Error(`artifact size mismatch for ${skill.id}`);
  }
  if (sha256Hex(archive) !== skill.sha256) throw new Error(`artifact SHA-256 mismatch for ${skill.id}`);
  return archive;
}

async function fetchWithTimeout(target, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(target, { ...options, signal: controller.signal, redirect: "error" });
  } finally {
    clearTimeout(timer);
  }
}

async function responseError(response, fallback) {
  let code = "";
  try {
    const payload = await response.json();
    code = payload?.error?.code || "";
  } catch {
    // Ignore untrusted non-JSON response bodies.
  }
  return new Error(`${fallback}: HTTP ${response.status}${code ? ` (${code})` : ""}`);
}

function validateManifest(value, { expectedEnvironment = "" } = {}) {
  if (expectedEnvironment && value?.runtime?.environment && value.runtime.environment !== expectedEnvironment) {
    throw new Error(`Access Center environment ${value.runtime.environment} does not match Bootstrap ${expectedEnvironment}`);
  }
  if (
    !value ||
    value.schema_version !== 2 ||
    !Number.isSafeInteger(value.permission_revision) ||
    value.permission_revision < 1 ||
    value.revision !== value.permission_revision ||
    !Number.isSafeInteger(value.catalog_revision) ||
    value.catalog_revision < 1 ||
    !/^[0-9a-f]{64}$/.test(value.manifest_etag) ||
    !validManifestRuntime(value.runtime, expectedEnvironment) ||
    !Array.isArray(value.skills)
  ) {
    throw new Error("Access Center returned an invalid v2 manifest");
  }
  const seen = new Set();
  for (const skill of value.skills) {
    const expectedInstall = skill?.id ? `skill.${skill.id}.install` : "";
    if (
      !skill ||
      !IDENTIFIER_PATTERN.test(skill.id) ||
      typeof skill.display_name !== "string" ||
      !skill.display_name ||
      !VERSION_PATTERN.test(skill.version) ||
      typeof skill.download_url !== "string" ||
      !skill.download_url ||
      !/^[0-9a-f]{64}$/.test(skill.sha256) ||
      !Number.isSafeInteger(skill.size) ||
      skill.size < 1 ||
      skill.install_capability !== expectedInstall ||
      !Array.isArray(skill.required_capabilities) ||
      new Set(skill.required_capabilities).size !== skill.required_capabilities.length ||
      skill.required_capabilities.includes(expectedInstall) ||
      skill.required_capabilities.some((code) => typeof code !== "string" || !CAPABILITY_PATTERN.test(code))
    ) {
      throw new Error("Access Center returned an invalid Skill entry");
    }
    if (seen.has(skill.id)) throw new Error(`manifest contains duplicate Skill ${skill.id}`);
    seen.add(skill.id);
  }
  return value;
}

function validManifestRuntime(runtime, expectedEnvironment) {
  if (
    !runtime ||
    !IDENTIFIER_PATTERN.test(runtime.environment) ||
    (expectedEnvironment && runtime.environment !== expectedEnvironment) ||
    !runtime.services ||
    typeof runtime.services !== "object" ||
    Array.isArray(runtime.services) ||
    !runtime.services["geo-api"]
  ) {
    return false;
  }
  const entries = Object.entries(runtime.services);
  if (!entries.length) return false;
  return entries.every(([serviceID, endpoint]) => {
    if (!IDENTIFIER_PATTERN.test(serviceID) || !endpoint || typeof endpoint.base_url !== "string") return false;
    try {
      validateBaseURL(endpoint.base_url);
      return true;
    } catch {
      return false;
    }
  });
}

function installArchive(skillsDir, skillID, archive, managed) {
  const target = managedSkillPath(skillsDir, skillID);
  if (fs.existsSync(target) && !managed) throw new Error(`refusing to overwrite unmanaged Skill directory: ${target}`);
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(skillsDir, ".adgine-install-"));
  let backup = "";
  try {
    extractZip(archive, temporary);
    if (!fs.statSync(path.join(temporary, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`archive for ${skillID} does not contain a root SKILL.md`);
    }
    if (fs.existsSync(target)) {
      backup = `${target}.adgine-backup-${Date.now()}`;
      fs.renameSync(target, backup);
    }
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (backup && !fs.existsSync(target)) fs.renameSync(backup, target);
      throw error;
    }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function extractZip(archive, destination) {
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > MAX_ARCHIVE_BYTES) throw new Error("invalid ZIP archive size");
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entryCount > MAX_ARCHIVE_ENTRIES || centralOffset + centralSize > eocd) {
    throw new Error("unsupported ZIP archive layout");
  }

  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(archive, cursor, 46);
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP central directory");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    ensureRange(archive, cursor + 46, nameLength + extraLength + commentLength);
    if (flags & 0x1) throw new Error("encrypted ZIP entries are not supported");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const safeName = sanitizeZipEntry(name);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`symbolic links are not allowed in Skill ZIPs: ${name}`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("uncompressed ZIP content is too large");

    ensureRange(archive, localOffset, 30);
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid ZIP local header");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    ensureRange(archive, localOffset + 30, localNameLength + localExtraLength);
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localName !== name) throw new Error(`ZIP header name mismatch for ${name}`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    ensureRange(archive, dataOffset, compressedSize);
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);

    const outputPath = path.join(destination, ...safeName.split("/"));
    assertInside(destination, outputPath);
    if (name.endsWith("/")) {
      fs.mkdirSync(outputPath, { recursive: true, mode: 0o755 });
    } else {
      let payload;
      if (method === 0) payload = Buffer.from(compressed);
      else if (method === 8) payload = zlib.inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
      else throw new Error(`unsupported ZIP compression method ${method}`);
      if (payload.length !== uncompressedSize) throw new Error(`ZIP size mismatch for ${name}`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o755 });
      fs.writeFileSync(outputPath, payload, { mode: unixMode & 0o111 ? 0o755 : 0o644, flag: "wx" });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central directory size mismatch");
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let cursor = archive.length - 22; cursor >= minimum; cursor -= 1) {
    if (archive.readUInt32LE(cursor) === 0x06054b50) return cursor;
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

function ensureRange(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error("ZIP entry is out of bounds");
  }
}

function sanitizeZipEntry(name) {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`unsafe ZIP entry: ${JSON.stringify(name)}`);
  }
  const withoutTrailingSlash = name.endsWith("/") ? name.slice(0, -1) : name;
  const parts = withoutTrailingSlash.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe ZIP entry: ${JSON.stringify(name)}`);
  }
  return parts.join("/");
}

function readLock(skillsDir) {
  const lockPath = path.join(skillsDir, ".adgine-skillctl-lock.json");
  if (!fs.existsSync(lockPath)) {
    return {
      schema_version: LOCK_SCHEMA_VERSION,
      manifest_revision: 0,
      permission_revision: 0,
      catalog_revision: 0,
      manifest_etag: "",
      environment: "",
      access_center_url: "",
      updated_at: null,
      installed: {},
    };
  }
  const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (!value || value.schema_version !== LOCK_SCHEMA_VERSION || !value.installed || typeof value.installed !== "object" || Array.isArray(value.installed)) {
    throw new Error(`invalid Adgine lock file: ${lockPath}`);
  }
  return value;
}

function runtimeMatchesConfiguration(cfg, lock) {
  if (lock.environment !== cfg.environment || lock.access_center_url !== cfg.baseUrl) return false;
  try {
    const runtime = readRuntimeConfig(cfg.runtimeFile);
    const apiKey = findAPIKey(cfg);
    return Boolean(
      runtime &&
      apiKey &&
      runtime.environment === cfg.environment &&
      runtime.access_center_url === cfg.baseUrl &&
      runtime.manifest_etag === lock.manifest_etag &&
      runtime.key_fingerprint === sha256Hex(Buffer.from(apiKey, "utf8")),
    );
  } catch {
    return false;
  }
}

function readRuntimeConfig(runtimeFile) {
  if (!fs.existsSync(runtimeFile)) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  } catch {
    throw new Error(`invalid managed runtime file: ${runtimeFile}`);
  }
  if (
    !value ||
    value.schema_version !== RUNTIME_SCHEMA_VERSION ||
    !IDENTIFIER_PATTERN.test(value.environment) ||
    typeof value.access_center_url !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.manifest_etag) ||
    !/^[0-9a-f]{64}$/.test(value.key_fingerprint) ||
    !validManifestRuntime({ environment: value.environment, services: value.services }, value.environment)
  ) {
    throw new Error(`invalid managed runtime file: ${runtimeFile}`);
  }
  validateBaseURL(value.access_center_url);
  return value;
}

function writeRuntimeConfig(cfg, manifest, updatedAt, apiKey) {
  const services = {};
  for (const [serviceID, endpoint] of Object.entries(manifest.runtime.services)) {
    services[serviceID] = { base_url: endpoint.base_url.replace(/\/+$/, "") };
  }
  atomicWriteJSON(cfg.runtimeFile, {
    schema_version: RUNTIME_SCHEMA_VERSION,
    environment: manifest.runtime.environment,
    access_center_url: cfg.baseUrl,
    manifest_etag: manifest.manifest_etag,
    key_fingerprint: sha256Hex(Buffer.from(apiKey, "utf8")),
    services,
    updated_at: updatedAt,
  }, 0o600);
}

function writeLock(skillsDir, value) {
  atomicWriteJSON(path.join(skillsDir, ".adgine-skillctl-lock.json"), value, 0o600);
}

function disableManagedSkill(skillsDir, skillID) {
  if (!IDENTIFIER_PATTERN.test(skillID)) throw new Error("invalid Skill id");
  const lock = readLock(skillsDir);
  if (!lock.installed[skillID]) throw new Error(`Skill is not managed by Adgine: ${skillID}`);
  disableSkillFiles(skillsDir, skillID);
  lock.installed[skillID].status = "disabled";
  lock.updated_at = new Date().toISOString();
  writeLock(skillsDir, lock);
  return { disabled: skillID };
}

function disableSkillFiles(skillsDir, skillID) {
  const target = managedSkillPath(skillsDir, skillID);
  const skillFile = path.join(target, "SKILL.md");
  const disabledFile = path.join(target, "SKILL.md.disabled");
  if (fs.existsSync(skillFile)) {
    if (fs.existsSync(disabledFile)) throw new Error(`cannot disable ${skillID}: ${disabledFile} already exists`);
    fs.renameSync(skillFile, disabledFile);
  }
}

function removeManagedSkillFiles(skillsDir, skillID) {
  const target = managedSkillPath(skillsDir, skillID);
  if (!fs.existsSync(target)) return;
  const quarantine = path.join(skillsDir, `.adgine-remove-${skillID}-${crypto.randomBytes(6).toString("hex")}`);
  assertInside(skillsDir, quarantine);
  fs.renameSync(target, quarantine);
  try {
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(quarantine)) fs.renameSync(quarantine, target);
    throw error;
  }
}

function managedSkillPath(skillsDir, skillID) {
  if (!IDENTIFIER_PATTERN.test(skillID)) throw new Error(`invalid Skill id: ${skillID}`);
  const target = path.join(skillsDir, skillID);
  assertInside(skillsDir, target);
  return target;
}

async function withSyncLock(skillsDir, operation) {
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(skillsDir, ".adgine-skillctl-sync.lock");
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`another skillctl sync may be running; remove stale lock only after verifying: ${lockPath}`);
    throw error;
  }
  try {
    return await operation();
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockPath);
  }
}

function findAPIKey(cfg) {
  if (process.env.ADGINE_API_KEY) return process.env.ADGINE_API_KEY.trim();
  try {
    const value = JSON.parse(fs.readFileSync(cfg.credentialsFile, "utf8"));
    return typeof value.api_key === "string" ? value.api_key.trim() : "";
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error(`cannot read credentials file: ${cfg.credentialsFile}`);
  }
}

function loadAPIKey(cfg) {
  const apiKey = findAPIKey(cfg);
  if (!apiKey) throw new Error("Adgine API Key is not configured; use host secret injection or skillctl login");
  validateAPIKeyShape(apiKey);
  return apiKey;
}

function validateAPIKeyShape(apiKey) {
  if (!/^adg_sk_live_[A-Za-z0-9_-]{17,}$/.test(apiKey)) throw new Error("Adgine API Key format is invalid");
}

function validateBaseURL(value) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("the built-in Access Center URL must be an HTTP(S) origin or base path without credentials or query parameters");
  }
}

function validateHTTPSURL(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be an HTTPS URL`);
  }
}

function atomicWriteJSON(target, value, mode) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.tmp-${path.basename(target)}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, mode);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (!relative) return;
    throw new Error(`path escapes managed directory: ${candidate}`);
  }
}

function nearestExistingParent(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sha256Hex(payload) {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    return Promise.resolve(fs.readFileSync(0, "utf8").split(/\r?\n/, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const outputStream = process.stderr;
    let secret = "";
    outputStream.write(prompt);
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      outputStream.write("\n");
    };
    const onKeypress = (text, key) => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("credential input cancelled"));
      } else if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        resolve(secret);
      } else if (key?.name === "backspace") {
        secret = secret.slice(0, -1);
      } else if (text && !key?.ctrl && !key?.meta) {
        secret += text;
      }
    };
    input.on("keypress", onKeypress);
  });
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  extractZip,
  isManifestCheckFresh,
  sanitizeZipEntry,
  sha256Hex,
  validateAPIKeyShape,
  validateBootstrapProfile,
  validateManifest,
};
