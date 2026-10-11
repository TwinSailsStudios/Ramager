export const INITIAL_STATE = {
  seed: 481516, day: 0, speed: 1, paused: false, cash: 184200, debt: 910000,
  marketIndex: 104.2, baseRate: 5.25, weather: "CLEAR", temperature: 18,
  history: [5220, 5950, 6410, 6180, 7470, 8420],
  properties: [
    { id: "p1", name: "Hawthorne Duplex", address: "18 Hawthorne Ave", units: 2, occupied: 2, value: 428000, rent: 4120, expense: 1510, condition: 91 },
    { id: "p2", name: "The Marlowe", address: "241 Mercer Street", units: 6, occupied: 5, value: 896000, rent: 10280, expense: 4470, condition: 78 }
  ],
  tenants: [
    { name:"Ava & Liam Chen", unit:"Hawthorne · 1A", rent:2100, satisfaction:94, status:"Current" },
    { name:"Noah Williams", unit:"Hawthorne · 1B", rent:2020, satisfaction:88, status:"Current" },
    { name:"Mia Rodriguez", unit:"Marlowe · 2A", rent:1890, satisfaction:82, status:"Current" },
    { name:"Ethan Kim", unit:"Marlowe · 2B", rent:2080, satisfaction:76, status:"Current" },
    { name:"Sophia Patel", unit:"Marlowe · 3A", rent:2210, satisfaction:91, status:"Current" },
    { name:"Lucas Martin", unit:"Marlowe · 3B", rent:1980, satisfaction:69, status:"At risk" },
    { name:"Emma Davis", unit:"Marlowe · 4A", rent:2120, satisfaction:85, status:"Current" }
  ],
  workOrders: [
    { id:"w1", title:"Low water pressure", location:"The Marlowe · 3B", severity:"MEDIUM", cost:380, progress:0, detail:"Tenant reports intermittent pressure loss during peak morning use." },
    { id:"w2", title:"Hallway light flicker", location:"The Marlowe · Floor 2", severity:"LOW", cost:140, progress:0, detail:"Ballast is near end of service life. No immediate safety hazard." }
  ],
  activities: [
    { text:"Rent received from Ava & Liam Chen", kind:"good", age:"4 MIN" },
    { text:"Maintenance request opened at The Marlowe", kind:"warn", age:"1 HR" },
    { text:"Hawthorne inspection scored 91/100", kind:"good", age:"4 HR" },
    { text:"Base lending rate held at 5.25%", kind:"good", age:"1 DAY" }
  ]
};

export function cloneInitialState() { return structuredClone(INITIAL_STATE); }
export function random(state, salt = 0) {
  let x = (state.seed + state.day * 374761393 + salt * 668265263) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
export function portfolio(state) {
  const value = state.properties.reduce((sum, p) => sum + p.value, 0);
  const rent = state.properties.reduce((sum, p) => sum + p.rent * p.occupied / p.units, 0);
  const expenses = state.properties.reduce((sum, p) => sum + p.expense, 0);
  const occupied = state.properties.reduce((sum, p) => sum + p.occupied, 0);
  const units = state.properties.reduce((sum, p) => sum + p.units, 0);
  return { value, rent, expenses, cashflow: Math.round(rent - expenses - state.debt * .00075), occupancy: occupied / units, units };
}
export function advanceDay(state) {
  const next = structuredClone(state); next.day += 1;
  const marketShock = (random(next, 1) - .48) * .18;
  next.marketIndex = Math.max(80, next.marketIndex + marketShock);
  next.temperature = Math.round(16 + 9 * Math.sin(next.day / 16) + (random(next, 2) - .5) * 7);
  next.weather = random(next, 3) > .79 ? "RAIN" : next.temperature < 2 ? "FREEZE" : "CLEAR";
  for (const p of next.properties) {
    p.value = Math.round(p.value * (1 + marketShock / 100));
    if (random(next, p.id.charCodeAt(1)) < .025) p.condition = Math.max(45, p.condition - 1);
  }
  if (next.day % 30 === 0) {
    const totals = portfolio(next); next.cash += totals.cashflow; next.history.push(totals.cashflow); next.history = next.history.slice(-6);
    next.activities.unshift({ text:`Monthly books closed: +${money(totals.cashflow)} net`, kind:"good", age:"NOW" });
  }
  if (random(next, 22) < .018 && next.workOrders.length < 5) {
    next.workOrders.push({ id:`w${next.day}`, title:"HVAC filter restriction", location:next.properties[1].name, severity:"LOW", cost:190, progress:0, detail:"Airflow sensor detected a rising pressure differential." });
    next.activities.unshift({ text:"New preventive maintenance alert", kind:"warn", age:"NOW" });
  }
  next.activities = next.activities.slice(0, 8);
  return next;
}
export function resolveWorkOrder(state, id) {
  const next = structuredClone(state); const work = next.workOrders.find(w => w.id === id);
  if (!work || next.cash < work.cost) return state;
  next.cash -= work.cost; next.workOrders = next.workOrders.filter(w => w.id !== id);
  next.properties.forEach(p => p.condition = Math.min(100, p.condition + 1));
  next.activities.unshift({ text:`Resolved: ${work.title} · -${money(work.cost)}`, kind:"good", age:"NOW" });
  return next;
}
export function acquire(state, deal) {
  const next = structuredClone(state); const down = Math.round(deal.price * .25);
  if (next.cash < down) return state;
  next.cash -= down; next.debt += deal.price - down;
  next.properties.push({ id:`p${next.properties.length+1}`, name:deal.name, address:deal.address, units:deal.units, occupied:deal.units-1, value:deal.price, rent:deal.rent, expense:deal.expense, condition:deal.condition });
  next.activities.unshift({ text:`Acquired ${deal.name} with ${money(down)} equity`, kind:"good", age:"NOW" });
  return next;
}
export const deals = [
  { name:"Juniper Court", address:"77 Juniper Road", units:4, price:612000, rent:7600, expense:2940, condition:84, cap:"9.1%" },
  { name:"Foundry Lofts", address:"9 Foundry Lane", units:8, price:1240000, rent:16100, expense:6250, condition:72, cap:"8.0%" },
  { name:"Parkline House", address:"403 Parkline Blvd", units:12, price:1890000, rent:25400, expense:9800, condition:88, cap:"8.3%" }
];
export function money(value) { return new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(value); }
