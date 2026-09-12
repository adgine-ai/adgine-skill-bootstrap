#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function bootstrapRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function readLocalVersion(root = bootstrapRoot()) {
  const versionPath = path.join(root, "VERSION");
  if (fs.statSync(versionPath, { throwIfNoEntry: false })?.isFile()) {
    return validateVersion(fs.readFileSync(versionPath, "utf8").trim());
  }
  const releasePath = path.join(root, "release.json");
  if (fs.statSync(releasePath, { throwIfNoEntry: false })?.isFile()) {
    const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    return validateVersion(release.version);
  }
  throw new Error("Bootstrap VERSION is unavailable");
}

function readBootstrapProfile(root = bootstrapRoot()) {
  const profilePath = path.join(root, "bootstrap-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  if (
    profile?.schema_version !== 1 ||
    !new Set(["test", "production"]).has(profile.channel) ||
    profile.environment !== profile.channel ||
    typeof profile.version_url !== "string" ||
    typeof profile.release_url !== "string"
  ) {
    throw new Error("invalid Bootstrap profile");
  }
  return profile;
}

function cacheFile(channel) {
  return path.join(os.tmpdir(), `adgine-skill-bootstrap-${channel}-version.json`);
}

function validateVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) throw new Error("invalid Bootstrap version");
  return value.replace(/^v/, "");
}

function compareVersions(left, right) {
  const a = VERSION_PATTERN.exec(left);
  const b = VERSION_PATTERN.exec(right);
  if (!a || !b) throw new Error("invalid semantic version");
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  return a[4].localeCompare(b[4]);
}

function readFreshCache(channel, now = Date.now()) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(channel), "utf8"));
    if (Number.isFinite(cached.checked_at_ms) && now - cached.checked_at_ms < CACHE_TTL_MS) {
      return validateVersion(cached.latest);
    }
  } catch {
    // A missing or malformed cache only causes a fresh remote lookup.
  }
  return "";
}

function writeCache(channel, latest, now = Date.now()) {
  try {
    fs.writeFileSync(cacheFile(channel), `${JSON.stringify({ checked_at_ms: now, latest })}\n`, { mode: 0o600 });
  } catch {
    // Version checks must never fail the caller because caching is unavailable.
  }
}

async function fetchLatestVersion({ force = false, profile } = {}) {
  if (!force) {
    const cached = readFreshCache(profile.channel);
    if (cached) return cached;
  }
  const testMode = process.env.NODE_ENV === "test";
  const remoteURL = testMode && process.env.ADGINE_BOOTSTRAP_VERSION_TEST_URL
    ? process.env.ADGINE_BOOTSTRAP_VERSION_TEST_URL
    : `${profile.version_url}?t=${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(remoteURL, {
      headers: {
        Accept: "text/plain",
        "Cache-Control": "no-cache",
        "User-Agent": "adgine-skill-bootstrap-version-check/1.0",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`version request returned HTTP ${response.status}`);
    const latest = validateVersion((await response.text()).trim());
    if (!(testMode && process.env.ADGINE_BOOTSTRAP_VERSION_TEST_URL)) writeCache(profile.channel, latest);
    return latest;
  } finally {
    clearTimeout(timer);
  }
}

async function getVersionState(options = {}) {
  if (process.env.ADGINE_SKIP_BOOTSTRAP_VERSION_CHECK) return null;
  try {
    const root = options.root || bootstrapRoot();
    const profile = readBootstrapProfile(root);
    const current = readLocalVersion(root);
    const latest = await fetchLatestVersion({ ...options, profile });
    const updateAvailable = compareVersions(latest, current) > 0;
    const installType = fs.existsSync(path.join(root, ".git")) ? "git" : "package";
    return {
      current,
      latest,
      channel: profile.channel,
      update_available: updateAvailable,
      install_type: installType,
      update_command: installType === "git" ? `git -C ${root} pull --ff-only` : "",
      release_url: profile.release_url,
    };
  } catch (error) {
    if (process.env.ADGINE_BOOTSTRAP_VERSION_DEBUG === "1") {
      process.stderr.write(`[check_version] ${error.message}\n`);
    }
    return null;
  }
}

function formatUserInline(state) {
  if (!state?.update_available) return "";
  if (state.install_type === "git") {
    return `Adgine Skill Bootstrap ${state.channel || "production"} v${state.latest} 已发布（当前 v${state.current}）。请确认后更新到最新版本。`;
  }
  return `Adgine Skill Bootstrap ${state.channel || "production"} v${state.latest} 已发布（当前 v${state.current}）。请前往 ${state.release_url} 下载最新版并在当前 Agent 中重新安装。`;
}

async function main(argv = process.argv.slice(2)) {
  const state = await getVersionState({ force: argv.includes("--force") });
  if (argv.includes("--human")) {
    const message = formatUserInline(state);
    if (message) process.stdout.write(`${message}\n`);
    return;
  }
  if (argv.includes("--notice")) {
    if (state?.update_available) {
      process.stdout.write(`_notice: ${JSON.stringify({ update: { ...state, message: formatUserInline(state) } })}\n`);
    }
    return;
  }
  if (state) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch(() => {
    // Update checks are advisory and must never block Skill execution.
  });
}

export { compareVersions, formatUserInline, getVersionState, readLocalVersion, validateVersion };
