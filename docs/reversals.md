# Funding reversals and liabilities

SponsorRail v0.15 adds append-only corrections for money that leaves or is clawed back from a sponsor campaign.

## Principle

> Correct history. Do not rewrite it.

A refund or dispute does not erase the original verified deposit. It appends a signed reversal that references that deposit.

Likewise, already-settled compute remains spent. SponsorRail does not pretend the work unhappened because the payment later reversed.

## Signed reversal

The same trusted funding source that issued a deposit can issue a reversal.

The funding-source registry verifies the Ed25519 signature and asset contract before the ledger changes.

## Original-deposit bound

Every reversal points to one original deposit.

The ledger verifies:

```text
same source
same campaign
same asset
sum(all reversals) <= original deposit credits
```

This supports multiple partial refunds without permitting an unlimited negative mint.

## Liability model

A campaign has three ordinary pool balances:

```text
available
reserved
spent
```

v0.15 adds:

```text
outstanding funding liability
```

Reversal order:

1. debit available credits
2. leave reserved credits untouched
3. leave spent credits untouched
4. record any remaining reversal as liability

A campaign with liability cannot authorize new campaign-funded work.

## Liability repayment

Credits flowing back toward availability pass through liability first:

- new verified deposits
- released grants
- unused compute refunded during settlement
- expired reservation recovery

Only the remainder becomes available.

## Stripe mapping

Stripe Checkout deposits are correlated by PaymentIntent.

Successful refunds produce `reason=refund`.

A final lost Stripe dispute produces `reason=dispute_loss`.

Pending/failed refunds and non-lost dispute closures do not create funding reversals.

## Current boundary

v0.15 does not model temporary dispute holds. It waits for a final lost dispute before applying a permanent debit.

That is conservative about ledger finality but means a campaign may remain economically exposed while a dispute is unresolved. A future hold/reserve layer can model that intermediate state explicitly.
