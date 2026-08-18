export function isAccountDeletionEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    environment.AUTH_EMAIL_FROM?.trim() &&
      environment.RESEND_API_KEY?.trim(),
  );
}

