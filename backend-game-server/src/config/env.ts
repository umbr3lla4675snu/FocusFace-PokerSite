import dotenv from "dotenv";

dotenv.config();

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(getEnv("PORT", "4000")),
  corsOrigin: getEnv("CORS_ORIGIN", "http://127.0.0.1:5500"),
};
