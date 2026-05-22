# How to feed your data to the AGRIC AI chatbot (plain English)

You do **not** need to “train” Gemini like training a photo model.  
Your `GEMINI_API_KEY` only lets your server **send text to Google’s API** each time someone chats.

Think of it like giving the assistant a **reference packet** before every conversation.

---

## Two kinds of data you already use

| What | Where you edit it | What it powers |
|------|-------------------|----------------|
| **Project info** (team, mission, contact, partners) | `Agricai-Node/data/project-knowledge.md` | “Who founded Agric AI?”, “How do I contact you?” |
| **Disease library** (symptoms, treatment, prevention) | `Agricai-Python/data/classes.json` | “How do I treat tomato late blight?” |

Both are loaded into the chat **system instruction** on every message.

---

## Step-by-step: update project / founder info

1. Open **`Agricai-Node/data/project-knowledge.md`** in any text editor.
2. Change names, roles, phone, mission, partners — use simple headings and bullets.
3. Save the file.
4. Restart the API:
   ```bash
   cd Agricai-Node
   npm run dev
   ```
5. Open the chatbot on the website and ask: *“Who is on the Agric AI team?”*

No upload to Google. No waiting for training jobs.

---

## Step-by-step: update disease advice

1. Open **`Agricai-Python/data/classes.json`**.
2. Edit the text fields (`explanation`, `treatment`, `prevention`, `care`, Kinyarwanda fields).
3. Ensure the Node server can read that file (see `.env` below).
4. Restart **both** APIs if needed (Python for Detect, Node for chat).

---

## Optional settings (`.env` in Agricai-Node)

```env
GEMINI_API_KEY=your_key_from_google_ai_studio

# Model (stable default)
GEMINI_MODEL=gemini-2.5-flash

# How much disease JSON to include (bigger = more detail, more cost)
GEMINI_CLASSES_MAX_CHARS=8000

# Paths (usually leave default)
CLASSES_JSON_PATH=../Agricai-Python/data/classes.json
PROJECT_KNOWLEDGE_PATH=./data/project-knowledge.md
```

---

## “Training” vs “feeding” — what’s the difference?

| Approach | Plain English | When to use |
|----------|---------------|-------------|
| **Feeding (what you use now)** | Paste your docs into each request | Team info, disease library, FAQs — **best for Agric AI** |
| **RAG** | Store many documents, search relevant parts per question | Large PDF manuals, hundreds of pages |
| **Fine-tuning** | Pay Google to customize model weights on thousands of Q&A pairs | Rare; expensive; hard to update |

For founders, contact details, and crop advice you control in JSON/Markdown, **feeding is enough**.

---

## Photo disease model (Detect page) is separate

- Leaf photos go to **Agricai-Python** (ONNX model), not Gemini.
- To improve detection you **retrain** the image model (Kaggle / `kaggle_train_full.py`), not the chat key.
- Chat and vision share the same **wording** in `classes.json` but different technology.

---

## Privacy reminder

Text you put in `project-knowledge.md` and `classes.json` is sent to **Google’s Gemini API** when users chat.  
Do not put passwords, secret keys, or private farmer data in those files.

---

## Quick checklist after edits

- [ ] Saved `project-knowledge.md` and/or `classes.json`
- [ ] Restarted `npm run dev` in Agricai-Node
- [ ] Tested one project question and one disease question in the chatbot
