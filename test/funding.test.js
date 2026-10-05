import test from "node:test";
import assert from "node:assert/strict";

import {
  FundingSourceRegistry,
  SignedFundingSource,
  createFundingSourceKeyPair,
  verifyFundingDeposit,
  verifyFundingReversal
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
