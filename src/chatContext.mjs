import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_ROOT = path.join(__dirname, "..");

/** Mirrors homepage `CropSupport` — keep in sync when marketing copy changes. */
const SUPPORTED_CROPS_TEXT = `
- Avocado (~6 disease categories)
- Mangoes (~6)
- Orange (~6)
- Onions (~5)
- Carrots (~5)
- Tomatoes (~10)
- Potatoes (~7)
- Cassava (~8)
- Forest trees (~4)
- Tea (~4)
- Coffee (~5)
- Maize (~8)
- Beans (~6)
`.trim();

const RESPOND_RULES = {
  en: "Respond in English. Use clear, practical, farmer-friendly language.",
  rw: "Respond in Kinyarwanda. Use clear, practical, farmer-friendly language.",
  sw: "Respond in Kiswahili (East African context). Use clear, practical, farmer-friendly language.",
  fr: "Respond in French. Use clear, practical, farmer-friendly language.",
  kg: "Respond in Ikigande when you can; if not fully supported, use English for technical terms and note the limitation briefly.",
};

function resolvePath(envValue, ...candidates) {
  if (envValue?.trim()) {
    const p = path.resolve(envValue.trim());
    if (existsSync(p)) return p;
  }
  for (const c of candidates) {
    const p = path.resolve(c);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Disease library used by Detect + chat grounding.
 * Default: sibling repo Agricai-Python/data/classes.json
 */
export function resolveClassesJsonPath() {
  return resolvePath(
    process.env.CLASSES_JSON_PATH,
    path.join(NODE_ROOT, "data", "classes.json"),
    path.join(NODE_ROOT, "..", "Agricai-Python", "data", "classes.json"),
    path.join(NODE_ROOT, "..", "..", "Agricai-Python", "data", "classes.json"),
  );
}

/**
 * Company / team / product facts — edit data/project-knowledge.md (no code change).
 */
export function resolveProjectKnowledgePath() {
  return resolvePath(
    process.env.PROJECT_KNOWLEDGE_PATH,
    path.join(NODE_ROOT, "data", "project-knowledge.md"),
  );
}

function readTextFile(filePath, maxChars) {
  if (!filePath) return "";
  try {
    const raw = readFileSync(filePath, "utf8");
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars)}\n... (truncated)`;
  } catch {
    return "";
  }
}

/**
 * Load disease library JSON for prompt grounding (truncated if very large).
 */
export function loadClassesSnippet(maxChars = 6000) {
  const p = resolveClassesJsonPath();
  const text = readTextFile(p, maxChars);
  if (!text && p) {
    console.warn(`[chat] classes.json empty or unreadable: ${p}`);
  } else if (!p) {
    console.warn(
      "[chat] classes.json not found. Set CLASSES_JSON_PATH or place file at Agricai-Python/data/classes.json",
    );
  }
  return text;
}

/**
 * Load project / founder / contact knowledge (Markdown).
 */
export function loadProjectKnowledge(maxChars = 12000) {
  const p = resolveProjectKnowledgePath();
  const text = readTextFile(p, maxChars);
  if (!text && !p) {
    console.warn(
      "[chat] project-knowledge.md not found. Create Agricai-Node/data/project-knowledge.md",
    );
  }
  return text;
}

/**
 * @param {string} language - en | rw | sw | fr | kg
 * @param {{ classesSnippet: string, projectKnowledge: string }} opts
 */
export function buildSystemInstruction(language, { classesSnippet, projectKnowledge }) {
  const lang = RESPOND_RULES[language] ? language : "en";
  const respondInstruction = RESPOND_RULES[lang];

  return `You are the AGRIC AI assistant for a crop health and farming advisory web app focused on East African contexts (including Rwanda and neighboring regions).

${respondInstruction}

When users ask about AGRIC AI as a company (founders, team, mission, contact, partners, app features, website), use the PROJECT KNOWLEDGE section below as the source of truth. Do not invent staff names or contact details that are not listed there.

When users ask about crop diseases, symptoms, or treatments, prefer the DISEASE LIBRARY JSON below. If the library does not cover the topic, give careful general guidance and recommend confirming with a local agricultural extension officer or certified agronomist.

Product positioning:
- Help farmers and advisors with crop disease symptoms, integrated pest management, prevention, and general good agricultural practices.
- The site highlights disease detection from leaf photos; answers should stay aligned with that mission.

Supported crops (coverage orientation — detection may not cover every class yet):
${SUPPORTED_CROPS_TEXT}

--- BEGIN PROJECT KNOWLEDGE (company, team, contact, product) ---
${projectKnowledge || "(Project knowledge file not loaded. Tell the user to contact info@agric-ai.com for official information.)"}
--- END PROJECT KNOWLEDGE ---

--- BEGIN DISEASE LIBRARY (JSON) ---
${classesSnippet || "(Disease library not loaded on server.)"}
--- END DISEASE LIBRARY ---

Safety and quality rules:
- You are not a substitute for on-site inspection, laboratory diagnosis, or national regulations. Add a short disclaimer when discussing treatments or pesticides.
- Do not invent specific commercial product names or exact application rates unless they are explicitly in the library text above; otherwise refer to active ingredients and label/extension guidance.
- Be concise; use short headings and bullet lists when giving steps.
`;
}
