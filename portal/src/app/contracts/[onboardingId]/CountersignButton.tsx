"use client";

import { useActionState } from "react";
import { SignaturePad, SignMethod } from "@/app/SignaturePad";
import { countersignAction, type CsResult } from "./actions";

export function CountersignButton({ onboardingId, signerName, today }: { onboardingId: string; signerName: string; today: string }) {
  const [s, action, pending] = useActionState<CsResult, FormData>(countersignAction, {});
  return (
    <form action={action} className="stack-form countersign-form">
      <input type="hidden" name="onboardingId" value={onboardingId} />
      <SignMethod>
        {(mode) =>
          mode === "draw" ? (
            <SignaturePad name="signatureImage" label={`Signature of ${signerName}, for Book Clarity, LLC`} />
          ) : (
            <p>Your name, <strong>{signerName}</strong>, is used as your signature.</p>
          )
        }
      </SignMethod>
      <p className="sign-date"><strong>Date:</strong> {today} <span className="muted">(added automatically when you countersign)</span></p>
      <p className="muted">By clicking Countersign you sign this agreement electronically on behalf of Book Clarity, LLC.</p>
      <button disabled={pending}>Countersign</button>
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}
