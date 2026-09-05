# *High-Yield: The Real Estate Simulation* — Technical Design

**Document status:** implementation blueprint  
**Simulation contract:** deterministic fixed-step core; presentation is asynchronous  
**Target:** a UE5/UE6-class engine with virtualized geometry, compute shaders, world partition, and volumetric lighting

## 0. Architectural invariants

The title is a coupled simulation, not five independent features. A winter storm increases feeder load; a weak transformer trips; apartments cool; pipes freeze; tenants complain, miss work, and default; net operating income falls; the lender tightens covenants; a nearby foreclosure depresses comparable sales. Every change travels through typed events and conserved flows rather than directly mutating unrelated systems.

### 0.1 Time, determinism, and scale

The authoritative simulation uses integer `SimTick` and counter-based random streams keyed by `(world_seed, system_id, entity_id, tick, draw_index)`. Floating-point reductions are sorted by stable entity ID and use fixed-point values where money, energy, mass, or network flow is conserved. Rendering may interpolate but never writes authoritative state.

| Clock | Step | Responsibilities |
|---|---:|---|
| Physics | 1/30 s | occupants, doors, elevators, local structural transients |
| Building | 1 simulated minute | utilities, temperature, leaks, queues, exposure |
| Operations | 1 simulated hour | schedules, work orders, satisfaction, wear |
| Economy | 1 simulated day | rent, wages, listings, crime, demand |
| Finance | month boundary | debt service, credit, tax, foreclosure |
| Planning | quarter/year | zoning, construction pipeline, migration, progression |

At speed-up, inactive buildings run analytically in shards. A shard advances from one discontinuity (lease expiry, payment, storm, failure) to the next. Re-entering a district materializes its aggregate state with the same keyed random stream, preventing save/reload or camera position from rerolling outcomes.

```text
Input/Commands -> Validation -> Fixed Tick Scheduler -> Domain Systems
                                          |              |
                                          v              v
                                  Append-only Event Log  Read Models
                                          |              |
                            Save/Replay/Multiplayer      UI/Rendering
```

### 0.2 Common types and event discipline

```pseudo
type MoneyCents = int64
type RateBps = int32
type SimTick = uint64
type EntityId = uint128

struct Quantity { raw: int64; scale: int32; unit: UnitId }
struct DomainEvent { tick; sequence; kind; subject; payload; causation_id }

function step_world(tick):
    commands = CommandQueue.drain_sorted(tick, by=(player_id, sequence))
    for c in commands: validate_and_apply(c)
    for phase in [Weather, Economy, Agents, Utilities, Structure, Maintenance, Finance]:
        phase_events = systems[phase].step(snapshot, RNGKey(tick, phase))
        EventBus.publish(sort(phase_events, by=(subject, kind)))
    SnapshotStore.commit(tick)
```

Systems communicate by events (`PowerLost`, `PipeBurst`, `NoiseExposure`, `PaymentMissed`) and query immutable snapshots. Cycles are resolved on the next tick; this makes ordering explicit and replayable. Save files contain a versioned snapshot, event-log tail, RNG counters, content hashes, and outstanding scheduled events.

## 1. Macro-economic simulation: the city grid

### 1.1 Spatial and relational model

The city is a multiplex graph. The same parcel participates in geographic adjacency, road-time, transit-time, utility, school-catchment, employment, and social-influence layers.

```text
District 1--* Parcel 1--1 Property 1--* Building 1--* Unit
    |           |          |              |
    |           *--* Amenity              *--* UtilityNode
    |           *--* TransitNode          *--* WorkOrder
    *--* EconomicSector

Player/Owner 1--* Ownership *--1 Property
Property 1--* Valuation; Property 1--* Auction; Property 1--* Lien
Loan *--1 Property; Loan *--1 Borrower; Bank 1--* Loan
Tenant 1--* Lease *--1 Unit; Tenant *--1 Household; Tenant *--* Job
```

| Entity | Important persisted fields |
|---|---|
| `Parcel` | polygon, buildable volume, zoning mix, FAR, hazards, tax district |
| `DistrictNode` | population cohorts, jobs, crime vector, amenity stock, expectations |
| `Property` | improvements, condition, occupancy, NOI history, liens, assessed value |
| `Bank` | deposits, capital, liquidity, risk appetite, concentration by district/type |
| `Loan` | principal, index, spread, amortization, DSCR/LTV covenants, delinquency state |
| `MarketActor` | strategy, capital, financing constraints, information radius, portfolio |

### 1.2 City dynamics

Each district `d` has state `x_d=[households, jobs_s, wage_s, vacancies, crime_k, amenities, construction]`. Daily evolution combines endogenous flows, neighbor spillovers, policy impulses, and bounded stochastic shocks:

\[
x_{d,t+1}=\Pi_\Omega\{x_{d,t}+\Delta t[f(x_{d,t},p_t)+\sum_j W^{layer}_{dj}g(x_j-x_d)]+L_d\epsilon_t\}
\]

`Pi` projects onto feasible nonnegative stocks. Shocks use a correlated Cholesky factor `L`: a recession can strike employment citywide while a station closure remains local. Household cohort migration uses a discrete-choice utility:

\[
U_{h,d}=\beta_h^T[\log wage, -rent/income, -commute, safety, schools, amenities]+\xi_{h,d};\quad
P(d|h)=\frac{capacity_d e^{U_{h,d}/\tau}}{\sum_j capacity_j e^{U_{h,j}/\tau}}
\]

Vacancies and asking rents clear through damped tâtonnement rather than teleporting to equilibrium: `rent[t+1] = clamp(rent[t] * exp(k*(target_occ-occ)), ±daily_cap)`. New projects enter a multi-year pipeline when risk-adjusted residual land value exceeds acquisition plus entitlement and construction costs.

Crime is separated into violent, property, and nuisance indices. It rises with unemployment, vacancy, crowding, and prior crime, falls with legitimate foot traffic and services, and diffuses along street edges. Policing suppresses observed incidents but excessive displacement pushes some activity to neighbors. This prevents a single universal “crime number” and creates spatial externalities.

### 1.3 Property value

Value is reconciled from income, comparable-sales, and replacement-cost approaches. This prevents a transient local feature from unrealistically dominating price.

\[
NOI=EGI-vacancy-credit\ loss-operating\ expense-reserves
\]
\[
V_{income}=\sum_{y=1}^{H}\frac{NOI_y}{(1+r)^y}+\frac{NOI_{H+1}/(cap-g)}{(1+r)^H}
\]
\[
\log(PPSF_i)=\alpha_{type}+\beta^Tz_i+u_{district}+u_{time}+\epsilon
\]

Features `z` include log network distance to transit, job accessibility within 30 minutes, commercial amenity diversity, compatible commercial frontage, nuisance/nightlife, crime by type, school quality, flood/noise exposure, zoning/FAR option value, condition, energy grade, vacancy, and spatially weighted recent sales. A monotone spline models transit distance: very close rail access helps, but platform noise penalizes abutting parcels. Commercial zoning has complementarity until noise/loading externalities exceed a threshold.

```pseudo
function value_property(p, as_of):
    scenario_noi = forecast_NOI(p, macro_scenarios, lease_roll, 10 years)
    income = probability_weighted_DCF(scenario_noi, discount_rate(p))

    comps = sales.within(travel_minutes=15, age<=18 months, same_use=p.use)
    weights = exp(-distance/compscale) * exp(-age/halflife) * similarity(p, comps)
    comparable = weighted_median(comps.ppsf * hedonic_adjustment(comps, p), weights) * p.area

    replacement = land_residual(p.parcel) + depreciated_rebuild_cost(p)
    confidence = [lease_data_quality(p), effective_comp_count(weights), inspection_quality(p)]
    raw = confidence_weighted_median([income, comparable, replacement], confidence)
    return raw * title_liquidity_hazard_adjustments(p)
```

Daily land-price return is `mu + spatial_lag + B*macro_shocks + idiosyncratic_shock`; volatility increases as transaction count falls. Players initially see a confidence interval, not ground truth. Appraisals narrow uncertainty but can be stale or biased.

### 1.4 Gentrification and displacement

Gentrification is an emergent regime, tracked by a pressure score rather than scripted:

\[
G_d=0.25z(permit\ value)+0.20z(high\ income\ inflow)+0.15z(amenity\ openings)+0.15z(transit\ gain)+0.15z(rent\ growth)-0.10z(vacancy)
\]

If `G` exceeds a hysteresis threshold for two quarters, expectations raise renovation and luxury-development probabilities. Displacement risk per household is a logistic hazard based on rent burden, lease expiry, protection policy, income shocks, and social ties. Displaced households migrate through the same choice model, changing commute, labor supply, and neighboring rents. Rent control, vouchers, inclusionary zoning, and community investment alter individual channels rather than toggling gentrification off.

### 1.5 Banking, leverage, and credit

The central policy path follows a stochastic Taylor-style process:

\[
i_t=\rho i_{t-1}+(1-\rho)(r^*+\pi_t+a(\pi_t-\pi^*)+b\,outputGap_t)+\sigma\epsilon_t
\]

Quoted loan rate in basis points is `index + bank funding spread + expected loss + capital charge + liquidity premium + term premium - relationship discount`, with floors and caps. Expected loss is `PD × LGD × EAD`; LGD responds to stressed LTV and foreclosure time.

Underwriting computes:

* `LTV = principal / min(purchase_price, appraised_value)`; stressed LTV uses a downside appraisal.
* `DSCR = underwritten_NOI / annual_debt_service`; NOI uses market vacancy, normalized expenses, and haircut income.
* `DebtYield = underwritten_NOI / principal`.
* Borrowing base is the minimum implied principal from max LTV, min DSCR, min debt yield, and bank concentration capacity.

For monthly rate `q` and `n` payments, debt service is `A=P q(1+q)^n/((1+q)^n-1)`. Variable-rate loans reprice at their contractual reset and can trigger covenants without immediately defaulting.

```pseudo
score = 1000
score -= 280 * sigmoid(8 * (payment_lateness_rate - .03))
score -= 170 * clamp(revolving_utilization, 0, 1)
score -= 150 * recent_default_severity
score -= 100 * inquiry_burst
score += 120 * log1p(years_of_clean_history) / log(21)
score +=  80 * portfolio_DSCR_quality
score = clamp(score, 300, 1000)

PD_12m = logistic(calibration[type] + f(score) + macro_stress + leverage + concentration)
```

Credit stores the underlying history, not only a score. Missed payments roll `Current -> 30 -> 60 -> 90 days`, cure only after cleared arrears, and decay in influence over years. Banks themselves obey capital and liquidity limits; correlated losses can cause a credit crunch, loan sales, or failure.

### 1.6 Distress, foreclosure, and auctions

A property enters special servicing through payment delinquency, covenant breach, tax lien, or owner insolvency. Jurisdiction parameters govern notices, cure windows, receivership, redemption, and court delay.

```text
Performing -> Watchlist -> Delinquent -> Notice/Cure -> ForeclosureFiled
                    ^          | cure             | stay/modify
                    +----------+                  v
    REO <- FailedAuction <- Scheduled <- Judgment/Authorization
     |          |              |          |
     +-> Listed/SealedBid      Sold ------> Closing -> Owned
```

Structural decay continues through proceedings. Vacant security, freeze damage, vandalism, unpaid utility liens, title defects, occupants, and legal delay are uncertain inspection findings. A bid escrow is locked at registration. Proxy bids use deterministic priority `(amount, submitted_tick, bidder_id)` and visible increments; sealed bids resolve once. Anti-sniping extends live auctions when a valid bid arrives in the final window.

AI bidders estimate private value using strategy-specific renovation ability, financing, portfolio synergy, and risk aversion:

```pseudo
for bidder in qualified_bidders:
    samples = monte_carlo(256, keyed_rng(bidder, auction),
      rent, vacancy, title_defect, structural_scope, delay, exit_cap)
    certainty_equivalent = mean(NPV(samples)) - bidder.risk_aversion * downside_semideviation(samples)
    max_bid = min(certainty_equivalent - required_margin,
                  cash_and_debt_capacity(bidder), concentration_limit(bidder))
    strategy = choose(proxy, wait, drop_out, collusion_reportable=false)
```

At closing, the winner can still fail financing or title review and lose earnest money; the asset then passes to the backup bidder or is relisted. The UI must separate known repair estimates from hidden-risk distributions.

## 2. Micro-architectural engine

### 2.1 Gridless building representation

Authoritative geometry is a boundary representation (B-rep), not rendered triangles. Vertices use building-local fixed-point millimeters; half-edges define planar faces; closed shells define spaces and solids. Constraints encode coincidence, parallelism, dimensions, floor elevations, clearance, and code rules. A transaction edits a copy, solves constraints, validates manifoldness and code, then atomically commits a new revision.

```pseudo
struct Vertex { id; xyz_mm: int64[3] }
struct HalfEdge { id; origin; twin; next; face }
struct Face { id; plane; outer_loop; inner_loops[]; assembly_id; space_left; space_right }
struct Solid { id; boundary_faces[]; category; material_layers[] }
struct Space { id; shell_faces[]; usage; floor_level; volume; portals[] }
struct Connector { id; kind; host_face; transform; capacity; state }
struct BuildingRevision { geometry_hash; entities; constraints; derived_graph_versions }
```

Edits produce derived products: render meshes, collision, room/portal graph, navmesh tiles, acoustic graph, thermal zones, structural finite elements, fire compartments, quantity takeoff, and utility routing obstacles. Dirty regions are spatially bounded and rebuilt asynchronously; gameplay commits only when authoritative low-resolution products validate. Render Nanite meshes can arrive later.

### 2.2 Structural mechanics

Beams, columns, slabs, shear walls, footings, and connections compile to a sparse finite-element model. Loads include dead weight, occupancy live load, wind, snow, water, equipment, and construction staging. The quasi-static solve is:

\[
K(u,d)u=f,\quad \eta_e=\max(\sigma/\sigma_{allow},\delta/\delta_{allow},buckling^{-1})
\]

Damage `d` reduces stiffness. The interactive solver uses a coarse beam/shell graph and preconditioned conjugate gradient; a background audit refines suspect zones. Removing a pillar is previewed as a staged command: load paths are recomputed before demolition begins. During unsafe work, temporary shoring carries load. Without it, overloaded components accumulate nonlinear damage; slabs visibly sag via a displacement field, crack, yield, then progressively fail. Failure redistributes load and queues another solve—never a single scripted collapse.

```pseudo
function structural_step(model, loads, dt):
    u = solve_sparse(model.K(damage), loads)
    for e in stable_order(model.elements):
        utilization = interaction_equation(e, stress(u,e), buckling(e), connection(e))
        if utilization > 1:
            e.damage += dt * material_fatigue(e) * (utilization - 1)^exponent
        if e.damage >= failure_threshold: emit ElementFailed(e.id)
        emit VisualDeflection(e.id, low_pass(u[e.nodes]))
```

### 2.3 Material and assembly taxonomy

Composition is preferred over deep inheritance. `MaterialDefinition` is immutable content; an installed `MaterialState` contains wear, moisture, contamination, temperature, and workmanship. An `Assembly` stacks layers with studs, cavities, fasteners, and junction treatments.

| Property group | Examples / units |
|---|---|
| Mechanical | density, elastic modulus, yield/compressive strength, creep, fatigue, hardness |
| Hygrothermal | conductivity, heat capacity, vapor permeance, sorption, freeze tolerance |
| Acoustic | octave-band absorption `alpha[f]`, transmission loss `TL[f]`, impact isolation |
| Fire/health | ignition, smoke, toxicity, fire rating contribution, mold susceptibility |
| Lifecycle | cost, embodied carbon, install skill/time, service life, repairability |
| Appearance | texture set, roughness/newness curves, stain/scuff/crack responses |

```pseudo
interface ConstitutiveModel:
    stress(strain, temperature, moisture, damage) -> Tensor
    advance(state, exposures, dt) -> MaterialState

record MaterialDefinition:
    id; mechanical; hygrothermal; acoustic_bands; fire; lifecycle; visual_curves

record AssemblyDefinition:
    layers[]; framing_pattern; junction_seal; fasteners; penetrations_policy

function assembly_TL(A, frequency):
    base = coupled_mass_spring_mass(A.layers, frequency)
    return base - flanking_loss(A.junctions) - penetration_loss(A.openings)
```

Cheap drywall has low impact resistance, weak low-frequency transmission loss, moisture sensitivity, and low replacement cost. Double resilient-channel acoustic panels add mass, decoupling, sealed junctions, and labor cost. Marketing labels never directly alter satisfaction; measured sound exposure does.

### 2.4 Utility networks and degradation

Electrical, potable water, drain/waste/vent, hydronic, gas, ventilation, data, and fire systems are typed graphs with ports. A port defines medium, direction, size/voltage, capacity, and compatibility. Routing uses 3D A* over service corridors with bend radius, slope, access, collision, and code-clearance constraints.

**Electrical.** Modified nodal analysis solves feeder voltage and current. Devices specify time-varying real/reactive power. Thermal state of conductor `e` follows `C dT/dt = I²R(T) - h(T-Tambient)`. Breaker trip curves integrate `I/In` and temperature; upstream/downstream selectivity determines ripple effects.

```pseudo
function electrical_tick(graph, loads, dt):
    V, I = solve_power_flow(graph, loads)
    for edge in graph.edges_downstream_order:
        edge.temp += dt * (I[edge]^2 * resistance(edge.temp) - cooling(edge)) / heat_capacity(edge)
        edge.breaker.trip_integral += dt * trip_curve(I[edge]/edge.rating, edge.temp)
        if edge.breaker.trip_integral >= 1:
            edge.breaker.open = true
            disconnected = graph.reachable_loads_below(edge)
            emit PowerLost(disconnected, cause=edge.id)
    protection_coordination_audit(graph)
```

A short in 3B first trips its branch breaker. A mis-rated or stuck branch breaker allows fault current to heat the feeder and trip the floor panel, darkening multiple units. The sudden HVAC stop changes thermal zones; emergency lighting drains batteries; pumps and routers fail according to backup topology. Restoration requires isolation, diagnosis, repair, and safe re-energization; blindly resetting into a persistent fault retrips and worsens damage.

**Water and HVAC.** Water uses nodal continuity plus pressure/head-loss equations; drainage requires gravity slope and capacity. Leak area turns pressure into mass flow. Thermal zones use an RC network with solar, occupants, infiltration, HVAC, and inter-zone coupling. HVAC components solve mass/energy balance and degrade with runtime, cycling, fouling, corrosion, and poor maintenance.

For component `c`, hazard is

\[
\lambda_c=\lambda_0 ageShape(age)\exp(\gamma_T T_{stress}+\gamma_L overload+\gamma_M moisture-\gamma_S serviceQuality)
\]

Failure in a step occurs when keyed `u < 1-exp(-lambda*dt)`. Preventive maintenance reduces condition-age but cannot erase chronological age; replacement does.

## 3. Neural tenant simulation

“Neural” describes believable agents, not uncontrolled black-box inference. Decisions use inspectable utility models, hierarchical state machines, and bounded memory so saves replay and designers can explain outcomes.

### 3.1 Agent data and psychology

```pseudo
struct Personality {
    openness, conscientiousness, extraversion, agreeableness, neuroticism: Q0_16
    noise_tolerance, cleanliness, risk_tolerance, privacy_need: Q0_16
}
struct NeedState { sleep, hunger, hygiene, safety, belonging, comfort, autonomy: Q0_16 }
struct Tenant {
    id; household_id; personality; needs; health; skills; job_id; money;
    beliefs: Map<Fact, Belief(confidence,last_observed)>;
    episodic_memory: RingBuffer<EventAppraisal>;
    relationships: Map<EntityId, AffinityTrust>;
    plan; current_action; satisfaction_components; complaint_cooldowns;
}
```

OCEAN changes sensitivities and action probabilities, not destiny. Neuroticism amplifies perceived severity and slows emotional recovery. Conscientiousness favors early payment and cleaning. Extraversion increases social utility and party invitation rate. Agreeableness favors negotiation over escalation. Openness increases tolerance for unusual layouts and neighborhood change.

An event is appraised against needs and expectations. The exponentially decayed satisfaction component is:

\[
S_{k,t+1}=S_{k,t}e^{-dt/\tau_k}+(1-e^{-dt/\tau_k})clamp(actual_k-expected_k)
\]

Overall satisfaction is a loss-averse weighted mean with hard floors for safety and habitability. Repeated unresolved failures acquire a trust multiplier; luxury amenities cannot compensate for no heat.

```pseudo
function maybe_complain(tenant, defect):
    perceived = defect.objective_severity * (0.65 + 0.7*tenant.neuroticism)
    perceived *= expectation_multiplier(tenant.lease, tenant.rent)
    urgency = perceived + memory_of_repeats(defect) - complaint_friction(tenant)
    if urgency > adaptive_threshold and cooldown_expired(defect.kind):
        channel = choose_channel(tenant.agreeableness, urgency, landlord_trust)
        emit SupportTicket(channel, observed_symptoms_only, perceived))
```

### 3.2 Schedules, planning, and 3D navigation

Life templates generate flexible obligations: sleep window, work shift, commute, meals, childcare, errands, and leisure. A utility planner chooses actions satisfying hard commitments and needs, with inertia to prevent thrashing. Agents know only observed routes and announced outages.

Navigation is hierarchical:

1. City transit/road graph selects building-to-destination route.
2. Building room-portal graph selects stairs/elevators and security boundaries.
3. Navmesh path follows walkable surfaces.
4. Reciprocal local avoidance handles people, doors, and furniture.

Elevators are capacity-constrained servers. A destination-control scheduler batches compatible calls; passengers have arrival, patience, accessibility, and floor destination. Hallway edges have density-dependent speed (fundamental pedestrian flow curve). A queue delay updates lateness risk, stress, and satisfaction only after being experienced.

```pseudo
function choose_daily_action(a, now):
    candidates = affordances.reachable(a) + [wait, cancel, remote_alternative]
    for x in candidates:
        utility[x] = need_relief(a,x) + commitment_value(a,x)
                   + personality_fit(a,x) + social_value(a,x)
                   - predicted_time(a,x) - money_cost(x) - uncertainty(a,x)
                   - switch_cost(a.current_action,x)
    return softmax_sample(utility, keyed_rng(a.id, now.slot))

function edge_travel_time(edge):
    density = occupants_on(edge) / edge.area
    speed = free_speed * max(min_speed_ratio, 1 - density/jam_density)
    return edge.length/speed + door_queue(edge) + elevator_expected_wait(edge)
```

### 3.3 Acoustic propagation and parties

Sound is calculated in octave bands over an acoustic zone/portal graph. Sources have band power and time envelopes. Walls contribute frequency-specific transmission loss; doors and gaps form parallel paths; corridors, ducts, and slab junctions provide flanking paths. For each receiver, the engine retains the energetic sum of significant paths, capped by an audibility budget.

\[
L_{r,b}=10\log_{10}\sum_p 10^{(L_{s,b}-TL_{p,b}-20\log_{10}r_p-\alpha_b r_p+R_{p,b})/10}
\]

```pseudo
function propagate_noise(source, building):
    pq.push(source.zone, loss_bands=0, distance=1m)
    best = Map<(zone,band), dB_loss>(INF)
    while pq and visited_paths < ACOUSTIC_BUDGET:
        state = pq.pop_lowest_a_weighted_loss()
        for portal in building.acoustic_edges(state.zone):
            loss = state.loss + portal.assembly.TL_bands
                 + air_absorption(state.distance) + geometric_spreading(state.distance)
                 + portal.flanking_penalty_bands
            if materially_better(loss, best[portal.other]): pq.push(portal.other, loss)
    for receiver in nearby_tenants:
        level = energetic_sum(paths_to(receiver.zone)) + room_response(receiver.room)
        exposure = integrate_over_time(max(0, level - ambient(receiver.zone)))
        annoyance = exposure * sensitivity(receiver) * sleep_penalty(receiver, now)
        emit NoiseExposure(receiver.id, source.id, annoyance))
```

Extraversion increases party probability, guest count, and duration; conscientiousness, neighbor affinity, lease enforcement memory, schedule, and quiet hours reduce it. Noise produces evidence, not automatic guilt: tenants may misattribute sounds when paths overlap.

### 3.4 Employment, household finance, and leases

Employment is a state machine with macro-sensitive hazards:

```text
OutOfLaborForce <-> Searching -> Probation -> Employed -> Promoted
                         ^          |            |  |
                         +----------+------------+  +-> LaidOff -> Searching
                                      quit/fire
```

Job offers depend on skills, commute, sector vacancies, networks, and discrimination-policy parameters. Wages adjust through contract frequency and sector productivity, not instantly with inflation. Households budget liquid cash, debt, benefits, recurring bills, and a precautionary reserve.

At rent due date the household solves constrained payment priority based on eviction risk, utilities, food, health, and debt. Financial lifecycle:

```text
Stable -> Strained -> Late -> Delinquent -> PaymentPlan -> Cured
             |         |          |             |
             v         v          v             v
         Assistance  Fee/Notice  Court       BrokenPlan -> Delinquent
                                  | 
                            Evicted/MoveOut/Bankruptcy
```

Lease upgrade/downgrade requests arise when expected permanent income, household size, space mismatch, satisfaction, moving cost, and available alternatives make relocation utility exceed staying by a hysteresis margin. A promotion does not guarantee an upgrade; a job loss first triggers savings, assistance, negotiation, or roommate search according to the agent.

## 4. Visual and environmental systems

### 4.1 Weather and building physics

Weather is a seeded regional field with fronts, not independent dice per parcel. Hourly variables include dry-bulb/dew point, precipitation phase/intensity, wind vector/gusts, cloud/solar radiation, air quality, and ground temperature. Seasonal normals feed a correlated autoregressive residual; extreme-event generators supply heat waves, freezes, storms, smoke, and floods.

The building envelope maps weather to zone heat/moisture. Windward rain wets façades; stack effect and wind pressure drive infiltration; snow adds structural load; solar orientation adds gains; humidity enables mold after sufficient time above material-specific water activity.

Pipe temperature obeys an RC balance with surrounding air, flowing water, heat trace, and insulation. Burst risk requires both freezing and pressure/expansion exposure:

```pseudo
for pipe in exposed_pipes:
    pipe.temp = implicit_thermal_step(pipe, ambient_zone, water_flow, dt)
    if pipe.temp < freeze_point:
        pipe.ice_fraction += freeze_rate(pipe.temp, insulation, dt)
    else:
        pipe.ice_fraction -= thaw_rate(pipe.temp, dt)
    stress = constrained_expansion(pipe.ice_fraction, pipe.geometry, pipe.material)
    if stress > strength(pipe.condition) and hazard_draw(pipe, stress, dt):
        emit PipeBurst(pipe.id, crack_area(stress)))
```

A burst leaks according to pressure, wets porous layers, shorts exposed circuits, removes water pressure, and creates work orders. Emergency prices increase with citywide demand, road accessibility, contractor inventory, and after-hours multipliers. Forecasts carry uncertainty, letting insulation, shutoff zoning, spares, and preventive action create real option value.

### 4.2 Visual state and shaders

Simulation stores causes (`moisture`, `UV`, `abrasion`, `corrosion`, `mold biomass`, `soiling`, `crack width`) in sparse surface tiles. It never stores “ugly = 0.7.” Compute passes advect moisture, grow stains from leak origins, accumulate footfall scuffs, and rasterize structural cracks along stress directions. Visual resolution may be higher than simulation resolution but samples the same fields.

```pseudo
SurfaceStateTile = {
  moisture, dirt, abrasion, mold, corrosion, uv_fade, crack_mask, repair_mask
}

shader(surface):
    age = sample(state_atlas, surface.uv2)
    albedo = lerp(new_albedo, faded_or_stained_albedo(age), masks(age))
    roughness = material.roughness_curve(age.abrasion, age.dirt, renovation_age)
    normal = blend(new_normal, peel_crack_normal(age), age.crack_mask)
    specular = physically_clamped(material.specular * finish_integrity(age))
    return weather_response(albedo, roughness, normal, surface.moisture)
```

Material instances use virtual-texture atlases and deterministic decals; distance selects aggregate masks, while close range reveals geometry/displacement. Renovation creates a work-progress mask, replaces relevant material state, records substrate defects that were not repaired, and transitions dust/wet finish/cure to final gloss. It does not merely swap a pristine texture at button press.

## 5. Core loop, UI, and progression

### 5.1 Core gameplay loop

```text
Observe market/building/people
  -> Diagnose causes and uncertainty
  -> Finance and prioritize
  -> Design/bid/schedule/negotiate
  -> Execute while occupants and markets continue
  -> Measure cash flow, safety, trust, and externalities
  -> Refinance/hold/sell/expand
```

The player is constrained by cash, credit, staff time, contractor capacity, permits, resident disruption, and information. Every major decision exposes forecast ranges and opportunity cost. Pausing planning does not fabricate perfect diagnosis; inspection quality controls knowledge.

### 5.2 Dashboard and read models

The UI uses query-only read models generated from events. It cannot mutate simulation state except through validated commands. The main shell contains portfolio KPIs and alerts; city view covers acquisition and policy; property view covers floors, tenants, systems, work; design view provides geometry and engineering; finance view covers ledgers, scenarios, and covenants.

| Overlay | Spatial source | Scale / legend | Drill-down |
|---|---|---|---|
| Satisfaction | tenant experienced events interpolated by occupied space | -100..100, confidence hatch | component history and attributable events |
| Structure | element utilization and deflection | demand/capacity ratio; >1 critical | loads, connections, proposed remediation |
| Wi-Fi | AP ray/portal propagation plus channel contention | RSSI, SNR, throughput percentile | path loss, clients, interference |
| Noise | octave-band exposure | dBA and sleep threshold | sources and transmission paths |
| Thermal/moisture | zone/surface fields | temperature, RH, water activity | envelope and HVAC contribution |
| Utilities | graph edge load/capacity | flow and protection state | upstream/downstream dependency |

Heatmaps render into 3D world-aligned volumes/surfaces and a 2D floor stack. Legends always display units, time window, min/max, threshold, freshness, and uncertainty. Color-blind palettes, patterns, and numeric inspection are mandatory. Selecting a hotspot traces causal edges (“3B cold because floor panel tripped because branch breaker was mis-rated”), with event-log evidence.

Wireless prediction uses band-specific wall loss, distance loss, AP power, antenna orientation, interference, airtime contention, and client capability. Coverage is not a painted radius. Background Monte Carlo shows p10/p50 throughput under occupant load.

### 5.3 Work orders, staffing, and execution

Tickets become diagnosed faults only after inspection. A work order is a dependency DAG of access, shutdown, demolition, repair, inspection, cure, and cleanup tasks. Each task requires skills, materials, tools, permits, and safe occupancy conditions. Dispatch solves a rolling constrained schedule; player overrides remain possible but expose overtime and SLA consequences.

```pseudo
priority(order) = expected_safety_loss(order.delay)
                + expected_asset_damage(order.delay)
                + tenant_habitability_penalty(order.delay)
                + regulatory/SLA_penalty(order.delay)
                - dispatch_and_disruption_cost(order)
```

### 5.4 Progression from duplex to skyscraper

Progression unlocks organizational capacity and complexity, not arbitrary stat bonuses. Define portfolio complexity:

\[
C=0.5\sqrt{units}+2floors^{0.7}+4systems+3jurisdictions+5mixedUse+8\,highRiseRisk
\]

Managerial capacity is `K = staff_skill_hours × process_maturity × software_automation`. If `C/K > 1`, inspection latency, missed tasks, accounting errors, and response times rise smoothly. Delegation therefore becomes necessary but never removes oversight.

| Phase | Typical scope | New decisions | Graduation evidence |
|---|---|---|---|
| Owner-operator | 2-unit duplex | rent, simple repairs, first mortgage | 12 months solvent, habitability compliance |
| Small portfolio | 8–40 units | staff/contractors, preventive plans, refinance | stable DSCR, reserves, tenant trust |
| Multifamily | 50–250 units | elevators, central plant, capex phasing, unions | audited operations, incident readiness |
| Regional | several assets | shared services, concentration, acquisitions | delegated SLAs, diversified liquidity |
| High-rise/mixed-use | 20–50 stories | vertical transport, life safety, demand charges | engineering certification and capital stack |
| Institutional sandbox | city influence | development, policy, funds, systemic risk | open-ended, scenario-scored play |

Pacing uses capability gates with multiple proofs, not XP alone:

```pseudo
readiness(next_tier) = min(
    finance_score(DSCR_history, liquidity, audit_accuracy),
    operations_score(SLA, preventive_ratio, incident_rate),
    trust_score(retention, fair_housing, complaint_resolution),
    engineering_score(inspections, code, resilience_drills))

if readiness >= tier.threshold and player_accepts_risk:
    expose_deals(next_tier)       // not free ownership
    unlock_staff_roles_and_tools(next_tier)
```

Deal flow gradually broadens through reputation, broker relationships, and lender confidence. A player may attempt large assets early with expensive partners, restrictive debt, and limited diligence; the game permits failure. Scenario directors target a band of liquidity stress and operational load by changing *offers and exogenous events*, never by secretly changing component failure probabilities after purchase.

### 5.5 Accounting, analytics, and anti-exploit rules

Every currency movement is double-entry. Asset costs capitalize or expense according to explicit rules. The dashboard reconciles cash, accrual NOI, taxable income, and lender NOI rather than collapsing them. Forecasts run cloned deterministic worlds with distinct scenario IDs.

Anti-exploit invariants:

* Saving/reloading cannot reroll an event because randomness is keyed to identity and tick.
* Splitting/merging rooms does not reset wear; surface state maps by world-space provenance.
* Selling to affiliates does not create valid comparables; beneficial ownership is traced.
* Repeated breaker reset, eviction cycling, and deferred work retain physical/legal history.
* Offline aggregation conserves money, energy proxies, inventory, condition, and scheduled events.

## 6. Service boundaries and implementation plan

### 6.1 Runtime modules

| Module | Owns | Publishes |
|---|---|---|
| `CitySim` | district stocks, zoning, migration, sector economy | market/policy/weather-demand events |
| `PropertyMarket` | listings, comps, auctions, valuations | bids, sale, appraisal events |
| `Finance` | ledger, banks, loans, tax, credit | payment/covenant/default events |
| `BuildingCore` | B-rep revisions, spaces, derivation graph | geometry/code-change events |
| `Structure` | elements, loads, damage | deflection/failure/unsafe events |
| `MEP` | utility topology and component state | outage/leak/failure events |
| `Agents` | beliefs, needs, plans, household finances | action, exposure, complaint events |
| `Environment` | weather fields and envelope exposure | storm/temperature/moisture events |
| `Maintenance` | tickets, work DAGs, labor/inventory | diagnosis/task/repair events |
| `Presentation` | read models, LODs, UI, audio, VFX | commands only; no domain ownership |

### 6.2 Persistence and performance budgets

Entity components are schema-versioned and chunked by district/building. Hot SoA arrays serve utility, exposure, and agent ticks; relational IDs preserve durable references. Geometry and content definitions are content-addressed. Snapshots are copy-on-write; migrations are deterministic and tested against golden saves.

Per active high-rise target at normal speed: coarse structure <2 ms after a dirty edit, utilities <2 ms/minute tick, 1,000 agents amortized <4 ms/frame, acoustic propagation <1 ms with path cache, read-model/heatmap updates <2 ms. Expensive valuation and Monte Carlo jobs run in deterministic worker batches and commit at declared tick boundaries. Degradation is updated analytically from last-update time where no threshold event occurs.

### 6.3 Verification strategy

* **Unit/property tests:** accounting balances, graph conservation, trip selectivity, geometry manifoldness, monotonic material responses.
* **Golden replay:** identical command log produces byte-identical daily state hashes across save/load and worker counts.
* **Scenario tests:** freeze-to-burst-to-claim chain, pillar removal and shoring, recession-to-default-to-auction, elevator congestion.
* **Monte Carlo calibration:** vacancy, rent, default, failure, and migration distributions match authored synthetic targets and later telemetry.
* **Fuzzing:** arbitrary edit sequences never commit non-manifold solids; malformed content cannot create negative money/energy stocks.
* **Explainability:** every KPI delta can trace to events, equations, inputs, and freshness; every AI action exposes top utility terms.

```pseudo
test deterministic_replay:
    A = simulate(seed=42, commands=fixture, workers=1)
    B = simulate(seed=42, commands=fixture, workers=16, save_reload_at=day(90))
    assert A.daily_state_hashes == B.daily_state_hashes

test electrical_selectivity:
    inject_short(unit="3B", circuit="kitchen")
    step_until_protection_settles()
    assert breaker("3B.kitchen").open
    assert breaker("floor.feeder").closed
    assert powered("3A")
```

## 7. Definition of production readiness

A vertical slice is ready when one district, one duplex, and one mid-rise support the complete causal loop: stochastic employment and rents; loan underwriting and monthly books; gridless edits; structural/load validation; routed power/water/HVAC; autonomous schedules and payments; weather-driven freeze damage; acoustic complaints; work-order repair; foreclosure auction; causal dashboard; deterministic replay. Content volume, skyscrapers, and visual fidelity scale only after those contracts, conservation tests, and profiler budgets pass.
