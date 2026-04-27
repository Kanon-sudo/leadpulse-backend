import dns from "node:dns/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const dnsCache = new Map();
const emailCache = new Map();
const domainCacheTtlMs = Number(process.env.LEADPULSE_VERIFY_DOMAIN_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const emailCacheTtlMs = Number(process.env.LEADPULSE_VERIFY_EMAIL_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const dnsTimeoutMs = Number(process.env.LEADPULSE_VERIFY_DNS_TIMEOUT_MS || 6000);
const rdapTimeoutMs = Number(process.env.LEADPULSE_VERIFY_RDAP_TIMEOUT_MS || 4500);
const smtpTimeoutMs = Number(process.env.LEADPULSE_SMTP_TIMEOUT_MS || 5000);
const smtpProbeEnabled = String(process.env.LEADPULSE_SMTP_PROBE_ENABLED || "false").toLowerCase() === "true";
const smtpMailFrom = process.env.LEADPULSE_SMTP_MAIL_FROM || "verify@leadpulse.email";
const smtpHeloName = process.env.LEADPULSE_SMTP_HELO_NAME || "leadpulse.email";

const commonDomainTypos = new Map([
  ["gmal.com", "gmail.com"],
  ["gmial.com", "gmail.com"],
  ["gmail.con", "gmail.com"],
  ["gmail.cm", "gmail.com"],
  ["hotmail.con", "hotmail.com"],
  ["hotmial.com", "hotmail.com"],
  ["hotmai.com", "hotmail.com"],
  ["outlok.com", "outlook.com"],
  ["outllok.com", "outlook.com"],
  ["icloud.con", "icloud.com"],
  ["yaho.com", "yahoo.com"],
  ["yahooo.com", "yahoo.com"],
]);

const disposableDomains = new Set([
  "10mail.org",
  "10minutemail.com",
  "10minutemail.net",
  "10minutemail.org",
  "20minutemail.com",
  "disposablemail.com",
  "discard.email",
  "dropmail.me",
  "emailondeck.com",
  "getnada.com",
  "guerrillamail.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailsac.com",
  "nada.email",
  "sharklasers.com",
  "temp-mail.org",
  "tempmail.com",
  "throwaway.email",
  "trashmail.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

const reservedDomains = new Set([
  "example.com",
  "example.net",
  "example.org",
  "invalid",
  "localhost",
  "test.com",
]);

const rolePrefixes = new Set([
  "abuse",
  "admin",
  "billing",
  "careers",
  "compliance",
  "contact",
  "customer",
  "customerservice",
  "facturacion",
  "finance",
  "hello",
  "help",
  "hr",
  "info",
  "jobs",
  "legal",
  "marketing",
  "media",
  "newsletter",
  "noreply",
  "no-reply",
  "office",
  "people",
  "postmaster",
  "press",
  "privacy",
  "recruiting",
  "sales",
  "security",
  "soporte",
  "support",
  "team",
  "ventas",
  "webmaster",
]);

const operationalAliasTokens = new Set([
  "asist",
  "asistente",
  "comp",
  "compras",
  "comunicacion",
  "gte",
  "gtech",
  "gterh",
  "gterrhh",
  "hr",
  "mgr",
  "plantmgr",
  "rh",
  "rrhh",
]);

const suspiciousTlds = new Set(["zip", "mov", "xyz", "click", "top", "loan", "work"]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isLikelyEmail(email) {
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(email);
}

function isDisposableDomain(domain) {
  const normalized = normalizeEmail(domain);
  const parts = normalized.split(".");
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (disposableDomains.has(parts.slice(index).join("."))) {
      return true;
    }
  }
  return disposableDomains.has(normalized);
}

function isLowQualityLocalPart(localPart) {
  const compacted = String(localPart || "").replace(/[._%+-]/g, "");
  if (compacted.length < 8) {
    return false;
  }

  if (isHighRiskLocalPart(localPart)) {
    return false;
  }

  const letters = compacted.replace(/[^a-z]/gi, "");
  if (letters.length >= 8) {
    const vowels = (letters.match(/[aeiou]/gi) || []).length;
    const consonantRuns = letters.match(/[^aeiou]{5,}/gi) || [];
    return vowels / letters.length < 0.18 || consonantRuns.length > 0;
  }

  return false;
}

function isHighRiskLocalPart(localPart) {
  const compacted = String(localPart || "").replace(/[._%+-]/g, "");
  if (compacted.length < 8) {
    return false;
  }

  const digits = compacted.replace(/\D/g, "");
  if (digits.length >= 6 || (digits.length >= 4 && digits.length / compacted.length >= 0.45)) {
    return true;
  }

  if (/^[a-f0-9]{12,}$/i.test(compacted)) {
    return true;
  }

  return false;
}

function isOperationalAliasLocalPart(localPart) {
  const value = String(localPart || "").toLowerCase();
  const compacted = value.replace(/[._%+-]/g, "");
  const tokens = value.split(/[._%+-]+/).filter(Boolean);

  if (/^h\d{3,}[-._]?[a-z]{2}\d?$/i.test(value)) {
    return true;
  }

  if (/^asist[a-z0-9]{4,}$/i.test(compacted) || /^gterr?h?[a-z0-9]{3,}$/i.test(compacted)) {
    return true;
  }

  if (/^(comp|plantmgr|mhmxcomunicacion|mtygtech)[a-z0-9]*$/i.test(compacted)) {
    return true;
  }

  return tokens.some((token) => operationalAliasTokens.has(token));
}

function getCached(cache, key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

async function withTimeout(promise, timeoutMs, fallback) {
  const timeout = delay(timeoutMs).then(() => fallback);
  return Promise.race([promise, timeout]);
}

async function resolveDnsRecord(resolver) {
  try {
    const records = await withTimeout(resolver(), dnsTimeoutMs, null);
    if (records === null) {
      return { records: [], status: "timeout" };
    }
    return { records, status: "ok" };
  } catch (error) {
    const code = String(error?.code || "");
    if (["ENOTFOUND", "ENODATA", "ENODOMAIN"].includes(code)) {
      return { records: [], status: code.toLowerCase() };
    }
    return { records: [], status: "error", error: error instanceof Error ? error.message : code };
  }
}

function analyzeLocal(email) {
  const normalized = normalizeEmail(email);
  const hardIssues = [];
  const warnings = [];
  let domain = "";
  let localPart = "";

  if (!normalized) {
    hardIssues.push("Campo vacio");
    return { normalized, localPart, domain, hardIssues, warnings, typoSuggestion: "" };
  }

  if (/\s/.test(String(email || "").trim())) {
    hardIssues.push("Contiene espacios");
  }

  if (!isLikelyEmail(normalized)) {
    hardIssues.push("Formato invalido");
  }

  [localPart = "", domain = ""] = normalized.split("@");
  const domainParts = domain.split(".");
  const tld = domainParts.at(-1) || "";
  const typoSuggestion = commonDomainTypos.get(domain) || "";

  if (!localPart || !domain) hardIssues.push("Le falta usuario o dominio");
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) hardIssues.push("Local part mal escrito");
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) hardIssues.push("Dominio mal escrito");
  if (!domain.includes(".")) hardIssues.push("Dominio incompleto");
  if (typoSuggestion) hardIssues.push(`Posible typo de dominio: ${typoSuggestion}`);
  if (domainParts.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) hardIssues.push("Etiqueta de dominio invalida");
  if (domain.length > 253) hardIssues.push("Dominio demasiado largo");
  if (tld.length > 0 && tld.length < 2) hardIssues.push("TLD demasiado corto");
  if (suspiciousTlds.has(tld)) hardIssues.push("TLD sospechoso");
  if (/[^a-z0-9.!#$%&'*+/=?^_`{|}~-]/i.test(localPart)) hardIssues.push("Caracteres no validos");
  if (reservedDomains.has(domain)) hardIssues.push("Dominio reservado o de prueba");
  if (isDisposableDomain(domain)) hardIssues.push("Dominio temporal o desechable");
  if (isHighRiskLocalPart(localPart)) hardIssues.push("Local part aleatorio o de baja calidad");
  else if (isOperationalAliasLocalPart(localPart)) hardIssues.push("Alias operativo o departamental");
  else if (isLowQualityLocalPart(localPart)) warnings.push("Local part inusual, revisar manualmente");
  if (rolePrefixes.has(localPart)) hardIssues.push(localPart === "noreply" || localPart === "no-reply" ? "Correo tipo noreply" : "Cuenta de rol");
  if (localPart.length > 64) hardIssues.push("Usuario demasiado largo");
  if (normalized.length > 254) hardIssues.push("Email demasiado largo");
  if (/xn--/.test(domain)) warnings.push("Dominio internacional, revisar manualmente");

  return { normalized, localPart, domain, hardIssues, warnings, typoSuggestion };
}

function parseSpf(txtRecords) {
  const records = txtRecords
    .flat()
    .map((parts) => String(Array.isArray(parts) ? parts.join("") : parts).replace(/"/g, "").trim())
    .filter((value) => /^v=spf1\b/i.test(value));

  if (!records.length) return "missing";
  if (records.length > 1) return "invalid";
  return /\s[~+\-?]all\b/i.test(records[0]) ? "present" : "invalid";
}

function extractDomainAgeDays(rdapData) {
  const events = Array.isArray(rdapData?.events) ? rdapData.events : [];
  const registrationEvent = events.find((event) =>
    ["registration", "registered", "created"].includes(String(event.eventAction || "").toLowerCase())
  );
  const candidateDate = registrationEvent?.eventDate || events[0]?.eventDate || null;
  const parsed = candidateDate ? Date.parse(candidateDate) : Number.NaN;
  if (Number.isNaN(parsed)) return null;
  return Math.max(Math.floor((Date.now() - parsed) / (1000 * 60 * 60 * 24)), 0);
}

async function lookupDomain(domain) {
  const cached = getCached(dnsCache, domain);
  if (cached) return cached;

  const [mxResult, aResult, aaaaResult, txtResult, dmarcResult, rdapResponse] = await Promise.all([
    resolveDnsRecord(() => dns.resolveMx(domain)),
    resolveDnsRecord(() => dns.resolve4(domain)),
    resolveDnsRecord(() => dns.resolve6(domain)),
    resolveDnsRecord(() => dns.resolveTxt(domain)),
    resolveDnsRecord(() => dns.resolveTxt(`_dmarc.${domain}`)),
    withTimeout(fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`).catch(() => null), rdapTimeoutMs, null),
  ]);

  let rdapData = null;
  if (rdapResponse?.ok) {
    rdapData = await rdapResponse.json().catch(() => null);
  }

  const mx = mxResult.records;
  const a = aResult.records;
  const aaaa = aaaaResult.records;
  const txt = txtResult.records;
  const dmarc = dmarcResult.records;
  const dnsStatuses = [mxResult.status, aResult.status, aaaaResult.status];
  const dnsHadLookupFailure = dnsStatuses.some((status) => ["timeout", "error"].includes(status));
  const isNxDomain = dnsStatuses.every((status) => status === "enotfound" || status === "enodomain");
  const txtJoined = txt.flat().join(" | ");
  const parkedStrong = /(parkingcrew|sedoparking|bodis|afternic|namecheap parking|domain parked|dropcatch|hugedomains|(^|[\s|;])dan\.com([\s|;]|$)|undeveloped|domain for sale)/i.test(txtJoined);
  const parkedSoft = /(parking page|parked|this domain is for sale|go daddy|godaddy|squadhelp|(^|[\s|;])sav\.com([\s|;]|$)|namebright)/i.test(txtJoined);
  const hasMx = mx.length > 0;
  const hasA = a.length > 0 || aaaa.length > 0;
  const domainAgeDays = extractDomainAgeDays(rdapData);

  const result = {
    status: "ok",
    mx: mx.sort((left, right) => left.priority - right.priority),
    hasMx,
    hasA,
    spf: parseSpf(txt),
    dmarc: dmarc.flat().some((record) => /v=dmarc1/i.test(String(record))) ? "present" : "missing",
    domainAgeDays,
    isVeryNewDomain: typeof domainAgeDays === "number" && domainAgeDays < 180,
    lookupStatus: {
      mx: mxResult.status,
      a: aResult.status,
      aaaa: aaaaResult.status,
      txt: txtResult.status,
      dmarc: dmarcResult.status,
    },
  };

  if (dnsHadLookupFailure) result.status = "unknown";
  else if (isNxDomain) result.status = "nxdomain";
  else if (parkedStrong) result.status = "parked-strong";
  else if (parkedSoft) result.status = "parked-soft";
  else if (!hasMx && !hasA) result.status = "missing-both";
  else if (!hasMx) result.status = "missing-mx";
  else if (!hasA) result.status = "missing-a";

  setCached(dnsCache, domain, result, domainCacheTtlMs);
  return result;
}

function readSmtpLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const lastLine = lines.at(-1) || "";
      if (/^\d{3}\s/.test(lastLine)) {
        cleanup();
        resolve({ code: Number(lastLine.slice(0, 3)), raw: buffer });
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function smtpCommand(socket, command) {
  socket.write(`${command}\r\n`);
  return readSmtpLine(socket);
}

async function smtpProbe(email, mxRecords) {
  if (!smtpProbeEnabled || !mxRecords.length) {
    return { enabled: smtpProbeEnabled, status: "skipped" };
  }

  const domain = email.split("@")[1];
  const fakeEmail = `lp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@${domain}`;
  const socket = net.createConnection({ host: mxRecords[0].exchange, port: 25 });
  socket.setTimeout(smtpTimeoutMs);

  try {
    await withTimeout(new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("SMTP timeout")));
    }), smtpTimeoutMs, Promise.reject(new Error("SMTP timeout")));

    await readSmtpLine(socket);
    await smtpCommand(socket, `EHLO ${smtpHeloName}`);
    await smtpCommand(socket, `MAIL FROM:<${smtpMailFrom}>`);
    const real = await smtpCommand(socket, `RCPT TO:<${email}>`);
    const fake = await smtpCommand(socket, `RCPT TO:<${fakeEmail}>`);
    await smtpCommand(socket, "QUIT").catch(() => null);

    return {
      enabled: true,
      status: fake.code >= 200 && fake.code < 300 ? "catch_all" : (real.code >= 200 && real.code < 300 ? "accepted" : "rejected"),
      realCode: real.code,
      fakeCode: fake.code,
    };
  } catch (error) {
    return {
      enabled: true,
      status: "unknown",
      error: error instanceof Error ? error.message : "SMTP probe failed",
    };
  } finally {
    socket.destroy();
  }
}

function applyDnsFindings(dnsResult, hardIssues, warnings) {
  if (dnsResult.status === "unknown") {
    warnings.push("No se pudo confirmar DNS");
    return;
  }

  if (dnsResult.status === "nxdomain") hardIssues.push("NXDOMAIN / dominio inexistente");
  else if (dnsResult.status === "parked-strong") hardIssues.push("Parked domain confirmado");
  else if (dnsResult.status === "parked-soft") warnings.push("Parked domain sospechoso");
  else if (dnsResult.status === "missing-both") hardIssues.push("Dominio sin MX ni A");
  else if (dnsResult.status === "missing-mx") hardIssues.push("Dominio sin MX");
  else if (dnsResult.status === "missing-a") warnings.push("Dominio sin A visible");
  if (dnsResult.isVeryNewDomain) warnings.push("Dominio muy nuevo");
  if (dnsResult.dmarc === "missing") warnings.push("Dominio sin DMARC visible");
  if (dnsResult.spf === "missing") warnings.push("Dominio sin SPF visible");
  if (dnsResult.spf === "invalid") warnings.push("SPF invalido o conflictivo");
}

function deriveStatus(hardIssues, warnings, smtp) {
  if (smtp?.status === "catch_all") {
    return { status: "risky", subStatus: "catch_all", score: 55 };
  }
  if (smtp?.status === "rejected") {
    return { status: "invalid", subStatus: "mailbox_rejected", score: 10 };
  }
  if (hardIssues.length) {
    return { status: "invalid", subStatus: "failed_policy", score: 15 };
  }
  if (warnings.length) {
    return { status: "risky", subStatus: "review", score: 70 };
  }
  return { status: "valid", subStatus: "clean", score: smtp?.status === "accepted" ? 95 : 90 };
}

export async function verifyEmailAddress(email, options = {}) {
  const normalized = normalizeEmail(email);
  const cacheKey = `${normalized}:${smtpProbeEnabled ? "smtp" : "nosmtp"}`;
  const cached = getCached(emailCache, cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const local = analyzeLocal(email);
  const hardIssues = [...local.hardIssues];
  const warnings = [...local.warnings];
  let dnsResult = null;
  let smtp = { enabled: smtpProbeEnabled, status: "skipped" };

  if (local.domain && !hardIssues.length && options.dns !== false) {
    dnsResult = await lookupDomain(local.domain);
    applyDnsFindings(dnsResult, hardIssues, warnings);

    if (options.smtp !== false && !hardIssues.length) {
      smtp = await smtpProbe(local.normalized, dnsResult.mx || []);
      if (smtp.status === "catch_all") warnings.push("Catch-all detectado");
      if (smtp.status === "rejected") hardIssues.push("SMTP rechazo el buzon");
    }
  }

  const verdict = deriveStatus(hardIssues, warnings, smtp);
  const result = {
    email: String(email || ""),
    normalizedEmail: local.normalized,
    status: verdict.status,
    subStatus: verdict.subStatus,
    score: verdict.score,
    hardIssues,
    warnings,
    typoSuggestion: local.typoSuggestion,
    dns: dnsResult,
    smtp,
    cached: false,
  };

  setCached(emailCache, cacheKey, result, emailCacheTtlMs);
  return result;
}

export async function verifyEmailBatch(emails, options = {}) {
  const uniqueEmails = [...new Set(
    emails
      .map((email) => String(email || "").trim())
      .filter(Boolean)
  )].slice(0, Number(process.env.LEADPULSE_VERIFY_MAX_BATCH || 1000));

  const results = [];
  for (const email of uniqueEmails) {
    results.push(await verifyEmailAddress(email, options));
  }

  return {
    total: uniqueEmails.length,
    results,
    counters: results.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, { valid: 0, risky: 0, invalid: 0, unknown: 0 }),
  };
}
