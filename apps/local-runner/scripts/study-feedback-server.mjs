#!/usr/bin/env node

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const htmlFile = path.join(appRoot, "aufgabenblatt-guide.html");
const clientFile = path.join(appRoot, "study-feedback-client.js");
const port = Number(process.env.STUDY_FEEDBACK_PORT || 4326);
const apiKey = process.env.GEMINI_API_KEY || "";
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.sendFile(htmlFile);
});

app.get("/study-feedback-client.js", (_req, res) => {
  res.type("application/javascript").sendFile(clientFile);
});

app.post("/feedback", async (req, res) => {
  const answers = {
    cosine: String(req.body?.cosine ?? "").trim(),
    tfidf: String(req.body?.tfidf ?? "").trim(),
    relation: String(req.body?.relation ?? "").trim(),
  };

  if (!answers.cosine && !answers.tfidf && !answers.relation) {
    res.status(400).json({ error: "Bitte zuerst mindestens eine Antwort ausfüllen." });
    return;
  }

  try {
    const feedback = ai ? await createModelFeedback(ai, answers) : createFallbackFeedback(answers);
    res.json({ feedback });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Feedback konnte nicht generiert werden.",
    });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`study-feedback-server listening on http://127.0.0.1:${port}`);
});

async function createModelFeedback(ai, answers) {
  const prompt = [
    "Du bist ein präziser deutschsprachiger Tutor für ein NLP-Aufgabenblatt.",
    "Bewerte die Antworten kurz, hilfreich und konkret.",
    "Fokus: fachliche Korrektheit, fehlende Schritte, kurze Verbesserungshinweise.",
    "Schreibe nur in Deutsch.",
    "Format:",
    "Einschätzung:",
    "- ...",
    "Korrekturhinweise:",
    "- ...",
    "Nächster Schritt:",
    "- ...",
    "",
    "Aufgabe 1 erwartet: Cosine Similarity mit Skalarprodukt, Normen, Einsetzen, Interpretation.",
    "Aufgabe 2 erwartet: TF, IDF, TF-IDF und Deutung für 'Informatik'.",
    "Aufgabe 3 erwartet: Einordnung ähnlich vs relationiert sowie der Unterschied Word2Vec vs BERT.",
    "",
    `Antwort Aufgabe 1:\n${answers.cosine || "(leer)"}`,
    `Antwort Aufgabe 2:\n${answers.tfidf || "(leer)"}`,
    `Antwort Aufgabe 3:\n${answers.relation || "(leer)"}`,
  ].join("\n");

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
  });

  return response.text?.trim() || "Es kam keine auswertbare Rückmeldung zurück.";
}

function createFallbackFeedback(answers) {
  const completed = Object.values(answers).filter(Boolean).length;
  return [
    "Einschätzung:",
    `- Du hast bisher ${completed} von 3 Antwortbereichen ausgefüllt.`,
    "Korrekturhinweise:",
    answers.cosine
      ? "- Prüfe bei Aufgabe 1 besonders, ob Skalarprodukt, beide Normen und die Interpretation vorkommen."
      : "- Aufgabe 1 fehlt noch: Rechne Skalarprodukt, Normen und Cosine Similarity aus.",
    answers.tfidf
      ? "- Prüfe bei Aufgabe 2, ob du TF, IDF und TF-IDF getrennt erklärt hast."
      : "- Aufgabe 2 fehlt noch: Berechne TF, dann IDF, dann TF-IDF.",
    answers.relation
      ? "- Prüfe bei Aufgabe 3, ob du ähnlich und relationiert sauber unterscheidest und BERT/Word2Vec vergleichst."
      : "- Aufgabe 3 fehlt noch: Wortpaare einordnen und BERT vs Word2Vec kurz erklären.",
    "Nächster Schritt:",
    "- Wenn ein Bereich noch unsicher ist, ergänze zuerst die fehlenden Rechenschritte und schicke das Formular erneut ab.",
  ].join("\n");
}
