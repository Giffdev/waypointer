import { NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/lib/auth/guards";
import { RequestOriginError } from "@/lib/auth/request";
import {
  ProfileValidationError,
  UsernameConflictError,
  UsernameValidationError,
} from "@/lib/profile/service";
import { DeletionAuthorizationError } from "@/lib/auth/account-deletion";

export class AccountRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccountRequestError";
  }
}

export function accountApiError(error: unknown): NextResponse {
  if (error instanceof AuthenticationRequiredError) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Authentication is required." } },
      { status: 401 },
    );
  }
  if (error instanceof RequestOriginError) {
    return NextResponse.json(
      { error: { code: "forbidden", message: "The request is not allowed." } },
      { status: 403 },
    );
  }
  if (error instanceof ProfileValidationError) {
    return NextResponse.json(
      { error: { code: "invalid-profile", message: error.message } },
      { status: 400 },
    );
  }
  if (error instanceof UsernameValidationError) {
    return NextResponse.json(
      { error: { code: "invalid-username", message: error.message } },
      { status: 400 },
    );
  }
  if (error instanceof UsernameConflictError) {
    return NextResponse.json(
      { error: { code: "username-taken", message: error.message } },
      { status: 409 },
    );
  }
  if (error instanceof DeletionAuthorizationError) {
    return NextResponse.json(
      {
        error: {
          code: "deletion-not-authorized",
          message: "The account deletion request could not be authorized.",
        },
      },
      { status: 403 },
    );
  }
  if (error instanceof AccountRequestError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: {
        code: "account-service-unavailable",
        message: "Account settings are temporarily unavailable.",
      },
    },
    { status: 503 },
  );
}
