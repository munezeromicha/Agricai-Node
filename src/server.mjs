import { GoogleGenerativeAI } from "@google/generative-ai";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import {
  buildSystemInstruction,
  loadClassesSnippet,
  loadProjectKnowledge,
  resolveClassesJsonPath,
  resolveProjectKnowledgePath,
} from "./chatContext.mjs";
import { mountPlatformApi } from "./platformApi.mjs";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo `public/logo.jpeg` (three levels up from `src/` → project root). Override with CONTACT_LOGO_PATH if needed. */
const CONTACT_LOGO_PATH = process.env.CONTACT_LOGO_PATH?.trim()
  ? path.resolve(process.env.CONTACT_LOGO_PATH.trim())
  : path.join(__dirname, "..", "..", "..", "public", "logo.jpeg");
const CONTACT_LOGO_CID = "agricai-logo";

const PORT = Number(process.env.PORT) || 3008;
const MAIL_TO = process.env.MAIL_TO?.trim();
const MAIL_FROM = process.env.MAIL_FROM?.trim();
const SMTP_HOST = process.env.SMTP_HOST?.trim();
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER?.trim();
const SMTP_PASS = process.env.SMTP_PASS?.trim();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
/**
 * `gemini-1.5-flash` returns 404 on current APIs (deprecated / removed for generateContent).
 * Use a current ID from https://ai.google.dev/gemini-api/docs/models — default is stable Flash.
 */
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
/** Used when the primary model returns 503/429 or is unavailable. */
const GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
];
/** Cap disease-library JSON in the system prompt to reduce input tokens (helps per-minute free limits). */
const GEMINI_CLASSES_MAX_CHARS = Math.min(
  Math.max(Number(process.env.GEMINI_CLASSES_MAX_CHARS) || 6000, 2000),
  50000,
);
const GEMINI_PROJECT_MAX_CHARS = Math.min(
  Math.max(Number(process.env.GEMINI_PROJECT_MAX_CHARS) || 12000, 1000),
  80000,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaOrRateLimitError(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  const s = String(err.message || "");
  return /429|Too Many Requests|quota exceeded|RESOURCE_EXHAUSTED/i.test(s);
}

/** Transient Google errors — retry or try another model. */
function isRetryableGeminiError(err) {
  if (!err) return false;
  if (err.status === 429 || err.status === 503 || err.status === 500) return true;
  const s = String(err.message || "");
  return /503|502|500|429|Service Unavailable|high demand|try again later|RESOURCE_EXHAUSTED|Too Many Requests/i.test(
    s,
  );
}

function geminiModelsToTry() {
  const primary = GEMINI_MODEL;
  const list = [primary, ...GEMINI_FALLBACK_MODELS];
  return [...new Set(list.filter(Boolean))];
}

/** Short message for API clients; detailed logs stay server-side. */
function quotaPlainEnglishMessage() {
  return (
    "Google Gemini temporarily blocked this request: your API key’s project hit its usage limit for this model " +
    "(free tier per-minute/per-day limits, or burst of requests). Wait a minute and try again, try another model " +
    "via GEMINI_MODEL in .env (e.g. gemini-2.5-flash or gemini-2.0-flash), or enable billing in Google Cloud / AI Studio for higher quotas."
  );
}

const allowedOrigins = (process.env.CORS_ORIGINS ||
  "http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateBody(body) {
  const errors = {};
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!name || name.length > 100) errors.name = name ? "Name is too long" : "Name is required";
  if (!email || email.length > 255) errors.email = email ? "Email is too long" : "Email is required";
  else if (!emailRe.test(email)) errors.email = "Invalid email address";
  if (!subject || subject.length > 200) errors.subject = subject ? "Subject is too long" : "Subject is required";
  if (!message || message.length < 10) errors.message = message ? "Message must be at least 10 characters" : "Message is required";
  else if (message.length > 2000) errors.message = "Message is too long";

  return { name, email, subject, message, errors };
}

function createTransport() {
  if (!SMTP_HOST || !MAIL_TO || !MAIL_FROM) {
    throw new Error("Missing SMTP_HOST, MAIL_TO, or MAIL_FROM in environment.");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(
  cors({
    origin(origin, callback) {
      const ok = !origin || allowedOrigins.includes(origin);
      callback(null, ok);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

mountPlatformApi(app);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "agricai-platform-api",
    geminiConfigured: Boolean(GEMINI_API_KEY),
    knowledge: {
      classesJson: resolveClassesJsonPath(),
      projectKnowledge: resolveProjectKnowledgePath(),
    },
  });
});

const CHAT_LANG = new Set(["en", "rw", "sw", "fr", "kg"]);

app.post("/api/chat", async (req, res) => {
  if (!GEMINI_API_KEY) {
    res.status(503).json({
      ok: false,
      message: "Chat is not configured. Set GEMINI_API_KEY in the API server environment.",
    });
    return;
  }

  const langRaw = typeof req.body?.language === "string" ? req.body.language : "en";
  const language = CHAT_LANG.has(langRaw) ? langRaw : "en";
  const rawMessages = req.body?.messages;

  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    res.status(400).json({ ok: false, message: "Expected a non-empty messages array." });
    return;
  }

  const start = rawMessages.findIndex(
    (m) => m && m.role === "user" && typeof m.content === "string",
  );
  if (start === -1) {
    res.status(400).json({ ok: false, message: "No user message found." });
    return;
  }

  const thread = [];
  for (let i = start; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string") {
      res.status(400).json({ ok: false, message: "Invalid message content." });
      return;
    }
    const text = m.content.trim();
    if (!text) {
      res.status(400).json({ ok: false, message: "Empty message." });
      return;
    }
    if (text.length > 8000) {
      res.status(400).json({ ok: false, message: "Message too long." });
      return;
    }
    thread.push({ role: m.role, content: text });
  }

  if (thread.length === 0 || thread[thread.length - 1].role !== "user") {
    res.status(400).json({ ok: false, message: "Last message must be from the user." });
    return;
  }
  for (let i = 0; i < thread.length; i++) {
    const expectUser = i % 2 === 0;
    if (expectUser && thread[i].role !== "user") {
      res.status(400).json({
        ok: false,
        message: "Messages must alternate user then assistant, starting with user.",
      });
      return;
    }
    if (!expectUser && thread[i].role !== "assistant") {
      res.status(400).json({
        ok: false,
        message: "Messages must alternate user then assistant, starting with user.",
      });
      return;
    }
  }
  if (thread.length > 42) {
    res.status(400).json({ ok: false, message: "Too many messages in this conversation." });
    return;
  }

  const history = thread.slice(0, -1).map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));
  const userText = thread[thread.length - 1].content;

  const classesSnippet = loadClassesSnippet(GEMINI_CLASSES_MAX_CHARS);
  const projectKnowledge = loadProjectKnowledge(GEMINI_PROJECT_MAX_CHARS);
  const systemInstruction = buildSystemInstruction(language, {
    classesSnippet,
    projectKnowledge,
  });

  const runWithModel = async (modelName) => {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction,
    });
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userText);
    return result.response.text();
  };

  const runWithRetries = async (modelName) => {
    const delays = [0, 1500, 3000];
    let lastErr;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        return await runWithModel(modelName);
      } catch (err) {
        lastErr = err;
        if (!isRetryableGeminiError(err) || attempt === delays.length - 1) throw err;
        console.warn(
          `[chat] ${modelName} attempt ${attempt + 1} failed (${err.status || "?"}), retrying…`,
        );
      }
    }
    throw lastErr;
  };

  try {
    let reply;
    let lastErr;
    const models = geminiModelsToTry();

    for (const modelName of models) {
      try {
        reply = await runWithRetries(modelName);
        if (modelName !== GEMINI_MODEL) {
          console.info(`[chat] succeeded with fallback model: ${modelName}`);
        }
        break;
      } catch (err) {
        lastErr = err;
        if (!isRetryableGeminiError(err)) break;
        console.warn(`[chat] model ${modelName} unavailable, trying next…`, err.message);
      }
    }

    if (reply === undefined) throw lastErr;

    if (!reply || !reply.trim()) {
      res.status(502).json({ ok: false, message: "Empty model response." });
      return;
    }
    res.json({ ok: true, message: reply.trim() });
  } catch (err) {
    console.error("[chat]", err);
    if (isQuotaOrRateLimitError(err)) {
      res.status(429).json({
        ok: false,
        code: "GEMINI_QUOTA_OR_RATE_LIMIT",
        message: quotaPlainEnglishMessage(),
      });
      return;
    }
    if (isRetryableGeminiError(err)) {
      res.status(503).json({
        ok: false,
        code: "GEMINI_UNAVAILABLE",
        message:
          "The AI assistant is temporarily busy on Google's side. Please wait a moment and try again. " +
          "If this keeps happening, set GEMINI_MODEL=gemini-2.5-flash in Agricai-Node/.env (avoid gemini-flash-latest).",
      });
      return;
    }
    res.status(502).json({
      ok: false,
      message: err?.message || "Chat request failed.",
    });
  }
});

app.post("/api/contact", async (req, res) => {
  const { name, email, subject, message, errors } = validateBody(req.body);
  if (Object.keys(errors).length > 0) {
    res.status(400).json({ ok: false, message: "Validation failed", errors });
    return;
  }

  let transport;
  try {
    transport = createTransport();
  } catch (e) {
    console.error("[contact] config error:", e.message);
    res.status(503).json({ ok: false, message: "Email service is not configured." });
    return;
  }

  const text = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  AGRICAI — New contact message`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Name     : ${name}`,
    `Email    : ${email}`,
    `Subject  : ${subject}`,
    ``,
    `Message`,
    `──────────────────────────────────`,
    message,
    ``,
    `Reply directly to this email to answer ${name} (${email}).`,
  ].join("\n");

  const logoAttached = existsSync(CONTACT_LOGO_PATH);
  const html = buildContactEmailHtml({
    name,
    email,
    subject,
    message,
    logoCid: logoAttached ? CONTACT_LOGO_CID : null,
  });

  const attachments = logoAttached
    ? [{ filename: "logo.jpeg", path: CONTACT_LOGO_PATH, cid: CONTACT_LOGO_CID }]
    : [];

  try {
    await transport.sendMail({
      from: MAIL_FROM,
      to: MAIL_TO,
      replyTo: email,
      subject: `[Contact] ${subject}`,
      text,
      html,
      attachments,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[contact] sendMail:", err);
    res.status(502).json({ ok: false, message: "Could not send your message. Please try again later." });
  }
});

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Line breaks for HTML body (escape first). */
function messageToHtmlParagraphs(message) {
  const lines = escapeHtml(message).split(/\r\n|\n|\r/);
  return lines.map((line) => (line === "" ? "<br />" : line)).join("<br />");
}

/**
 * Table layout + inline styles for broad email client support.
 */
function buildContactEmailHtml({ name, email, subject, message, logoCid }) {
  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
  const green = "#14532d";
  const greenLight = "#166534";
  const muted = "#64748b";
  const border = "#e2e8f0";
  const cardBg = "#ffffff";
  const pageBg = "#f1f5f0";

  const logoBlock = logoCid
    ? `
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:0 0 18px 0;">
                    <img src="cid:${logoCid}" alt="AgricAI" width="88" height="88"
                      style="display:block;width:88px;height:88px;max-width:88px;border:0;line-height:100%;outline:none;text-decoration:none;background-color:#ffffff;border-radius:50%;box-shadow:0 4px 16px rgba(0,0,0,0.18);" />
                  </td>
                </tr>
              </table>`
    : "";

  const rows = [
    { label: "Name", value: escapeHtml(name) },
    { label: "Email", value: escapeHtml(email) },
    { label: "Subject", value: escapeHtml(subject) },
  ];

  const detailRows = rows
    .map(
      (r) => `
  <tr>
    <td style="padding:14px 20px 6px 20px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${muted};font-family:${font};">${r.label}</td>
  </tr>
  <tr>
    <td style="padding:0 20px 16px 20px;font-size:16px;line-height:1.45;color:#0f172a;font-family:${font};border-bottom:1px solid ${border};">${r.value}</td>
  </tr>`,
    )
    .join("");

  const messageBlock = messageToHtmlParagraphs(message);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>New contact — AgricAI</title>
</head>
<body style="margin:0;padding:0;background-color:${pageBg};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px 48px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
          <tr>
            <td bgcolor="${green}" style="border-radius:16px 16px 0 0;background-color:${green};background:linear-gradient(135deg,${green} 0%,${greenLight} 100%);padding:28px 28px 26px 28px;font-family:${font};">
              ${logoBlock}
              <p style="margin:0 0 6px 0;font-size:13px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.85);">AgricAI</p>
              <h1 style="margin:0;font-size:22px;line-height:1.25;font-weight:700;color:#ffffff;">New message from your site</h1>
              <p style="margin:10px 0 0 0;font-size:14px;line-height:1.5;color:rgba(255,255,255,0.9);">Someone used the <strong style="color:#fff;">Get in Touch</strong> form.</p>
            </td>
          </tr>
          <tr>
            <td style="background-color:${cardBg};border:1px solid ${border};border-top:none;padding:0;border-radius:0 0 16px 16px;overflow:hidden;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-family:${font};">
                ${detailRows}
                <tr>
                  <td style="padding:20px 20px 8px 20px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${muted};">Message</td>
                </tr>
                <tr>
                  <td style="padding:0 20px 24px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f8faf8;border:1px solid ${border};border-radius:12px;">
                      <tr>
                        <td style="padding:18px 20px;font-size:15px;line-height:1.6;color:#1e293b;font-family:${font};word-break:break-word;">${messageBlock}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 20px 22px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-radius:12px;overflow:hidden;">
                      <tr>
                        <td bgcolor="${green}" style="padding:14px 18px;font-size:13px;line-height:1.55;color:#ffffff;font-family:${font};background-color:${green};background:linear-gradient(135deg,${green} 0%,${greenLight} 100%);border:1px solid rgba(255,255,255,0.18);border-radius:12px;">
                          <strong style="color:#ffffff;">Tip:</strong><span style="color:rgba(255,255,255,0.95);"> Reply to this email — your reply goes to </span><strong style="color:#ffffff;">${escapeHtml(email)}</strong><span style="color:rgba(255,255,255,0.95);"> (${escapeHtml(name)}).</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 12px 0 12px;font-size:12px;line-height:1.5;color:${muted};font-family:${font};">
              Sent from the AgricAI contact form · This is an automated notification.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const server = app.listen(PORT, () => {
  console.log(`Contact API listening on http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[contact] Port ${PORT} is already in use (another contact-api or stale process). Close it or set PORT in .env.`,
    );
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
