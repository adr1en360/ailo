import { z } from "zod";
import { PaymentRequest, Payment, Receipt, SpendPolicy, Check } from "@ailo/core";

export { PaymentRequest, Payment, Receipt, SpendPolicy, Check };
export type { Check as CheckType };

export const SetSpendPolicyInput = SpendPolicy;
export type SetSpendPolicyInput = z.infer<typeof SetSpendPolicyInput>;
