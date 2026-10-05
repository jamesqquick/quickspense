export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} '${id}' not found` : `${resource} not found`,
      "NOT_FOUND",
      404,
    );
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Unauthorized") {
    super(message, "UNAUTHORIZED", 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "Forbidden") {
    super(message, "FORBIDDEN", 403);
    this.name = "ForbiddenError";
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(
      `Invalid state transition from '${from}' to '${to}'`,
      "INVALID_STATE_TRANSITION",
      400,
    );
    this.name = "InvalidStateTransitionError";
  }
}

export class NoReadyStripeConnectionError extends DomainError {
  constructor() {
    super(
      "Connect a ready Stripe account before sending this invoice",
      "NO_READY_STRIPE_CONNECTION",
      409,
    );
    this.name = "NoReadyStripeConnectionError";
  }
}

export class InvalidStripeConnectStateError extends DomainError {
  constructor() {
    super(
      "Stripe connection state is invalid or expired",
      "INVALID_STRIPE_CONNECT_STATE",
      400,
    );
    this.name = "InvalidStripeConnectStateError";
  }
}

export type StripeConnectionOperationConflictReason =
  | "active_connection"
  | "operation_in_progress"
  | "pending_disconnect";

export class StripeConnectionOperationConflictError extends ConflictError {
  constructor(public readonly reason: StripeConnectionOperationConflictReason) {
    const messages: Record<StripeConnectionOperationConflictReason, string> = {
      active_connection:
        "Disconnect the current Stripe account before connecting another account",
      operation_in_progress: "A Stripe connection operation is already in progress",
      pending_disconnect: "The Stripe account disconnect is still pending",
    };
    super(messages[reason]);
    this.name = "StripeConnectionOperationConflictError";
  }
}
