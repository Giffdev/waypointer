import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectRoot, "node_modules", "maplibre-gl");
const destinationRoot = join(projectRoot, "public", "maplibre");
const files = [
  ["dist", "maplibre-gl-worker.mjs"],
  ["dist", "maplibre-gl-shared.mjs"],
  ["LICENSE.txt"],
];

await mkdir(destinationRoot, { recursive: true });
await Promise.all(
  files.map((parts) =>
    copyFile(join(sourceRoot, ...parts), join(destinationRoot, parts.at(-1))),
  ),
);
