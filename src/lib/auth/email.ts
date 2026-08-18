import { canExposeDevelopmentVerificationLink } from "@/lib/runtime-mode";

type VerificationDelivery = {
  developmentUrl?: string;
};

async function sendAuthEmail(input: {
  email: string;
  subject: string;
  text: string;
  developmentUrl: string;
  failureMessage: string;
}): Promise<VerificationDelivery> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.AUTH_EMAIL_FROM?.trim();

  if (apiKey && from) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.email,
        subject: input.subject,
        text: input.text,
      }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(input.failureMessage);
    return {};
  }

  if (canExposeDevelopmentVerificationLink()) {
    return { developmentUrl: input.developmentUrl };
  }

  throw new Error(
    "RESEND_API_KEY and AUTH_EMAIL_FROM are required to deliver authentication email.",
  );
}

export async function sendVerificationEmail(input: {
  email: string;
  verificationUrl: string;
}): Promise<VerificationDelivery> {
  return sendAuthEmail({
    email: input.email,
    subject: "Verify your Waypointer email",
    text: `Verify your Waypointer email by opening this link:\n\n${input.verificationUrl}\n\nThis link expires in 24 hours.`,
    developmentUrl: input.verificationUrl,
    failureMessage: "Verification email delivery failed.",
  });
}

export async function sendDeletionCancellationEmail(input: {
  email: string;
  cancellationUrl: string;
  graceExpiresAt: Date;
}): Promise<VerificationDelivery> {
  return sendAuthEmail({
    email: input.email,
    subject: "Cancel your Waypointer account deletion",
    text: `Your Waypointer account is disabled and scheduled for deletion. If you requested this, no action is needed.\n\nTo cancel before ${input.graceExpiresAt.toISOString()}, open this single-use link:\n\n${input.cancellationUrl}\n\nOld sessions and cancelled jobs will not be restored.`,
    developmentUrl: input.cancellationUrl,
    failureMessage: "Deletion cancellation email delivery failed.",
  });
}
