import path from "node:path";
import {
  createCandidateManifest,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";

const root = path.resolve(import.meta.dirname, "..");
const artifact = await writeContentAddressedJson(
  path.join(root, "artifacts", "release-evidence", "airport-catalog"),
  "candidate",
  await createCandidateManifest(),
);
process.stdout.write(
  JSON.stringify({
    path: path.relative(root, artifact.path),
    sha256: artifact.sha256,
  }),
);
