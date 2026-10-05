import test from "node:test";
import assert from "node:assert/strict";
import {
  createHmac
} from "node:crypto";
import {
  mkdtempSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FundingSourceRegistry,
  StripeCheckoutFundingAdapter,
  createFundingSourceKeyPair,
  loadSqliteBackend,
  verifyFundingDeposit,
  verifyStripeWebhookSignature
} from "../src/index.js";

const [major, minor] =
  process.versions.node
    .split(".")
    .map(Number);

const sqliteAvailable =
  major > 22 ||
  (
    major === 22 &&
    minor >= 5
  );

const WEBHOOK_SECRET =
  "whsec_test_secret";

function stripeHeader(
  rawBody,
  timestamp = 1000,
  secret = WEBHOOK_SECRET
) {
  const signature =
    createHmac(
      "sha256",
      secret
    )
      .update(
        `${timestamp}.${rawBody}`
      )
      .digest("hex");

  return `t=${timestamp},v1=${signature}`;
}

function stripeEvent({
  eventId = "evt_1",
  eventType =
    "checkout.session.completed",
  sessionId = "cs_test_1",
  paymentIntentId =
    "pi_test_1",
  amountTotal = 1000,
  currency = "usd",
  paymentStatus = "paid",
  mode = "payment",
  livemode = false,
  sessionCreated = 900,
  metadata = {}
} = {}) {
  return {
    id: eventId,
    object: "event",
    created: 1000,
    livemode,
    type: eventType,
    data: {
      object: {
        id: sessionId,
        object:
          "checkout.session",
        payment_intent:
          paymentIntentId,
        created:
          sessionCreated,
        mode,
        payment_status:
          paymentStatus,
        amount_total:
          amountTotal,
        currency,
        metadata
      }
    }
  };
}

function rawEvent(
  overrides = {}
) {
  return JSON.stringify(
    stripeEvent(
      overrides
    )
  );
}


function refundEvent({
  eventId = "evt_refund",
  eventType = "refund.created",
  refundId = "re_test_1",
  paymentIntentId =
    "pi_test_1",
  amount = 200,
  currency = "usd",
  status = "succeeded",
  livemode = false,
  created = 950
} = {}) {
  return {
    id: eventId,
    object: "event",
    created,
    livemode,
    type: eventType,
    data: {
      object: {
        id: refundId,
        object: "refund",
        amount,
        currency,
        payment_intent:
          paymentIntentId,
        status,
        created
      }
    }
  };
}

function disputeEvent({
  eventId =
    "evt_dispute",
  eventType =
    "charge.dispute.closed",
  disputeId =
    "du_test_1",
  paymentIntentId =
    "pi_test_1",
  amount = 100,
  currency = "usd",
  status = "lost",
  livemode = false,
  created = 960
} = {}) {
  return {
    id: eventId,
    object: "event",
    created,
    livemode,
    type:
      eventType,
    data: {
      object: {
        id: disputeId,
        object:
          "dispute",
        amount,
        currency,
        payment_intent:
          paymentIntentId,
        status,
        created
      }
    }
  };
}

function rawRefund(
  overrides = {}
) {
  return JSON.stringify(
    refundEvent(
      overrides
    )
  );
}

function rawDispute(
  overrides = {}
) {
  return JSON.stringify(
    disputeEvent(
      overrides
    )
  );
}

function makeAdapter(
  overrides = {}
) {
  const keys =
    createFundingSourceKeyPair();

  const adapter =
    new StripeCheckoutFundingAdapter({
      webhookSecret:
        WEBHOOK_SECRET,
      sourceId:
        "stripe.checkout",
      privateKey:
        keys.privateKey,
      campaignId:
        "stripe-campaign",
      creditsPerMinorUnit: {
        usd: 2
      },
      now:
        () => 1_000_000,
      ...overrides
    });

  const registry =
    new FundingSourceRegistry([
      {
        sourceId:
          "stripe.checkout",
        publicKey:
          keys.publicKey
      }
    ]);

  return {
    keys,
    adapter,
    registry
  };
}

function dbPath() {
  const dir =
    mkdtempSync(
      join(
        tmpdir(),
        "sponsorrail-stripe-"
      )
    );

  return join(
    dir,
    "stripe.db"
  );
}

test(
  "Stripe webhook signature verifies raw body with timestamp tolerance",
  () => {
    const rawBody =
      rawEvent();

    const header =
      stripeHeader(
        rawBody
      );

    assert.equal(
      verifyStripeWebhookSignature({
        rawBody,
        signatureHeader:
          header,
        webhookSecret:
          WEBHOOK_SECRET,
        now:
          () => 1_000_000
      }),
      true
    );

    assert.equal(
      verifyStripeWebhookSignature({
        rawBody:
          rawBody + " ",
        signatureHeader:
          header,
        webhookSecret:
          WEBHOOK_SECRET,
        now:
          () => 1_000_000
      }),
      false
    );

    assert.equal(
      verifyStripeWebhookSignature({
        rawBody,
        signatureHeader:
          header,
        webhookSecret:
          WEBHOOK_SECRET,
        toleranceSeconds:
          10,
        now:
          () => 2_000_000
      }),
      false
    );
  }
);

test(
  "Stripe Checkout adapter converts verified paid amount to signed credits",
  () => {
    const {
      adapter,
      registry
    } =
      makeAdapter();

    const rawBody =
      rawEvent({
        amountTotal: 1250,
        metadata: {
          sponsorrail_credits:
            "999999999"
        }
      });

    const mapped =
      adapter.handleWebhook({
        rawBody,
        signatureHeader:
          stripeHeader(
            rawBody
          )
      });

    assert.equal(
      mapped.credits,
      2500
    );

    assert.equal(
      mapped
        .depositReceipt
        .depositId,
      "stripe-checkout:cs_test_1"
    );

    assert.equal(
      mapped
        .depositReceipt
        .externalReference,
      "stripe-payment-intent:pi_test_1"
    );

    assert.equal(
      mapped
        .depositReceipt
        .occurredAt,
      "1970-01-01T00:15:00.000Z"
    );

    assert.equal(
      verifyFundingDeposit(
        mapped.depositReceipt,
        registry
      ),
      true
    );
  }
);

test(
  "Stripe Checkout adapter rejects invalid signature unpaid wrong mode and unsupported event",
  () => {
    const {
      adapter
    } =
      makeAdapter();

    const good =
      rawEvent();

    assert.throws(
      () =>
        adapter.handleWebhook({
          rawBody: good,
          signatureHeader:
            stripeHeader(
              good,
              1000,
              "wrong-secret"
            )
        }),
      /signature verification failed/
    );

    for (
      const [overrides, pattern]
      of [
        [
          {
            paymentStatus:
              "unpaid"
          },
          /is not paid/
        ],
        [
          {
            mode:
              "subscription"
          },
          /payment mode/
        ],
        [
          {
            eventType:
              "payment_intent.succeeded"
          },
          /unsupported Stripe event/
        ]
      ]
    ) {
      const body =
        rawEvent(
          overrides
        );

      assert.throws(
        () =>
          adapter.handleWebhook({
            rawBody: body,
            signatureHeader:
              stripeHeader(
                body
              )
          }),
        pattern
      );
    }
  }
);

test(
  "Stripe adapter defaults to test mode and requires explicit live-mode enablement",
  () => {
    const {
      adapter
    } =
      makeAdapter();

    const live =
      rawEvent({
        livemode: true
      });

    assert.throws(
      () =>
        adapter.handleWebhook({
          rawBody: live,
          signatureHeader:
            stripeHeader(
              live
            )
        }),
      /livemode mismatch/
    );

    const {
      adapter:
        liveAdapter
    } =
      makeAdapter({
        requiredLivemode:
          true
      });

    assert.doesNotThrow(
      () =>
        liveAdapter
          .handleWebhook({
            rawBody: live,
            signatureHeader:
              stripeHeader(
                live
              )
          })
    );
  }
);

test(
  "Stripe adapter rejects unconfigured currencies and credit ceilings",
  () => {
    const {
      adapter
    } =
      makeAdapter();

    const eur =
      rawEvent({
        currency: "eur"
      });

    assert.throws(
      () =>
        adapter.handleWebhook({
          rawBody: eur,
          signatureHeader:
            stripeHeader(
              eur
            )
        }),
      /currency is not configured/
    );

    const {
      adapter:
        capped
    } =
      makeAdapter({
        maxCreditsPerDeposit:
          100
      });

    const tooLarge =
      rawEvent({
        amountTotal: 100
      });

    assert.throws(
      () =>
        capped.handleWebhook({
          rawBody:
            tooLarge,
          signatureHeader:
            stripeHeader(
              tooLarge
            )
        }),
      /exceeds configured credit ceiling/
    );
  }
);

test(
  "Stripe async payment success maps to same deterministic Checkout deposit",
  () => {
    const {
      adapter
    } =
      makeAdapter();

    const completed =
      rawEvent({
        eventId:
          "evt_completed",
        sessionId:
          "cs_shared",
        eventType:
          "checkout.session.completed"
      });

    const asyncSuccess =
      rawEvent({
        eventId:
          "evt_async",
        sessionId:
          "cs_shared",
        eventType:
          "checkout.session.async_payment_succeeded"
      });

    const first =
      adapter.handleWebhook({
        rawBody: completed,
        signatureHeader:
          stripeHeader(
            completed
          )
      });

    const second =
      adapter.handleWebhook({
        rawBody:
          asyncSuccess,
        signatureHeader:
          stripeHeader(
            asyncSuccess
          )
      });

    assert.deepEqual(
      second.depositReceipt,
      first.depositReceipt
    );
  }
);

test(
  "Stripe webhook deposits into SQLite exactly once across retries",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const broker =
      new SqliteFundingBroker(
        database
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 10,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant: 5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const body =
      rawEvent({
        amountTotal: 500
      });

    const first =
      adapter.handleAndDeposit({
        rawBody: body,
        signatureHeader:
          stripeHeader(
            body
          ),
        broker,
        fundingSourceRegistry:
          registry
      });

    const replay =
      adapter.handleAndDeposit({
        rawBody: body,
        signatureHeader:
          stripeHeader(
            body
          ),
        broker,
        fundingSourceRegistry:
          registry
      });

    assert.equal(
      first.deposit.applied,
      true
    );

    assert.equal(
      replay.deposit
        .idempotent,
      true
    );

    assert.equal(
      broker
        .fundingSnapshot(
          "stripe-campaign"
        )
        .verifiedDepositCredits,
      1000
    );

    assert.equal(
      broker
        .campaignSnapshot(
          "stripe-campaign"
        )
        .pool
        .availableCredits,
      1010
    );

    broker.close();
  }
);

test(
  "different successful Stripe events for one Checkout Session cannot mint twice",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const broker =
      new SqliteFundingBroker(
        database
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 0 + 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const completed =
      rawEvent({
        eventId:
          "evt_one",
        sessionId:
          "cs_same",
        amountTotal: 250
      });

    const asyncSucceeded =
      rawEvent({
        eventId:
          "evt_two",
        sessionId:
          "cs_same",
        amountTotal: 250,
        eventType:
          "checkout.session.async_payment_succeeded"
      });

    const first =
      adapter.handleAndDeposit({
        rawBody: completed,
        signatureHeader:
          stripeHeader(
            completed
          ),
        broker,
        fundingSourceRegistry:
          registry
      });

    const second =
      adapter.handleAndDeposit({
        rawBody:
          asyncSucceeded,
        signatureHeader:
          stripeHeader(
            asyncSucceeded
          ),
        broker,
        fundingSourceRegistry:
          registry
      });

    assert.equal(
      first.deposit.applied,
      true
    );

    assert.equal(
      second.deposit
        .idempotent,
      true
    );

    assert.equal(
      broker
        .fundingSnapshot(
          "stripe-campaign"
        )
        .verifiedDepositCredits,
      500
    );

    broker.close();
  }
);


test(
  "successful Stripe partial refund reverses only refunded credits",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const payment =
      rawEvent({
        amountTotal: 500,
        paymentIntentId:
          "pi_refund"
      });

    adapter.handleAndDeposit({
      rawBody: payment,
      signatureHeader:
        stripeHeader(
          payment
        ),
      broker,
      fundingSourceRegistry:
        registry
    });

    const refund =
      rawRefund({
        refundId: "re_partial",
        paymentIntentId:
          "pi_refund",
        amount: 200
      });

    const reversed =
      adapter
        .handleReversalWebhook({
          rawBody: refund,
          signatureHeader:
            stripeHeader(
              refund
            ),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      reversed.accepted,
      true
    );

    assert.equal(
      reversed.credits,
      400
    );

    assert.equal(
      reversed.reversal
        .availableDebited,
      400
    );

    const snapshot =
      broker.fundingSnapshot(
        "stripe-campaign"
      );

    assert.equal(
      snapshot
        .verifiedDepositCredits,
      1000
    );

    assert.equal(
      snapshot
        .verifiedReversalCredits,
      400
    );

    assert.equal(
      snapshot
        .netVerifiedFundingCredits,
      600
    );

    broker.close();
  }
);

test(
  "Stripe refund retry is idempotent across created and updated events",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const payment =
      rawEvent({
        amountTotal: 500,
        paymentIntentId:
          "pi_retry"
      });

    adapter.handleAndDeposit({
      rawBody: payment,
      signatureHeader:
        stripeHeader(payment),
      broker,
      fundingSourceRegistry:
        registry
    });

    const created =
      rawRefund({
        eventId:
          "evt_refund_created",
        eventType:
          "refund.created",
        refundId:
          "re_same",
        paymentIntentId:
          "pi_retry",
        amount: 100,
        created: 950
      });

    const updated =
      rawRefund({
        eventId:
          "evt_refund_updated",
        eventType:
          "refund.updated",
        refundId:
          "re_same",
        paymentIntentId:
          "pi_retry",
        amount: 100,
        created: 950
      });

    const first =
      adapter
        .handleReversalWebhook({
          rawBody: created,
          signatureHeader:
            stripeHeader(
              created
            ),
          broker,
          fundingSourceRegistry:
            registry
        });

    const second =
      adapter
        .handleReversalWebhook({
          rawBody: updated,
          signatureHeader:
            stripeHeader(
              updated
            ),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      first.reversal.applied,
      true
    );

    assert.equal(
      second.reversal
        .idempotent,
      true
    );

    assert.equal(
      broker
        .listFundingReversals()
        .length,
      1
    );

    broker.close();
  }
);

test(
  "pending or failed Stripe refund does not mutate SponsorRail credits",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const payment =
      rawEvent({
        amountTotal: 100,
        paymentIntentId:
          "pi_pending"
      });

    adapter.handleAndDeposit({
      rawBody: payment,
      signatureHeader:
        stripeHeader(payment),
      broker,
      fundingSourceRegistry:
        registry
    });

    const pending =
      rawRefund({
        paymentIntentId:
          "pi_pending",
        status: "pending"
      });

    const result =
      adapter
        .handleReversalWebhook({
          rawBody: pending,
          signatureHeader:
            stripeHeader(
              pending
            ),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      result.ignored,
      true
    );

    assert.equal(
      broker
        .fundingSnapshot(
          "stripe-campaign"
        )
        .verifiedReversalCredits,
      0
    );

    broker.close();
  }
);

test(
  "final lost Stripe dispute creates reversal while won dispute is ignored",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const payment =
      rawEvent({
        amountTotal: 500,
        paymentIntentId:
          "pi_dispute"
      });

    adapter.handleAndDeposit({
      rawBody: payment,
      signatureHeader:
        stripeHeader(payment),
      broker,
      fundingSourceRegistry:
        registry
    });

    const won =
      rawDispute({
        disputeId:
          "du_won",
        paymentIntentId:
          "pi_dispute",
        amount: 100,
        status: "won"
      });

    const ignored =
      adapter
        .handleReversalWebhook({
          rawBody: won,
          signatureHeader:
            stripeHeader(won),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      ignored.ignored,
      true
    );

    const lost =
      rawDispute({
        disputeId:
          "du_lost",
        paymentIntentId:
          "pi_dispute",
        amount: 100,
        status: "lost"
      });

    const reversed =
      adapter
        .handleReversalWebhook({
          rawBody: lost,
          signatureHeader:
            stripeHeader(lost),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      reversed.accepted,
      true
    );

    assert.equal(
      reversed
        .reversalReceipt
        .reason,
      "dispute_loss"
    );

    assert.equal(
      broker
        .fundingSnapshot(
          "stripe-campaign"
        )
        .verifiedReversalCredits,
      200
    );

    broker.close();
  }
);

test(
  "Stripe reversal must resolve to original PaymentIntent deposit",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const refund =
      rawRefund({
        paymentIntentId:
          "pi_unknown"
      });

    assert.throws(
      () =>
        adapter
          .handleReversalWebhook({
            rawBody: refund,
            signatureHeader:
              stripeHeader(
                refund
              ),
            broker,
            fundingSourceRegistry:
              registry
          }),
      /no matching SponsorRail Stripe deposit/
    );

    broker.close();
  }
);


test(
  "Stripe dispute creation quarantines credits with a deterministic hold",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const payment =
      rawEvent({
        amountTotal: 500,
        paymentIntentId:
          "pi_hold"
      });

    adapter.handleAndDeposit({
      rawBody: payment,
      signatureHeader:
        stripeHeader(payment),
      broker,
      fundingSourceRegistry:
        registry
    });

    const opened =
      rawDispute({
        eventId:
          "evt_dispute_open",
        eventType:
          "charge.dispute.created",
        disputeId:
          "du_hold",
        paymentIntentId:
          "pi_hold",
        amount: 100,
        status:
          "needs_response"
      });

    const result =
      adapter
        .handleDisputeHoldWebhook({
          rawBody: opened,
          signatureHeader:
            stripeHeader(
              opened
            ),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      result.kind,
      "hold"
    );

    assert.equal(
      result.credits,
      200
    );

    assert.equal(
      result.hold.heldCredits,
      200
    );

    const snapshot =
      broker.fundingSnapshot(
        "stripe-campaign"
      );

    assert.equal(
      snapshot.activeHeldCredits,
      200
    );

    assert.equal(
      snapshot
        .verifiedReversalCredits,
      0
    );

    broker.close();
  }
);

test(
  "Stripe dispute update replays the same hold idempotently",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const payment =
      rawEvent({
        amountTotal: 500,
        paymentIntentId:
          "pi_update"
      });

    adapter.handleAndDeposit({
      rawBody: payment,
      signatureHeader:
        stripeHeader(payment),
      broker,
      fundingSourceRegistry:
        registry
    });

    const created =
      rawDispute({
        eventId:
          "evt_created",
        eventType:
          "charge.dispute.created",
        disputeId:
          "du_update",
        paymentIntentId:
          "pi_update",
        amount: 100,
        status:
          "needs_response",
        created: 960
      });

    const updated =
      rawDispute({
        eventId:
          "evt_updated",
        eventType:
          "charge.dispute.updated",
        disputeId:
          "du_update",
        paymentIntentId:
          "pi_update",
        amount: 100,
        status:
          "under_review",
        created: 960
      });

    const first =
      adapter
        .handleDisputeHoldWebhook({
          rawBody: created,
          signatureHeader:
            stripeHeader(
              created
            ),
          broker,
          fundingSourceRegistry:
            registry
        });

    const second =
      adapter
        .handleDisputeHoldWebhook({
          rawBody: updated,
          signatureHeader:
            stripeHeader(
              updated
            ),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      first.hold.applied,
      true
    );

    assert.equal(
      second.hold.idempotent,
      true
    );

    assert.equal(
      broker.listFundingHolds()
        .length,
      1
    );

    broker.close();
  }
);

test(
  "won Stripe dispute releases its active hold",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const payment =
      rawEvent({
        amountTotal: 500,
        paymentIntentId:
          "pi_won_hold"
      });

    adapter.handleAndDeposit({
      rawBody: payment,
      signatureHeader:
        stripeHeader(payment),
      broker,
      fundingSourceRegistry:
        registry
    });

    const opened =
      rawDispute({
        eventType:
          "charge.dispute.created",
        disputeId:
          "du_won_hold",
        paymentIntentId:
          "pi_won_hold",
        amount: 100,
        status:
          "needs_response"
      });

    adapter
      .handleDisputeHoldWebhook({
        rawBody: opened,
        signatureHeader:
          stripeHeader(opened),
        broker,
        fundingSourceRegistry:
          registry
      });

    const closed =
      rawDispute({
        eventId:
          "evt_won_closed",
        eventType:
          "charge.dispute.closed",
        disputeId:
          "du_won_hold",
        paymentIntentId:
          "pi_won_hold",
        amount: 100,
        status: "won",
        created: 970
      });

    const result =
      adapter
        .handleReversalWebhook({
          rawBody: closed,
          signatureHeader:
            stripeHeader(closed),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      result.kind,
      "hold_release"
    );

    assert.equal(
      broker.fundingSnapshot(
        "stripe-campaign"
      ).activeHoldCount,
      0
    );

    assert.equal(
      broker.fundingSnapshot(
        "stripe-campaign"
      ).verifiedReversalCredits,
      0
    );

    broker.close();
  }
);

test(
  "lost Stripe dispute converts active hold into one permanent reversal",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const broker =
      new SqliteFundingBroker(
        dbPath()
      );

    broker.createCampaign({
      campaignId:
        "stripe-campaign",
      sponsorDisclosure:
        "Example Sponsor",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds useful compute",
      targetingMode:
        "universal",
      budgetCredits: 1,
      eligibleTaskClasses:
        ["*"],
      allowedPrivacyModes:
        ["blind"],
      maxComputePerGrant:
        5000
    });

    const {
      adapter,
      registry
    } =
      makeAdapter();

    const payment =
      rawEvent({
        amountTotal: 500,
        paymentIntentId:
          "pi_lost_hold"
      });

    adapter.handleAndDeposit({
      rawBody: payment,
      signatureHeader:
        stripeHeader(payment),
      broker,
      fundingSourceRegistry:
        registry
    });

    const opened =
      rawDispute({
        eventType:
          "charge.dispute.created",
        disputeId:
          "du_lost_hold",
        paymentIntentId:
          "pi_lost_hold",
        amount: 100,
        status:
          "needs_response"
      });

    adapter
      .handleDisputeHoldWebhook({
        rawBody: opened,
        signatureHeader:
          stripeHeader(opened),
        broker,
        fundingSourceRegistry:
          registry
      });

    const closed =
      rawDispute({
        eventId:
          "evt_lost_closed",
        eventType:
          "charge.dispute.closed",
        disputeId:
          "du_lost_hold",
        paymentIntentId:
          "pi_lost_hold",
        amount: 100,
        status: "lost",
        created: 970
      });

    const first =
      adapter
        .handleReversalWebhook({
          rawBody: closed,
          signatureHeader:
            stripeHeader(closed),
          broker,
          fundingSourceRegistry:
            registry
        });

    const replay =
      adapter
        .handleReversalWebhook({
          rawBody: closed,
          signatureHeader:
            stripeHeader(closed),
          broker,
          fundingSourceRegistry:
            registry
        });

    assert.equal(
      first.kind,
      "hold_reversal"
    );

    assert.equal(
      first.resolution.applied,
      true
    );

    assert.equal(
      replay.resolution
        .idempotent,
      true
    );

    const snapshot =
      broker.fundingSnapshot(
        "stripe-campaign"
      );

    assert.equal(
      snapshot.activeHoldCount,
      0
    );

    assert.equal(
      snapshot
        .verifiedReversalCredits,
      200
    );

    assert.equal(
      broker
        .listFundingReversals()
        .length,
      1
    );

    broker.close();
  }
);
