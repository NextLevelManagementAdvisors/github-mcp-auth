#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
loadEnv();
import { listen } from "./http.js";
import { runMigrations } from "./db.js";

for (const required of [
  "DATABASE_URL",
  "API_KEY_HASH_SALT",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "BASE_URL",
]) {
  if (!process.env[required]) {
    console.error(`Missing required env var: ${required}`);
    process.exit(1);
  }
}

const salt = process.env.API_KEY_HASH_SALT ?? "";
if (salt.length < 32) {
  console.error("API_KEY_HASH_SALT must be at least 32 characters");
  process.exit(1);
}

runMigrations()
  .then(() => listen())
  .catch((err) => {
    console.error("Failed to run migrations:", err);
    process.exit(1);
  });
