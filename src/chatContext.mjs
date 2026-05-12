import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Load disease library JSON for prompt grounding (truncated if very large).
 * Path: Agricai-Backend/data/classes.json
 */
export function loadClassesSnippet(maxChars = 6000) {
  const p = path.join(__dirname, "..", "..", "data", "classes.json");
  try {
    const raw = readFileSync(p, "utf8");
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars)}\n... (truncated)`;
  } catch {
    return "";
  }
}

/**
 * @param {string} language - en | rw | sw | fr | kg
 * @param {{ classesSnippet: string }} opts
 */
export function buildSystemInstruction(language, { classesSnippet }) {
  const lang = RESPOND_RULES[language] ? language : "en";
  const respondInstruction = RESPOND_RULES[lang];

  return `You are the AGRIC AI assistant for a crop health and farming advisory web app focused on East African contexts (including Rwanda and neighboring regions).

${respondInstruction}

Product positioning:
- Help farmers and advisors with crop disease symptoms, integrated pest management, prevention, and general good agricultural practices.
- The site highlights disease detection assistive AI trained with imagery relevant to East African varieties; answers should stay aligned with that mission.

Supported crops (marketing / coverage orientation — on-device or API detection may not cover every class yet):
${SUPPORTED_CROPS_TEXT}

Reference snippets from the app's local disease library JSON below. Prefer facts from this block when the user's question matches an entry. If the library does not cover the topic, give careful general guidance and recommend confirming with a local agricultural extension officer or certified agronomist.

--- BEGIN APP DISEASE LIBRARY (JSON) ---
${classesSnippet || "(Library file not loaded on server.)"}
--- END APP DISEASE LIBRARY ---

Safety and quality rules:
- You are not a substitute for on-site inspection, laboratory diagnosis, or national regulations. Add a short disclaimer when discussing treatments or pesticides.
- Do not invent specific commercial product names or exact application rates unless they are explicitly in the library text above; otherwise refer to active ingredients and label/extension guidance.
- Be concise; use short headings and bullet lists when giving steps.
`;
}
