import { FirecrackerAdapterError } from "./errors.ts";

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** A fresh jailer-safe id for one boot attempt, distinct from sandbox id. */
export function createExecutionId(): string {
  return `sbx-${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Throw a jailer error unless `executionId` matches the jail-safe grammar. */
export function assertExecutionId(executionId: string): void {
  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    throw new FirecrackerAdapterError({
      code: "SBX_FC_JAILER",
      operation: "validate execution id",
      message: "validate execution id failed jail validation or staging",
      retryable: false,
    });
  }
}
