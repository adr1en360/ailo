import { evaluatePolicy, formatNaira, type Check, type Payment, type PaymentRequest, type Receipt } from "@ailo/core";
import { AppError } from "../../shared/AppError";
import { eventsService } from "../events/events.service";
import { ledgerService } from "../ledger/ledger.service";
import { approvalsService } from "../approvals/approvals.service";
import * as mandates from "../mandates/mandates.service";
import { getPayee } from "../payees/payees";
import { getPayoutRail } from "../rails";
import { shouldSecondLook } from "../second-look/second-look.flags";
import { secondLook, type SecondLookDeps, type SecondLookOutcome } from "../second-look/second-look.service";

// Bank details come only from the server-side payee directory, never from the agent's request (PRD 5.9).
function payoutAccount(payeeId: string) {
  const payee = getPayee(payeeId);
  return payee
    ? { destination_bank_code: payee.bank_code, destination_account_number: payee.account_number, payee_email: payee.email }
    : {};
}
import { paymentsRepository, PaymentsRepository } from "./payments.repository";

// With no model configured, every flagged payment escalates to the owner's Nod (Second Look fails safe).
const NO_MODEL: SecondLookDeps = {
  decide: async () => { throw new Error("No Second Look model configured"); },
  timeoutMs: 1800,
};

export class PaymentsService {
  constructor(private repo: PaymentsRepository = paymentsRepository, private secondLookDeps: SecondLookDeps = NO_MODEL) {
    // Connect approval decisions to payment transitions
    approvalsService.setDecisionHandler(async (paymentId, decision) => {
      if (decision === "approve") {
        await this.executeApprovedPayout(paymentId);
      } else {
        await this.executeDeniedPayment(paymentId);
      }
    });
  }

  useSecondLook(deps: SecondLookDeps): void {
    this.secondLookDeps = deps;
  }

  async listPayments(): Promise<Payment[]> {
    return this.repo.listPayments();
  }

  async getPayment(id: string): Promise<{ payment: Payment; receipt?: Receipt }> {
    const record = await this.repo.findPaymentById(id);
    if (!record) {
      throw new AppError(404, "PAYMENT_NOT_FOUND", `Payment ${id} not found`);
    }
    const { receipt, ...payment } = record;
    return { payment, receipt };
  }

  private async block(
    base: Omit<Payment, "verdict" | "decided_by" | "status" | "kora_reference">,
    receipt: Receipt,
    decidedBy: Payment["decided_by"],
  ): Promise<{ payment: Payment; receipt: Receipt }> {
    const payment: Payment = { ...base, verdict: "block", decided_by: decidedBy, status: "blocked", kora_reference: null };
    await this.repo.savePayment(payment, receipt);
    eventsService.emitPaymentUpdated(payment);
    return { payment, receipt };
  }

  /**
   * Main check ladder per PRD 5.2.
   */
  async processPayment(
    agent: { id: string; name: string },
    req: PaymentRequest
  ): Promise<{ payment: Payment; receipt: Receipt }> {
    const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const reference = `AL-${paymentId}`;
    const now = new Date().toISOString();
    const payeeName = getPayee(req.payee_id)?.name ?? req.payee_id;
    const base = {
      id: paymentId,
      agent_id: agent.id,
      payee_id: req.payee_id,
      payee_name: payeeName,
      amount_kobo: req.amount_kobo,
      category: req.category,
      reason: req.reason,
      created_at: now,
    };

    const checks: Check[] = [];

    // Step 1: Signature & Badge check (passed by agentAuth middleware)
    checks.push({
      step: "signature",
      result: "pass",
      detail: `Badge verified for agent ${agent.name} (${agent.id})`,
    });

    // Step 2: Deterministic Rules (Spec Gate): the owner's latest saved mandate.
    const mandate = await mandates.current();
    const receipt: Receipt = {
      payment_id: paymentId,
      policy_version: mandate?.version ?? 1, // the contract needs a positive version even when no rule exists
      checks,
    };

    if (!mandate) {
      checks.push({ step: "rules", result: "fail", detail: "No spending rule saved yet: the owner sets one in Spec Gate" });
      return this.block(base, receipt, "rules");
    }

    const decision = evaluatePolicy(mandate.policy, req, {
      now: new Date(now),
      spent_today_kobo: await this.repo.getDailySpend(agent.id),
      spent_this_week_kobo: await this.repo.getWeeklySpend(agent.id),
      payee_spent_24h_kobo: await this.repo.getRollingPayeeSpend24h(req.payee_id),
    });
    const reasons = decision.reasons.map((r) => r.message).join("; ");

    if (decision.verdict === "block") {
      checks.push({ step: "rules", result: "fail", detail: `Rule v${mandate.version}: ${reasons}` });
      return this.block(base, receipt, "rules");
    }

    checks.push({
      step: "rules",
      result: "pass",
      detail: `Rule v${mandate.version}: ${decision.verdict === "nod" ? `needs Nod (${reasons})` : "within limits"}`,
    });

    // Step 3: Reserve Funds with Balance Condition
    try {
      await ledgerService.reserve(paymentId, req.amount_kobo);
      checks.push({
        step: "reserve",
        result: "pass",
        detail: `Reserved ${formatNaira(req.amount_kobo)} in holds`,
      });
    } catch (err) {
      checks.push({
        step: "reserve",
        result: "fail",
        detail: (err as Error).message,
      });
      return this.block(base, receipt, "rules");
    }

    // Step 4: Second Look, only on flagged payments. It can block or escalate, never approve.
    const { flagged, flags } = shouldSecondLook(req, {
      payee_payments_today: await this.repo.countPayeePayments24h(req.payee_id),
    });
    let look: SecondLookOutcome | undefined;

    if (!flagged) {
      checks.push({ step: "second_look", result: "skipped", detail: "not flagged" });
    } else {
      look = await secondLook(
        {
          owner_rule: mandate.english_rule,
          payment: { ...req, payee_name: payeeName },
          page_text: req.page_text,
          flags,
        },
        this.secondLookDeps,
      );

      if (look.verdict === "block") {
        await ledgerService.releaseHold(paymentId);
        checks.push({ step: "second_look", result: "fail", detail: `Blocked: ${look.reason}` });
        return this.block(base, receipt, "second_look");
      }

      checks.push({
        step: "second_look",
        result: look.verdict === "ok" ? "pass" : "fail",
        detail: `${look.verdict === "ok" ? "OK" : "Escalated to owner"} (${flags.join(", ")}): ${look.reason}`,
      });
    }

    // Step 5: Nod. The rules decide unknown payees and thresholds; Second Look can only add an escalation.
    const nodReason: "above_threshold" | "second_look_flag" | "new_payee" | undefined =
      decision.reasons.some((r) => r.code === "NEW_PAYEE") ? "new_payee"
      : decision.verdict === "nod" ? "above_threshold"
      : look?.verdict === "escalate" ? "second_look_flag"
      : undefined;

    if (nodReason) {
      checks.push({
        step: "nod",
        result: "pass",
        detail: `Waiting for owner Nod (${nodReason === "second_look_flag" ? look!.reason : reasons})`,
      });

      const nodPayment: Payment = { ...base, verdict: "nod", decided_by: "nod", status: "pending_approval", kora_reference: null };
      await this.repo.savePayment(nodPayment, receipt);

      // Create owner approval request for /nod page
      await approvalsService.createApproval({
        payment_id: paymentId,
        amount_kobo: req.amount_kobo,
        payee_name: payeeName,
        reason: req.reason,
        why: nodReason,
      });

      eventsService.emitPaymentUpdated(nodPayment);
      return { payment: nodPayment, receipt };
    }

    checks.push({
      step: "nod",
      result: "skipped",
      detail: `under ${formatNaira(mandate.policy.nod_above_kobo)} threshold`,
    });

    // Step 6: Payout through Rails
    const rail = getPayoutRail();
    const payoutResult = await rail.payout({
      payment_id: paymentId,
      reference,
      amount_kobo: req.amount_kobo,
      payee_id: req.payee_id,
      payee_name: payeeName,
      narration: req.reason,
      ...payoutAccount(req.payee_id),
    });

    if (payoutResult.status === "settled") {
      await ledgerService.postHold(paymentId);
      checks.push({
        step: "payout",
        result: "pass",
        detail: `Kora confirmed ${reference}`,
      });
    } else if (payoutResult.status === "unknown" || payoutResult.status === "submitted") {
      checks.push({
        step: "payout",
        result: "pass",
        detail: `Payout submitted to rail (${reference}), awaiting confirmation`,
      });
    } else {
      await ledgerService.releaseHold(paymentId);
      checks.push({
        step: "payout",
        result: "fail",
        detail: payoutResult.error ?? "Payout rejected by rail",
      });
    }

    const settledPayment: Payment = {
      ...base,
      verdict: "allow",
      decided_by: look?.verdict === "ok" ? "second_look" : "rules",
      status: payoutResult.status,
      kora_reference: reference,
    };

    await this.repo.savePayment(settledPayment, receipt);
    eventsService.emitPaymentUpdated(settledPayment);
    return { payment: settledPayment, receipt };
  }

  /**
   * Called when owner taps "Approve" on /nod.
   */
  async executeApprovedPayout(paymentId: string): Promise<Payment> {
    const record = await this.repo.findPaymentById(paymentId);
    if (!record) {
      throw new AppError(404, "PAYMENT_NOT_FOUND", `Payment ${paymentId} not found`);
    }

    const reference = `AL-${paymentId}`;
    const rail = getPayoutRail();

    const payoutResult = await rail.payout({
      payment_id: paymentId,
      reference,
      amount_kobo: record.amount_kobo,
      payee_id: record.payee_id,
      payee_name: record.payee_name,
      narration: record.reason,
      ...payoutAccount(record.payee_id),
    });

    const newChecks: Check[] = [];
    if (payoutResult.status === "settled") {
      await ledgerService.postHold(paymentId);
      newChecks.push({
        step: "payout",
        result: "pass",
        detail: `Owner approved; Kora confirmed ${reference}`,
      });
    } else if (payoutResult.status === "unknown" || payoutResult.status === "submitted") {
      newChecks.push({
        step: "payout",
        result: "pass",
        detail: `Owner approved; rail submitted (${reference})`,
      });
    } else {
      await ledgerService.releaseHold(paymentId);
      newChecks.push({
        step: "payout",
        result: "fail",
        detail: payoutResult.error ?? "Payout rejected by rail",
      });
    }

    const updated = await this.repo.updatePayment(
      paymentId,
      {
        status: payoutResult.status,
        kora_reference: reference,
      },
      newChecks
    );

    eventsService.emitPaymentUpdated(updated!);
    return updated!;
  }

  /**
   * Called when owner taps "Deny" on /nod.
   */
  async executeDeniedPayment(paymentId: string): Promise<Payment> {
    const record = await this.repo.findPaymentById(paymentId);
    if (!record) {
      throw new AppError(404, "PAYMENT_NOT_FOUND", `Payment ${paymentId} not found`);
    }

    await ledgerService.releaseHold(paymentId);

    const newChecks: Check[] = [
      {
        step: "nod",
        result: "fail",
        detail: "Denied by owner",
      },
    ];

    const updated = await this.repo.updatePayment(
      paymentId,
      {
        status: "blocked",
        verdict: "block",
      },
      newChecks
    );

    eventsService.emitPaymentUpdated(updated!);
    return updated!;
  }
}

export const paymentsService = new PaymentsService();
