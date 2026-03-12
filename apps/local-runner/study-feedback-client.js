const mount = document.querySelector("#feedback-trainer");

if (mount) {
  const style = document.createElement("style");
  style.textContent = `
    .trainer-form{display:grid;gap:12px;margin-top:18px}
    .trainer-form label{font-size:.92rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
    .trainer-form textarea{width:100%;min-height:104px;padding:14px 16px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.82);color:var(--ink);font:inherit;resize:vertical}
    .trainer-form button{width:fit-content;padding:12px 18px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--accent),#ee8f47);color:#fff;font:inherit;font-weight:700;cursor:pointer}
    .feedback-box{min-height:120px;padding:16px;white-space:pre-wrap}
  `;
  document.head.append(style);
  mount.innerHTML = `
    <div class="mini">Interaktives Feedback</div>
    <h3>Schick deine Lösungen ab</h3>
    <p>Trag deine Antworten ein, schick das Formular ab und lies das Feedback direkt darunter.</p>
    <form class="trainer-form" id="trainer-form">
      <label for="cosine-answer">1. Cosine Similarity</label>
      <textarea id="cosine-answer" name="cosine" placeholder="Skalarprodukt, Normen, Ergebnis und Interpretation"></textarea>
      <label for="tfidf-answer">2. TF-IDF</label>
      <textarea id="tfidf-answer" name="tfidf" placeholder="TF, IDF, TF-IDF und kurze Deutung"></textarea>
      <label for="relation-answer">3. Ähnlichkeit / Relationiertheit + Zusatzfrage</label>
      <textarea id="relation-answer" name="relation" placeholder="Einordnung der Wortpaare und deine BERT/Word2Vec-Erklärung"></textarea>
      <button type="submit">Feedback holen</button>
    </form>
    <div class="note feedback-box" id="feedback-output">Noch nichts abgeschickt. Sobald du das Formular sendest, erscheint hier dein Feedback.</div>
  `;
}

const form = document.querySelector("#trainer-form");
const output = document.querySelector("#feedback-output");

if (form instanceof HTMLFormElement && output) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = {
      cosine: String(formData.get("cosine") ?? "").trim(),
      tfidf: String(formData.get("tfidf") ?? "").trim(),
      relation: String(formData.get("relation") ?? "").trim(),
    };

    output.textContent = "Ich prüfe deine Antworten gerade ...";

    try {
      const response = await fetch("/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Feedback konnte nicht geladen werden.");
      }

      output.textContent = data.feedback;
    } catch (error) {
      output.textContent = error instanceof Error ? error.message : "Unbekannter Fehler beim Laden des Feedbacks.";
    }
  });
}
