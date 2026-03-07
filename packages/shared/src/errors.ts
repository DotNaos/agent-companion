import type { ZodError } from "zod";
import { PolicyError } from "./policy.js";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function toErrorEnvelope(error: unknown) {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  if (error instanceof PolicyError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  if (isZodError(error)) {
    return {
      code: "INVALID_SCHEMA",
      message: "Payload failed schema validation",
      details: error.flatten(),
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}

function isZodError(error: unknown): error is ZodError {
  return typeof error === "object" && error !== null && "issues" in error;
}
