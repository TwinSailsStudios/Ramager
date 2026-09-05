import assert from "node:assert/strict";
import { cloneInitialState, advanceDay, portfolio, resolveWorkOrder, acquire, deals } from "../sim-core.mjs";

const a = cloneInitialState();
const b = cloneInitialState();
for (let i = 0; i < 90; i++) { Object.assign(a, advanceDay(a)); Object.assign(b, advanceDay(b)); }
assert.deepEqual(a, b, "simulation must be deterministic");
assert.equal(a.day, 90);
assert.ok(a.cash > 184200, "monthly operations should generate cash");
assert.ok(portfolio(a).occupancy > 0 && portfolio(a).occupancy <= 1);

const repaired = resolveWorkOrder(cloneInitialState(), "w1");
assert.equal(repaired.workOrders.length, 1);
assert.equal(repaired.cash, 184200 - 380);

const bought = acquire(cloneInitialState(), deals[0]);
assert.equal(bought.properties.length, 3);
assert.equal(bought.debt, 910000 + Math.round(deals[0].price * .75));
console.log("simulation tests passed");
