//! Bottom-up unit-cost map — `doc/JITA_INDEX_SEED_PLAN.md` §3.3.
//!
//! ```text
//! cost(type) = SUM( qty * cost(material) ) / outputPerRun   if type has a T1 blueprint
//!            = <the leaf ladder>                            otherwise
//!
//! leaf(type)  capture-first (default) : capture -> basePrice -> needs capture
//!             base-price-first        : basePrice -> capture -> needs capture
//! ```
//!
//! The capture rung is the price manifest: [`CostInputs::captures`] carries the `ccp-*`
//! entries the manifest already holds, so a leaf resolves once its one-time capture exists
//! and everything above it in the tree resolves with it. An empty [`CapturedLeafPrices`]
//! reproduces the pre-manifest behaviour exactly.
//!
//! **Only the leaf rung has two orders** ([`crate::config::LeafPriceSource`], plan §11). The
//! recursive expansion, the per-run divide, the cycle guard and [`CostMap::server_parity_eiv`]
//! are identical either way; "3x manufacturing cost" keeps its shape and only the value of
//! its inputs moves. The default is `capture-first` because the seed must charge for an input
//! exactly what it charges for that input as a product — see [`crate::config::LeafPriceSource`]
//! for the money pumps the other order opens.
//!
//! Four properties this module exists to guarantee:
//!
//! 1. **The per-run divide is mandatory.** 307 bucket-A products yield more than one unit
//!    per run (missiles are 100/run), so the blueprint's material value is a *run* value,
//!    not a unit price. Forgetting the divide is the plan's #1 way to ship absurd prices
//!    (§8.2).
//! 2. **Only T1-blueprint producers expand.** A material that is itself manufacturable T1
//!    recurses; everything else is a leaf. T2/faction materials are leaves *by design* —
//!    they have blueprints, but expanding them would price invented goods off their T1
//!    inputs and would contradict §2.5 ("never seeded" is not "never priced as an input",
//!    but their cost basis is their market price, not their build).
//! 3. **Needs-capture propagates.** A product whose tree contains any unpriced leaf is
//!    itself unpriced, and carries the set of leaf typeIDs responsible. An A∪B type that
//!    is still unpriced at build time is dropped and named rather than seeded at a guess
//!    (§4.1, see [`crate::seedplan`]), so the seeder has to be able to say exactly which
//!    leaves the one-time CCP capture (§4.2) must fetch.
//! 4. **Nothing ever resolves to 0.** A zero price would seed a free item. Every path that
//!    would produce 0 (no materials, all-zero material sum, absent basePrice) ends at
//!    `NeedsCapture` instead.
//!
//! Two costs coexist in this file and must not be confused:
//!
//! * [`CostMap::resolve`] — the **seeder's** unit cost, per-unit, deep, capture-aware.
//! * [`CostMap::server_parity_eiv`] — the **game's** job-tax EIV, per-run, one level deep,
//!   basePrice-only. It exists solely to diff against the Node server (plan §9's
//!   "sample-diff script Node vs Rust").

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::classify::{Producer, ProducerIndex};
use crate::config::{LeafPriceSource, PricingModel};
use crate::staticdata::{ReprocessingStatic, StaticData};

/// Where a resolved unit cost came from. `CostRecursive` and `BasePrice` are the two
/// price-manifest *local* `source` strings from plan §4.1 verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostSource {
    /// Expanded from the type's own T1 blueprint and divided by its per-run output.
    CostRecursive,
    /// Leaf priced at its SDE `basePrice`.
    BasePrice,
    /// Leaf priced from a `ccp-*` capture the manifest already holds. **Never written back
    /// to the manifest**: the capture entry already exists there and owns its own source
    /// and `capturedAt`, and captures are permanent (§4.3).
    Captured,
    /// Rule B: priced from the other side of this type's compressed/uncompressed pair.
    DerivedTwin,
    /// Rule C: lifted so that the type's ask covers what it reprocesses into.
    ReprocessingFloor,
}

impl CostSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::CostRecursive => "cost-recursive",
            Self::BasePrice => "base-price",
            Self::Captured => "ccp-capture",
            Self::DerivedTwin => "derived-compressed-twin",
            Self::ReprocessingFloor => "reprocessing-floor",
        }
    }
}

/// The `ccp-*` prices the manifest holds, as the cost map's third leaf rung.
///
/// Deliberately a plain typeID → price map rather than the manifest itself: the cost map
/// must not care which capture source a price came from, only that one exists.
#[derive(Debug, Clone, Default)]
pub struct CapturedLeafPrices {
    prices: HashMap<u32, f64>,
}

impl CapturedLeafPrices {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ignores anything that is not a finite positive price — a captured zero would seed a
    /// free item just as surely as a missing one would.
    pub fn insert(&mut self, type_id: u32, price: f64) {
        if price.is_finite() && price > 0.0 {
            self.prices.insert(type_id, price);
        }
    }

    pub fn get(&self, type_id: u32) -> Option<f64> {
        self.prices.get(&type_id).copied()
    }

    pub fn contains(&self, type_id: u32) -> bool {
        self.prices.contains_key(&type_id)
    }

    pub fn len(&self) -> usize {
        self.prices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.prices.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (u32, f64)> + '_ {
        self.prices.iter().map(|(type_id, price)| (*type_id, *price))
    }
}

impl FromIterator<(u32, f64)> for CapturedLeafPrices {
    fn from_iter<T: IntoIterator<Item = (u32, f64)>>(iter: T) -> Self {
        let mut captures = Self::default();
        for (type_id, price) in iter {
            captures.insert(type_id, price);
        }
        captures
    }
}

/// Unit prices a piece-8 rule imposes on the ladder, keyed by typeID.
///
/// Used twice, and the two are applied differently — see [`CostMap::resolve`]:
///
/// * **twins** (rule B) *replace* whatever the ladder would have said, including
///   `NeedsCapture`, because the whole point is that a compressed pair has one price and it
///   does not matter which side the number was read off;
/// * **floors** (rule C) are a `max` over an already-resolved price, because "its ask must
///   cover its reprocessing outputs" is a lower bound, not a valuation.
///
/// Both are computed once per run and then held fixed for the lifetime of a [`CostMap`], so
/// memoisation stays sound.
#[derive(Debug, Clone, Default)]
pub struct OverridePrices {
    prices: HashMap<u32, f64>,
}

impl OverridePrices {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ignores anything that is not a finite positive price, on the same grounds as
    /// [`CapturedLeafPrices::insert`]: a zero override would seed a free item.
    pub fn insert(&mut self, type_id: u32, price: f64) {
        if price.is_finite() && price > 0.0 {
            self.prices.insert(type_id, price);
        }
    }

    pub fn get(&self, type_id: u32) -> Option<f64> {
        self.prices.get(&type_id).copied()
    }

    pub fn contains(&self, type_id: u32) -> bool {
        self.prices.contains_key(&type_id)
    }

    pub fn len(&self) -> usize {
        self.prices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.prices.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (u32, f64)> + '_ {
        self.prices.iter().map(|(type_id, price)| (*type_id, *price))
    }
}

impl FromIterator<(u32, f64)> for OverridePrices {
    fn from_iter<T: IntoIterator<Item = (u32, f64)>>(iter: T) -> Self {
        let mut overrides = Self::default();
        for (type_id, price) in iter {
            overrides.insert(type_id, price);
        }
        overrides
    }
}

/// The result of resolving one type.
#[derive(Debug, Clone, PartialEq)]
pub enum CostOutcome {
    Priced {
        /// ISK per **unit** (never per run).
        unit_cost: f64,
        source: CostSource,
    },
    /// No local price exists. `missing_leaves` is the set of leaf typeIDs whose absent
    /// `basePrice` blocked this type — the exact shopping list for the §4.2 CCP capture.
    NeedsCapture { missing_leaves: BTreeSet<u32> },
}

impl CostOutcome {
    pub fn unit_cost(&self) -> Option<f64> {
        match self {
            Self::Priced { unit_cost, .. } => Some(*unit_cost),
            Self::NeedsCapture { .. } => None,
        }
    }

    pub fn is_priced(&self) -> bool {
        matches!(self, Self::Priced { .. })
    }

    pub fn source(&self) -> Option<CostSource> {
        match self {
            Self::Priced { source, .. } => Some(*source),
            Self::NeedsCapture { .. } => None,
        }
    }

    /// Histogram key: `cost-recursive`, `base-price` or `needs-capture`.
    pub fn source_label(&self) -> &'static str {
        match self {
            Self::Priced { source, .. } => source.label(),
            Self::NeedsCapture { .. } => "needs-capture",
        }
    }

    pub fn missing_leaves(&self) -> &BTreeSet<u32> {
        static EMPTY: BTreeSet<u32> = BTreeSet::new();
        match self {
            Self::Priced { .. } => &EMPTY,
            Self::NeedsCapture { missing_leaves } => missing_leaves,
        }
    }
}

/// A traversal that re-entered a type already on the stack. Real SDE data is expected to
/// contain none of these; any hit is reported rather than swallowed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostCycle {
    /// The type the traversal re-entered.
    pub type_id: u32,
    /// The traversal stack at the moment of re-entry, outermost first.
    pub path: Vec<u32>,
}

/// The immutable side of a cost resolution. `Copy` so a recursive `&mut self` method can
/// hold a snapshot of it without borrowing the [`CostMap`].
#[derive(Debug, Clone, Copy)]
pub struct CostInputs<'a> {
    pub data: &'a StaticData,
    pub producers: &'a ProducerIndex,
    pub invention_lineage: &'a HashSet<u32>,
    /// Captured `ccp-*` prices from the price manifest (§4). Empty means "no manifest",
    /// which is the piece-3 behaviour: every price-less leaf blocks its whole tree.
    pub captures: &'a CapturedLeafPrices,
    pub model: PricingModel,
    /// Which of the two leaf rungs is tried first (plan §11). Affects [`CostMap::resolve`]
    /// only through [`CostMap`]'s leaf ladder — never the expansion or the parity EIV.
    pub leaf_source: LeafPriceSource,
    /// Rule B, `[index_seed] derive_compressed_from_source`: the one price a
    /// compressed/uncompressed pair shares. **Replaces** the ladder for both sides. Empty
    /// when the rule is off, which reproduces the piece-7 behaviour exactly.
    pub twins: &'a OverridePrices,
    /// Rule C, `[index_seed] floor_cost_at_reprocessing_value`: the lowest cost whose **ask**
    /// still covers what the type refines into, i.e. `reprocess_value / sell_multiplier`
    /// plus a margin. Applied as a **lower bound** on whatever else priced the type. Empty
    /// when the rule is off.
    pub floors: &'a OverridePrices,
}

impl<'a> CostInputs<'a> {
    /// `max(0, basePrice)`, matching the server's `getFallbackTypePrice`
    /// (`industryPricing.js:40-43`). A missing, negative or non-finite basePrice is 0,
    /// which is what makes a type an unpriced leaf.
    pub fn base_price(self, type_id: u32) -> f64 {
        let raw = self
            .data
            .item_type(type_id)
            .and_then(|item| item.base_price)
            .unwrap_or(0.0);
        if raw.is_finite() && raw > 0.0 { raw } else { 0.0 }
    }

    /// The producing blueprint of a type **iff** the type is manufacturable T1 and may
    /// therefore be expanded (plan §3.3, sharing the three T1 signals with the bucket-A
    /// rules in `classify`).
    ///
    /// Deliberately *not* filtered on published/market-group membership: intermediate
    /// components are legitimate cost inputs whether or not they are seeded themselves.
    /// Deliberately *stops* at T2/T3 and faction/storyline/officer/deadspace materials —
    /// they have blueprints, but under this model they are leaves at basePrice.
    pub fn producer_for_expansion(self, type_id: u32) -> Option<&'a Producer> {
        let producer = self.producers.get(type_id)?;
        // Invention lineage, either way round: the blueprint was invented (so the product
        // is T2/T3), or the type is itself an invented blueprint.
        if self.invention_lineage.contains(&producer.blueprint_type_id)
            || self.invention_lineage.contains(&type_id)
        {
            return None;
        }
        if self.data.tech_level(type_id) >= 2 {
            return None;
        }
        if self
            .data
            .meta_group_id(type_id)
            .is_some_and(|meta_group| meta_group >= 3)
        {
            return None;
        }
        Some(producer)
    }

    /// The captured price for a type, if the manifest holds a usable one. A captured zero or
    /// NaN is no capture: it would seed a free item.
    pub fn capture_price(self, type_id: u32) -> Option<f64> {
        self.captures
            .get(type_id)
            .filter(|price| price.is_finite() && *price > 0.0)
    }

    /// The leaf ladder in one place, in the order [`CostInputs::leaf_source`] asks for.
    /// `None` means neither rung answered, which is a capture request, never a zero.
    pub fn leaf_price(self, type_id: u32) -> Option<(f64, CostSource)> {
        let base = self.base_price(type_id);
        let base_rung = (base > 0.0).then_some((base, CostSource::BasePrice));
        let capture_rung = self
            .capture_price(type_id)
            .map(|price| (price, CostSource::Captured));
        if self.leaf_source.prefers_capture() {
            capture_rung.or(base_rung)
        } else {
            base_rung.or(capture_rung)
        }
    }
}

/// Memoised bottom-up cost resolution over the blueprint dependency graph.
#[derive(Debug)]
pub struct CostMap<'a> {
    inputs: CostInputs<'a>,
    memo: HashMap<u32, CostOutcome>,
    stack: Vec<u32>,
    on_stack: HashSet<u32>,
    cycles: Vec<CostCycle>,
    /// Types whose producer claims a per-run output <= 0 (bad data). Treated as 1/run.
    nonpositive_per_run: BTreeSet<u32>,
    /// Types with a producer whose materials summed to 0 — no usable material rows at all.
    /// These fall back to the leaf ladder rather than resolving to a free item.
    empty_material_sum: BTreeSet<u32>,
    /// Every type the traversal ever asked the leaf ladder for — the capture request set
    /// (§4.2) under `capture-first`. See [`CostMap::leaves_seen`].
    leaves_seen: BTreeSet<u32>,
}

impl<'a> CostMap<'a> {
    pub fn new(inputs: CostInputs<'a>) -> Self {
        Self {
            inputs,
            memo: HashMap::new(),
            stack: Vec::new(),
            on_stack: HashSet::new(),
            cycles: Vec::new(),
            nonpositive_per_run: BTreeSet::new(),
            empty_material_sum: BTreeSet::new(),
            leaves_seen: BTreeSet::new(),
        }
    }

    pub fn inputs(&self) -> CostInputs<'a> {
        self.inputs
    }

    pub fn model(&self) -> PricingModel {
        self.inputs.model
    }

    /// Cycles actually hit during resolution, in the order they were encountered.
    pub fn cycles(&self) -> &[CostCycle] {
        &self.cycles
    }

    pub fn nonpositive_per_run(&self) -> &BTreeSet<u32> {
        &self.nonpositive_per_run
    }

    pub fn empty_material_sum(&self) -> &BTreeSet<u32> {
        &self.empty_material_sum
    }

    /// Every type the leaf ladder was consulted for while resolving whatever has been
    /// resolved so far — i.e. **every leaf reachable from the resolved roots**, including the
    /// three non-obvious ways a type becomes a leaf: it has no expandable producer, it was cut
    /// by the cycle guard, or its blueprint summed to no materials.
    ///
    /// This is the capture request set of plan §4.2 under `capture-first`: a leaf's cost *is*
    /// its captured price there, so every leaf that feeds a seeded type needs one, not merely
    /// the ones `basePrice` cannot price. Membership does not depend on which prices exist —
    /// nothing in the traversal branches on a price — so the set a run computes is the
    /// permanent shopping list, not "what is still missing today".
    pub fn leaves_seen(&self) -> &BTreeSet<u32> {
        &self.leaves_seen
    }

    pub fn memoized(&self) -> usize {
        self.memo.len()
    }

    /// Resolve one type's unit cost.
    ///
    /// The full order, which is the piece-8 apply order (A settles the captures the ladder
    /// can see, then B, then C — each rule depends on the previous one being settled):
    ///
    /// ```text
    /// cost(T) = max( twin(T) if rule B priced T's compressed pair
    ///                else Σ(qty x cost(material)) / perRun   if T has a T1 blueprint
    ///                else the leaf ladder,
    ///                floor(T) if rule C computed one )
    /// ```
    ///
    /// Rule B sits **above** the blueprint expansion, not inside the leaf ladder, because 12
    /// of the 212 pairs (the ice ones) carry an SDE compression blueprint and would otherwise
    /// never reach the ladder at all.
    pub fn resolve(&mut self, type_id: u32) -> CostOutcome {
        debug_assert!(self.stack.is_empty(), "resolve must start from an empty stack");
        self.resolve_inner(type_id).0
    }

    /// Rule B: the price this type's compressed pair settled on, if any. Replaces everything
    /// below it.
    fn twin(&self, type_id: u32) -> Option<CostOutcome> {
        self.inputs
            .twins
            .get(type_id)
            .map(|unit_cost| CostOutcome::Priced {
                unit_cost,
                source: CostSource::DerivedTwin,
            })
    }

    /// Rule C: raise an already-priced outcome to its reprocessing floor when that is higher.
    ///
    /// A pure lookup — the floors were computed to a fixpoint before this map was built — so
    /// it can be applied on the cycle-cut path too without re-entering the traversal. It
    /// deliberately does **not** rescue a `NeedsCapture`: a floor is a lower bound on a
    /// price, not a substitute for having one, and an unpriceable type must stay unpriceable
    /// and be dropped by name (§4.1) rather than acquire a price by a side door.
    fn apply_floor(&self, type_id: u32, outcome: CostOutcome) -> CostOutcome {
        let CostOutcome::Priced { unit_cost, source } = outcome else {
            return outcome;
        };
        match self.inputs.floors.get(type_id) {
            Some(floor) if floor > unit_cost => CostOutcome::Priced {
                unit_cost: floor,
                source: CostSource::ReprocessingFloor,
            },
            _ => CostOutcome::Priced { unit_cost, source },
        }
    }

    /// The recursive worker. The `bool` reports whether the returned outcome depended on a
    /// cycle cut; such outcomes are **not** memoised, so the finished map does not depend
    /// on which type the traversal happened to enter first. (The server memoises these
    /// unconditionally — `industryPricing.js:175` — which is fine for a live cache but not
    /// for a committed, reviewable price manifest.)
    fn resolve_inner(&mut self, type_id: u32) -> (CostOutcome, bool) {
        if let Some(cached) = self.memo.get(&type_id) {
            return (cached.clone(), false);
        }

        // Cycle guard, mirroring `industryPricing.js:148-151`: a type already on the
        // traversal stack is valued as a leaf instead of recursing forever.
        if self.on_stack.contains(&type_id) {
            self.cycles.push(CostCycle {
                type_id,
                path: self.stack.clone(),
            });
            let cut = match self.twin(type_id) {
                Some(outcome) => outcome,
                None => self.leaf(type_id),
            };
            let cut = self.apply_floor(type_id, cut);
            return (cut, true);
        }

        // Rule B, above the expansion: both sides of a compressed pair carry one price, and
        // for the 12 ice pairs the compressed side has a blueprint that would otherwise win.
        if let Some(outcome) = self.twin(type_id) {
            let outcome = self.apply_floor(type_id, outcome);
            self.memo.insert(type_id, outcome.clone());
            return (outcome, false);
        }

        let inputs = self.inputs;
        let Some(producer) = inputs.producer_for_expansion(type_id) else {
            let outcome = self.leaf(type_id);
            let outcome = self.apply_floor(type_id, outcome);
            self.memo.insert(type_id, outcome.clone());
            return (outcome, false);
        };

        self.stack.push(type_id);
        self.on_stack.insert(type_id);

        let per_run = if producer.per_run > 0 {
            producer.per_run
        } else {
            self.nonpositive_per_run.insert(type_id);
            1
        };

        let mut run_value = 0.0_f64;
        let mut missing_leaves: BTreeSet<u32> = BTreeSet::new();
        let mut used_cycle_cut = false;

        for material in &producer.materials {
            // Same guards as the server: a zero/negative typeID or quantity contributes
            // nothing (`industryPricing.js:158-162`).
            let quantity = material.quantity.max(0);
            if material.type_id == 0 || quantity <= 0 {
                continue;
            }
            let outcome = match inputs.model {
                PricingModel::Recursive => {
                    let (outcome, cut) = self.resolve_inner(material.type_id);
                    used_cycle_cut |= cut;
                    outcome
                }
                // shallow_eiv: one level only. Materials are never expanded, whatever they
                // are — that is the whole point of the parity mode (plan §3.3).
                PricingModel::ShallowEiv => self.leaf(material.type_id),
            };
            match outcome {
                CostOutcome::Priced { unit_cost, .. } => {
                    run_value += unit_cost * quantity as f64;
                }
                CostOutcome::NeedsCapture {
                    missing_leaves: leaves,
                } => {
                    missing_leaves.extend(leaves);
                }
            }
        }

        self.on_stack.remove(&type_id);
        self.stack.pop();

        let outcome = if !missing_leaves.is_empty() {
            // Requirement 3 of the module docs: one unpriced leaf anywhere in the tree
            // makes the whole product unpriced, and the leaves travel with the outcome.
            CostOutcome::NeedsCapture { missing_leaves }
        } else if run_value > 0.0 {
            CostOutcome::Priced {
                unit_cost: run_value / per_run as f64,
                source: CostSource::CostRecursive,
            }
        } else {
            // A blueprint with no usable material rows. The server falls back to a
            // basePrice here (`industryPricing.js:171-173`); so do we, and where there is
            // no basePrice either the type needs a capture rather than costing nothing.
            self.empty_material_sum.insert(type_id);
            self.leaf(type_id)
        };
        let outcome = self.apply_floor(type_id, outcome);

        if !used_cycle_cut {
            self.memo.insert(type_id, outcome.clone());
        }
        (outcome, used_cycle_cut)
    }

    /// The leaf ladder, in [`CostInputs::leaf_source`] order, recording the request.
    ///
    /// Plan §3.3 originally fixed the order at `basePrice` then capture; plan §11 (open
    /// question 10) asked whether raw materials should come off the market instead. Piece 7
    /// answers it with a knob whose default is the capture — see
    /// [`crate::config::LeafPriceSource`] for why — and the old order stays reachable so the
    /// two can be measured against each other.
    ///
    /// Neither rung may return 0: a zero leaf seeds a free item, so a leaf with no usable
    /// price on either rung is a capture request naming itself.
    fn leaf(&mut self, type_id: u32) -> CostOutcome {
        self.leaves_seen.insert(type_id);
        match self.inputs.leaf_price(type_id) {
            Some((unit_cost, source)) => CostOutcome::Priced { unit_cost, source },
            None => CostOutcome::NeedsCapture {
                missing_leaves: BTreeSet::from([type_id]),
            },
        }
    }

    /// The **game's** estimated item value for one run of this type's blueprint: a port of
    /// `resolveBlueprintActivityPrice` (`server/src/services/industry/industryPricing.js:136-178`)
    /// as `quoteIndustryJob` evaluates it for job tax.
    ///
    /// * one level deep — the server recurses on material typeIDs *as blueprint typeIDs*,
    ///   and no material typeID is a blueprint typeID (0 of 27,062 references), so every
    ///   material is valued at its own `basePrice`;
    /// * materials at `max(0, basePrice)` with `max(0, quantity)`;
    /// * **no per-run divide** — this INTENTIONALLY differs from [`CostMap::resolve`] and
    ///   both pricing modes. The server taxes a job per run, so a 100-per-run missile
    ///   blueprint has an EIV of the whole run. Dividing here would quietly destroy the
    ///   Node-vs-Rust diff this function exists for;
    /// * a material sum of 0 falls back to the type's own `basePrice`.
    ///
    /// One documented divergence: the game calls the function with the **blueprint**
    /// typeID, so its zero-sum fallback is the *blueprint's* basePrice. This port is keyed
    /// by product typeID (the seeder has no blueprint-side universe), so its fallback is
    /// the product's basePrice. The two agree everywhere the material sum is positive,
    /// which is the entire clean-EIV class the parity check cares about; the divergent
    /// class is counted by [`CostMap::server_parity_eiv_detail`].
    pub fn server_parity_eiv(&self, type_id: u32) -> f64 {
        self.server_parity_eiv_detail(type_id).0
    }

    /// [`CostMap::server_parity_eiv`] plus whether the zero-material-sum fallback fired
    /// (the one arm where this port and the Node original can disagree).
    pub fn server_parity_eiv_detail(&self, type_id: u32) -> (f64, bool) {
        let inputs = self.inputs;
        // Note the producer lookup is *unfiltered*: the server knows nothing about tech
        // level or metaGroup, it just reads the blueprint's material list.
        let materials = inputs
            .producers
            .get(type_id)
            .map(|producer| producer.materials.as_slice())
            .unwrap_or(&[]);

        let mut sum = 0.0_f64;
        for material in materials {
            let quantity = material.quantity.max(0);
            if material.type_id == 0 || quantity <= 0 {
                continue;
            }
            sum += inputs.base_price(material.type_id) * quantity as f64;
        }

        if sum > 0.0 {
            (sum, false)
        } else {
            (inputs.base_price(type_id), true)
        }
    }
}

/// A finished cost report over a set of types — the shape the `cost` subcommand prints and
/// the price-manifest generator (piece 4) will consume.
#[derive(Debug, Default)]
pub struct CostReport {
    /// Resolved outcome per requested type.
    pub outcomes: BTreeMap<u32, CostOutcome>,
    /// leaf typeID → how many requested types it blocks.
    pub blocked_by_leaf: BTreeMap<u32, usize>,
}

impl CostReport {
    /// Resolves every type in `type_ids`, accumulating the needs-capture blame map.
    pub fn build(map: &mut CostMap<'_>, type_ids: impl IntoIterator<Item = u32>) -> Self {
        let mut report = Self::default();
        for type_id in type_ids {
            let outcome = map.resolve(type_id);
            for leaf in outcome.missing_leaves() {
                *report.blocked_by_leaf.entry(*leaf).or_insert(0) += 1;
            }
            report.outcomes.insert(type_id, outcome);
        }
        report
    }

    pub fn count_with_label(&self, label: &str) -> usize {
        self.outcomes
            .values()
            .filter(|outcome| outcome.source_label() == label)
            .count()
    }

    /// Priced types as `(type_id, unit_cost)`, ascending by cost.
    pub fn priced_sorted_by_cost(&self) -> Vec<(u32, f64)> {
        let mut priced = self
            .outcomes
            .iter()
            .filter_map(|(type_id, outcome)| {
                outcome.unit_cost().map(|unit_cost| (*type_id, unit_cost))
            })
            .collect::<Vec<_>>();
        priced.sort_by(|left, right| {
            left.1
                .partial_cmp(&right.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.0.cmp(&right.0))
        });
        priced
    }

    /// Leaves ordered by how many requested types they block, most blocking first.
    pub fn leaves_by_blast_radius(&self) -> Vec<(u32, usize)> {
        let mut leaves = self
            .blocked_by_leaf
            .iter()
            .map(|(type_id, count)| (*type_id, *count))
            .collect::<Vec<_>>();
        leaves.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
        leaves
    }

    /// Priced types whose unit cost is not a finite positive number. Must always be empty:
    /// a zero or NaN price would seed a free or unmarshalable order.
    pub fn degenerate_prices(&self) -> Vec<(u32, f64)> {
        self.outcomes
            .iter()
            .filter_map(|(type_id, outcome)| outcome.unit_cost().map(|cost| (*type_id, cost)))
            .filter(|(_, cost)| !cost.is_finite() || *cost <= 0.0)
            .collect()
    }
}

// ------------------------------------------------------------------ the piece-8 pipeline

/// Rules B and C, run in order, plus what each of them did.
#[derive(Debug, Default)]
pub struct PricingRules {
    pub twins: OverridePrices,
    pub floors: OverridePrices,
    /// `None` when `[index_seed] derive_compressed_from_source = false`.
    pub twin_report: Option<TwinDerivation>,
    /// `None` when `[index_seed] floor_cost_at_reprocessing_value = false`.
    pub floor_report: Option<ReprocessingFloorOutcome>,
}

impl PricingRules {
    /// True when rule C hit its pass cap with types still rising — the caller must say so
    /// rather than shipping a half-relaxed price set.
    pub fn floor_diverged(&self) -> bool {
        self.floor_report
            .as_ref()
            .is_some_and(|floor| !floor.converged)
    }
}

/// Runs the piece-8 rules against a natural cost ladder and returns the overrides they
/// produce. **The order is the contract**, and it is why this lives in one function:
///
/// 1. **A** is already settled by the time we get here — it decided which captures
///    `base.captures` contains at all ([`crate::manifest::CapturePolicy`]), because B has to
///    know which side of a pair holds a *real* price before it can prefer it, and C must not
///    floor anything against CCP's industry index.
/// 2. **B** equalises each compressed pair, which is also what rescues an untraded raw ore
///    from its traded twin — so it must run before C, or C would floor the ore against a
///    price B is about to replace.
/// 3. **C** floors what is left. It sees B's prices, so a compressed pair is floored as one.
///
/// `base` must carry empty `twins` and `floors`.
pub fn apply_pricing_rules(
    base: CostInputs<'_>,
    reprocessing: &ReprocessingStatic,
    roots: &BTreeSet<u32>,
    seed_captures: &CapturedLeafPrices,
    floor_ask: FloorAsk<'_>,
    derive_compressed_from_source: bool,
    floor_cost_at_reprocessing_value: bool,
    max_passes: usize,
) -> PricingRules {
    let mut rules = PricingRules::default();

    if derive_compressed_from_source {
        let derivation = derive_compressed_twins(base, &reprocessing.compressed_by_source);
        rules.twins = derivation.overrides.clone();
        rules.twin_report = Some(derivation);
    }

    if floor_cost_at_reprocessing_value {
        let floored = compute_reprocessing_floors(
            CostInputs {
                twins: &rules.twins,
                ..base
            },
            reprocessing,
            roots,
            seed_captures,
            floor_ask,
            max_passes,
        );
        rules.floors = floored.floors.clone();
        rules.floor_report = Some(floored);
    }

    rules
}

// ------------------------------------------------------- rule B: compressed/uncompressed

/// Two market captures for the same pair that do not agree — the arbitrage rule B closes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TwinDisagreement {
    pub source_type: u32,
    pub compressed_type: u32,
    pub source_price: f64,
    pub compressed_price: f64,
}

impl TwinDisagreement {
    /// How far apart the two sides were, always >= 1.
    pub fn ratio(&self) -> f64 {
        let (low, high) = if self.source_price <= self.compressed_price {
            (self.source_price, self.compressed_price)
        } else {
            (self.compressed_price, self.source_price)
        };
        if low > 0.0 { high / low } else { f64::INFINITY }
    }
}

/// What rule B did, in enough detail to review it.
#[derive(Debug, Clone, Default)]
pub struct TwinDerivation {
    /// The prices to hand to [`CostInputs::twins`].
    pub overrides: OverridePrices,
    pub pairs_total: usize,
    /// Pairs where at least one side had a number to share.
    pub pairs_priced: usize,
    /// Pairs where neither side had any price at all: nothing to propagate, both stay
    /// unpriced and get dropped by name like any other unpriceable type.
    pub pairs_unpriceable: usize,
    /// Pairs where **both** sides hold a real market capture.
    pub pairs_both_captured: usize,
    /// … of which the two captures disagreed. Every one of these was an open arbitrage.
    pub pairs_disagreed: usize,
    /// The worst disagreement found, by ratio.
    pub worst_disagreement: Option<TwinDisagreement>,
    /// Sides whose price this rule moved.
    pub sides_repriced: usize,
    /// … of which had no price at all before: the untraded raw ores rescued by their traded
    /// compressed twin, and vice versa.
    pub sides_rescued: usize,
    /// … and of which had no market capture of their own, so their old price was an SDE
    /// constant (or nothing) and their new one is a real market price read off the twin.
    /// This is the piece-7 audit's class 3 — untraded moon and exotic ores — being pulled
    /// onto the market by the side of the pair people actually trade.
    pub sides_off_the_sde: usize,
}

/// Rule B — `[index_seed] derive_compressed_from_source`.
///
/// Compression in this game is 1:1 in both directions (`compressInventoryItem` retypes the
/// stack with `outputQuantity: sourceQuantity`; gas decompression multiplies by an efficiency
/// capped at 1), and the two sides of every pair reprocess into the same materials per unit.
/// All 212 pairs at SDE 3396210 are 1:1 on both the refine-yield basis and the 12 pairs that
/// carry an SDE compression blueprint. Compression buys hauling volume, and the seed does not
/// model volume, so **any** per-unit price difference between the two sides is a pure
/// round-trip against the seed.
///
/// The pair therefore gets one price, taken from the first rung that answers:
///
/// | rung | `capture-first` (default)      | `base-price-first`             |
/// |------|--------------------------------|--------------------------------|
/// | 1    | the source ore's market capture| the source ore's `basePrice`   |
/// | 2    | the compressed twin's capture  | the compressed twin's `basePrice` |
/// | 3    | the source ore's `basePrice`   | the source ore's market capture|
/// | 4    | the compressed twin's `basePrice` | the compressed twin's capture |
///
/// The source ore always outranks its twin at the same rung, per the piece-8 brief. Only
/// sides whose price actually moves get an override, so a pair that already agreed is not
/// rewritten and does not churn the committed manifest.
///
/// `inputs` must carry **empty** `twins` and `floors`: this rule reads the natural ladder to
/// decide what it is changing, and the apply order is A → B → C.
pub fn derive_compressed_twins(
    inputs: CostInputs<'_>,
    compressed_by_source: &BTreeMap<u32, u32>,
) -> TwinDerivation {
    debug_assert!(
        inputs.twins.is_empty() && inputs.floors.is_empty(),
        "rule B reads the natural ladder; it must run before rules B and C are applied"
    );
    let mut result = TwinDerivation {
        pairs_total: compressed_by_source.len(),
        ..TwinDerivation::default()
    };
    // The natural price of each side, from the same traversal the seed uses — not the leaf
    // ladder alone, because the 12 ice pairs price their compressed side off a blueprint.
    let mut natural = CostMap::new(inputs);

    for (source, compressed) in compressed_by_source {
        let (source, compressed) = (*source, *compressed);
        let source_capture = inputs.capture_price(source);
        let compressed_capture = inputs.capture_price(compressed);
        let source_base = (inputs.base_price(source) > 0.0).then(|| inputs.base_price(source));
        let compressed_base =
            (inputs.base_price(compressed) > 0.0).then(|| inputs.base_price(compressed));

        if let (Some(left), Some(right)) = (source_capture, compressed_capture) {
            result.pairs_both_captured += 1;
            let disagreement = TwinDisagreement {
                source_type: source,
                compressed_type: compressed,
                source_price: left,
                compressed_price: right,
            };
            if (left - right).abs() > left.abs().max(right.abs()) * PRICE_EPSILON {
                result.pairs_disagreed += 1;
                if result
                    .worst_disagreement
                    .is_none_or(|worst| disagreement.ratio() > worst.ratio())
                {
                    result.worst_disagreement = Some(disagreement);
                }
            }
        }

        let ladder = if inputs.leaf_source.prefers_capture() {
            [source_capture, compressed_capture, source_base, compressed_base]
        } else {
            [source_base, compressed_base, source_capture, compressed_capture]
        };
        let Some(price) = ladder.into_iter().flatten().next() else {
            result.pairs_unpriceable += 1;
            continue;
        };
        result.pairs_priced += 1;
        // Was the price the pair settled on read off a real market capture, rather than the
        // SDE? Only then is a side that had no capture of its own being moved onto the market.
        let from_the_market = source_capture
            .or(compressed_capture)
            .is_some_and(|capture| (capture - price).abs() <= capture.abs() * PRICE_EPSILON);

        for (side, own_capture) in [(source, source_capture), (compressed, compressed_capture)] {
            let before = natural.resolve(side).unit_cost();
            let moves = match before {
                None => {
                    result.sides_rescued += 1;
                    true
                }
                Some(before) => (before - price).abs() > before.abs().max(price) * PRICE_EPSILON,
            };
            if moves {
                result.sides_repriced += 1;
                if own_capture.is_none() && from_the_market {
                    result.sides_off_the_sde += 1;
                }
                result.overrides.insert(side, price);
            }
        }
    }
    result
}

// ---------------------------------------------------------- rule C: reprocessing floor

/// Relative tolerance for "these two prices are the same number". Twelve significant digits
/// survive the manifest's JSON round trip, so anything closer than this is noise, and
/// treating it as a change would rewrite the committed file forever.
pub const PRICE_EPSILON: f64 = 1e-9;

/// Both sides of the trade rule C has to close, as the seed actually prices them, plus the
/// headroom the floor keeps above the resulting equality.
///
/// Rule C exists to close audit check 1, and check 1 is a comparison between two *seed
/// prices*, not between two costs:
///
/// ```text
/// outlay  = ask(T)                            = sell_multiplier(T) × cost(T)
/// revenue = Σ (qty / portionSize) × bid(mat)   = Σ (qty / portionSize) × buy_multiplier(mat) × cost(mat)
/// ```
///
/// so the condition to satisfy is `sell_multiplier(T) × cost(T) ≥ revenue`, and the smallest
/// cost that satisfies it is `revenue / sell_multiplier(T)`. Neither multiplier is a fudge
/// factor: together they are the change of variables between the cost basis rule C computes
/// in and the price basis check 1 compares in.
///
/// **Every multiplier is per row**, because the seed has two of each: A∪B rows are priced by
/// `[index_seed] sell_multiplier`/`buy_multiplier` and bucket-D junk rows by the
/// `[junk_seed]` pair (`crate::build::plan_seed_rows` splits on exactly this predicate).
/// The two sides are keyed on **different** types on purpose — the ask is the candidate's
/// own, while each unit of revenue is paid at the bid of the *material* that produced it.
/// That distinction is not academic: a bucket-D junk module recycles into minerals, which are
/// bucket-B index rows, so keying the buy side on the candidate would misprice precisely the
/// junk class this rule was extended to cover. At `buy_multiplier = 1` everywhere — today's
/// shipped default — every form of this collapses to the same number.
#[derive(Debug, Clone, Copy)]
pub struct FloorAsk<'a> {
    /// `[index_seed] sell_multiplier` — the ask multiplier for every A∪B row.
    pub index_sell_multiplier: f64,
    /// `[index_seed] buy_multiplier` — the bid multiplier for every A∪B row.
    pub index_buy_multiplier: f64,
    /// `[junk_seed] sell_multiplier` — the ask multiplier for every bucket-D row.
    pub junk_sell_multiplier: f64,
    /// `[junk_seed] buy_multiplier` — the bid multiplier for every bucket-D row.
    pub junk_buy_multiplier: f64,
    /// The A∪B set (`crate::classify::Classification::union_ab`). A type outside it is a
    /// bucket-D junk row and takes the junk pair.
    pub index_types: &'a BTreeSet<u32>,
    /// `[index_seed] reprocessing_floor_margin` — the fraction of headroom the floor keeps
    /// above the exact `ask == revenue` equality so float noise cannot flip check 1's strict
    /// comparison. 0 is legal and means exact equality.
    pub margin: f64,
}

impl FloorAsk<'_> {
    /// Rule C with the whole seed off: every multiplier 1, no margin. The floor then equals
    /// the raw reprocessing value, which is the pre-fix behaviour and is only ever what a
    /// caller wants when there is no seed markup to divide out.
    pub fn unscaled(index_types: &BTreeSet<u32>) -> FloorAsk<'_> {
        FloorAsk {
            index_sell_multiplier: 1.0,
            index_buy_multiplier: 1.0,
            junk_sell_multiplier: 1.0,
            junk_buy_multiplier: 1.0,
            index_types,
            margin: 0.0,
        }
    }

    /// A multiplier that can be multiplied or divided by. Non-finite or non-positive degrades
    /// to 1 — the un-scaled behaviour, which is the safe direction — though the config
    /// validator rejects those long before they get here.
    fn usable(multiplier: f64) -> f64 {
        if multiplier.is_finite() && multiplier > 0.0 {
            multiplier
        } else {
            1.0
        }
    }

    /// The multiplier that will set this type's **ask** — the outlay side of check 1.
    pub fn sell_multiplier(&self, type_id: u32) -> f64 {
        Self::usable(if self.index_types.contains(&type_id) {
            self.index_sell_multiplier
        } else {
            self.junk_sell_multiplier
        })
    }

    /// The multiplier that will set this type's **bid** — what the seed pays for one unit of
    /// it as a refine output, i.e. the revenue side of check 1.
    pub fn buy_multiplier(&self, type_id: u32) -> f64 {
        Self::usable(if self.index_types.contains(&type_id) {
            self.index_buy_multiplier
        } else {
            self.junk_buy_multiplier
        })
    }

    /// The lowest cost whose ask still covers `refine_revenue`, with the margin on top:
    /// `refine_revenue / sell_multiplier(T) x (1 + margin)`.
    ///
    /// `refine_revenue` is already in **bid** units — see
    /// [`crate::cost::compute_reprocessing_floors`], which folds each material's own
    /// [`FloorAsk::buy_multiplier`] in as it accumulates.
    pub fn floor_for(&self, type_id: u32, refine_revenue: f64) -> f64 {
        let margin = if self.margin.is_finite() && self.margin >= 0.0 {
            self.margin
        } else {
            0.0
        };
        refine_revenue / self.sell_multiplier(type_id) * (1.0 + margin)
    }
}

/// How many relaxation passes rule C may take before the run gives up and says so.
///
/// The fixpoint is monotone — floors only ever rise, and every cost is non-decreasing in the
/// floors — so it terminates on any acyclic reprocessing graph, and the observed depth is a
/// handful of passes (`ore → mineral` is one hop; `moon ore → intermediate → composite` is
/// three or four). The cap exists for the case that would *not* terminate: a cycle in the
/// reprocessing graph whose round trip gains value, which is a genuine money pump in the
/// static data and must be reported rather than looped on.
pub const REPROCESSING_FLOOR_MAX_PASSES: usize = 24;

/// One type the floor lifted, and by how much.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FloorLift {
    pub type_id: u32,
    /// What the type cost before rule C ran.
    pub from: f64,
    /// The floor it was lifted to: `reprocess_value / sell_multiplier x (1 + margin)`, **not**
    /// the raw reprocessing value. The type's *ask* is what has to cover the refine revenue,
    /// so the ask is where the two meet, and this number is that ask divided back down into a
    /// cost.
    pub to: f64,
}

impl FloorLift {
    pub fn ratio(&self) -> f64 {
        if self.from > 0.0 {
            self.to / self.from
        } else {
            f64::INFINITY
        }
    }
}

/// What rule C did.
#[derive(Debug, Clone, Default)]
pub struct ReprocessingFloorOutcome {
    /// The prices to hand to [`CostInputs::floors`].
    pub floors: OverridePrices,
    /// Relaxation passes actually run. The last one is the one that changed nothing.
    pub passes: usize,
    /// False when the cap was hit with types still moving — a reported failure, never a
    /// silent one.
    pub converged: bool,
    /// Types whose price the floor lifted.
    pub lifted: usize,
    /// Every lift, worst ratio first.
    pub lifts: Vec<FloorLift>,
    /// Types still rising when the cap was reached. Empty on a converged run.
    pub still_moving: Vec<u32>,
    /// Candidates evaluated: seeded types with a usable reprocessing row.
    pub candidates: usize,
}

impl ReprocessingFloorOutcome {
    pub fn largest_lift(&self) -> Option<FloorLift> {
        self.lifts.first().copied()
    }
}

/// Rule C — `[index_seed] floor_cost_at_reprocessing_value`.
///
/// ```text
/// refine_revenue(T) = Σ( material.quantity × buy_multiplier(material) × cost(material) ) / portionSize
/// cost(T) := max( cost(T), refine_revenue(T) / sell_multiplier(T) × (1 + margin) )
/// ```
///
/// iterated to a fixpoint.
///
/// This is the mirror image of the rule the cost model is already built on. It prices a
/// manufactured product at what its inputs cost because the inputs can be turned into the
/// product; reprocessing runs the same conversion backwards, so buying a type must never be
/// cheaper than what comes out of it. Where the two disagree — an ore whose **ask** is below
/// what the seed's **bids** pay for the minerals inside it — the gap is exactly the profit of
/// buying the ore from the seed and selling the minerals straight back to it.
///
/// **Why the multipliers.** Audit check 1 compares two seed prices, `ask(T)` against
/// `Σ qty × bid(material) / portionSize`, so both sides have to be expressed in price units
/// before they can be compared and then converted back into the cost units the manifest
/// stores. That is the whole content of `× buy_multiplier` and `/ sell_multiplier`; see
/// [`FloorAsk`], including why the buy side is keyed on each material and the sell side on the
/// candidate.
///
/// Flooring `cost` at the raw `Σ qty × cost(material) / portionSize` instead — no multipliers
/// at all — asks for `sell_multiplier` times more than safety needs: it over-prices every
/// lifted type by that factor, and where the type also has a blueprint it can push the cost
/// above the ceiling audit check 2 imposes (`cost ≤ sell_multiplier × build_cost`), turning a
/// type with a perfectly feasible price window into a reported violation.
///
/// Only materials that have a resolvable cost contribute, which is also how the audit values
/// them: an output the seed does not price pays nothing on either side of the comparison.
///
/// The iteration is monotone (floors only rise, and a cost is non-decreasing in the floors),
/// so it terminates unless the reprocessing graph itself contains a cycle that gains value
/// *after* the divide; [`ReprocessingFloorOutcome::converged`] is false in that case and the
/// offending types are named. `inputs.floors` must be empty — this function computes them.
pub fn compute_reprocessing_floors(
    inputs: CostInputs<'_>,
    reprocessing: &ReprocessingStatic,
    roots: &BTreeSet<u32>,
    seed_captures: &CapturedLeafPrices,
    ask: FloorAsk<'_>,
    max_passes: usize,
) -> ReprocessingFloorOutcome {
    debug_assert!(
        inputs.floors.is_empty(),
        "rule C computes the floors; it must not be handed a previous run's"
    );
    let candidates = roots
        .iter()
        .filter_map(|type_id| reprocessing.get(*type_id))
        .filter(|entry| {
            entry.is_reprocessable() && entry.portion_size > 0 && !entry.materials.is_empty()
        })
        .collect::<Vec<_>>();

    let mut result = ReprocessingFloorOutcome {
        candidates: candidates.len(),
        ..ReprocessingFloorOutcome::default()
    };
    if candidates.is_empty() || max_passes == 0 {
        result.converged = true;
        return result;
    }

    let mut floors = OverridePrices::new();
    let mut baseline: BTreeMap<u32, f64> = BTreeMap::new();

    for pass in 1..=max_passes {
        result.passes = pass;
        let mut map = CostMap::new(CostInputs {
            floors: &floors,
            ..inputs
        });
        // Cost of every candidate and of everything any candidate refines into. The
        // materials are resolved even when they are not roots, because their price is what
        // the floor is made of.
        let mut cost: BTreeMap<u32, f64> = BTreeMap::new();
        let price_of = |map: &mut CostMap<'_>, type_id: u32| -> Option<f64> {
            // The **seed** price, in the piece-8 apply order — not simply the cost map's
            // answer, which differs from it in both directions:
            //
            // * rule B has already replaced one side of every disagreeing compressed pair,
            //   so its capture is no longer what that side is seeded at;
            // * a type that holds a market capture is seeded off that capture even when it
            //   has a blueprint (the merge prefers the capture, and 40-odd POS and structure
            //   types land here). Flooring its recursive build cost instead leaves exactly
            //   those types unfloored and their reprocess loop open.
            let base = match inputs.twins.get(type_id) {
                Some(twin) => twin,
                None => match seed_captures.get(type_id) {
                    Some(capture) => capture,
                    None => map.resolve(type_id).unit_cost()?,
                },
            };
            // A floor already imposed is part of the price by the next pass; `resolve`
            // applies it for the computed arm, so this only matters for the captured one.
            Some(match floors.get(type_id) {
                Some(floor) if floor > base => floor,
                _ => base,
            })
        };
        for index in 0..candidates.len() {
            let type_id = candidates[index].type_id;
            if let Some(price) = price_of(&mut map, type_id) {
                cost.insert(type_id, price);
            }
            for position in 0..candidates[index].materials.len() {
                let material = candidates[index].materials[position].type_id;
                if material == 0 || cost.contains_key(&material) {
                    continue;
                }
                if let Some(price) = price_of(&mut map, material) {
                    cost.insert(material, price);
                }
            }
        }
        if pass == 1 {
            baseline = cost.clone();
        }

        let mut rising: Vec<(u32, f64)> = Vec::new();
        for entry in &candidates {
            let portion = entry.portion_size as f64;
            // What the seed's **bids** pay for one unit's worth of refine outputs — the exact
            // revenue side of audit check 1, at perfect yield. Each material carries its own
            // bucket's `buy_multiplier`, because that is the row the player would be selling
            // into: a bucket-D junk module recycles into bucket-B minerals, so the candidate's
            // own multiplier is the wrong one to charge the outputs at.
            let mut refine_revenue = 0.0_f64;
            for material in &entry.materials {
                let quantity = material.quantity.max(0);
                if material.type_id == 0 || quantity <= 0 {
                    continue;
                }
                if let Some(unit_cost) = cost.get(&material.type_id) {
                    refine_revenue += unit_cost
                        * ask.buy_multiplier(material.type_id)
                        * quantity as f64
                        / portion;
                }
            }
            if !(refine_revenue.is_finite() && refine_revenue > 0.0) {
                continue;
            }
            // A type with no price of its own is left unpriced: a floor is a lower bound on
            // a price, not a way to conjure one (§4.1 — unpriceable types are dropped and
            // named, never guessed at).
            let Some(current) = cost.get(&entry.type_id).copied() else {
                continue;
            };
            // The floor is the *cost* whose ask covers that revenue, not the revenue itself —
            // see the function docs. Everything downstream (the fixpoint test, the lift report
            // and the override handed to `CostInputs::floors`) is in cost units, so the change
            // of variables happens exactly here and nowhere else.
            let floor = ask.floor_for(entry.type_id, refine_revenue);
            if !(floor.is_finite() && floor > 0.0) {
                continue;
            }
            if floor > current * (1.0 + PRICE_EPSILON) {
                rising.push((entry.type_id, floor));
            }
        }

        if rising.is_empty() {
            result.converged = true;
            break;
        }
        for (type_id, floor) in &rising {
            let lifted = floors.get(*type_id).map_or(*floor, |held| held.max(*floor));
            floors.insert(*type_id, lifted);
        }
        if pass == max_passes {
            result.still_moving = rising.into_iter().map(|(type_id, _)| type_id).collect();
        }
    }

    result.lifted = floors.len();
    result.lifts = floors
        .iter()
        .map(|(type_id, to)| FloorLift {
            type_id,
            from: baseline.get(&type_id).copied().unwrap_or(0.0),
            to,
        })
        .collect();
    result.lifts.sort_by(|left, right| {
        right
            .ratio()
            .partial_cmp(&left.ratio())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.type_id.cmp(&right.type_id))
    });
    result.floors = floors;
    result
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap as StdHashMap;
    use std::path::PathBuf;

    use super::*;
    use crate::staticdata::{
        BlueprintActivities, BlueprintActivity, BlueprintDefinition, DogmaProjection,
        InventionActivity, InventionProductEntry, ItemTypeRecord, MaterialEntry, ProductEntry,
    };

    const CATEGORY_SHIP: u32 = 6;
    const CATEGORY_MODULE: u32 = 7;
    const CATEGORY_CHARGE: u32 = 8;
    const CATEGORY_MATERIAL: u32 = 4;

    fn item(type_id: u32, category_id: u32, name: &str, base_price: f64) -> ItemTypeRecord {
        ItemTypeRecord {
            type_id,
            group_id: Some(1),
            category_id: Some(category_id),
            group_name: Some("Test Group".to_string()),
            name: name.to_string(),
            mass: None,
            volume: None,
            capacity: None,
            portion_size: None,
            race_id: None,
            base_price: Some(base_price),
            market_group_id: Some(1),
            icon_id: None,
            sound_id: None,
            graphic_id: None,
            radius: None,
            published: true,
        }
    }

    /// A type with no `basePrice` at all — the salvage/PI/gas shape that drives the whole
    /// needs-capture path (plan §3.2).
    fn unpriced_item(type_id: u32, category_id: u32, name: &str) -> ItemTypeRecord {
        let mut record = item(type_id, category_id, name, 0.0);
        record.base_price = None;
        record
    }

    fn activity(product_type_id: u32, per_run: i64, materials: &[(u32, i64)]) -> BlueprintActivity {
        BlueprintActivity {
            materials: materials
                .iter()
                .map(|(type_id, quantity)| MaterialEntry {
                    type_id: *type_id,
                    quantity: *quantity,
                })
                .collect(),
            products: vec![ProductEntry {
                type_id: product_type_id,
                quantity: per_run,
            }],
            time: Some(100),
        }
    }

    fn manufacturing(
        blueprint_type_id: u32,
        product_type_id: u32,
        per_run: i64,
        materials: &[(u32, i64)],
    ) -> BlueprintDefinition {
        BlueprintDefinition {
            blueprint_type_id,
            blueprint_name: format!("Blueprint {blueprint_type_id}"),
            // 0 on purpose: reaction rows carry 0 here and nothing may depend on it.
            product_type_id: 0,
            product_name: String::new(),
            max_production_limit: None,
            published: true,
            activities: BlueprintActivities {
                manufacturing: Some(activity(product_type_id, per_run, materials)),
                ..BlueprintActivities::default()
            },
        }
    }

    fn inventor(blueprint_type_id: u32, invented_blueprint_type_id: u32) -> BlueprintDefinition {
        BlueprintDefinition {
            blueprint_type_id,
            blueprint_name: format!("Blueprint {blueprint_type_id}"),
            product_type_id: 0,
            product_name: String::new(),
            max_production_limit: None,
            published: true,
            activities: BlueprintActivities {
                invention: Some(InventionActivity {
                    materials: Vec::new(),
                    products: vec![InventionProductEntry {
                        type_id: invented_blueprint_type_id,
                        quantity: 1,
                        probability: Some(0.3),
                    }],
                    time: Some(100),
                }),
                ..BlueprintActivities::default()
            },
        }
    }

    fn fixture(
        item_types: Vec<ItemTypeRecord>,
        blueprints: Vec<BlueprintDefinition>,
        dogma: Vec<(u32, DogmaProjection)>,
    ) -> StaticData {
        let mut item_types = item_types;
        item_types.sort_by_key(|item| item.type_id);
        let item_type_index = item_types
            .iter()
            .enumerate()
            .map(|(index, item)| (item.type_id, index))
            .collect::<StdHashMap<_, _>>();
        StaticData {
            dir: PathBuf::from("."),
            stations: Vec::new(),
            station_index: StdHashMap::new(),
            solar_systems: Vec::new(),
            solar_system_index: StdHashMap::new(),
            item_types,
            item_type_index,
            blueprints,
            dogma: dogma.into_iter().collect::<StdHashMap<_, _>>(),
        }
    }

    /// Builds the producer index + invention lineage the cost map needs, exactly the way
    /// `Classification::compute` does.
    struct Harness {
        producers: ProducerIndex,
        invention_lineage: HashSet<u32>,
        captures: CapturedLeafPrices,
        twins: OverridePrices,
        floors: OverridePrices,
    }

    impl Harness {
        /// Adds a manifest capture for a leaf, the way `refresh-prices` would.
        fn with_capture(mut self, type_id: u32, price: f64) -> Self {
            self.captures.insert(type_id, price);
            self
        }

        /// Pins a rule-B twin price, the way `derive_compressed_twins` would.
        fn with_twin(mut self, type_id: u32, price: f64) -> Self {
            self.twins.insert(type_id, price);
            self
        }

        /// Pins a rule-C floor, the way `compute_reprocessing_floors` would.
        fn with_floor(mut self, type_id: u32, price: f64) -> Self {
            self.floors.insert(type_id, price);
            self
        }

        fn new(data: &StaticData) -> Self {
            let producers = ProducerIndex::build(data);
            let mut invention_lineage = HashSet::new();
            for blueprint in &data.blueprints {
                let Some(invention) = blueprint.activities.invention.as_ref() else {
                    continue;
                };
                for product in &invention.products {
                    invention_lineage.insert(product.type_id);
                }
            }
            Self {
                producers,
                invention_lineage,
                captures: CapturedLeafPrices::new(),
                twins: OverridePrices::new(),
                floors: OverridePrices::new(),
            }
        }

        /// Defaults to the pre-piece-7 ladder so every test written against `basePrice`
        /// first keeps testing exactly that; `capture_first` opts into the new default.
        fn inputs<'a>(&'a self, data: &'a StaticData, model: PricingModel) -> CostInputs<'a> {
            self.inputs_with(data, model, LeafPriceSource::BasePriceFirst)
        }

        fn capture_first<'a>(
            &'a self,
            data: &'a StaticData,
            model: PricingModel,
        ) -> CostInputs<'a> {
            self.inputs_with(data, model, LeafPriceSource::CaptureFirst)
        }

        fn inputs_with<'a>(
            &'a self,
            data: &'a StaticData,
            model: PricingModel,
            leaf_source: LeafPriceSource,
        ) -> CostInputs<'a> {
            CostInputs {
                data,
                producers: &self.producers,
                invention_lineage: &self.invention_lineage,
                captures: &self.captures,
                model,
                leaf_source,
                twins: &self.twins,
                floors: &self.floors,
            }
        }
    }

    /// The three minerals a Venture is made of, at their SDE basePrices.
    fn minerals() -> Vec<ItemTypeRecord> {
        vec![
            item(34, CATEGORY_MATERIAL, "Tritanium", 2.0),
            item(35, CATEGORY_MATERIAL, "Pyerite", 8.0),
            item(36, CATEGORY_MATERIAL, "Mexallon", 32.0),
        ]
    }

    #[test]
    fn venture_anchor_resolves_to_134400_in_both_the_cost_map_and_server_parity() {
        // server/tests/industryManufacturingParity.test.js:667 — Venture EIV = 134,400:
        //   1750 x Mexallon (36) @ 32 =  56,000
        //   4200 x Pyerite  (35) @  8 =  33,600
        //  22400 x Tritanium(34) @  2 =  44,800
        // 1 unit per run, so the unit cost equals the EIV.
        let mut item_types = minerals();
        item_types.push(item(32880, CATEGORY_SHIP, "Venture", 300_000.0));
        let data = fixture(
            item_types,
            vec![manufacturing(
                32881,
                32880,
                1,
                &[(36, 1750), (35, 4200), (34, 22400)],
            )],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert_eq!(
            map.resolve(32880),
            CostOutcome::Priced {
                unit_cost: 134_400.0,
                source: CostSource::CostRecursive,
            }
        );
        assert_eq!(map.server_parity_eiv(32880), 134_400.0);
        // The Venture's own basePrice (300,000) must never leak into the cost: it has a
        // blueprint, so the blueprint wins.
        assert_ne!(map.resolve(32880).unit_cost(), Some(300_000.0));
        // 3x ask, per plan §3.3 / §9.
        assert_eq!(map.resolve(32880).unit_cost().unwrap() * 3.0, 403_200.0);

        // With no captures held, the leaf ladder's order cannot matter — both orders fall
        // through to basePrice. The anchor only moves once the minerals are captured, and
        // `server_parity_eiv` never moves at all (see the capture-first test below).
        let mut capture_first = CostMap::new(harness.capture_first(&data, PricingModel::Recursive));
        assert_eq!(capture_first.resolve(32880).unit_cost(), Some(134_400.0));
        assert_eq!(capture_first.server_parity_eiv(32880), 134_400.0);
    }

    #[test]
    fn per_run_output_is_divided_out_but_server_parity_keeps_the_whole_run() {
        // 100 units per run off 500 x Tritanium @ 2 = 1,000 ISK of materials.
        let mut item_types = minerals();
        item_types.push(item(200, CATEGORY_CHARGE, "Test Missile", 0.0));
        let data = fixture(
            item_types,
            vec![manufacturing(201, 200, 100, &[(34, 500)])],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert_eq!(map.resolve(200).unit_cost(), Some(10.0), "1000 / 100 per run");
        // The server does not divide — it taxes per run — so parity keeps the full 1,000.
        assert_eq!(map.server_parity_eiv(200), 1_000.0);

        // shallow_eiv divides too: it is one level deep, not per-run.
        let mut shallow = CostMap::new(harness.inputs(&data, PricingModel::ShallowEiv));
        assert_eq!(shallow.resolve(200).unit_cost(), Some(10.0));
    }

    #[test]
    fn a_manufacturable_material_expands_and_beats_its_own_base_price() {
        // Component 300 is manufacturable T1: 100 x Tritanium @ 2 = 200 per unit, while
        // its own basePrice is only 5. The product consumes 10 of them.
        //   recursive : 10 x 200 = 2,000
        //   shallow   : 10 x   5 =    50   (basePrice leaf, one level only)
        let mut item_types = minerals();
        item_types.push(item(300, CATEGORY_MATERIAL, "Test Component", 5.0));
        item_types.push(item(301, CATEGORY_SHIP, "Test Hull", 0.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(3001, 300, 1, &[(34, 100)]),
                manufacturing(3011, 301, 1, &[(300, 10)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);

        let mut recursive = CostMap::new(harness.inputs(&data, PricingModel::Recursive));
        assert_eq!(recursive.resolve(300).unit_cost(), Some(200.0));
        assert_eq!(recursive.resolve(301).unit_cost(), Some(2_000.0));

        let mut shallow = CostMap::new(harness.inputs(&data, PricingModel::ShallowEiv));
        assert_eq!(shallow.resolve(301).unit_cost(), Some(50.0));
        assert_ne!(
            recursive.resolve(301).unit_cost(),
            shallow.resolve(301).unit_cost(),
            "the whole point of the recursive model is that it differs here"
        );

        // The server's job-tax EIV agrees with the shallow value (basePrice leaves,
        // 1 per run), which is exactly the parity class plan §3.2 counts at 1,379.
        assert_eq!(recursive.server_parity_eiv(301), 50.0);
    }

    #[test]
    fn an_unpriced_leaf_makes_the_whole_product_unpriced_and_names_the_leaf() {
        // The rig shape from plan §3.2: salvage has no basePrice, so the rig cannot be
        // priced locally and the capture list must say which salvage type to fetch.
        let mut item_types = minerals();
        item_types.push(unpriced_item(400, CATEGORY_MATERIAL, "Burned Logic Circuit"));
        item_types.push(item(401, CATEGORY_MODULE, "Test Rig I", 0.0));
        let data = fixture(
            item_types,
            vec![manufacturing(4011, 401, 1, &[(34, 100), (400, 5)])],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert_eq!(
            map.resolve(401),
            CostOutcome::NeedsCapture {
                missing_leaves: BTreeSet::from([400]),
            }
        );
        assert_eq!(map.resolve(401).unit_cost(), None);
        // …and not zero. A zero here would seed a free rig.
        assert!(!map.resolve(401).is_priced());

        // Propagation is transitive: anything built from the rig is blocked by the same
        // leaf, with the leaf's identity preserved.
        let mut item_types = minerals();
        item_types.push(unpriced_item(400, CATEGORY_MATERIAL, "Burned Logic Circuit"));
        item_types.push(item(401, CATEGORY_MODULE, "Test Rig I", 0.0));
        item_types.push(item(402, CATEGORY_SHIP, "Rigged Hull", 0.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(4011, 401, 1, &[(34, 100), (400, 5)]),
                manufacturing(4021, 402, 1, &[(401, 3), (34, 10)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));
        assert_eq!(
            map.resolve(402),
            CostOutcome::NeedsCapture {
                missing_leaves: BTreeSet::from([400]),
            }
        );

        // The blame map counts both blocked products against the one leaf.
        let report = CostReport::build(&mut map, [401_u32, 402]);
        assert_eq!(report.blocked_by_leaf.get(&400), Some(&2));
        assert_eq!(report.count_with_label("needs-capture"), 2);
        assert!(report.degenerate_prices().is_empty());
    }

    #[test]
    fn a_captured_leaf_unblocks_everything_above_it() {
        // Same rig shape as above, but the manifest now holds a captured price for the
        // salvage. Capture 5 x 40 = 200, plus 100 x Tritanium @ 2 = 200, so the rig is 400 —
        // and the hull built from three rigs plus 10 Tritanium is 3 x 400 + 20 = 1,220.
        let mut item_types = minerals();
        item_types.push(unpriced_item(400, CATEGORY_MATERIAL, "Burned Logic Circuit"));
        item_types.push(item(401, CATEGORY_MODULE, "Test Rig I", 0.0));
        item_types.push(item(402, CATEGORY_SHIP, "Rigged Hull", 0.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(4011, 401, 1, &[(34, 100), (400, 5)]),
                manufacturing(4021, 402, 1, &[(401, 3), (34, 10)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data).with_capture(400, 40.0);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert_eq!(
            map.resolve(400),
            CostOutcome::Priced {
                unit_cost: 40.0,
                source: CostSource::Captured,
            }
        );
        assert_eq!(map.resolve(401).unit_cost(), Some(400.0));
        assert_eq!(map.resolve(402).unit_cost(), Some(1_220.0));

        let report = CostReport::build(&mut map, [400_u32, 401, 402]);
        assert_eq!(report.count_with_label("needs-capture"), 0);
        assert_eq!(report.count_with_label("ccp-capture"), 1);
        assert_eq!(report.count_with_label("cost-recursive"), 2);
        assert!(report.blocked_by_leaf.is_empty());
        assert!(report.degenerate_prices().is_empty());
    }

    #[test]
    fn base_price_first_keeps_the_sde_value_and_a_zero_capture_is_no_capture() {
        // The pre-piece-7 ladder, still reachable: cost -> basePrice -> capture.
        let mut item_types = minerals();
        item_types.push(unpriced_item(400, CATEGORY_MATERIAL, "Burned Logic Circuit"));
        let data = fixture(item_types, Vec::new(), Vec::new());

        let harness = Harness::new(&data).with_capture(34, 9_999.0);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));
        assert_eq!(
            map.resolve(34),
            CostOutcome::Priced {
                unit_cost: 2.0,
                source: CostSource::BasePrice,
            },
            "under base-price-first an SDE basePrice outranks the capture"
        );

        // A captured zero (or NaN) must not be accepted under either order: it would seed a
        // free item.
        let harness = Harness::new(&data).with_capture(400, 0.0);
        assert!(harness.captures.is_empty());
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));
        assert_eq!(
            map.resolve(400),
            CostOutcome::NeedsCapture {
                missing_leaves: BTreeSet::from([400]),
            }
        );
        let mut map = CostMap::new(harness.capture_first(&data, PricingModel::Recursive));
        assert_eq!(
            map.resolve(400),
            CostOutcome::NeedsCapture {
                missing_leaves: BTreeSet::from([400]),
            }
        );
    }

    #[test]
    fn capture_first_prices_a_leaf_off_the_market_and_carries_it_up_the_tree() {
        // Plan §11 resolved: the captured market price is the leaf's cost, and basePrice is
        // only the fallback. The Venture anchor is the measurable consequence — the ship is
        // 134,400 while its minerals sit at their SDE constants, and it moves the moment they
        // are valued at what the seed actually charges for them.
        let mut item_types = minerals();
        item_types.push(item(32880, CATEGORY_SHIP, "Venture", 300_000.0));
        let data = fixture(
            item_types,
            vec![manufacturing(
                32881,
                32880,
                1,
                &[(36, 1750), (35, 4200), (34, 22400)],
            )],
            Vec::new(),
        );
        // Tritanium captured at 5 (basePrice 2), Pyerite at 10 (8), Mexallon left uncaptured.
        let harness = Harness::new(&data).with_capture(34, 5.0).with_capture(35, 10.0);

        let mut map = CostMap::new(harness.capture_first(&data, PricingModel::Recursive));
        assert_eq!(
            map.resolve(34),
            CostOutcome::Priced {
                unit_cost: 5.0,
                source: CostSource::Captured,
            },
            "the capture outranks basePrice"
        );
        assert_eq!(
            map.resolve(36),
            CostOutcome::Priced {
                unit_cost: 32.0,
                source: CostSource::BasePrice,
            },
            "basePrice is still the fallback where no capture exists"
        );
        // 1750 x 32 + 4200 x 10 + 22400 x 5 = 56,000 + 42,000 + 112,000 = 210,000.
        assert_eq!(map.resolve(32880).unit_cost(), Some(210_000.0));

        // The game's job-tax EIV is basePrice-only and must NOT move with the leaf ladder:
        // it is the parity check against the server, not a seed price.
        assert_eq!(map.server_parity_eiv(32880), 134_400.0);

        let mut base_first = CostMap::new(harness.inputs(&data, PricingModel::Recursive));
        assert_eq!(base_first.resolve(32880).unit_cost(), Some(134_400.0));
        assert_eq!(base_first.server_parity_eiv(32880), 134_400.0);
    }

    #[test]
    fn the_leaf_set_is_every_leaf_reachable_and_does_not_move_with_the_prices() {
        // The capture request set under capture-first: not "leaves basePrice cannot price"
        // but every leaf the traversal touches, including the ones with a perfectly good
        // basePrice — those are exactly the ones whose cost basis capture-first changes.
        let mut item_types = minerals();
        item_types.push(item(300, CATEGORY_MATERIAL, "Test Component", 5.0));
        item_types.push(item(301, CATEGORY_SHIP, "Test Hull", 0.0));
        item_types.push(unpriced_item(400, CATEGORY_MATERIAL, "Burned Logic Circuit"));
        let data = fixture(
            item_types,
            vec![
                // 300 is manufacturable, so it expands and is NOT a leaf.
                manufacturing(3001, 300, 1, &[(34, 100)]),
                manufacturing(3011, 301, 1, &[(300, 10), (35, 2), (400, 1)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);

        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));
        map.resolve(301);
        assert_eq!(
            map.leaves_seen(),
            &BTreeSet::from([34, 35, 400]),
            "34 and 35 have basePrices and are still leaves; 300 expands and is not"
        );

        // Adding captures cannot change the set: nothing in the traversal branches on price.
        let priced = Harness::new(&data)
            .with_capture(34, 9.0)
            .with_capture(400, 40.0);
        let mut map = CostMap::new(priced.capture_first(&data, PricingModel::Recursive));
        map.resolve(301);
        assert_eq!(map.leaves_seen(), &BTreeSet::from([34, 35, 400]));

        // A cycle-cut type is a leaf too, and must appear in the shopping list.
        let mut item_types = minerals();
        item_types.push(item(500, CATEGORY_MATERIAL, "Widget A", 7.0));
        item_types.push(item(501, CATEGORY_MATERIAL, "Widget B", 11.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(5001, 500, 1, &[(501, 2), (34, 3)]),
                manufacturing(5011, 501, 1, &[(500, 2), (34, 5)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.capture_first(&data, PricingModel::Recursive));
        map.resolve(500);
        assert!(
            map.leaves_seen().contains(&500),
            "500 was cut by the cycle guard and valued as a leaf"
        );
        assert!(map.leaves_seen().contains(&34));
    }

    #[test]
    fn capture_first_is_the_default_and_shallow_eiv_uses_the_same_ladder() {
        let mut item_types = minerals();
        item_types.push(item(200, CATEGORY_CHARGE, "Test Missile", 0.0));
        let data = fixture(
            item_types,
            vec![manufacturing(201, 200, 100, &[(34, 500)])],
            Vec::new(),
        );
        let harness = Harness::new(&data).with_capture(34, 6.0);

        assert!(LeafPriceSource::default().prefers_capture());
        assert_eq!(LeafPriceSource::default().key(), "capture-first");

        // 500 x 6 / 100 per run = 30, against 500 x 2 / 100 = 10 on basePrice.
        let mut recursive = CostMap::new(harness.capture_first(&data, PricingModel::Recursive));
        assert_eq!(recursive.resolve(200).unit_cost(), Some(30.0));
        let mut shallow = CostMap::new(harness.capture_first(&data, PricingModel::ShallowEiv));
        assert_eq!(shallow.resolve(200).unit_cost(), Some(30.0));
        // …and the server's per-run, basePrice-only EIV is untouched by either.
        assert_eq!(recursive.server_parity_eiv(200), 1_000.0);
    }

    #[test]
    fn mutually_recursive_blueprints_terminate_and_report_the_cycle() {
        // Two blueprints each consuming the other's product. Without a cycle guard this
        // recurses until the stack dies.
        let mut item_types = minerals();
        item_types.push(item(500, CATEGORY_MATERIAL, "Widget A", 7.0));
        item_types.push(item(501, CATEGORY_MATERIAL, "Widget B", 11.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(5001, 500, 1, &[(501, 2), (34, 3)]),
                manufacturing(5011, 501, 1, &[(500, 2), (34, 5)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        // A(500) = 2 x B + 3 x Tritanium, where B is cut to its basePrice (11) on
        // re-entry: 2 x (2 x 7 + 5 x 2) + 3 x 2 = 2 x 24 + 6 = 54.
        let outcome = map.resolve(500);
        assert_eq!(outcome.unit_cost(), Some(54.0));
        assert!(outcome.unit_cost().unwrap().is_finite());

        assert_eq!(map.cycles().len(), 1, "the cycle must be reported, not hidden");
        assert_eq!(map.cycles()[0].type_id, 500);
        assert_eq!(map.cycles()[0].path, vec![500, 501]);

        // Cycle-cut results are not memoised, so entering from the other side is still
        // correct rather than inheriting the first traversal's cut.
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));
        // B(501) = 2 x A + 5 x Tritanium, A cut to basePrice 7 on re-entry:
        // 2 x (2 x 11 + 3 x 2) + 5 x 2 = 2 x 28 + 10 = 66.
        assert_eq!(map.resolve(501).unit_cost(), Some(66.0));
    }

    #[test]
    fn a_cycle_through_an_unpriced_leaf_needs_capture_instead_of_looping() {
        let mut item_types = minerals();
        item_types.push(unpriced_item(600, CATEGORY_MATERIAL, "Unpriced Widget A"));
        item_types.push(unpriced_item(601, CATEGORY_MATERIAL, "Unpriced Widget B"));
        let data = fixture(
            item_types,
            vec![
                manufacturing(6001, 600, 1, &[(601, 2)]),
                manufacturing(6011, 601, 1, &[(600, 2)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert_eq!(
            map.resolve(600),
            CostOutcome::NeedsCapture {
                missing_leaves: BTreeSet::from([600]),
            }
        );
        assert_eq!(map.cycles().len(), 1);
    }

    #[test]
    fn leaves_use_base_price_and_t2_materials_are_never_expanded() {
        // 700 is a T2 material: it has a blueprint (invented from 7001) and Tech Level 2.
        // Expanding it would price it at 100 x Tritanium = 200; the rule says it stays a
        // basePrice leaf at 9,000, so the product costs 2 x 9,000 = 18,000.
        let mut item_types = minerals();
        item_types.push(item(700, CATEGORY_MATERIAL, "T2 Widget", 9_000.0));
        item_types.push(item(701, CATEGORY_MODULE, "T1 Consumer", 0.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(7002, 700, 1, &[(34, 100)]),
                inventor(7001, 7002),
                manufacturing(7011, 701, 1, &[(700, 2)]),
            ],
            vec![(
                700,
                DogmaProjection {
                    tech_level: Some(2.0),
                    meta_group_id: Some(2),
                },
            )],
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert!(
            harness.producers.get(700).is_some(),
            "the T2 material does have a blueprint — that is the trap"
        );
        assert_eq!(
            map.resolve(700),
            CostOutcome::Priced {
                unit_cost: 9_000.0,
                source: CostSource::BasePrice,
            },
            "a T2 material is a basePrice leaf, never an expansion"
        );
        assert_eq!(map.resolve(701).unit_cost(), Some(18_000.0));

        // A plain leaf with no blueprint at all takes its basePrice.
        assert_eq!(
            map.resolve(34),
            CostOutcome::Priced {
                unit_cost: 2.0,
                source: CostSource::BasePrice,
            }
        );
    }

    #[test]
    fn faction_metagroup_materials_are_leaves_too() {
        let mut item_types = minerals();
        item_types.push(item(800, CATEGORY_MODULE, "Domination Widget", 5_000.0));
        item_types.push(item(801, CATEGORY_MODULE, "Consumer", 0.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(8002, 800, 1, &[(34, 100)]),
                manufacturing(8011, 801, 1, &[(800, 1)]),
            ],
            vec![(
                800,
                DogmaProjection {
                    tech_level: None,
                    meta_group_id: Some(4),
                },
            )],
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert_eq!(map.resolve(800).source(), Some(CostSource::BasePrice));
        assert_eq!(map.resolve(801).unit_cost(), Some(5_000.0));
    }

    #[test]
    fn a_blueprint_with_no_usable_materials_falls_back_instead_of_costing_nothing() {
        let mut item_types = minerals();
        item_types.push(item(900, CATEGORY_MODULE, "Materialless Product", 250.0));
        item_types.push(unpriced_item(901, CATEGORY_MODULE, "Materialless Unpriced"));
        let data = fixture(
            item_types,
            vec![
                manufacturing(9001, 900, 1, &[]),
                manufacturing(9011, 901, 1, &[(0, 5), (34, 0)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert_eq!(
            map.resolve(900),
            CostOutcome::Priced {
                unit_cost: 250.0,
                source: CostSource::BasePrice,
            }
        );
        assert_eq!(
            map.resolve(901),
            CostOutcome::NeedsCapture {
                missing_leaves: BTreeSet::from([901]),
            },
            "never 0"
        );
        assert_eq!(map.empty_material_sum().len(), 2);
        // The server's fallback arm agrees on the priced side.
        assert_eq!(map.server_parity_eiv(900), 250.0);
        assert!(map.server_parity_eiv_detail(900).1, "fallback arm fired");
    }

    #[test]
    fn negative_quantities_and_per_run_are_clamped_like_the_server() {
        let mut item_types = minerals();
        item_types.push(item(1000, CATEGORY_MODULE, "Odd Data Product", 0.0));
        let data = fixture(
            item_types,
            vec![manufacturing(10_001, 1000, -5, &[(34, 100), (35, -20)])],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        // The negative material row is skipped (max(0, quantity)) and the non-positive
        // per-run output is treated as 1 rather than flipping the price negative.
        assert_eq!(map.resolve(1000).unit_cost(), Some(200.0));
        assert!(map.nonpositive_per_run().contains(&1000));
        assert_eq!(map.server_parity_eiv(1000), 200.0);
    }

    #[test]
    fn memoisation_returns_the_same_answer_and_stops_re_walking_the_tree() {
        let mut item_types = minerals();
        item_types.push(item(1100, CATEGORY_MATERIAL, "Shared Component", 0.0));
        item_types.push(item(1101, CATEGORY_SHIP, "Consumer One", 0.0));
        item_types.push(item(1102, CATEGORY_SHIP, "Consumer Two", 0.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(11_001, 1100, 1, &[(34, 100)]),
                manufacturing(11_011, 1101, 1, &[(1100, 2)]),
                manufacturing(11_021, 1102, 1, &[(1100, 3)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));

        assert_eq!(map.resolve(1101).unit_cost(), Some(400.0));
        let memoized_after_first = map.memoized();
        assert_eq!(map.resolve(1102).unit_cost(), Some(600.0));
        assert_eq!(map.resolve(1101).unit_cost(), Some(400.0));
        assert!(map.memoized() >= memoized_after_first);
        assert_eq!(map.cycles().len(), 0);
    }

    #[test]
    fn the_report_ranks_costs_and_capture_blame() {
        let mut item_types = minerals();
        item_types.push(item(1200, CATEGORY_SHIP, "Cheap Hull", 0.0));
        item_types.push(item(1201, CATEGORY_SHIP, "Pricey Hull", 0.0));
        item_types.push(unpriced_item(1202, CATEGORY_MATERIAL, "Unpriced Salvage"));
        item_types.push(item(1203, CATEGORY_MODULE, "Blocked Rig", 0.0));
        let data = fixture(
            item_types,
            vec![
                manufacturing(12_001, 1200, 1, &[(34, 100)]),
                manufacturing(12_011, 1201, 1, &[(36, 100)]),
                manufacturing(12_031, 1203, 1, &[(1202, 1)]),
            ],
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let mut map = CostMap::new(harness.inputs(&data, PricingModel::Recursive));
        let report = CostReport::build(&mut map, [1200_u32, 1201, 1203, 34]);

        assert_eq!(report.count_with_label("cost-recursive"), 2);
        assert_eq!(report.count_with_label("base-price"), 1);
        assert_eq!(report.count_with_label("needs-capture"), 1);

        let priced = report.priced_sorted_by_cost();
        assert_eq!(priced.first().copied(), Some((34, 2.0)));
        assert_eq!(priced.last().copied(), Some((1201, 3_200.0)));

        assert_eq!(report.leaves_by_blast_radius(), vec![(1202, 1)]);
        assert!(report.degenerate_prices().is_empty());
    }

    // ------------------------------------------------------ rule B: compressed twins

    /// The pair shape the real data has, in miniature: an ore and its compressed twin, both
    /// refining into the same mineral at the same rate per unit, neither with a blueprint.
    fn ore_pair_data() -> StaticData {
        fixture(
            vec![
                item(34, CATEGORY_MATERIAL, "Tritanium", 2.0),
                item(1300, CATEGORY_MATERIAL, "Veldspar", 10.0),
                item(1301, CATEGORY_MATERIAL, "Compressed Veldspar", 250.0),
            ],
            Vec::new(),
            Vec::new(),
        )
    }

    fn ore_pair_map() -> BTreeMap<u32, u32> {
        BTreeMap::from([(1300_u32, 1301_u32)])
    }

    /// Refine rows for the pair: both sides yield 400 Tritanium per 100 units, which is what
    /// makes the 1:1 compression price-neutral in this game.
    fn ore_pair_reprocessing() -> ReprocessingStatic {
        ReprocessingStatic::new(
            vec![
                refine_row(1300, "Veldspar", 100, &[(34, 400)]),
                refine_row(1301, "Compressed Veldspar", 100, &[(34, 400)]),
            ],
            ore_pair_map(),
        )
    }

    fn refine_row(
        type_id: u32,
        name: &str,
        portion_size: i64,
        materials: &[(u32, i64)],
    ) -> crate::staticdata::ReprocessingType {
        crate::staticdata::ReprocessingType {
            type_id,
            name: name.to_string(),
            portion_size,
            is_refinable: true,
            is_recyclable: true,
            family: "test".to_string(),
            materials: materials
                .iter()
                .map(|(type_id, quantity)| crate::staticdata::ReprocessingMaterial {
                    type_id: *type_id,
                    quantity: *quantity,
                })
                .collect(),
        }
    }

    /// **Rule B.** Two captures that disagree collapse onto the source ore's, both sides come
    /// out at exactly one price, and the disagreement is reported rather than swallowed.
    #[test]
    fn a_compression_pair_converges_on_one_price_and_the_disagreement_is_reported() {
        let data = ore_pair_data();
        let harness = Harness::new(&data)
            .with_capture(1300, 12.0)
            .with_capture(1301, 300.0);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);

        // Before the rule: the two sides are 25x apart, which is a round trip against the
        // seed in one click.
        let mut before = CostMap::new(inputs);
        assert_eq!(before.resolve(1300).unit_cost(), Some(12.0));
        assert_eq!(before.resolve(1301).unit_cost(), Some(300.0));

        let derived = derive_compressed_twins(inputs, &ore_pair_map());
        assert_eq!(derived.pairs_total, 1);
        assert_eq!(derived.pairs_priced, 1);
        assert_eq!(derived.pairs_both_captured, 1);
        assert_eq!(derived.pairs_disagreed, 1);
        let worst = derived.worst_disagreement.expect("a disagreement was found");
        assert!((worst.ratio() - 25.0).abs() < 1e-9, "ratio {}", worst.ratio());
        assert_eq!(derived.sides_repriced, 1, "only the compressed side moves");
        assert_eq!(derived.sides_rescued, 0);

        let after_inputs = CostInputs {
            twins: &derived.overrides,
            ..inputs
        };
        let mut after = CostMap::new(after_inputs);
        assert_eq!(after.resolve(1300).unit_cost(), Some(12.0));
        assert_eq!(
            after.resolve(1301).unit_cost(),
            Some(12.0),
            "the compressed twin takes the source ore's captured price"
        );
        assert_eq!(after.resolve(1301).source(), Some(CostSource::DerivedTwin));
    }

    /// The rescue case from the piece-7 audit's class 3: an untraded raw ore with no capture
    /// and no `basePrice` is priced from its traded compressed twin instead of being dropped.
    #[test]
    fn an_untraded_ore_is_rescued_by_its_traded_compressed_twin() {
        let data = fixture(
            vec![
                unpriced_item(1300, CATEGORY_MATERIAL, "Untraded Ore"),
                unpriced_item(1301, CATEGORY_MATERIAL, "Compressed Untraded Ore"),
            ],
            Vec::new(),
            Vec::new(),
        );
        let harness = Harness::new(&data).with_capture(1301, 77.0);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);
        assert!(
            !CostMap::new(inputs).resolve(1300).is_priced(),
            "with no capture and no basePrice the raw ore is unpriceable on its own"
        );

        let derived = derive_compressed_twins(inputs, &ore_pair_map());
        assert_eq!(derived.sides_rescued, 1);
        assert_eq!(derived.pairs_both_captured, 0);
        let mut after = CostMap::new(CostInputs {
            twins: &derived.overrides,
            ..inputs
        });
        assert_eq!(after.resolve(1300).unit_cost(), Some(77.0));
        assert_eq!(after.resolve(1301).unit_cost(), Some(77.0));
    }

    /// A pair that already agrees is left alone: no override, so the committed manifest does
    /// not churn a source label for pairs that were never wrong.
    #[test]
    fn a_compression_pair_that_already_agrees_is_not_rewritten() {
        let data = ore_pair_data();
        let harness = Harness::new(&data)
            .with_capture(1300, 12.0)
            .with_capture(1301, 12.0);
        let derived = derive_compressed_twins(
            harness.capture_first(&data, PricingModel::Recursive),
            &ore_pair_map(),
        );
        assert_eq!(derived.pairs_both_captured, 1);
        assert_eq!(derived.pairs_disagreed, 0);
        assert_eq!(derived.sides_repriced, 0);
        assert!(derived.overrides.is_empty());
    }

    // ------------------------------------------------------ rule C: reprocessing floor

    /// The seed's shipped shape for rule C's tests: ask x3 / bid x1 on both bucket sets and
    /// 0.1% of margin, with every candidate an index (A∪B) row unless a test says otherwise.
    const TEST_SELL_MULTIPLIER: f64 = 3.0;
    const TEST_BUY_MULTIPLIER: f64 = 1.0;
    const TEST_MARGIN: f64 = 0.001;

    fn ask_for(index_types: &BTreeSet<u32>) -> FloorAsk<'_> {
        FloorAsk {
            index_sell_multiplier: TEST_SELL_MULTIPLIER,
            index_buy_multiplier: TEST_BUY_MULTIPLIER,
            junk_sell_multiplier: TEST_SELL_MULTIPLIER,
            junk_buy_multiplier: TEST_BUY_MULTIPLIER,
            index_types,
            margin: TEST_MARGIN,
        }
    }

    /// What rule C must produce for a type whose reprocessing outputs cost `value`, at the
    /// shipped multipliers (`buy_multiplier = 1`, so cost units and bid units coincide).
    fn expected_floor(value: f64) -> f64 {
        value * TEST_BUY_MULTIPLIER / TEST_SELL_MULTIPLIER * (1.0 + TEST_MARGIN)
    }

    /// **Rule C, one hop.** An ore whose *ask* is below the value of the mineral inside it is
    /// lifted until the ask covers it — not to the value itself — and the relaxation reaches a
    /// fixpoint on the next pass.
    #[test]
    fn the_reprocessing_floor_lifts_an_underpriced_ore_and_reaches_a_fixpoint() {
        let data = ore_pair_data();
        // 4 Tritanium per Veldspar at 2.0 each = 8.0 of minerals per ore unit. The ore is
        // captured at 1.0, so it sells for 3.0 and refining it pays 8.0: an open loop.
        let harness = Harness::new(&data)
            .with_capture(1300, 1.0)
            .with_capture(1301, 1.0)
            .with_capture(34, 2.0);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);
        let roots = BTreeSet::from([34_u32, 1300, 1301]);

        let floors = compute_reprocessing_floors(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            ask_for(&roots),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(floors.converged, "the relaxation must reach a fixpoint");
        assert_eq!(floors.passes, 2, "one pass to lift, one to confirm nothing moved");
        assert_eq!(floors.lifted, 2, "both sides of the pair refine identically");
        let largest = floors.largest_lift().expect("something was lifted");
        assert!(
            (largest.to - expected_floor(8.0)).abs() < 1e-9,
            "lifted to {} but the floor is 8.0 / 3 x 1.001 = {}",
            largest.to,
            expected_floor(8.0)
        );
        assert!(
            largest.to < 8.0,
            "flooring at the full reprocessing value would over-price the ore by the sell \
             multiplier: the ask, not the cost, is what has to cover the refine revenue"
        );
        // The property the floor exists for, stated as the audit states it: ask >= revenue.
        assert!(largest.to * TEST_SELL_MULTIPLIER >= 8.0);
        assert!((largest.ratio() - expected_floor(8.0)).abs() < 1e-9, "from 1.0");
        assert!(floors.still_moving.is_empty());

        let mut after = CostMap::new(CostInputs {
            floors: &floors.floors,
            ..inputs
        });
        assert_eq!(after.resolve(1300).unit_cost(), Some(expected_floor(8.0)));
        assert_eq!(
            after.resolve(1300).source(),
            Some(CostSource::ReprocessingFloor)
        );
        assert_eq!(
            after.resolve(34).unit_cost(),
            Some(2.0),
            "the mineral itself refines into nothing and is untouched"
        );

        // An ore whose ask already covers its contents is left alone even though its *cost*
        // does not — 5.0 costs less than the 8.0 inside it, but it sells for 15.0. This is
        // precisely the class the old `max(cost, reprocess_value)` formulation over-priced.
        let covered = Harness::new(&data)
            .with_capture(1300, 5.0)
            .with_capture(1301, 5.0)
            .with_capture(34, 2.0);
        let covered_inputs = covered.capture_first(&data, PricingModel::Recursive);
        let none = compute_reprocessing_floors(
            covered_inputs,
            &ore_pair_reprocessing(),
            &roots,
            &covered.captures,
            ask_for(&roots),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(none.converged);
        assert_eq!(
            none.lifted, 0,
            "3 x 5.0 = 15.0 already covers the 8.0 of minerals; nothing to close"
        );
        assert_eq!(none.passes, 1, "nothing moved on the first pass");
    }

    /// The margin is the only thing standing between the corrected floor and a float-noise
    /// violation, so it is asserted directly: 0 gives exact equality, and the default gives
    /// headroom that is strictly positive but far below the 8% transaction tax.
    #[test]
    fn the_floor_margin_is_the_headroom_over_exact_ask_revenue_equality() {
        let data = ore_pair_data();
        let harness = Harness::new(&data)
            .with_capture(1300, 1.0)
            .with_capture(1301, 1.0)
            .with_capture(34, 2.0);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);
        let roots = BTreeSet::from([34_u32, 1300, 1301]);

        let exact = compute_reprocessing_floors(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            FloorAsk {
                margin: 0.0,
                ..ask_for(&roots)
            },
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        let exact_floor = exact.floors.get(1300).expect("the ore was lifted");
        assert!(
            (exact_floor * TEST_SELL_MULTIPLIER - 8.0).abs() < 1e-9,
            "with no margin the ask lands exactly on the refine revenue: {}",
            exact_floor * TEST_SELL_MULTIPLIER
        );

        let margined = compute_reprocessing_floors(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            ask_for(&roots),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        let margined_floor = margined.floors.get(1300).expect("the ore was lifted");
        assert!(margined_floor > exact_floor, "the margin only ever adds");
        assert!(
            margined_floor * TEST_SELL_MULTIPLIER > 8.0,
            "and it puts the ask strictly above the revenue, which is what check 1 tests"
        );
        assert!(
            margined_floor < exact_floor * 1.08,
            "while staying far inside the 8% transaction tax the gate already requires"
        );
    }

    /// Every multiplier is chosen per row, and the two sides are keyed on different types.
    ///
    /// A bucket-D junk type is seeded at the `[junk_seed]` **ask**, so that is what its own
    /// floor divides by. But its refine outputs are sold into whatever bid *those* materials
    /// carry — a junk module recycles into minerals, which are bucket-B index rows — so the
    /// revenue side takes the material's bucket, not the candidate's.
    #[test]
    fn each_row_is_floored_against_its_own_bucket_and_its_materials_bids() {
        let data = ore_pair_data();
        let harness = Harness::new(&data)
            .with_capture(1300, 1.0)
            .with_capture(1301, 1.0)
            .with_capture(34, 2.0);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);
        let roots = BTreeSet::from([34_u32, 1300, 1301]);
        // 1300 and the Tritanium it refines into are index rows; 1301 is junk and sells at
        // x1.5 instead of x3. Both refine into 4 Tritanium per unit, i.e. 8.0 of cost.
        let index_types = BTreeSet::from([34_u32, 1300]);

        let floors = compute_reprocessing_floors(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            FloorAsk {
                index_sell_multiplier: 3.0,
                index_buy_multiplier: 1.0,
                junk_sell_multiplier: 1.5,
                junk_buy_multiplier: 7.0,
                index_types: &index_types,
                margin: 0.0,
            },
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(floors.converged);
        assert_eq!(floors.floors.get(1300), Some(8.0 * 1.0 / 3.0));
        assert_eq!(
            floors.floors.get(1301),
            Some(8.0 * 1.0 / 1.5),
            "the junk side divides by its own x1.5 ask, but its Tritanium is an INDEX row and \
             pays the x1 index bid — the absurd x7 junk bid must not touch this number"
        );

        // …and when the material really is junk, the junk bid is what it pays. Same graph,
        // Tritanium moved into bucket D.
        let minerals_are_junk = BTreeSet::from([1300_u32]);
        let floors = compute_reprocessing_floors(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            FloorAsk {
                index_sell_multiplier: 3.0,
                index_buy_multiplier: 1.0,
                junk_sell_multiplier: 1.5,
                junk_buy_multiplier: 7.0,
                index_types: &minerals_are_junk,
                margin: 0.0,
            },
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(floors.converged);
        assert_eq!(
            floors.floors.get(1300),
            Some(8.0 * 7.0 / 3.0),
            "the ore is still an index row (x3 ask) but its outputs now pay the x7 junk bid"
        );
        assert_eq!(floors.floors.get(1301), Some(8.0 * 7.0 / 1.5));
    }

    /// **The buy side, pinned.** Rule C's floor has to stay exact under *any* multiplier pair,
    /// not just at the shipped `buy_multiplier = 1.0`. Raising the bid multiplier raises what
    /// the seed pays for a refine output, so it raises the revenue check 1 measures — and the
    /// floor has to rise with it or the loop reopens.
    ///
    /// The counterfactual is pinned the way 29659's is: the same book, floored the sell-only
    /// way, is run through the real `check_reprocess` and must report the violation.
    #[test]
    fn a_raised_buy_multiplier_keeps_check_1_clean_and_reopens_it_under_a_sell_only_divide() {
        use crate::audit::{PERFECT_YIELD, SeedBook, check_reprocess};
        use crate::build::{SeedPricing, SeedRow};

        const ORE: u32 = 1300;
        const MINERAL: u32 = 34;
        const MINERAL_COST: f64 = 2_000.0;
        /// 400 Tritanium per 100 units of ore = 4 per unit, so 8,000.00 of cost per ore unit.
        const REFINE_COST_VALUE: f64 = 8_000.0;
        const SELL: f64 = 3.0;
        const BUY: f64 = 2.0;

        let data = fixture(
            vec![
                item(MINERAL, CATEGORY_MATERIAL, "Tritanium", 1.0),
                item(ORE, CATEGORY_MATERIAL, "Veldspar", 1.0),
                item(1301, CATEGORY_MATERIAL, "Compressed Veldspar", 1.0),
            ],
            Vec::new(),
            Vec::new(),
        );
        let harness = Harness::new(&data)
            .with_capture(MINERAL, MINERAL_COST)
            .with_capture(ORE, 1_000.0)
            .with_capture(1301, 1_000.0);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);
        let roots = BTreeSet::from([MINERAL, ORE, 1301_u32]);
        let reprocessing = ore_pair_reprocessing();

        let exact = |margin: f64| FloorAsk {
            index_sell_multiplier: SELL,
            index_buy_multiplier: BUY,
            junk_sell_multiplier: SELL,
            junk_buy_multiplier: BUY,
            index_types: &roots,
            margin,
        };

        let floors = compute_reprocessing_floors(
            inputs,
            &reprocessing,
            &roots,
            &harness.captures,
            exact(TEST_MARGIN),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(floors.converged);
        let floor = floors.floors.get(ORE).expect("the ore must be lifted");
        assert!(
            (floor - REFINE_COST_VALUE * BUY / SELL * (1.0 + TEST_MARGIN)).abs() < 1e-9,
            "floor {floor} is not revenue x buy / sell x (1 + margin)"
        );
        // The sell-only floor is exactly half of it, because the bid multiplier is 2.
        let sell_only = REFINE_COST_VALUE / SELL * (1.0 + TEST_MARGIN);
        assert!((floor - 2.0 * sell_only).abs() < 1e-9);

        // ------------------------------------------------------ check 1, on the real book
        let pricing = SeedPricing {
            sell_multiplier: SELL,
            buy_multiplier: BUY,
            // Zeroed on purpose: `price_floor` lifts asks and only ever helps, so leaving it
            // in would mask whether the floor itself is sufficient.
            price_floor: 0.0,
        };
        let rows = |ore_cost: f64| -> Vec<SeedRow> {
            [
                (ORE, "Veldspar", ore_cost),
                (MINERAL, "Tritanium", MINERAL_COST),
            ]
            .into_iter()
            .map(|(type_id, name, cost)| SeedRow {
                type_id,
                name: name.to_string(),
                bucket: "B",
                junk: false,
                cost,
                ask: pricing.ask(cost),
                bid: pricing.bid(cost),
                sides: crate::seedplan::SeedSides::BOTH,
                quantity: 1,
            })
            .collect()
        };

        let book = SeedBook::from_rows(&rows(floor), &crate::build::test_station());
        let clean = check_reprocess(&book, &reprocessing, PERFECT_YIELD);
        assert_eq!(
            clean.violation_count(),
            0,
            "check 1 must stay closed at buy x{BUY}: {:?}",
            clean.violations.first().map(|v| v.loop_text.clone())
        );

        // The counterfactual: the same data floored the old sell-only way reopens the loop,
        // and by the full factor of the bid multiplier.
        let reopened = SeedBook::from_rows(&rows(sell_only), &crate::build::test_station());
        let violations = check_reprocess(&reopened, &reprocessing, PERFECT_YIELD);
        assert_eq!(
            violations.violation_count(),
            1,
            "dividing by sell_multiplier alone leaves the ore's ask covering only half the \
             revenue once the seed pays x{BUY} for its minerals"
        );
        let worst = violations.worst_ratio().expect("one violation");
        assert!(
            (worst - BUY / (1.0 + TEST_MARGIN)).abs() < 1e-9,
            "and the loop pays the whole bid multiplier over, less the margin the sell-only \
             floor still carried: x{worst}"
        );
        assert_eq!(violations.violations[0].type_id, ORE);
        assert!(
            violations.violations[0].survives_tax(),
            "x{worst} clears the 8% tax, so this would have gated the build"
        );
    }

    /// **Rule C, deep chain.** `moon ore -> intermediate -> composite`: lifting the
    /// intermediate has to propagate to the ore that refines into it, which is what the
    /// fixpoint is for. A single pass would leave the ore under-priced and the loop open.
    #[test]
    fn the_reprocessing_floor_propagates_up_a_deep_chain() {
        let data = fixture(
            vec![
                item(34, CATEGORY_MATERIAL, "Tritanium", 100.0),
                item(1400, CATEGORY_MATERIAL, "Composite", 1.0),
                item(1401, CATEGORY_MATERIAL, "Intermediate", 1.0),
                item(1402, CATEGORY_MATERIAL, "Moon Ore", 1.0),
            ],
            Vec::new(),
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let inputs = harness.inputs(&data, PricingModel::Recursive);
        // Composite refines into 1 Tritanium (100.0); Intermediate into 1 Composite;
        // Moon Ore into 1 Intermediate. Every link starts at basePrice 1.0.
        let reprocessing = ReprocessingStatic::new(
            vec![
                refine_row(1400, "Composite", 1, &[(34, 1)]),
                refine_row(1401, "Intermediate", 1, &[(1400, 1)]),
                refine_row(1402, "Moon Ore", 1, &[(1401, 1)]),
            ],
            BTreeMap::new(),
        );
        let roots = BTreeSet::from([34_u32, 1400, 1401, 1402]);

        let floors = compute_reprocessing_floors(
            inputs,
            &reprocessing,
            &roots,
            &harness.captures,
            ask_for(&roots),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(floors.converged);
        assert_eq!(floors.lifted, 3);
        assert_eq!(
            floors.passes, 4,
            "three hops to propagate the mineral's value, one to confirm the fixpoint"
        );

        let mut after = CostMap::new(CostInputs {
            floors: &floors.floors,
            ..inputs
        });
        // Each hop divides by the sell multiplier again, because each link's own ask is what
        // has to cover the link below it. The chain therefore decays instead of carrying the
        // full 100.0 up — and every link still satisfies `ask >= what it refines into`.
        let mut expected = 100.0;
        for type_id in [1400_u32, 1401, 1402] {
            expected = expected_floor(expected);
            let resolved = after
                .resolve(type_id)
                .unit_cost()
                .expect("every link in the chain is priced");
            assert!(
                (resolved - expected).abs() < 1e-9,
                "type {type_id} resolved to {resolved}, expected {expected}"
            );
            assert_eq!(
                after.resolve(type_id).source(),
                Some(CostSource::ReprocessingFloor)
            );
        }
        for (type_id, refines_into) in [
            (1400_u32, 100.0),
            (1401, expected_floor(100.0)),
            (1402, expected_floor(expected_floor(100.0))),
        ] {
            let ask = after.resolve(type_id).unit_cost().unwrap() * TEST_SELL_MULTIPLIER;
            assert!(
                ask >= refines_into,
                "type {type_id} sells for {ask} but refines into {refines_into}"
            );
        }
    }

    /// A value-gaining cycle in the reprocessing graph never terminates. The cap catches it,
    /// the run says so, and the offending types are named instead of the process spinning.
    #[test]
    fn a_value_gaining_reprocessing_cycle_is_detected_rather_than_looped_on() {
        let data = fixture(
            vec![
                item(1500, CATEGORY_MATERIAL, "Loop A", 10.0),
                item(1501, CATEGORY_MATERIAL, "Loop B", 10.0),
            ],
            Vec::new(),
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let inputs = harness.inputs(&data, PricingModel::Recursive);
        // Each side refines into four of the other. After the divide by the x3 ask that is
        // still a gain of 4/3 per hop, so a round trip multiplies the price by ~1.78 and no
        // finite fixpoint exists. (Note the divide matters here too: at two-for-one the same
        // graph *would* settle, because 2/3 < 1 — only a cycle that gains after the ask is
        // taken into account is a real money pump.)
        let reprocessing = ReprocessingStatic::new(
            vec![
                refine_row(1500, "Loop A", 1, &[(1501, 4)]),
                refine_row(1501, "Loop B", 1, &[(1500, 4)]),
            ],
            BTreeMap::new(),
        );
        let roots = BTreeSet::from([1500_u32, 1501]);

        let floors = compute_reprocessing_floors(
            inputs,
            &reprocessing,
            &roots,
            &harness.captures,
            ask_for(&roots),
            6,
        );
        assert!(!floors.converged, "a gaining cycle has no fixpoint to reach");
        assert_eq!(floors.passes, 6, "it stops at the cap rather than spinning");
        assert_eq!(
            floors.still_moving,
            vec![1500, 1501],
            "and names what was still rising"
        );

        // The same graph at two-for-one settles immediately: 2/3 of a price per hop is a
        // loss, so there is nothing to close and nothing to iterate on.
        let losing = ReprocessingStatic::new(
            vec![
                refine_row(1500, "Loop A", 1, &[(1501, 2)]),
                refine_row(1501, "Loop B", 1, &[(1500, 2)]),
            ],
            BTreeMap::new(),
        );
        let settled = compute_reprocessing_floors(
            inputs,
            &losing,
            &roots,
            &harness.captures,
            ask_for(&roots),
            6,
        );
        assert!(settled.converged);
        assert_eq!(settled.lifted, 0);
    }

    /// Apply order. B runs before C, so a pair is floored as one price rather than the floor
    /// being computed against a number B is about to replace. Each knob is measurable alone.
    #[test]
    fn the_rules_apply_in_order_b_then_c() {
        let data = ore_pair_data();
        let harness = Harness::new(&data)
            .with_capture(1300, 0.5)
            .with_capture(1301, 300.0)
            .with_capture(34, 2.0);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);
        let roots = BTreeSet::from([34_u32, 1300, 1301]);

        let rules = apply_pricing_rules(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            ask_for(&roots),
            true,
            true,
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(!rules.floor_diverged());
        let mut map = CostMap::new(CostInputs {
            twins: &rules.twins,
            floors: &rules.floors,
            ..inputs
        });
        // B collapses 300.0 onto 0.5, then C lifts both until their ask covers the 8.0 of
        // Tritanium inside them.
        assert_eq!(map.resolve(1300).unit_cost(), Some(expected_floor(8.0)));
        assert_eq!(map.resolve(1301).unit_cost(), Some(expected_floor(8.0)));

        // With only B the pair agrees but is still under-priced.
        let twins_only = apply_pricing_rules(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            ask_for(&roots),
            true,
            false,
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        let mut map = CostMap::new(CostInputs {
            twins: &twins_only.twins,
            floors: &twins_only.floors,
            ..inputs
        });
        assert_eq!(map.resolve(1300).unit_cost(), Some(0.5));
        assert_eq!(map.resolve(1301).unit_cost(), Some(0.5));

        // With only C the pair is floored but still far apart.
        let floor_only = apply_pricing_rules(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            ask_for(&roots),
            false,
            true,
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        let mut map = CostMap::new(CostInputs {
            twins: &floor_only.twins,
            floors: &floor_only.floors,
            ..inputs
        });
        assert_eq!(map.resolve(1300).unit_cost(), Some(expected_floor(8.0)));
        assert_eq!(map.resolve(1301).unit_cost(), Some(300.0));

        // Both off is the piece-7 behaviour, unchanged.
        let none = apply_pricing_rules(
            inputs,
            &ore_pair_reprocessing(),
            &roots,
            &harness.captures,
            ask_for(&roots),
            false,
            false,
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(none.twins.is_empty() && none.floors.is_empty());
        assert!(none.twin_report.is_none() && none.floor_report.is_none());
    }

    /// The floor is a bound on the **seed price**, not on the cost map.
    ///
    /// A type that holds a market capture is seeded off that capture even when it has a
    /// blueprint — the merge prefers the capture — so its recursive build cost is not what a
    /// player pays. Flooring the recursive number leaves the type unfloored whenever the
    /// build cost happens to exceed the reprocessing value, which is exactly the shape of the
    /// POS/structure arrays that survived the first cut of this rule.
    #[test]
    fn the_floor_binds_the_captured_seed_price_not_the_recursive_build_cost() {
        let data = fixture(
            vec![
                item(34, CATEGORY_MATERIAL, "Tritanium", 2.0),
                item(1700, CATEGORY_MODULE, "Assembly Array", 1.0),
            ],
            vec![manufacturing(17_001, 1700, 1, &[(34, 100)])],
            Vec::new(),
        );
        // The array is captured at 10 but recycles into 50 Tritanium — 100 ISK of it — while
        // its blueprint says building one costs 200.
        let harness = Harness::new(&data)
            .with_capture(34, 2.0)
            .with_capture(1700, 10.0);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);
        assert_eq!(
            CostMap::new(inputs).resolve(1700).unit_cost(),
            Some(200.0),
            "the cost map expands the blueprint and never sees the capture"
        );
        let reprocessing = ReprocessingStatic::new(
            vec![refine_row(1700, "Assembly Array", 1, &[(34, 50)])],
            BTreeMap::new(),
        );
        let roots = BTreeSet::from([34_u32, 1700]);

        let floors = compute_reprocessing_floors(
            inputs,
            &reprocessing,
            &roots,
            &harness.captures,
            ask_for(&roots),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(floors.converged);
        assert_eq!(
            floors.floors.get(1700),
            Some(expected_floor(100.0)),
            "buying at 3 x the captured 10 and recycling for 100 is the loop; the floor lifts \
             the cost until 3 x cost covers the 100, and no further"
        );

        // The proof that the basis is what matters: told (wrongly) that nothing is seeded off
        // a capture, the same data floors nothing, because 100 / 3 < the 200 build cost.
        let cost_basis = compute_reprocessing_floors(
            inputs,
            &reprocessing,
            &roots,
            &CapturedLeafPrices::new(),
            ask_for(&roots),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert_eq!(cost_basis.lifted, 0);
    }

    /// The floor never prices a type that had no price: an unpriceable type stays unpriceable
    /// and is dropped by name (§4.1) rather than acquiring a price through a side door.
    #[test]
    fn the_reprocessing_floor_does_not_price_an_unpriceable_type() {
        let data = fixture(
            vec![
                item(34, CATEGORY_MATERIAL, "Tritanium", 2.0),
                unpriced_item(1600, CATEGORY_MATERIAL, "Unpriceable Ore"),
            ],
            Vec::new(),
            Vec::new(),
        );
        let harness = Harness::new(&data);
        let inputs = harness.inputs(&data, PricingModel::Recursive);
        let reprocessing = ReprocessingStatic::new(
            vec![refine_row(1600, "Unpriceable Ore", 1, &[(34, 100)])],
            BTreeMap::new(),
        );
        let roots = BTreeSet::from([34_u32, 1600]);
        let floors = compute_reprocessing_floors(
            inputs,
            &reprocessing,
            &roots,
            &harness.captures,
            ask_for(&roots),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(floors.converged);
        assert_eq!(floors.lifted, 0);
        assert!(
            !CostMap::new(CostInputs {
                floors: &floors.floors,
                ..inputs
            })
            .resolve(1600)
            .is_priced()
        );
    }

    /// **29659 Unrefined Fluxed Condensates** — the one type the old formulation could not
    /// price, and the reason this rule was re-derived.
    ///
    /// Its numbers at SDE build 3396210, per unit:
    ///
    /// ```text
    /// reprocess_value = 3,781,531.66        build_cost = 1,064,288.71
    ///
    /// check 1 (reprocess) needs  ask >= reprocess_value
    ///                         => cost >= 3,781,531.66 / 3 = 1,260,510.55
    /// check 2 (manufacture) needs bid <= 3 x build_cost
    ///                         => cost <= 3 x 1,064,288.71 = 3,192,866.13
    /// ```
    ///
    /// So a feasible window exists — `[1,260,510.55 .. 3,192,866.13]` — and the corrected
    /// floor lands inside it with room to spare. The old `max(cost, reprocess_value)` put the
    /// cost at 3,781,531.66, *above* the ceiling, and the resulting check-2 violation was
    /// mistaken for a structural impossibility. It was not: the loop is run against the
    /// **ask**, and comparing the refine revenue against `cost` asks for three times the
    /// price safety needs.
    ///
    /// The fixture is that arithmetic exactly — one input priced at the build cost, one
    /// output priced at the reprocessing value — and both audit checks are then run over the
    /// real [`SeedBook`] the build would write, not over a re-derivation of it.
    #[test]
    fn type_29659_unrefined_fluxed_condensates_lands_inside_its_feasible_window() {
        use crate::audit::{PERFECT_YIELD, SeedBook, check_manufacture, check_reprocess};
        use crate::build::{SeedPricing, SeedRow};

        const CONDENSATES: u32 = 29_659;
        /// The reaction input, priced so one run costs exactly the observed build cost.
        const INPUT: u32 = 16_636;
        /// The refined moon material it reprocesses into.
        const OUTPUT: u32 = 16_652;
        const BUILD_COST: f64 = 1_064_288.71;
        const REPROCESS_VALUE: f64 = 3_781_531.66;

        let data = fixture(
            vec![
                unpriced_item(CONDENSATES, CATEGORY_MATERIAL, "Unrefined Fluxed Condensates"),
                unpriced_item(INPUT, CATEGORY_MATERIAL, "Hafnium"),
                unpriced_item(OUTPUT, CATEGORY_MATERIAL, "Fluxed Condensates"),
            ],
            vec![manufacturing(46_184, CONDENSATES, 1, &[(INPUT, 1)])],
            Vec::new(),
        );
        let harness = Harness::new(&data)
            .with_capture(INPUT, BUILD_COST)
            .with_capture(OUTPUT, REPROCESS_VALUE);
        let inputs = harness.capture_first(&data, PricingModel::Recursive);
        let reprocessing = ReprocessingStatic::new(
            vec![refine_row(
                CONDENSATES,
                "Unrefined Fluxed Condensates",
                1,
                &[(OUTPUT, 1)],
            )],
            BTreeMap::new(),
        );
        let roots = BTreeSet::from([CONDENSATES, INPUT, OUTPUT]);

        // The fixture reproduces the two observed numbers rather than asserting them by
        // decree: the build cost is what the blueprint expands to, and the reprocessing value
        // is what the refine row is worth.
        assert_eq!(
            CostMap::new(inputs).resolve(CONDENSATES).unit_cost(),
            Some(BUILD_COST),
            "one input at {BUILD_COST} per run is the build cost this type is priced at"
        );

        let floors = compute_reprocessing_floors(
            inputs,
            &reprocessing,
            &roots,
            &harness.captures,
            ask_for(&roots),
            REPROCESSING_FLOOR_MAX_PASSES,
        );
        assert!(floors.converged);
        let floor = floors
            .floors
            .get(CONDENSATES)
            .expect("the type is under-priced against its refine revenue and must be lifted");

        // --------------------------------------------------------------- the window itself
        let check_1_floor = REPROCESS_VALUE / TEST_SELL_MULTIPLIER;
        let check_2_ceiling = TEST_SELL_MULTIPLIER * BUILD_COST;
        assert!(
            check_1_floor < check_2_ceiling,
            "the window is non-empty: {check_1_floor} .. {check_2_ceiling}"
        );
        assert!(
            floor >= check_1_floor,
            "the floor must clear check 1: {floor} < {check_1_floor}"
        );
        assert!(
            floor <= check_2_ceiling,
            "the floor must stay under check 2's ceiling: {floor} > {check_2_ceiling}"
        );
        assert!(
            REPROCESS_VALUE > check_2_ceiling,
            "and the old formulation's floor — the raw reprocessing value — did not: \
             {REPROCESS_VALUE} > {check_2_ceiling}. That is the violation this fix removes."
        );

        // ------------------------------------------------ both audit checks, on real rows
        let pricing = SeedPricing {
            sell_multiplier: TEST_SELL_MULTIPLIER,
            buy_multiplier: 1.0,
            price_floor: 100.0,
        };
        let rows = |condensates_cost: f64| -> Vec<SeedRow> {
            [
                (CONDENSATES, "Unrefined Fluxed Condensates", condensates_cost),
                (INPUT, "Hafnium", BUILD_COST),
                (OUTPUT, "Fluxed Condensates", REPROCESS_VALUE),
            ]
            .into_iter()
            .map(|(type_id, name, cost)| SeedRow {
                type_id,
                name: name.to_string(),
                bucket: "B",
                junk: false,
                cost,
                ask: pricing.ask(cost),
                bid: pricing.bid(cost),
                sides: crate::seedplan::SeedSides::BOTH,
                quantity: 1,
            })
            .collect()
        };

        let book = SeedBook::from_rows(&rows(floor), &crate::build::test_station());
        let reprocess = check_reprocess(&book, &reprocessing, PERFECT_YIELD);
        assert_eq!(
            reprocess.violation_count(),
            0,
            "check 1 at a perfect refine: {:?}",
            reprocess.violations.first().map(|v| v.loop_text.clone())
        );
        let manufacture = check_manufacture(&book, &harness.producers);
        assert_eq!(
            manufacture.violation_count(),
            0,
            "check 2: {:?}",
            manufacture.violations.first().map(|v| v.loop_text.clone())
        );

        // The two counterfactuals, so the test fails for the right reason if either bound
        // moves. Unfloored, check 1 fires; floored the old way, check 2 fires.
        let unfloored = SeedBook::from_rows(&rows(BUILD_COST), &crate::build::test_station());
        assert_eq!(
            check_reprocess(&unfloored, &reprocessing, PERFECT_YIELD).violation_count(),
            1,
            "without any floor the refine loop is open — that is why rule C exists"
        );
        let overshot = SeedBook::from_rows(&rows(REPROCESS_VALUE), &crate::build::test_station());
        assert_eq!(
            check_manufacture(&overshot, &harness.producers).violation_count(),
            1,
            "flooring at the full reprocessing value prices the type above 3 x its build \
             cost, which is the check-2 violation the old formulation manufactured"
        );
        assert_eq!(
            check_reprocess(&overshot, &reprocessing, PERFECT_YIELD).violation_count(),
            0,
            "and it did close check 1 — it was never wrong about the direction, only the size"
        );
    }
}
