import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const outputPath = path.join(rootDir, "docs", "data", "public-export.json");
const sourceUrl = process.env.PUBLIC_EXPORT_URL || "http://124.221.11.190/x-spam-guard/api/public/export";

async function main() {
  const response = await fetch(sourceUrl, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`export_failed_${response.status}`);
  }

  const data = await response.json();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(rootDir, outputPath)} from ${sourceUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
