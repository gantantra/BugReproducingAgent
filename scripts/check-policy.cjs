// Quick policy sanity check: does the default policy load, and does it actually mask the
// credential shapes the reliability gate seeds into the sensitive fixture?
//
// Kept as a script rather than a test because it is a diagnostic for policy authoring; the
// binding assertion lives in tests/reliability/redaction_before_persistence.spec.ts.
const { readFileSync } = require("node:fs");
const { Redactor } = require("../packages/evidence/dist/redaction.js");

const SEEDED = {
  awsKey: "AKIAIOSFODNN7EXAMPLEKEY123",
  bearer: "AKIAIOSFODNN7EXAMPLEKEY123456789",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  email: "real.user@company-domain.example",
  phone: "9876543210",
  card: "4111111111111111",
  pan: "ABCDE1234F",
};

let policy;
try {
  policy = Redactor.fromString(readFileSync("policies/default.yaml", "utf8"));
} catch (e) {
  console.log("POLICY_FAILED: " + String(e.message).split("\n")[0]);
  process.exit(1);
}
console.log("POLICY_OK rules=" + policy.policy.rules.length);

const htmlBody = [
  "<html><head></head><body>",
  "<script>",
  "fetch('/api/profile?access_token=" + SEEDED.awsKey + "&q=laptop', {",
  "  headers: { 'Authorization': 'Bearer " + SEEDED.bearer + "' }",
  "});",
  "window.localStorage.setItem('authToken', '" + SEEDED.jwt + "');",
  "</script>",
  "<div>" + SEEDED.email + " " + SEEDED.phone + " " + SEEDED.card + " " + SEEDED.pan + "</div>",
  "</body></html>",
].join("\n");

const jsonBody = JSON.stringify({
  email: SEEDED.email,
  phone: SEEDED.phone,
  card: SEEDED.card,
  pan: SEEDED.pan,
  plan: "gold",
});

const cases = [
  ["network.responseBody(html)", htmlBody, { contentType: "text/html", optIns: new Set(["captureBodies"]) }],
  ["network.responseBody(json)", jsonBody, { contentType: "application/json", optIns: new Set(["captureBodies"]) }],
  ["dom.text", htmlBody, {}],
  ["console.text", "token=" + SEEDED.jwt + " key=" + SEEDED.awsKey, {}],
  ["network.url", "http://x/api?access_token=" + SEEDED.awsKey + "&q=laptop", {}],
];

let leaks = 0;
for (const [label, value, ctx] of cases) {
  const scope = label.replace(/\(.*\)$/, "");
  const out = policy.redactField(scope, value, ctx);
  const v = out.value === undefined ? "" : out.value;
  const found = Object.entries(SEEDED).filter(([, secret]) => v.includes(secret));
  if (found.length) {
    leaks += found.length;
    console.log("LEAK " + label + " rule=" + out.ruleId + " -> " + found.map(([k]) => k).join(","));
  } else {
    console.log("CLEAN " + label + " rule=" + out.ruleId);
  }
}

// Non-sensitive content must survive, or redaction is blanket destruction rather than targeted.
const keep = policy.redactField("storage.localStorage", "3", { key: "cartCount" });
console.log("cartCount value kept = " + (keep.value === "3"));

console.log(leaks === 0 ? "RESULT: no leaks" : "RESULT: " + leaks + " leaks");
process.exit(leaks === 0 && keep.value === "3" ? 0 : 1);
