import { afterEach, describe, expect, it } from "vitest";
import { databaseConnectionInfo, databaseSslMode } from "@/db";

const prior = process.env.DATABASE_SSL;
afterEach(() => {
  if (prior === undefined) delete process.env.DATABASE_SSL;
  else process.env.DATABASE_SSL = prior;
});

describe("Render PostgreSQL connection mode", () => {
  it("does not force TLS on Render's private dpg-* internal hostname", () => {
    delete process.env.DATABASE_SSL;
    const url = "postgresql://user:pass@dpg-abc123-a:5432/fmpi";
    expect(databaseSslMode(url)).toBe(false);
    expect(databaseConnectionInfo(url).renderInternal).toBe(true);
  });

  it("does not force TLS on render-internal.com hosts", () => {
    delete process.env.DATABASE_SSL;
    expect(databaseSslMode("postgresql://u:p@db.render-internal.com:5432/app")).toBe(false);
  });

  it("enables TLS for Render's external Postgres host", () => {
    delete process.env.DATABASE_SSL;
    const ssl = databaseSslMode(
      "postgresql://u:p@dpg-abc-a.singapore-postgres.render.com:5432/app",
    );
    expect(ssl).toEqual({ rejectUnauthorized: false });
  });

  it("honours explicit sslmode and DATABASE_SSL overrides", () => {
    delete process.env.DATABASE_SSL;
    expect(databaseSslMode("postgresql://u:p@host/db?sslmode=disable")).toBe(false);
    expect(databaseSslMode("postgresql://u:p@host/db?sslmode=require")).toEqual({ rejectUnauthorized: false });
    process.env.DATABASE_SSL = "false";
    expect(databaseSslMode("postgresql://u:p@public.example/db?sslmode=require")).toBe(false);
    process.env.DATABASE_SSL = "true";
    expect(databaseSslMode("postgresql://u:p@127.0.0.1/db")).toEqual({ rejectUnauthorized: false });
  });
});
