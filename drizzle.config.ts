import { defineConfig } from "drizzle-kit";

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error(
    "MIGRATION_DATABASE_URL or DATABASE_URL is required for Drizzle commands.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: false,
});
