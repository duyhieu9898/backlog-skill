export type PolicyDecision =
  | {
      decision: 'allow';
    }
  | {
      decision: 'deny';
      code: string;
      reason: string;
    }
  | {
      decision: 'confirm';
      code: 'CONFIRMATION_REQUIRED';
      reason: string;
      actionFingerprint: string;
    };
