import { BudgetExceededError } from "./budgetBucket.js";
import { PgOperationError } from "./boundedPgSession.js";

/** Admission failures cannot produce a fallback qualification or authorize dispatch. */
export function isBudgetAdmissionError(error: unknown): error is BudgetExceededError | PgOperationError {
  return error instanceof BudgetExceededError || error instanceof PgOperationError;
}
