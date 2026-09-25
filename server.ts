import { withStatic } from "./app.js";
import { CLOUD } from "./storage.js";
import { MODEL } from "./claude.js";

const PORT = Number(process.env.PORT || 5173);
withStatic().listen(PORT, () => {
  console.log(`Module QA on http://localhost:${PORT}  (model: ${MODEL}, storage: ${CLOUD ? "cloud" : "local disk"})`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("ANTHROPIC_API_KEY is not set — Analyse will fail until it is.");
  }
});
