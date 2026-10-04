import {
  BlindSponsorPool,
  FundingBroker,
  createReceiptKeyPair,
  executeSponsoredTask,
  verifyReceipt
} from "../src/index.js";

const pool = new BlindSponsorPool({
  id: "oss-pool",
  sponsorDisclosure: "ExampleCloud",
  balanceCredits: 100,
  eligibleTaskClasses: ["software-development"]
});

const broker = new FundingBroker([pool]);
const keys = createReceiptKeyPair();

const task = {
  id: "task-001",
  taskClass: "software-development",
  computeRequested: 25,
  userMaxCost: 0,
  privacy: "blind",
  allowSponsorship: true,
  prompt: "Add a health endpoint and tests.",
  repositoryContext: "Private repository context that the sponsor must never receive."
};

const execution = await executeSponsoredTask({
  task,
  broker,
  receiptPrivateKey: keys.privateKey,
  runner: async ({ modelContext, authorization }) => {
    console.log("Agent sees:", modelContext);
    console.log("Execution authorization:", authorization);

    return {
      completed: true,
      computeUnitsUsed: 18,
      summary: "Health endpoint implemented and tests passed."
    };
  }
});

console.log("\nSponsor receipt:");
console.log(JSON.stringify(execution.receipt, null, 2));
console.log("\nReceipt signature valid:", verifyReceipt(execution.receipt, keys.publicKey));
console.log("Remaining sponsor credits:", pool.balanceCredits);
