import test from "node:test";
import assert from "node:assert/strict";

import {
  FundingSourceRegistry,
  SignedFundingSource,
  createFundingSourceKeyPair,
  verifyFundingDeposit,
  verifyFundingHold,
  verifyFundingHoldResolution,
  verifyFundingReversal,
  verifyFundingStatement
} from "../src/index.js";

function source() {
  const keys =
    createFundingSourceKeyPair();

  const fundingSource =
    new SignedFundingSource({
      sourceId:
        "source.example",
      privateKey:
        keys.privateKey,
      now:
        () => 1000
    });

  const registry =
    new FundingSourceRegistry([
      {
        sourceId:
          "source.example",
        publicKey:
          keys.publicKey
      }
    ]);

  return {
    keys,
    fundingSource,
    registry
  };
}

test(
  "funding source issues signed campaign deposit receipt",
  () => {
    const {
      fundingSource,
      registry
    } = source();

    const receipt =
      fundingSource.issueDeposit({
        campaignId:
          "campaign-1",
        credits: 25,
        depositId:
          "deposit-1",
        externalReference:
          "payment-1"
      });

    assert.equal(
      receipt.schema,
      "sponsorrail.funding-deposit.v0.13"
    );

    assert.equal(
      receipt.credits,
      25
    );

    assert.equal(
      verifyFundingDeposit(
        receipt,
        registry
      ),
      true
    );
  }
);

test(
  "tampered funding deposit fails verification",
  () => {
    const {
      fundingSource,
      registry
    } = source();

    const receipt =
      fundingSource.issueDeposit({
        campaignId:
          "campaign-1",
        credits: 25
      });

    assert.equal(
      verifyFundingDeposit(
        {
          ...receipt,
          credits: 250
        },
        registry
      ),
      false
    );
  }
);

test(
  "unregistered funding source is rejected",
  () => {
    const {
      fundingSource
    } = source();

    const receipt =
      fundingSource.issueDeposit({
        campaignId:
          "campaign-1",
        credits: 10
      });

    assert.equal(
      verifyFundingDeposit(
        receipt,
        new FundingSourceRegistry()
      ),
      false
    );
  }
);

test(
  "funding receipt schema cannot carry prompt source or model output",
  () => {
    const {
      fundingSource
    } = source();

    const receipt =
      fundingSource.issueDeposit({
        campaignId:
          "campaign-1",
        credits: 10,
        externalReference:
          "payment-1"
      });

    assert.deepEqual(
      Object.keys(receipt)
        .sort(),
      [
        "asset",
        "campaignId",
        "credits",
        "depositId",
        "externalReference",
        "occurredAt",
        "schema",
        "signature",
        "sourceId"
      ]
    );
  }
);


test(
  "funding source issues signed reversal receipt",
  () => {
    const {
      fundingSource,
      registry
    } = source();

    const reversal =
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit-1",
          campaignId:
            "campaign-1",
          credits: 7,
          reason: "refund",
          reversalId:
            "reversal-1",
          externalReference:
            "refund-1"
        });

    assert.equal(
      reversal.schema,
      "sponsorrail.funding-reversal.v0.15"
    );

    assert.equal(
      verifyFundingReversal(
        reversal,
        registry
      ),
      true
    );
  }
);

test(
  "tampered reversal and unsupported reason fail verification",
  () => {
    const {
      fundingSource,
      registry
    } = source();

    const reversal =
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit-1",
          campaignId:
            "campaign-1",
          credits: 7,
          reason: "refund"
        });

    assert.equal(
      verifyFundingReversal(
        {
          ...reversal,
          credits: 70
        },
        registry
      ),
      false
    );

    assert.throws(
      () =>
        fundingSource
          .issueReversal({
            originalDepositId:
              "deposit-1",
            campaignId:
              "campaign-1",
            credits: 1,
            reason:
              "mysterious-money-vanishing"
          }),
      /unsupported funding reversal reason/
    );
  }
);

test(
  "funding reversal schema contains no prompt source output or identity fields",
  () => {
    const {
      fundingSource
    } = source();

    const reversal =
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit-1",
          campaignId:
            "campaign-1",
          credits: 7,
          reason:
            "dispute_loss",
          externalReference:
            "dispute-1"
        });

    assert.deepEqual(
      Object.keys(reversal)
        .sort(),
      [
        "asset",
        "campaignId",
        "credits",
        "externalReference",
        "occurredAt",
        "originalDepositId",
        "reason",
        "reversalId",
        "schema",
        "signature",
        "sourceId"
      ]
    );
  }
);


test(
  "funding source issues signed temporary hold receipt",
  () => {
    const {
      fundingSource,
      registry
    } = source();

    const hold =
      fundingSource
        .issueHold({
          originalDepositId:
            "deposit-1",
          campaignId:
            "campaign-1",
          credits: 9,
          reason: "dispute",
          holdId: "hold-1",
          externalReference:
            "dispute-1"
        });

    assert.equal(
      hold.schema,
      "sponsorrail.funding-hold.v0.16"
    );

    assert.equal(
      verifyFundingHold(
        hold,
        registry
      ),
      true
    );
  }
);

test(
  "funding source issues signed hold release and reversal resolutions",
  () => {
    const {
      fundingSource,
      registry
    } = source();

    const release =
      fundingSource
        .issueHoldResolution({
          holdId: "hold-1",
          originalDepositId:
            "deposit-1",
          campaignId:
            "campaign-1",
          outcome: "release",
          reason:
            "dispute_won",
          resolutionId:
            "resolution-won"
        });

    const reverse =
      fundingSource
        .issueHoldResolution({
          holdId: "hold-2",
          originalDepositId:
            "deposit-1",
          campaignId:
            "campaign-1",
          outcome: "reverse",
          reason:
            "dispute_loss",
          resolutionId:
            "resolution-lost"
        });

    assert.equal(
      verifyFundingHoldResolution(
        release,
        registry
      ),
      true
    );

    assert.equal(
      verifyFundingHoldResolution(
        reverse,
        registry
      ),
      true
    );
  }
);

test(
  "hold resolution outcome and reason must agree",
  () => {
    const {
      fundingSource
    } = source();

    assert.throws(
      () =>
        fundingSource
          .issueHoldResolution({
            holdId: "hold-1",
            originalDepositId:
              "deposit-1",
            campaignId:
              "campaign-1",
            outcome: "release",
            reason:
              "dispute_loss"
          }),
      /reason does not match outcome/
    );
  }
);

test(
  "hold receipts contain no cognition or identity payloads",
  () => {
    const {
      fundingSource
    } = source();

    const hold =
      fundingSource
        .issueHold({
          originalDepositId:
            "deposit-1",
          campaignId:
            "campaign-1",
          credits: 4,
          reason: "dispute"
        });

    assert.deepEqual(
      Object.keys(hold)
        .sort(),
      [
        "asset",
        "campaignId",
        "credits",
        "externalReference",
        "holdId",
        "occurredAt",
        "originalDepositId",
        "reason",
        "schema",
        "signature",
        "sourceId"
      ]
    );
  }
);


test(
  "funding source issues signed reconciliation statement",
  () => {
    const {
      fundingSource,
      registry
    } = source();

    const statement =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign-1",
          depositedCredits: 25,
          reversedCredits: 7,
          activeHoldCredits: 4,
          statementId:
            "statement-1",
          asOf:
            "2026-10-05T06:00:00.000Z"
        });

    assert.equal(
      statement.schema,
      "sponsorrail.funding-statement.v0.17"
    );

    assert.equal(
      verifyFundingStatement(
        statement,
        registry
      ),
      true
    );
  }
);

test(
  "funding statement rejects impossible totals and tampering",
  () => {
    const {
      fundingSource,
      registry
    } = source();

    assert.throws(
      () =>
        fundingSource
          .issueStatement({
            campaignId:
              "campaign-1",
            depositedCredits: 10,
            reversedCredits: 11,
            activeHoldCredits: 0
          }),
      /reversedCredits cannot exceed/
    );

    assert.throws(
      () =>
        fundingSource
          .issueStatement({
            campaignId:
              "campaign-1",
            depositedCredits: 10,
            reversedCredits: 4,
            activeHoldCredits: 7
          }),
      /activeHoldCredits exceeds/
    );

    const statement =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign-1",
          depositedCredits: 10,
          reversedCredits: 4,
          activeHoldCredits: 2,
          statementId:
            "statement-tamper",
          asOf:
            "2026-10-05T06:00:00.000Z"
        });

    assert.equal(
      verifyFundingStatement(
        {
          ...statement,
          depositedCredits: 100
        },
        registry
      ),
      false
    );
  }
);

test(
  "funding statement schema contains no cognition payloads",
  () => {
    const {
      fundingSource
    } = source();

    const statement =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign-1",
          depositedCredits: 10,
          reversedCredits: 2,
          activeHoldCredits: 3,
          asOf:
            "2026-10-05T06:00:00.000Z"
        });

    assert.deepEqual(
      Object.keys(statement)
        .sort(),
      [
        "activeHoldCredits",
        "asOf",
        "asset",
        "campaignId",
        "depositedCredits",
        "reversedCredits",
        "schema",
        "signature",
        "sourceId",
        "statementId"
      ]
    );
  }
);
