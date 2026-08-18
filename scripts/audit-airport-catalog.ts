import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  auditAirportReferences,
  airportSearchPhoneticKeys,
  createAirportResolver,
  parseOurAirportsCsv,
} from "../src/lib/import/airport-resolution.ts";

const cachePath = path.resolve(
  "data",
  "private",
  "reference",
  "ourairports-airports.csv",
);
const references = parseOurAirportsCsv(await readFile(cachePath, "utf8"));
const audit = auditAirportReferences(references);
const resolve = createAirportResolver(references);
const representatives = [
  "W01",
  "OMK",
  "S18",
  "UIL",
  "KUIL",
  "S43",
  "3U2",
  "0S7",
].map((code) => {
  const result = resolve(code);
  return {
    code,
    status: result.status,
    airport:
      result.status === "resolved"
        ? `${result.reference.name} (${result.reference.ident})`
        : undefined,
  };
});

console.log(JSON.stringify({
  cachePath,
  ...audit,
  additionalIdentifierAliases:
    audit.expandedIdentifierAliases - audit.legacyIdentifierAliases,
  representatives,
  correctionSearchExamples: {
    Forks: airportSearchPhoneticKeys("Forks"),
    Quileute: airportSearchPhoneticKeys("Quileute"),
    Quillayute: airportSearchPhoneticKeys("Quillayute"),
  },
}, null, 2));
